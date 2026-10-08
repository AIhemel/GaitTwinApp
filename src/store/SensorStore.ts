import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

// 'waiting' is for nodes that stop advertising when idle (the posture cushion deep-sleeps while the
// seat is empty) — being unreachable then is normal, not a dropped connection.
export type NodeConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'waiting';

export interface NodeStats {
  rateHz: number; // packets/s over the last second
  syncLocked: boolean; // ClockSync has enough samples for a settled offset ('millis' nodes only)
  packets: number; // packets received this app run
  lastPacketAt: number | null; // phone time of the last packet
}

export interface GaitReading { pitch: number; roll: number; yaw: number; heel: number; mid: number; toe: number }

export interface EnvironmentReading {
  co2: number | null;
  temp: number | null;
  humidity: number | null;
  pm1: number | null;
  pm25: number | null;
  pm10: number | null;
  dba: number | null;
  latitude: number | null; // null = no fresh GPS fix in that window
  longitude: number | null;
  gpsClock: boolean; // the node's clock has been set from GPS
  receivedAt: number | null; // phone time the 10 s window arrived (= window end)
}

export interface PostureReading {
  pose: number | null; // 1 STRAIGHT .. 6 LEAN_BACKWARD (see NodePackets.POSE_NAMES)
  eventUtcMs: number | null; // when the pose was committed; null if unknown (replayed, cushion clock unset)
  replayed: boolean; // came from the cushion's offline queue, not live
}

interface SensorState {
  activeInterests: string[];
  nodeStatus: Record<string, NodeConnectionStatus>;
  nodeStats: Record<string, NodeStats>;
  isRecording: boolean;
  isSyncing: boolean;
  writeError: string | null;
  fileName: string;
  nodeBindings: Record<string, string | null>;

  gait: GaitReading;
  gaitLeft: GaitReading;
  posture: PostureReading;
  hydration: { weightGrams: number; capVolumeML: number; fusedVolumeML: number };
  environment: EnvironmentReading;

  addInterest: (nodeId: string) => void;
  removeInterest: (nodeId: string) => void;
  setNodeStatus: (nodeId: string, status: NodeConnectionStatus) => void;
  setNodeStats: (stats: Record<string, NodeStats>) => void;
  setRecording: (status: boolean) => void;
  setIsSyncing: (status: boolean) => void;
  setWriteError: (message: string | null) => void;
  setFileName: (name: string) => void;

  bindNode: (nodeId: string, macAddress: string) => Promise<void>;
  loadBindings: () => Promise<void>;

  updatePosture: (data: Partial<PostureReading>) => void;
  updateEnvironment: (data: Partial<EnvironmentReading>) => void;
}

const EMPTY_GAIT: GaitReading = { pitch: 0, roll: 0, yaw: 0, heel: 0, mid: 0, toe: 0 };

export const useSensorStore = create<SensorState>((set, get) => ({
  activeInterests: [],
  nodeStatus: { GAIT: 'disconnected', GAIT_LEFT: 'disconnected', POSTURE: 'disconnected', HYDRATION: 'disconnected', ENVIRONMENT: 'disconnected' },
  nodeStats: {},
  isRecording: false,
  isSyncing: false,
  writeError: null,
  fileName: 'DHT_Session_01',
  nodeBindings: { GAIT: null, GAIT_LEFT: null, POSTURE: null, HYDRATION: null, ENVIRONMENT: null },

  // gait / gaitLeft / hydration are written in bulk by the orchestrator's 10 Hz UI pump (via
  // setState), never per BLE packet — per-packet store updates are what froze the app with two
  // gait nodes streaming.
  gait: EMPTY_GAIT,
  gaitLeft: EMPTY_GAIT,
  posture: { pose: null, eventUtcMs: null, replayed: false },
  hydration: { weightGrams: 0, capVolumeML: 0, fusedVolumeML: 0 },
  environment: { co2: null, temp: null, humidity: null, pm1: null, pm25: null, pm10: null, dba: null, latitude: null, longitude: null, gpsClock: false, receivedAt: null },

  addInterest: (id) => set((state) => ({ activeInterests: [...new Set([...state.activeInterests, id])] })),
  removeInterest: (id) => set((state) => ({ activeInterests: state.activeInterests.filter(i => i !== id) })),
  setNodeStatus: (nodeId, status) => set((state) => ({ nodeStatus: { ...state.nodeStatus, [nodeId]: status } })),
  setNodeStats: (stats) => set({ nodeStats: stats }),
  setRecording: (status) => set({ isRecording: status }),
  setIsSyncing: (status) => set({ isSyncing: status }),
  setWriteError: (message) => { if (get().writeError !== message) set({ writeError: message }); },
  setFileName: (name) => set({ fileName: name }),

  bindNode: async (nodeId, macAddress) => {
    const newBindings = { ...get().nodeBindings, [nodeId]: macAddress };
    set({ nodeBindings: newBindings });
    await AsyncStorage.setItem('wban_bindings', JSON.stringify(newBindings));
  },

  loadBindings: async () => {
    const saved = await AsyncStorage.getItem('wban_bindings');
    if (saved) set({ nodeBindings: JSON.parse(saved) });
  },

  updatePosture: (data) => set((state) => ({ posture: { ...state.posture, ...data } })),
  updateEnvironment: (data) => set((state) => ({ environment: { ...state.environment, ...data } })),
}));
