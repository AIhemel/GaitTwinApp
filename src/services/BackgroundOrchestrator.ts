import BackgroundJob from 'react-native-background-actions';
import { BleError, BleManager, ConnectionPriority, Device, Subscription } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import RNFS from 'react-native-fs';
import { useSensorStore, NodeConnectionStatus, NodeStats, GaitReading } from '../store/SensorStore';
import { useChartStore } from '../store/ChartStore';
import { useLocationStore } from '../store/LocationStore';
import { startLocationTracking, stopLocationTracking } from './LocationService';
import { NODES, NODE_LIST, NODES_BY_ID, NodeConfig } from '../config/NodeRegistry';
import { ClockSync } from './ClockSync';
import { sessionWriter, cell, STREAM_HEADERS } from './SessionWriter';
import {
  decodeGait, decodeHydration, decodeEnvironment, decodePosture, poseName,
  encodePostureClock, POSTURE_SYNC_COMMAND,
} from '../protocol/NodePackets';
import pkg from '../../package.json';

// --- FIX 1: Cast global to 'any' so TypeScript doesn't complain ---
(globalThis as any).Buffer = Buffer;
export const manager = new BleManager(); // Exported so App.tsx can use it for scanning

// Data path (see SessionWriter for the file layout):
//   BLE packet -> decode (NodePackets) -> timestamp -> one CSV row per packet
//                                      -> module-level "latest" values -> 10 Hz UI pump -> store -> UI
// Nothing here writes to the store per gait/hydration packet: two gait nodes produce ~200 packets/s,
// and a store update per packet (re-rendering the whole app each time) is what froze and then
// crashed the app. Environment (one packet per 10 s) and posture (per pose change) update it directly.

sessionWriter.setErrorHandler((message) => useSensorStore.getState().setWriteError(message));

type GaitNodeId = 'GAIT' | 'GAIT_LEFT';
type MillisNodeId = GaitNodeId | 'HYDRATION';

// ClockSync for the nodes that stamp packets with millis() (see ClockSync.ts).
const clocks: Record<MillisNodeId, ClockSync> = {
  GAIT: new ClockSync(),
  GAIT_LEFT: new ClockSync(),
  HYDRATION: new ClockSync(30000), // 1 Hz node: a longer window to get enough samples
};

const latestGait: Record<GaitNodeId, GaitReading> = {
  GAIT: { pitch: 0, roll: 0, yaw: 0, heel: 0, mid: 0, toe: 0 },
  GAIT_LEFT: { pitch: 0, roll: 0, yaw: 0, heel: 0, mid: 0, toe: 0 },
};
let latestHydration = { weightGrams: 0, capVolumeML: 0, fusedVolumeML: 0 };
const uiDirty = new Set<MillisNodeId>();
const chartDirty = new Set<MillisNodeId>();

const packetCount: Record<string, number> = {}; // since the last stats tick
const totalPackets: Record<string, number> = {};
const lastPacketAt: Record<string, number> = {};
const countPacket = (nodeId: string, rxMs: number) => {
  packetCount[nodeId] = (packetCount[nodeId] ?? 0) + 1;
  totalPackets[nodeId] = (totalPackets[nodeId] ?? 0) + 1;
  lastPacketAt[nodeId] = rxMs;
};

// --- events.csv: connects, disconnects, reboots, posture syncs — so a stretch with no data reads as
// "node was away/asleep", not as a silent hole.
const logEvent = (node: string, event: string, deviceMs?: number | null, utcMs?: number | null, detail = '') => {
  sessionWriter.append('events', `${Date.now()},${node},${event},${cell(deviceMs)},${cell(utcMs)},${detail}`);
};

const sleep = (time: number) => new Promise<void>((resolve) => setTimeout(() => resolve(), time));

// ==========================================
// GAIT — both feet, ~100 packets/s each (the firmware notifies once per BNO080 report: rotation
// vector and accelerometer, each 50 Hz, so consecutive packets from one foot repeat whichever half
// didn't change). Every packet is logged as received.
// ==========================================
const GAIT_SIDE: Record<GaitNodeId, string> = { GAIT: 'R', GAIT_LEFT: 'L' };

const onGaitPacket = (nodeId: GaitNodeId, value: string) => {
  const rxMs = Date.now();
  const p = decodeGait(Buffer.from(value, 'base64'));
  if (!p) return;

  const clock = clocks[nodeId];
  if (clock.observe(p.deviceMs, rxMs) === 'reboot') logEvent(nodeId, 'reboot_detected', p.deviceMs);

  const g = latestGait[nodeId];
  g.pitch = p.pitch; g.roll = p.roll; g.yaw = p.yaw; g.heel = p.heel; g.mid = p.mid; g.toe = p.toe;
  uiDirty.add(nodeId);
  chartDirty.add(nodeId);
  countPacket(nodeId, rxMs);

  if (sessionWriter.isOpen) {
    sessionWriter.append('gait', `${GAIT_SIDE[nodeId]},${rxMs},${p.deviceMs},${cell(clock.toUtc(p.deviceMs))},${p.pitch.toFixed(3)},${p.roll.toFixed(3)},${p.qI.toFixed(6)},${p.qJ.toFixed(6)},${p.qK.toFixed(6)},${p.qR.toFixed(6)},${p.yaw.toFixed(3)},${p.heel},${p.mid},${p.toe},${p.accX.toFixed(4)},${p.accY.toFixed(4)},${p.accZ.toFixed(4)}`);
  }
};

// ==========================================
// HYDRATION — after connecting, the bottle streams live at 1 Hz, then (after a 3 s grace period)
// replays its offline log as a fast burst of old packets. Live packets feed ClockSync; offline ones
// are timed with the offset learned from the live ones (same boot). The bottle has no boot counter,
// so an offline packet newer than the latest live one must come from an earlier boot: its utc_ms is
// left blank rather than guessed.
// ==========================================
const HYDRATION_BURST_GAP_MS = 200;
const HYDRATION_OFFLINE_AGE_MS = 2000;
let lastHydrationPacketTime = 0;
let lastLiveHydrationDeviceMs: number | null = null;
let hydrationBurstLast: typeof latestHydration | null = null;
let hydrationSyncTimeout: ReturnType<typeof setTimeout> | null = null;

const onHydrationPacket = (value: string) => {
  const rxMs = Date.now();
  const p = decodeHydration(Buffer.from(value, 'base64'));
  if (!p) return;
  const reading = { weightGrams: p.weightGrams, capVolumeML: p.capVolumeML, fusedVolumeML: p.fusedVolumeML };

  const clock = clocks.HYDRATION;
  const sinceLast = rxMs - lastHydrationPacketTime;
  lastHydrationPacketTime = rxMs;
  const offset = clock.offsetMs;
  const age = offset === null ? 0 : rxMs - p.deviceMs - offset;
  const offline = sinceLast < HYDRATION_BURST_GAP_MS || age > HYDRATION_OFFLINE_AGE_MS;

  let utcMs: number | null;
  if (offline) {
    const earlierBoot = lastLiveHydrationDeviceMs !== null && p.deviceMs > lastLiveHydrationDeviceMs;
    utcMs = earlierBoot ? null : clock.toUtc(p.deviceMs);
    const store = useSensorStore.getState();
    if (!store.isSyncing) store.setIsSyncing(true);
    hydrationBurstLast = reading;
  } else {
    if (clock.observe(p.deviceMs, rxMs) === 'reboot') logEvent('HYDRATION', 'reboot_detected', p.deviceMs);
    lastLiveHydrationDeviceMs = p.deviceMs;
    utcMs = clock.toUtc(p.deviceMs);
    latestHydration = reading;
    uiDirty.add('HYDRATION');
    chartDirty.add('HYDRATION'); // offline samples aren't charted: they'd be out of order
  }
  countPacket('HYDRATION', rxMs);

  sessionWriter.append('hydration', `${rxMs},${p.deviceMs},${cell(utcMs)},${offline ? 1 : 0},${p.weightGrams.toFixed(2)},${p.capVolumeML.toFixed(2)},${p.fusedVolumeML.toFixed(2)}`);

  // 500 ms without packets ends a burst; the UI then shows the last replayed value until the
  // next live packet.
  if (hydrationSyncTimeout) clearTimeout(hydrationSyncTimeout);
  hydrationSyncTimeout = setTimeout(() => {
    const store = useSensorStore.getState();
    if (store.isSyncing) store.setIsSyncing(false);
    if (hydrationBurstLast) {
      latestHydration = hydrationBurstLast;
      hydrationBurstLast = null;
      uiDirty.add('HYDRATION');
    }
  }, 500);
};

// ==========================================
// ENVIRONMENT — one 10 s average per packet, live only (nothing is stored on the node while
// disconnected). The packet is sent the moment its window closes, so the phone receive time is
// the window end, to within BLE latency — far tighter than the node's own GPS clock, which only
// has whole seconds (that value is kept raw in device_utc_s).
// ==========================================
const onEnvironmentPacket = (value: string) => {
  const rxMs = Date.now();
  const e = decodeEnvironment(Buffer.from(value, 'base64'));
  if (!e) return;
  countPacket('ENVIRONMENT', rxMs);

  sessionWriter.append('environment', `${rxMs},${cell(e.deviceUtcS)},${rxMs},${cell(e.co2, 1)},${cell(e.temperature, 2)},${cell(e.humidity, 2)},${e.pm1},${e.pm25},${e.pm10},${cell(e.dba, 1)},${cell(e.latitude, 6)},${cell(e.longitude, 6)}`);
  useSensorStore.getState().updateEnvironment({
    co2: e.co2, temp: e.temperature, humidity: e.humidity, pm1: e.pm1, pm25: e.pm25, pm10: e.pm10, dba: e.dba,
    latitude: e.latitude, longitude: e.longitude, gpsClock: e.deviceUtcS !== null, receivedAt: rxMs,
  });
};

// ==========================================
// POSTURE CUSHION — one packet per committed pose change. Live packets are timed on arrival.
// Events committed while no phone was connected sit in the cushion's queue (max 32) until the app
// writes "sync"; those replayed packets carry the cushion's own clock (whole seconds, and it drifts
// during deep sleep), or 0 if its clock was never set — they're flagged replayed in the CSV.
// The app only asks for the queue while recording, so it isn't drained into nowhere.
// ==========================================
const POSTURE_REPLAY_AGE_MS = 5000; // a live packet's device time is within ~1-2 s of arrival
const POSTURE_DRAIN_IDLE_MS = 1500; // the cushion sends queued events 150 ms apart
let postureDrainUntil = 0;

const onPosturePacket = (value: string) => {
  const rxMs = Date.now();
  const p = decodePosture(Buffer.from(value, 'base64'));
  if (!p) return;
  countPacket('POSTURE', rxMs);

  // While draining the queue the cushion's loop is blocked, so no live event can interleave; a
  // queued event with no timestamp is only recognisable by arriving inside that window.
  const inDrain = rxMs < postureDrainUntil;
  if (inDrain) postureDrainUntil = rxMs + POSTURE_DRAIN_IDLE_MS;
  const deviceMs = p.deviceUtcS === null ? null : p.deviceUtcS * 1000;
  const replayed = inDrain || (deviceMs !== null && rxMs - deviceMs > POSTURE_REPLAY_AGE_MS);
  const utcMs = replayed ? deviceMs : rxMs;
  const source = !replayed ? 'rx' : deviceMs !== null ? 'device' : '';

  sessionWriter.append('posture', `${rxMs},${cell(p.deviceUtcS)},${cell(utcMs)},${source},${replayed ? 1 : 0},${p.pose},${poseName(p.pose)}`);
  useSensorStore.getState().updatePosture({ pose: p.pose, eventUtcMs: utcMs, replayed });
};

const writeToNode = (deviceId: string, node: NodeConfig, base64: string) => {
  if (!node.rxCharUUID) throw new Error(`${node.id} has no write characteristic`);
  return manager.writeCharacteristicWithResponseForDevice(deviceId, node.serviceUUID, node.rxCharUUID, base64);
};

// The cushion's clock only takes whole seconds (it sets tv_usec = 0), so the write is aligned to a
// second boundary — otherwise it would run up to 1 s behind for the rest of the session.
const setPostureClock = async (deviceId: string) => {
  await sleep(1000 - (Date.now() % 1000));
  const epochS = Math.round(Date.now() / 1000);
  await writeToNode(deviceId, NODES.POSTURE, encodePostureClock(epochS));
  logEvent('POSTURE', 'clock_set', null, epochS * 1000);
};

const requestPostureSync = async (deviceId: string) => {
  postureDrainUntil = Date.now() + 3000;
  await writeToNode(deviceId, NODES.POSTURE, POSTURE_SYNC_COMMAND);
  logEvent('POSTURE', 'sync_requested');
};

const preparePostureNode = async (deviceId: string) => {
  try {
    await setPostureClock(deviceId);
    if (useSensorStore.getState().isRecording) await requestPostureSync(deviceId);
  } catch (e) {
    console.warn('[POSTURE] clock/sync write failed:', e);
  }
};

const PACKET_HANDLERS: Record<string, (value: string) => void> = {
  GAIT: (v) => onGaitPacket('GAIT', v),
  GAIT_LEFT: (v) => onGaitPacket('GAIT_LEFT', v),
  HYDRATION: onHydrationPacket,
  ENVIRONMENT: onEnvironmentPacket,
  POSTURE: onPosturePacket,
};

// ==========================================
// CONNECTION LIFECYCLE (shared by every node)
// ==========================================
const deviceSubscriptions: Record<string, Subscription[]> = {};
const lastDisconnectTime: Record<string, number> = {};
const RECONNECT_COOLDOWN_MS = 3000;

const clearNodeSubscriptions = (nodeId: string) => {
  deviceSubscriptions[nodeId]?.forEach((s) => s.remove());
  delete deviceSubscriptions[nodeId];
};

const handleNodeDisconnected = (node: NodeConfig, deviceId: string, status?: NodeConnectionStatus) => {
  // The monitor error and onDisconnected usually both fire for one drop; handle it once.
  if (!deviceSubscriptions[node.id]) return;
  clearNodeSubscriptions(node.id);
  lastDisconnectTime[node.id] = Date.now();
  // A monitor error doesn't always mean the link is down; without this the node could sit in
  // "reconnecting" while still connected, and every reconnect attempt would fail.
  manager.cancelDeviceConnection(deviceId).catch(() => {});
  const store = useSensorStore.getState();
  store.setNodeStatus(node.id, status ?? (node.sleepsWhenIdle ? 'waiting' : 'reconnecting'));
  // The cushion never reports EMPTY; it goes to sleep ~10 s after the seat empties, which is what
  // this disconnect usually is. The pose is unknown from here until the next event.
  if (node.id === 'POSTURE') store.updatePosture({ pose: null, eventUtcMs: null, replayed: false });
  logEvent(node.id, 'disconnected');
};

// Android's Bluetooth stack generally serializes GATT operations (connect/MTU/service-discovery)
// across ALL peripherals sharing the phone's single BLE radio — kicking off two nodes' connect()
// sequences at the same instant (e.g. two gait shoes discovered in the same scan tick) makes both
// compete for that one radio and both come up slowly instead of one being quick and the other
// following shortly after. This flag serializes just the heavy connect+discover phase (not the
// lightweight notification streaming that follows), so multiple nodes connect one after another
// instead of fighting each other — the continuous scan naturally retries any node still waiting.
let connectionInFlight = false;
let connectionInFlightTimeout: ReturnType<typeof setTimeout> | null = null;

const beginConnectionAttempt = () => {
  connectionInFlight = true;
  if (connectionInFlightTimeout) clearTimeout(connectionInFlightTimeout);
  // Safety valve: if a connect() sequence somehow never resolves or rejects, don't let it
  // permanently block every other node's connection attempts forever.
  connectionInFlightTimeout = setTimeout(() => { connectionInFlight = false; }, 15000);
};

const endConnectionAttempt = () => {
  connectionInFlight = false;
  if (connectionInFlightTimeout) {
    clearTimeout(connectionInFlightTimeout);
    connectionInFlightTimeout = null;
  }
};

const canAttemptConnect = (nodeId: string, status: NodeConnectionStatus) => {
  if (status === 'connected' || status === 'connecting') return false;
  if (connectionInFlight) return false;
  return Date.now() - (lastDisconnectTime[nodeId] || 0) > RECONNECT_COOLDOWN_MS;
};

const connectNode = (node: NodeConfig, device: Device) => {
  const { setNodeStatus } = useSensorStore.getState();
  setNodeStatus(node.id, 'connecting');
  beginConnectionAttempt();

  device.connect()
    .then(dev => dev.requestMTU(128)) // gait 46 B / env 34 B don't fit the default 20 B payload
    .then(dev => dev.discoverAllServicesAndCharacteristics())
    .then(dev => {
      const subs: Subscription[] = [];
      deviceSubscriptions[node.id] = subs;
      subs.push(dev.onDisconnected(() => handleNodeDisconnected(node, dev.id)));

      if (node.id in clocks) {
        clocks[node.id as MillisNodeId].reset(); // the node may have rebooted while away
      }
      if (node.id === 'HYDRATION') lastLiveHydrationDeviceMs = null;
      if (node.id === 'GAIT' || node.id === 'GAIT_LEFT') {
        // Shorter connection interval: more airtime for ~100 packets/s and less per-packet
        // latency jitter for ClockSync to filter out. Android-only; harmless elsewhere.
        dev.requestConnectionPriority(ConnectionPriority.High).catch(() => {});
      }

      const handler = PACKET_HANDLERS[node.id];
      subs.push(dev.monitorCharacteristicForService(node.serviceUUID, node.charUUID, (err, char) => {
        if (err) {
          handleNodeDisconnected(node, dev.id);
          return;
        }
        if (char?.value) handler(char.value);
      }));

      setNodeStatus(node.id, 'connected');
      endConnectionAttempt();
      logEvent(node.id, 'connected');
      if (node.id === 'POSTURE') preparePostureNode(dev.id);
    })
    .catch(() => {
      clearNodeSubscriptions(node.id);
      lastDisconnectTime[node.id] = Date.now();
      manager.cancelDeviceConnection(device.id).catch(() => {});
      setNodeStatus(node.id, node.sleepsWhenIdle ? 'waiting' : 'disconnected');
      endConnectionAttempt();
    });
};

const onScanResult = (error: BleError | null, device: Device | null) => {
  if (error || !device) return;
  const { activeInterests, nodeBindings, nodeStatus } = useSensorStore.getState();
  for (const node of NODE_LIST) {
    if (
      device.id === nodeBindings[node.id] &&
      activeInterests.includes(node.id) &&
      canAttemptConnect(node.id, nodeStatus[node.id])
    ) {
      connectNode(node, device);
      return;
    }
  }
};

// Switching a node off disconnects it, instead of leaving it streaming in the background.
let interestWatcher: (() => void) | null = null;
const watchInterestChanges = () => {
  if (interestWatcher) return;
  interestWatcher = useSensorStore.subscribe((state, prev) => {
    if (state.activeInterests === prev.activeInterests) return;
    for (const id of prev.activeInterests) {
      const deviceId = state.nodeBindings[id];
      if (state.activeInterests.includes(id) || !NODES_BY_ID[id]) continue;
      if (deviceId) handleNodeDisconnected(NODES_BY_ID[id], deviceId, 'disconnected');
      const status = useSensorStore.getState().nodeStatus[id];
      if (status === 'reconnecting' || status === 'waiting') state.setNodeStatus(id, 'disconnected');
    }
  });
};

// ==========================================
// UI PUMP: latest gait/hydration values -> store at 10 Hz, sparklines at 4 Hz, node stats at 1 Hz.
// ==========================================
const UI_PUMP_MS = 100;
const CHART_INTERVAL_MS = 250;
const STATS_INTERVAL_MS = 1000;
let uiTimer: ReturnType<typeof setInterval> | null = null;

const startUiPump = () => {
  if (uiTimer) return;
  let lastChart = 0;
  let lastStats = Date.now();
  let lastStatsJson = '';

  uiTimer = setInterval(() => {
    const now = Date.now();

    if (uiDirty.size) {
      useSensorStore.setState({
        ...(uiDirty.has('GAIT') && { gait: { ...latestGait.GAIT } }),
        ...(uiDirty.has('GAIT_LEFT') && { gaitLeft: { ...latestGait.GAIT_LEFT } }),
        ...(uiDirty.has('HYDRATION') && { hydration: { ...latestHydration } }),
      });
      uiDirty.clear();
    }

    if (chartDirty.size && now - lastChart >= CHART_INTERVAL_MS) {
      lastChart = now;
      const samples: Record<string, number> = {};
      for (const nodeId of ['GAIT', 'GAIT_LEFT'] as GaitNodeId[]) {
        if (!chartDirty.has(nodeId)) continue;
        const key = nodeId === 'GAIT' ? 'gait' : 'gaitLeft';
        const g = latestGait[nodeId];
        Object.assign(samples, {
          [`${key}.pitch`]: g.pitch, [`${key}.roll`]: g.roll, [`${key}.yaw`]: g.yaw,
          [`${key}.heel`]: g.heel, [`${key}.mid`]: g.mid, [`${key}.toe`]: g.toe,
        });
      }
      if (chartDirty.has('HYDRATION')) {
        Object.assign(samples, {
          'hydration.fusedVolumeML': latestHydration.fusedVolumeML,
          'hydration.weightGrams': latestHydration.weightGrams,
          'hydration.capVolumeML': latestHydration.capVolumeML,
        });
      }
      chartDirty.clear();
      useChartStore.getState().pushSamples(samples);
    }

    if (now - lastStats >= STATS_INTERVAL_MS) {
      const elapsedS = (now - lastStats) / 1000;
      lastStats = now;
      const stats: Record<string, NodeStats> = {};
      for (const node of NODE_LIST) {
        stats[node.id] = {
          rateHz: Math.round((packetCount[node.id] ?? 0) / elapsedS),
          syncLocked: clocks[node.id as MillisNodeId]?.locked ?? false,
          packets: totalPackets[node.id] ?? 0,
          lastPacketAt: lastPacketAt[node.id] ?? null,
        };
        packetCount[node.id] = 0;
      }
      const json = JSON.stringify(stats);
      if (json !== lastStatsJson) {
        lastStatsJson = json;
        useSensorStore.getState().setNodeStats(stats);
      }
    }
  }, UI_PUMP_MS);
};

// ==========================================
// RECORDING SESSIONS
// ==========================================
let sessionName = '';
let sessionStartedAt = new Date();

const writeSessionMeta = async (dir: string, endTime?: Date) => {
  const { nodeBindings, activeInterests } = useSensorStore.getState();
  const clockSync = Object.fromEntries(
    (Object.keys(clocks) as MillisNodeId[]).map((id) => [id, { offsetMs: clocks[id].offsetMs, samples: clocks[id].sampleCount }])
  );
  const meta = {
    fileName: sessionName,
    startTime: sessionStartedAt.toISOString(),
    endTime: endTime ? endTime.toISOString() : null,
    appVersion: pkg.version,
    nodeBindings,
    activeInterests,
    timeBase:
      'utc_ms and rx_ms are Unix epoch milliseconds on the phone clock; rx_ms is when the packet arrived. ' +
      'Gait/hydration: utc_ms = device_ms (node millis) + a min-delay offset estimate (ClockSync); refit offline from rx_ms/device_ms if needed. ' +
      'Environment: utc_ms = arrival = end of the 10 s averaging window; device_utc_s is the node\'s GPS clock (whole seconds). ' +
      'Posture: utc_ms = when the pose was committed (held 10 s; onset is ~10 s earlier); live events use arrival time, replayed queue events the cushion clock (utc_source column).',
    streams: STREAM_HEADERS,
    ...(endTime && { clockSyncAtEnd: clockSync }),
  };
  try {
    await RNFS.writeFile(`${dir}/session.meta.json`, JSON.stringify(meta, null, 2), 'utf8');
  } catch (e) {
    console.error("Session metadata write failed:", e);
  }
};

// --- CALLED WHEN THE USER STARTS A RECORDING SESSION ---
export const startRecordingSession = async (): Promise<{ gpsError?: string; renamedTo?: string }> => {
  const store = useSensorStore.getState();
  const { dir, name, renamed } = await sessionWriter.open(store.fileName.trim() || 'DHT_Session');
  if (renamed) store.setFileName(name);
  sessionName = name;
  sessionStartedAt = new Date();
  await writeSessionMeta(dir);

  logEvent('APP', 'session_start');
  for (const id of store.activeInterests) logEvent(id, `status_at_start_${store.nodeStatus[id] ?? 'disconnected'}`);

  let gpsError: string | undefined;
  if (useLocationStore.getState().gpsTrackingEnabled) {
    useLocationStore.getState().clearPath();
    const result = await startLocationTracking();
    if (!result.success) gpsError = result.error;
  }

  store.setRecording(true);

  // Collect pose changes the cushion queued while no phone was listening.
  const postureId = store.nodeBindings.POSTURE;
  if (postureId && store.nodeStatus.POSTURE === 'connected') {
    requestPostureSync(postureId).catch((e) => console.warn('[POSTURE] sync failed:', e));
  }
  return { gpsError, renamedTo: renamed ? name : undefined };
};

// --- CALLED WHEN THE USER STOPS A RECORDING SESSION ---
export const stopRecordingSession = async () => {
  stopLocationTracking();
  useSensorStore.getState().setRecording(false);
  logEvent('APP', 'session_stop');
  const dir = sessionWriter.sessionDir;
  if (dir) await writeSessionMeta(dir, new Date());
  await sessionWriter.close();
};

// --- CALLED WHEN THE USER FLIPS THE GPS TRACKING SWITCH ---
// Takes effect immediately if a recording session is already in progress, instead of
// only applying the next time Start Recording is pressed.
export const setGpsTrackingLive = async (enabled: boolean): Promise<{ gpsError?: string }> => {
  useLocationStore.getState().setGpsTrackingEnabled(enabled);

  if (!useSensorStore.getState().isRecording) return {};

  if (enabled) {
    const result = await startLocationTracking();
    return { gpsError: result.success ? undefined : result.error };
  }

  stopLocationTracking();
  return {};
};

// --- THE BACKGROUND TASK ---
const orchestratorTask = async () => {
  startUiPump();
  watchInterestChanges();
  manager.startDeviceScan(null, null, onScanResult);

  // Keep the task (and so the foreground service) alive.
  while (true) {
    await sleep(1000);
  }
};

export const startBackgroundOrchestrator = async () => {
  const options = {
    taskName: 'WBAN_Orchestrator',
    taskTitle: 'Digital Twin Active',
    taskDesc: 'Monitoring WBAN Nodes in Background...',
    taskIcon: { name: 'ic_launcher', type: 'mipmap' },
    color: '#2196F3',
    parameters: { delay: 1000 },
  };

  if (!BackgroundJob.isRunning()) {
    await BackgroundJob.start(orchestratorTask, options);
  }
};

// --- TWO-WAY BLE COMMAND TRANSMITTER ---
export const sendHydrationCommand = async (command: string): Promise<boolean> => {
  const store = useSensorStore.getState();
  const macAddress = store.nodeBindings.HYDRATION;

  if (!macAddress || store.nodeStatus[NODES.HYDRATION.id] !== 'connected') {
    console.warn("Cannot send command: Hydration node offline.");
    return false;
  }

  // UPGRADE: Added .trim() to ensure no hidden spaces break the ESP32 parser
  const base64Command = Buffer.from(command.trim(), 'utf-8').toString('base64');

  try {
    await writeToNode(macAddress, NODES.HYDRATION, base64Command);
    console.log(`[BLE TX SUCCESS] Sent Command: ${command}`);
    return true;
  } catch (error) {
    console.error(`[BLE TX ERROR] Failed to send ${command}:`, error);
    return false;
  }
};
