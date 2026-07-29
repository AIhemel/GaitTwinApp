import BackgroundJob from 'react-native-background-actions';
import { BleManager, Subscription } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import RNFS from 'react-native-fs';
import { useSensorStore, NodeConnectionStatus } from '../store/SensorStore';
import { useChartStore } from '../store/ChartStore';
import { useLocationStore } from '../store/LocationStore';
import { startLocationTracking, stopLocationTracking } from './LocationService';
import { NODES } from '../config/NodeRegistry';
import pkg from '../../package.json';

// --- FIX 1: Cast global to 'any' so TypeScript doesn't complain ---
(globalThis as any).Buffer = Buffer;
export const manager = new BleManager(); // Exported so App.tsx can use it for scanning

// Time and location columns come first, deliberately, so "when and where" is always
// visible at the start of the row without scrolling past the sensor columns.
const CSV_HEADER = "System_MS,Wall_Clock_ISO,GPS_Lat,GPS_Lon,GPS_Speed_mps,Weather_Temp_C,Weather_Humidity_Pct,Gait_Pitch,Gait_Roll,Gait_Yaw,Gait_Heel,Gait_Mid,Gait_Toe,Posture_Spine,Hydro_Fused_mL,Hydro_Weight_g,Hydro_Cap_mL,Env_Temp,Env_Hum";
const SESSION_DIR = `${RNFS.DownloadDirectoryPath}/GaitTwin`;

let csvBuffer: string[] = [];

// --- FIX 2: Use ReturnType<typeof setInterval> instead of NodeJS.Timeout ---
let logTimer: ReturnType<typeof setInterval> | null = null;
let saveTimer: ReturnType<typeof setInterval> | null = null;

// --- BURST SYNC REFS FOR HYDRATION ---
let hydrationSyncBuffer: any[] = [];
let hydrationSyncTimeout: ReturnType<typeof setTimeout> | null = null;
let lastHydrationPacketTime = 0;

// --- PER-NODE CONNECTION LIFECYCLE TRACKING ---
const deviceSubscriptions: Record<string, { monitor?: Subscription; disconnect?: Subscription }> = {};
const lastDisconnectTime: Record<string, number> = {};
const RECONNECT_COOLDOWN_MS = 3000;

const clearNodeSubscriptions = (nodeId: string) => {
  const subs = deviceSubscriptions[nodeId];
  if (subs) {
    subs.monitor?.remove();
    subs.disconnect?.remove();
    delete deviceSubscriptions[nodeId];
  }
};

const handleNodeDisconnected = (nodeId: string) => {
  lastDisconnectTime[nodeId] = Date.now();
  clearNodeSubscriptions(nodeId);
  useSensorStore.getState().setNodeStatus(nodeId, 'reconnecting' as NodeConnectionStatus);
};

const canAttemptConnect = (nodeId: string, status: NodeConnectionStatus) => {
  if (status === 'connected' || status === 'connecting') return false;
  return Date.now() - (lastDisconnectTime[nodeId] || 0) > RECONNECT_COOLDOWN_MS;
};

// --- CHART SAMPLE THROTTLING (4Hz, independent of the 20ms CSV clock) ---
const CHART_THROTTLE_MS = 250;
const lastChartPush: Record<string, number> = {};
const pushChartSample = (key: string, value: number) => {
  const now = Date.now();
  if (now - (lastChartPush[key] || 0) >= CHART_THROTTLE_MS) {
    lastChartPush[key] = now;
    useChartStore.getState().pushSample(key, value);
  }
};

const sleep = (time: number) => new Promise<void>((resolve) => setTimeout(() => resolve(), time));

const ensureSessionDir = async () => {
  const exists = await RNFS.exists(SESSION_DIR);
  if (!exists) await RNFS.mkdir(SESSION_DIR);
};

const readFirstLine = async (path: string): Promise<string | null> => {
  try {
    const chunk = await RNFS.read(path, 4096, 0, 'utf8');
    const newlineIndex = chunk.indexOf('\n');
    return (newlineIndex >= 0 ? chunk.slice(0, newlineIndex) : chunk).replace(/\r$/, '');
  } catch {
    return null;
  }
};

// --- 1. THE SYNCHRONOUS LOGGER (50Hz) ---
const startMasterClock = () => {
  if (logTimer) return;

  csvBuffer = [];
  const startTime = Date.now();

  logTimer = setInterval(() => {
    const store = useSensorStore.getState();
    if (!store.isRecording) return;

    const t = Date.now() - startTime;
    const { gait, posture, hydration, environment } = store;
    const { currentPosition, currentWeather } = useLocationStore.getState();

    const lat = currentPosition ? currentPosition.latitude.toFixed(6) : '';
    const lon = currentPosition ? currentPosition.longitude.toFixed(6) : '';
    const speed = currentPosition?.speedMps != null ? currentPosition.speedMps.toFixed(2) : '';
    const weatherTemp = currentWeather.temperatureC != null ? currentWeather.temperatureC.toFixed(1) : '';
    const weatherHumidity = currentWeather.humidityPct != null ? currentWeather.humidityPct.toFixed(1) : '';

    const wallClock = new Date().toISOString();

    // Column order must always match CSV_HEADER exactly.
    const row = `${t},${wallClock},${lat},${lon},${speed},${weatherTemp},${weatherHumidity},${gait.pitch.toFixed(2)},${gait.roll.toFixed(2)},${gait.yaw.toFixed(2)},${gait.heel},${gait.mid},${gait.toe},${posture.spineAngle},${hydration.fusedVolumeML.toFixed(1)},${hydration.weightGrams.toFixed(1)},${hydration.capVolumeML.toFixed(1)},${environment.temp},${environment.humidity}`;
    csvBuffer.push(row);
  }, 20);

  saveTimer = setInterval(async () => {
    if (csvBuffer.length === 0) return;

    // Take a reference and swap in a fresh buffer *before* awaiting, so rows logged
    // during the write aren't lost, but don't discard `pending` until the write succeeds.
    const pending = csvBuffer;
    csvBuffer = [];

    const dataToSave = pending.join('\n') + '\n';
    const currentFileName = useSensorStore.getState().fileName || 'DHT_Master_Log';
    const path = `${SESSION_DIR}/${currentFileName}.csv`;

    try {
      await ensureSessionDir();
      await RNFS.appendFile(path, dataToSave, 'utf8');
      await RNFS.scanFile(path); // Force Android MediaStore to index the file
    } catch (e) {
      console.error("FS Error:", e);
      csvBuffer = pending.concat(csvBuffer); // don't lose data on a failed write
    }
  }, 5000);
};

// --- CALLED WHEN THE USER STARTS A RECORDING SESSION ---
export const startRecordingSession = async (): Promise<{ gpsError?: string; renamedTo?: string }> => {
  await ensureSessionDir();

  const store = useSensorStore.getState();
  let fileName = store.fileName || 'DHT_Session';
  let csvPath = `${SESSION_DIR}/${fileName}.csv`;
  let metaPath = `${SESSION_DIR}/${fileName}.meta.json`;

  let needsHeader = !(await RNFS.exists(csvPath));
  let renamedTo: string | undefined;

  if (!needsHeader) {
    // A file with this name already exists. Only safe to keep appending to it if its header
    // still matches the current column layout — otherwise every row we add would be shifted
    // relative to the old header (exactly the corruption this check exists to prevent).
    const existingHeader = await readFirstLine(csvPath);
    if (existingHeader !== CSV_HEADER) {
      const suffix = new Date().toISOString().replace(/[:.]/g, '-');
      fileName = `${fileName}_${suffix}`;
      csvPath = `${SESSION_DIR}/${fileName}.csv`;
      metaPath = `${SESSION_DIR}/${fileName}.meta.json`;
      store.setFileName(fileName);
      needsHeader = true;
      renamedTo = fileName;
    }
  }

  if (needsHeader) {
    csvBuffer.push(CSV_HEADER);

    const meta = {
      fileName,
      startTime: new Date().toISOString(),
      appVersion: pkg.version,
      nodeBindings: store.nodeBindings,
    };
    try {
      await RNFS.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');
    } catch (e) {
      console.error("Session metadata write failed:", e);
    }
  }

  let gpsError: string | undefined;
  if (useLocationStore.getState().gpsTrackingEnabled) {
    useLocationStore.getState().clearPath();
    const result = await startLocationTracking();
    if (!result.success) gpsError = result.error;
  }

  store.setRecording(true);
  return { gpsError, renamedTo };
};

// --- CALLED WHEN THE USER STOPS A RECORDING SESSION ---
export const stopRecordingSession = () => {
  stopLocationTracking();
  useSensorStore.getState().setRecording(false);
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

// --- 2. THE BLE CONNECTION MANAGER ---
const orchestratorTask = async (taskDataArguments: any) => {
  startMasterClock();

  // The infinite background loop
  await new Promise<void>(async (resolve) => {
    manager.startDeviceScan(null, null, (error, device) => {
      if (error || !device) return;

      const store = useSensorStore.getState();
      const { activeInterests, nodeBindings, nodeStatus, setNodeStatus, updateGait, updateHydration } = store;

      // ==========================================
      // NODE 1: GAIT ANALYSIS (46-Byte Payload - KEPT EXACTLY AS YOU HAD IT)
      // ==========================================
      if (
        device.id === nodeBindings.GAIT &&
        activeInterests.includes(NODES.GAIT.id) &&
        canAttemptConnect(NODES.GAIT.id, nodeStatus[NODES.GAIT.id])
      ) {
        setNodeStatus(NODES.GAIT.id, 'connecting');

        device.connect()
          .then(dev => dev.requestMTU(128))
          .then(dev => dev.discoverAllServicesAndCharacteristics())
          .then(dev => {
            setNodeStatus(NODES.GAIT.id, 'connected');

            deviceSubscriptions[NODES.GAIT.id] = deviceSubscriptions[NODES.GAIT.id] || {};
            deviceSubscriptions[NODES.GAIT.id].disconnect = dev.onDisconnected(() => {
              handleNodeDisconnected(NODES.GAIT.id);
            });

            deviceSubscriptions[NODES.GAIT.id].monitor = dev.monitorCharacteristicForService(NODES.GAIT.serviceUUID, NODES.GAIT.charUUID, (err, char) => {
              if (err) {
                handleNodeDisconnected(NODES.GAIT.id);
                return;
              }
              if (char?.value) {
                const buf = Buffer.from(char.value, 'base64');
                if (buf.length === 46) {
                   const pitch = buf.readFloatLE(4);
                   const roll = buf.readFloatLE(8);
                   const yaw = buf.readFloatLE(12);
                   const heel = buf.readUInt16LE(28);
                   const mid = buf.readUInt16LE(30);
                   const toe = buf.readUInt16LE(32);

                   updateGait({ pitch, roll, yaw, heel, mid, toe });

                   pushChartSample('gait.pitch', pitch);
                   pushChartSample('gait.roll', roll);
                   pushChartSample('gait.yaw', yaw);
                   pushChartSample('gait.heel', heel);
                   pushChartSample('gait.mid', mid);
                   pushChartSample('gait.toe', toe);
                }
              }
            });
          })
          .catch(() => {
            lastDisconnectTime[NODES.GAIT.id] = Date.now();
            setNodeStatus(NODES.GAIT.id, 'disconnected');
          });
      }

      // ==========================================
      // NODE 2: HYDRATION (16-Byte Payload + Direct-To-Disk Injection)
      // ==========================================
      if (
        device.id === nodeBindings.HYDRATION &&
        activeInterests.includes(NODES.HYDRATION.id) &&
        canAttemptConnect(NODES.HYDRATION.id, nodeStatus[NODES.HYDRATION.id])
      ) {
        setNodeStatus(NODES.HYDRATION.id, 'connecting');

        device.connect()
          .then(dev => dev.requestMTU(128))
          .then(dev => dev.discoverAllServicesAndCharacteristics())
          .then(dev => {
            setNodeStatus(NODES.HYDRATION.id, 'connected');

            deviceSubscriptions[NODES.HYDRATION.id] = deviceSubscriptions[NODES.HYDRATION.id] || {};
            deviceSubscriptions[NODES.HYDRATION.id].disconnect = dev.onDisconnected(() => {
              handleNodeDisconnected(NODES.HYDRATION.id);
            });

            deviceSubscriptions[NODES.HYDRATION.id].monitor = dev.monitorCharacteristicForService(NODES.HYDRATION.serviceUUID, NODES.HYDRATION.charUUID, (err, char) => {
              if (err) {
                handleNodeDisconnected(NODES.HYDRATION.id);
                return;
              }
              if (char?.value) {
                const buf = Buffer.from(char.value, 'base64');

                // UPGRADE: Now cracks the 16-byte payload
                if (buf.length !== 16) return;

                const timestamp = buf.readUInt32LE(0);
                const weightGrams = buf.readFloatLE(4);
                const capVolumeML = buf.readFloatLE(8);
                const fusedVolumeML = buf.readFloatLE(12);

                const now = Date.now();
                const timeSinceLastPacket = now - lastHydrationPacketTime;
                lastHydrationPacketTime = now;

                // BURST DETECTION (< 200ms)
                if (timeSinceLastPacket < 200) {
                  if (useSensorStore.getState().setIsSyncing) {
                    useSensorStore.getState().setIsSyncing(true);
                  }

                  // Push to UI background buffer
                  hydrationSyncBuffer.push({ weightGrams, capVolumeML, fusedVolumeML });

                  // UPGRADE: DIRECT-TO-DISK INJECTION (Fixes the data loss bug)
                  if (useSensorStore.getState().isRecording) {
                     const { gait, posture, environment } = useSensorStore.getState();
                     // Empty fields keep column count/order aligned with CSV_HEADER: Wall_Clock_ISO and
                     // GPS/weather weren't sampled at the time this reading was originally taken (only the
                     // ESP32's own counter is available, captured in the [OFFLINE_...] marker itself).
                     const historicalRow = `[OFFLINE_${timestamp}],,,,,,,${gait.pitch.toFixed(2)},${gait.roll.toFixed(2)},${gait.yaw.toFixed(2)},${gait.heel},${gait.mid},${gait.toe},${posture.spineAngle},${fusedVolumeML.toFixed(1)},${weightGrams.toFixed(1)},${capVolumeML.toFixed(1)},${environment.temp},${environment.humidity}`;
                     csvBuffer.push(historicalRow); // Force it straight into the CSV memory!
                  }
                  // Note: burst-replayed (offline) samples are intentionally not charted —
                  // they'd appear out of order against the live rolling trend.
                } else {
                  // Standard Live Packet
                  updateHydration({ weightGrams, capVolumeML, fusedVolumeML });
                  pushChartSample('hydration.fusedVolumeML', fusedVolumeML);
                  pushChartSample('hydration.weightGrams', weightGrams);
                  pushChartSample('hydration.capVolumeML', capVolumeML);
                }

                // AUTO-HEAL: If 500ms pass with no rapid packets, the flush is over
                if (hydrationSyncTimeout) clearTimeout(hydrationSyncTimeout);
                hydrationSyncTimeout = setTimeout(() => {
                  const currentState = useSensorStore.getState();
                  if (currentState.isSyncing && currentState.setIsSyncing) {
                    currentState.setIsSyncing(false);

                    // Update UI to the final packet of the burst
                    if (hydrationSyncBuffer.length > 0) {
                      const finalPacket = hydrationSyncBuffer[hydrationSyncBuffer.length - 1];
                      updateHydration({
                        weightGrams: finalPacket.weightGrams,
                        capVolumeML: finalPacket.capVolumeML,
                        fusedVolumeML: finalPacket.fusedVolumeML
                      });
                      hydrationSyncBuffer = [];
                    }
                  }
                }, 500);
              }
            });
          })
          .catch(() => {
            lastDisconnectTime[NODES.HYDRATION.id] = Date.now();
            setNodeStatus(NODES.HYDRATION.id, 'disconnected');
          });
      }

      // (Future Posture and Environment nodes go here...)
    });

    // Keep the task alive forever
    while (true) {
      await sleep(1000);
    }
  });
};

// --- 3. EXPORT THE START COMMAND ---
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

// --- 4. TWO-WAY BLE COMMAND TRANSMITTER ---
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
    await manager.writeCharacteristicWithResponseForDevice(
      macAddress,
      NODES.HYDRATION.serviceUUID,
      NODES.HYDRATION.rxCharUUID,
      base64Command
    );
    console.log(`[BLE TX SUCCESS] Sent Command: ${command}`);
    return true;
  } catch (error) {
    console.error(`[BLE TX ERROR] Failed to send ${command}:`, error);
    return false;
  }
};
