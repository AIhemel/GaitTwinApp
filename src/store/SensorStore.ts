import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type NodeConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

interface SensorState {
  activeInterests: string[];
  nodeStatus: Record<string, NodeConnectionStatus>;
  isRecording: boolean;
  isSyncing: boolean;
  fileName: string;
  nodeBindings: Record<string, string | null>;

  gait: { pitch: number; roll: number; yaw: number; heel: number; mid: number; toe: number };
  gaitLeft: { pitch: number; roll: number; yaw: number; heel: number; mid: number; toe: number };
  posture: { spineAngle: number };
  // --- UPDATED HYDRATION METRICS ---
  hydration: { weightGrams: number; capVolumeML: number; fusedVolumeML: number };
  environment: { temp: number; humidity: number };

  addInterest: (nodeId: string) => void;
  removeInterest: (nodeId: string) => void;
  setNodeStatus: (nodeId: string, status: NodeConnectionStatus) => void;
  setRecording: (status: boolean) => void;
  setIsSyncing: (status: boolean) => void;
  setFileName: (name: string) => void;
  
  bindNode: (nodeId: string, macAddress: string) => Promise<void>;
  loadBindings: () => Promise<void>;

  updateGait: (data: Partial<SensorState['gait']>) => void;
  updateGaitLeft: (data: Partial<SensorState['gaitLeft']>) => void;
  updatePosture: (data: Partial<SensorState['posture']>) => void;
  updateHydration: (data: Partial<SensorState['hydration']>) => void;
  updateEnvironment: (data: Partial<SensorState['environment']>) => void;
}

export const useSensorStore = create<SensorState>((set, get) => ({
  activeInterests: [],
  nodeStatus: { GAIT: 'disconnected', GAIT_LEFT: 'disconnected', POSTURE: 'disconnected', HYDRATION: 'disconnected', ENVIRONMENT: 'disconnected' },
  isRecording: false,
  isSyncing: false,
  fileName: 'DHT_Session_01',
  nodeBindings: { GAIT: null, GAIT_LEFT: null, POSTURE: null, HYDRATION: null, ENVIRONMENT: null },

  gait: { pitch: 0, roll: 0, yaw: 0, heel: 0, mid: 0, toe: 0 },
  gaitLeft: { pitch: 0, roll: 0, yaw: 0, heel: 0, mid: 0, toe: 0 },
  posture: { spineAngle: 0 },
  // --- UPDATED HYDRATION INITIAL STATE ---
  hydration: { weightGrams: 0, capVolumeML: 0, fusedVolumeML: 0 },
  environment: { temp: 0, humidity: 0 },

  addInterest: (id) => set((state) => ({ activeInterests: [...new Set([...state.activeInterests, id])] })),
  removeInterest: (id) => set((state) => ({ activeInterests: state.activeInterests.filter(i => i !== id) })),
  setNodeStatus: (nodeId, status) => set((state) => ({ nodeStatus: { ...state.nodeStatus, [nodeId]: status } })),
  setRecording: (status) => set({ isRecording: status }),
  setIsSyncing: (status) => set({ isSyncing: status }), 
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

  updateGait: (data) => set((state) => ({ gait: { ...state.gait, ...data } })),
  updateGaitLeft: (data) => set((state) => ({ gaitLeft: { ...state.gaitLeft, ...data } })),
  updatePosture: (data) => set((state) => ({ posture: { ...state.posture, ...data } })),
  updateHydration: (data) => set((state) => ({ hydration: { ...state.hydration, ...data } })),
  updateEnvironment: (data) => set((state) => ({ environment: { ...state.environment, ...data } })),
}));