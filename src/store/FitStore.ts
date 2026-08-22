import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

const TYPE_SYNC_STATE_KEY = 'fit_type_sync_state';
const LEGACY_WATERMARKS_KEY = 'fit_watermarks';
const SETTINGS_KEY = 'fit_settings';

export interface LatestFitValue {
  value: number | null;
  unit: string;
  timestamp: string; // ISO — content time of the newest individual record for this type
  // BLOOD_PRESSURE -> { diastolic }; SLEEP_SESSION -> { deepMin, lightMin, remMin, awakeMin };
  // everything else -> absent.
  detail?: Record<string, number>;
}

export interface TypeSyncState {
  changesToken: string | null; // null => next tick runs a backfill and mints a fresh token
  watermark: string | null; // ISO instant we're known caught-up through
}

interface FitSettings {
  autoSyncEnabled: boolean;
  syncIntervalMinutes: number;
  fitFileNameOverride: string | null;
}

interface FitState {
  permissionsGranted: string[];
  latestByType: Record<string, LatestFitValue>;
  dailyTotals: Record<string, LatestFitValue>;
  lastCheckedByType: Record<string, string>;
  typeSyncState: Record<string, TypeSyncState>;
  isSyncing: boolean;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  autoSyncEnabled: boolean;
  syncIntervalMinutes: number;
  fitFileNameOverride: string | null;

  setPermissionsGranted: (ids: string[]) => void;
  setLatest: (id: string, value: LatestFitValue) => void;
  setDailyTotal: (id: string, value: LatestFitValue) => void;
  setLastChecked: (id: string, iso: string) => void;
  setTypeSyncState: (id: string, state: TypeSyncState) => Promise<void>;
  setIsSyncing: (syncing: boolean) => void;
  setLastSyncAt: (iso: string) => void;
  setLastSyncError: (err: string | null) => void;
  setAutoSyncEnabled: (enabled: boolean) => Promise<void>;
  setSyncIntervalMinutes: (minutes: number) => Promise<void>;
  setFitFileNameOverride: (name: string | null) => Promise<void>;

  loadFitSettings: () => Promise<void>;
}

export const useFitStore = create<FitState>((set, get) => ({
  permissionsGranted: [],
  latestByType: {},
  dailyTotals: {},
  lastCheckedByType: {},
  typeSyncState: {},
  isSyncing: false,
  lastSyncAt: null,
  lastSyncError: null,
  autoSyncEnabled: true,
  syncIntervalMinutes: 10,
  fitFileNameOverride: null,

  setPermissionsGranted: (ids) => set({ permissionsGranted: ids }),
  setLatest: (id, value) => set((state) => ({ latestByType: { ...state.latestByType, [id]: value } })),
  setDailyTotal: (id, value) => set((state) => ({ dailyTotals: { ...state.dailyTotals, [id]: value } })),
  setLastChecked: (id, iso) => set((state) => ({ lastCheckedByType: { ...state.lastCheckedByType, [id]: iso } })),

  setTypeSyncState: async (id, syncState) => {
    const next = { ...get().typeSyncState, [id]: syncState };
    set({ typeSyncState: next });
    try {
      await AsyncStorage.setItem(TYPE_SYNC_STATE_KEY, JSON.stringify(next));
    } catch (e) {
      console.error('Failed to persist Fit type sync state:', e);
    }
  },

  setIsSyncing: (syncing) => set({ isSyncing: syncing }),
  setLastSyncAt: (iso) => set({ lastSyncAt: iso }),
  setLastSyncError: (err) => set({ lastSyncError: err }),

  setAutoSyncEnabled: async (enabled) => {
    set({ autoSyncEnabled: enabled });
    await persistSettings(get());
  },
  setSyncIntervalMinutes: async (minutes) => {
    set({ syncIntervalMinutes: minutes });
    await persistSettings(get());
  },
  setFitFileNameOverride: async (name) => {
    set({ fitFileNameOverride: name });
    await persistSettings(get());
  },

  loadFitSettings: async () => {
    try {
      const saved = await AsyncStorage.getItem(TYPE_SYNC_STATE_KEY);
      if (saved) {
        set({ typeSyncState: JSON.parse(saved) });
      } else {
        // One-time migration from the pre-Changes-API watermark shape: each old `{ id: iso }`
        // becomes `{ id: { changesToken: null, watermark: iso } }`, so the next sync tick does
        // exactly one more bounded backfill from where the old code left off, then mints a
        // changes-token — no re-download of history, no gap.
        const legacy = await AsyncStorage.getItem(LEGACY_WATERMARKS_KEY);
        if (legacy) {
          const legacyWatermarks: Record<string, string> = JSON.parse(legacy);
          const migrated: Record<string, TypeSyncState> = {};
          for (const [id, iso] of Object.entries(legacyWatermarks)) {
            migrated[id] = { changesToken: null, watermark: iso };
          }
          set({ typeSyncState: migrated });
          await AsyncStorage.setItem(TYPE_SYNC_STATE_KEY, JSON.stringify(migrated));
        }
      }

      const savedSettings = await AsyncStorage.getItem(SETTINGS_KEY);
      if (savedSettings) {
        const parsed: Partial<FitSettings> = JSON.parse(savedSettings);
        set({
          autoSyncEnabled: parsed.autoSyncEnabled ?? true,
          syncIntervalMinutes: parsed.syncIntervalMinutes ?? 10,
          fitFileNameOverride: parsed.fitFileNameOverride ?? null,
        });
      }
    } catch (e) {
      console.error('Failed to load Fit settings:', e);
    }
  },
}));

const persistSettings = async (state: FitState) => {
  const settings: FitSettings = {
    autoSyncEnabled: state.autoSyncEnabled,
    syncIntervalMinutes: state.syncIntervalMinutes,
    fitFileNameOverride: state.fitFileNameOverride,
  };
  try {
    await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to persist Fit settings:', e);
  }
};
