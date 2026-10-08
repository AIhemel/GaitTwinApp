import { create } from 'zustand';

export const RING_CAPACITY = 60;

interface ChartState {
  history: Record<string, number[]>;
  // One store update for many metrics at once, so a UI tick doesn't notify every subscriber
  // once per metric.
  pushSamples: (samples: Record<string, number>) => void;
}

export const useChartStore = create<ChartState>((set) => ({
  history: {},
  pushSamples: (samples) => set((state) => {
    const history = { ...state.history };
    for (const [key, value] of Object.entries(samples)) {
      const arr = history[key] ?? [];
      history[key] = arr.length >= RING_CAPACITY ? [...arr.slice(1), value] : [...arr, value];
    }
    return { history };
  }),
}));
