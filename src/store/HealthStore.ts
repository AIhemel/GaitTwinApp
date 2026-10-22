import { create } from 'zustand';
import type { DaySummary } from '../health/daySummary';
import type { Baselines } from '../health/baselines';

// What the Today tab shows. `today` is republished by the health engine every 5 min (and on demand);
// `viewed` is whichever day the user picked (today by default).
interface HealthState {
  today: DaySummary | null;
  viewedDate: string | null; // null = today
  viewed: DaySummary | null;
  days: string[];
  alertsVersion: number; // bumped when an alert or a response is written, so the Today list re-reads
  baselines: Baselines | null; // your usual, rebuilt at start-up and after midnight
  setBaselines: (b: Baselines) => void;
  lastImport: { imported: string[]; skipped: string[] } | null; // thesis days imported at this start-up
  setLastImport: (r: { imported: string[]; skipped: string[] }) => void;
  bumpAlerts: () => void;
  setToday: (s: DaySummary) => void;
  setViewed: (date: string | null, s: DaySummary | null) => void;
  setDays: (days: string[]) => void;
}

export const useHealthStore = create<HealthState>((set) => ({
  today: null,
  viewedDate: null,
  viewed: null,
  days: [],
  alertsVersion: 0,
  baselines: null,
  setBaselines: (baselines) => set({ baselines }),
  lastImport: null,
  setLastImport: (lastImport) => set({ lastImport }),
  bumpAlerts: () => set((st) => ({ alertsVersion: st.alertsVersion + 1 })),
  setToday: (s) => set({ today: s }),
  setViewed: (viewedDate, viewed) => set({ viewedDate, viewed }),
  setDays: (days) => set({ days }),
}));
