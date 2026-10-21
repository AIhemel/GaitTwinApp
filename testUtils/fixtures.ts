import { GaitSeries, emptySeries } from '../src/health/gait';
import { readFixtureText } from './readFixtureFile';

// Fixtures written by scripts/make_health_fixtures.py from handoff/sample_data + the Python pipeline.
export const loadJson = (name: string): any => JSON.parse(readFixtureText(name));

// Minimal CSV reader for the numeric fixtures (no quoted fields); empty cells -> NaN.
export const loadCsvGz = (name: string): Record<string, number[]> => {
  const text = readFixtureText(name).trim();
  const [head, ...rows] = text.split('\n');
  const cols = head.split(',');
  const out: Record<string, number[]> = Object.fromEntries(cols.map((c) => [c, []]));
  for (const r of rows) {
    const v = r.split(',');
    cols.forEach((c, i) => out[c].push(v[i] === '' ? NaN : Number(v[i])));
  }
  return out;
};

// A fixture foot as a GaitSeries, sorted by utc_ms with duplicate times dropped (keep first), as the
// pipeline does before stride detection.
export const loadFoot = (name: string): GaitSeries => {
  const c = loadCsvGz(name);
  const order = c.utc_ms.map((_, i) => i).sort((a, b) => c.utc_ms[a] - c.utc_ms[b] || a - b);
  const d = emptySeries();
  let last = NaN;
  for (const i of order) {
    if (c.utc_ms[i] === last) continue;
    last = c.utc_ms[i];
    d.t.push(c.utc_ms[i]); d.pitch.push(c.Pitch[i]);
    d.qI.push(c.Quat_I[i]); d.qJ.push(c.Quat_J[i]); d.qK.push(c.Quat_K[i]); d.qR.push(c.Quat_Real[i]);
    d.heel.push(c.Heel_FSR[i]); d.met1.push(c.Met1_FSR[i]); d.met5.push(c.Met5_FSR[i]);
    d.ax.push(c.Accel_X[i]); d.ay.push(c.Accel_Y[i]); d.az.push(c.Accel_Z[i]);
  }
  return d;
};
