import { create } from 'zustand';

export const RING_CAPACITY = 60;

interface ChartState {
  history: Record<string, number[]>;
  pushSample: (key: string, value: number) => void;
}

export const useChartStore = create<ChartState>((set, get) => ({
  history: {},
  pushSample: (key, value) => {
    const arr = get().history[key] ?? [];
    const next = arr.length >= RING_CAPACITY ? [...arr.slice(1), value] : [...arr, value];
    set((state) => ({ history: { ...state.history, [key]: next } }));
  },
}));
