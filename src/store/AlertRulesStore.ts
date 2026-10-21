import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_POLICY, NotificationPolicy, RULE_DEFS_BY_ID, Severity } from '../config/alertRules';

// The user's edits to the alert rules. Only differences from the defaults are stored, so a default
// changed in a later app version still reaches every value the user never touched.
const STORAGE_KEY = 'alert_rules_v1';

export interface RuleOverride {
  enabled?: boolean;
  severity?: Severity;
  cooldownMin?: number;
  params?: Record<string, number>;
}

// Personal profile and analysis options (edited on the Alerts & reminders screen).
export interface Profile {
  sex: 'male' | 'female' | null;
  heightM: number | null;
  massKg: number | null;
}

export interface AnalysisSettings {
  tempOffsetC: number; // added to the environment node's temperature (self-heating); pipeline default -5
  leanForwardIsUpright: boolean; // some users' upright sitting is reported by the cushion as LEAN_FORWARD
  hydrationTargetMl: number | null; // null = from sex: 2.0 L male, 1.6 L female (thresholds.json)
}

export const DEFAULT_PROFILE: Profile = { sex: null, heightM: null, massKg: null };
export const DEFAULT_ANALYSIS: AnalysisSettings = { tempOffsetC: -5, leanForwardIsUpright: false, hydrationTargetMl: null };

export interface ResolvedRule {
  id: string;
  enabled: boolean;
  severity: Severity;
  cooldownMin: number;
  params: Record<string, number>;
}

interface AlertRulesState {
  overrides: Record<string, RuleOverride>;
  policyOverride: Partial<NotificationPolicy>;
  profile: Profile;
  analysis: AnalysisSettings;
  setProfile: (patch: Partial<Profile>) => Promise<void>;
  setAnalysis: (patch: Partial<AnalysisSettings>) => Promise<void>;
  setRuleOverride: (id: string, patch: RuleOverride) => Promise<void>;
  resetRule: (id: string) => Promise<void>;
  setPolicy: (patch: Partial<NotificationPolicy>) => Promise<void>;
  resetPolicy: () => Promise<void>;
  load: () => Promise<void>;
}

type Persisted = Pick<AlertRulesState, 'overrides' | 'policyOverride' | 'profile' | 'analysis'>;

export const useAlertRulesStore = create<AlertRulesState>((set, get) => {
  const persist = (patch: Partial<Persisted>) => {
    const { overrides, policyOverride, profile, analysis } = { ...get(), ...patch };
    return AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ overrides, policyOverride, profile, analysis }));
  };
  return {
  overrides: {},
  policyOverride: {},
  profile: DEFAULT_PROFILE,
  analysis: DEFAULT_ANALYSIS,

  setProfile: async (patch) => {
    const profile = { ...get().profile, ...patch };
    set({ profile });
    await persist({ profile });
  },
  setAnalysis: async (patch) => {
    const analysis = { ...get().analysis, ...patch };
    set({ analysis });
    await persist({ analysis });
  },

  setRuleOverride: async (id, patch) => {
    const prev = get().overrides[id] ?? {};
    const next = { ...prev, ...patch, params: { ...prev.params, ...patch.params } };
    const overrides = { ...get().overrides, [id]: next };
    set({ overrides });
    await persist({ overrides });
  },
  resetRule: async (id) => {
    const overrides = { ...get().overrides };
    delete overrides[id];
    set({ overrides });
    await persist({ overrides });
  },
  setPolicy: async (patch) => {
    const policyOverride = { ...get().policyOverride, ...patch };
    set({ policyOverride });
    await persist({ policyOverride });
  },
  resetPolicy: async () => {
    set({ policyOverride: {} });
    await persist({ policyOverride: {} });
  },
  load: async () => {
    try {
      const saved = await AsyncStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        set({
          overrides: parsed.overrides ?? {},
          policyOverride: parsed.policyOverride ?? {},
          profile: { ...DEFAULT_PROFILE, ...parsed.profile },
          analysis: { ...DEFAULT_ANALYSIS, ...parsed.analysis },
        });
      }
    } catch (e) {
      console.warn('Alert rule settings could not be loaded; using defaults.', e);
    }
  },
  };
});

// Daily water target from drinks (thresholds.json: ~80 % of EFSA total water, 2.0 L male / 1.6 L female).
export const hydrationTargetMl = (): number => {
  const { profile, analysis } = useAlertRulesStore.getState();
  return analysis.hydrationTargetMl ?? (profile.sex === 'female' ? 1600 : 2000);
};

// Defaults with the user's edits applied. Read at evaluation time, so an edit takes effect at once.
export const resolveRule = (id: string): ResolvedRule => {
  const def = RULE_DEFS_BY_ID[id];
  if (!def) throw new Error(`Unknown alert rule ${id}`);
  const o = useAlertRulesStore.getState().overrides[id] ?? {};
  const params: Record<string, number> = {};
  for (const p of def.params) {
    const v = o.params?.[p.key];
    params[p.key] = typeof v === 'number' && Number.isFinite(v) ? Math.min(p.max, Math.max(p.min, v)) : p.default;
  }
  return {
    id,
    enabled: o.enabled ?? def.enabled,
    severity: o.severity ?? def.severity,
    cooldownMin: o.cooldownMin ?? def.cooldownMin,
    params,
  };
};

export const resolvePolicy = (): NotificationPolicy => ({ ...DEFAULT_POLICY, ...useAlertRulesStore.getState().policyOverride });
