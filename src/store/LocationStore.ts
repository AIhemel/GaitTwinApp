import { create } from 'zustand';

export interface TrackPoint {
  latitude: number;
  longitude: number;
  timestamp: number;
  speedMps: number | null;
  temperatureC: number | null;
  humidityPct: number | null;
}

export interface CurrentWeather {
  temperatureC: number | null;
  humidityPct: number | null;
  fetchedAt: number | null;
  fetchedLatitude: number | null;
  fetchedLongitude: number | null;
}

interface LocationState {
  gpsTrackingEnabled: boolean; // master on/off toggle set by the user
  isTracking: boolean; // true only while a recording session is actively tracking GPS
  currentPosition: { latitude: number; longitude: number; speedMps: number | null } | null;
  path: TrackPoint[];
  currentWeather: CurrentWeather;
  locationError: string | null; // surfaced to the UI (permission denied, GPS error, etc.)

  setGpsTrackingEnabled: (enabled: boolean) => void;
  setTracking: (tracking: boolean) => void;
  setCurrentPosition: (pos: { latitude: number; longitude: number; speedMps: number | null }) => void;
  addTrackPoint: (point: TrackPoint) => void;
  setCurrentWeather: (weather: CurrentWeather) => void;
  setLocationError: (error: string | null) => void;
  clearPath: () => void;
}

export const useLocationStore = create<LocationState>((set) => ({
  gpsTrackingEnabled: false,
  isTracking: false,
  currentPosition: null,
  path: [],
  currentWeather: { temperatureC: null, humidityPct: null, fetchedAt: null, fetchedLatitude: null, fetchedLongitude: null },
  locationError: null,

  setGpsTrackingEnabled: (enabled) => set({ gpsTrackingEnabled: enabled }),
  setTracking: (tracking) => set({ isTracking: tracking }),
  setCurrentPosition: (pos) => set({ currentPosition: pos }),
  addTrackPoint: (point) => set((state) => ({ path: [...state.path, point] })),
  setCurrentWeather: (weather) => set({ currentWeather: weather }),
  setLocationError: (error) => set({ locationError: error }),
  clearPath: () => set({ path: [], currentPosition: null }),
}));
