// Environment categories for the Today tab's intensity chart and summaries.
// PM2.5: US EPA AQI breakpoints (2024 revision, µg/m³), as in thresholds.json. CO₂, noise and
// temperature use plain-language bands built from the thresholds' alert levels.

export type EnvVar = 'pm25' | 'co2' | 'dba' | 'temp';
export const ENV_VARS: EnvVar[] = ['pm25', 'co2', 'dba', 'temp'];

export interface Band { upTo: number; label: string; color: string } // upTo inclusive; last band is open

export const ENV_BANDS: Record<EnvVar, { name: string; unit: string; bands: Band[] }> = {
  pm25: {
    name: 'PM2.5', unit: 'µg/m³',
    bands: [
      { upTo: 9.0, label: 'Good', color: '#2e9e4f' },
      { upTo: 35.4, label: 'Moderate', color: '#e3c22b' },
      { upTo: 55.4, label: 'Unhealthy for sensitive groups', color: '#f08a24' },
      { upTo: 125.4, label: 'Unhealthy', color: '#d63b3b' },
      { upTo: 225.4, label: 'Very unhealthy', color: '#8f3f97' },
      { upTo: Infinity, label: 'Hazardous', color: '#6b0f2a' },
    ],
  },
  co2: {
    name: 'CO₂', unit: 'ppm',
    bands: [
      { upTo: 800, label: 'Fresh', color: '#2e9e4f' },
      { upTo: 1000, label: 'Acceptable', color: '#e3c22b' },
      { upTo: 1500, label: 'Stuffy — ventilate', color: '#f08a24' },
      { upTo: Infinity, label: 'Poor air', color: '#d63b3b' },
    ],
  },
  dba: {
    name: 'Noise', unit: 'dBA',
    bands: [
      { upTo: 55, label: 'Quiet', color: '#2e9e4f' },
      { upTo: 70, label: 'Moderate', color: '#e3c22b' },
      { upTo: 85, label: 'Loud', color: '#f08a24' },
      { upTo: Infinity, label: 'Very loud', color: '#d63b3b' },
    ],
  },
  temp: {
    name: 'Temperature', unit: '°C',
    bands: [
      { upTo: 26, label: 'Comfortable', color: '#2e9e4f' },
      { upTo: 30, label: 'Warm', color: '#e3c22b' },
      { upTo: 35, label: 'Hot', color: '#f08a24' },
      { upTo: Infinity, label: 'Very hot', color: '#d63b3b' },
    ],
  },
};

export const NO_DATA_COLOR = '#e2e8f0';

export const bandIndex = (v: EnvVar, x: number): number => ENV_BANDS[v].bands.findIndex((b) => x <= b.upTo);

// "Polluted" in the daily summary = PM2.5 above the EPA moderate band (> 35.4 µg/m³).
export const POLLUTED_PM25 = 35.4;

// The node's temperature reads high from self-heating; the first 30 min after it starts are worse
// still (cold start: up to +12 °C). The pipeline adds a fixed offset (temp_offset_c, default -5).
export const TEMP_WARMUP_MS = 30 * 60000;

// Energy average for sound levels (dBA can't be averaged arithmetically).
export const leq = (dba: number[]): number | null =>
  dba.length ? 10 * Math.log10(dba.reduce((s, x) => s + 10 ** (x / 10), 0) / dba.length) : null;
