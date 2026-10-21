import { analyzeFoot, GaitStream, steady, Stride } from '../src/health/gait';
import { loadFoot, loadJson } from '../testUtils/fixtures';

// The TypeScript port against the thesis pipeline's own output on real sessions recorded with this
// app (handoff/sample_data): Hemel day 7 (both feet ~112 Hz, includes stairs and a walk) and
// Spriha day 3 (left foot 114 Hz; right foot ~62 Hz, which the pipeline's gate rejects).
const E = loadJson('gait_expected.json');

const near = (a: number | null, b: number | null, tol: number) =>
  (a === null || Number.isNaN(a as number)) ? b === null : b !== null && Math.abs((a as number) - b) <= tol;

describe.each(['hemel_R', 'hemel_L', 'spriha_L', 'spriha_R'])('%s', (key) => {
  const exp = E[key];
  const foot = loadFoot(`gait_${key}.csv.gz`);
  const res = analyzeFoot(foot);

  test('same quality gate decision and stream rate', () => {
    expect(res.gate.gated).toBe(exp.info.gated);
    expect(res.gate.rateHz).toBeCloseTo(exp.info.rate_hz, 6);
  });

  test('same strides, stride by stride', () => {
    expect(res.strides.length).toBe(exp.strides.length);
    if (exp.info.gated) return;
    expect(res.heelStrikes).toBe(exp.info.heel_strikes);
    res.strides.forEach((s: Stride, i: number) => {
      const p = exp.strides[i];
      expect(s.hs_ms).toBe(p.hs_ms);
      expect(s.stride_s).toBeCloseTo(p.stride_s, 9);
      expect(s.stance_pct).toBeCloseTo(p.stance_pct, 6);
      expect(near(s.stance_imu_pct, p.stance_imu_pct, 1e-6)).toBe(true);
      expect(near(s.pushoff_pct, p.pushoff_pct, 1e-6)).toBe(true);
      expect(s.tilt_range_deg).toBeCloseTo(p.tilt_range_deg, 6);
      expect(s.peak_acc_ms2).toBeCloseTo(p.peak_acc_ms2, 6);
      expect(s.heel_share).toBeCloseTo(p.heel_share, 9);
      expect(s.bout).toBe(p.bout);
    });
  });

  test('same steady-walking subset', () => {
    expect(steady(res.strides).length).toBe(exp.info.gated ? 0 : exp.info.steady_count);
  });
});

test('live (windowed) detection finds the same strides as analysing the whole recording', () => {
  for (const key of ['hemel_R', 'hemel_L', 'spriha_L']) {
    const foot = loadFoot(`gait_${key}.csv.gz`);
    const batch = analyzeFoot(foot).strides.map((s) => s.hs_ms);
    const live: number[] = [];
    const stream = new GaitStream((r) => live.push(...r.strides.map((s) => s.hs_ms)));
    foot.t.forEach((t, i) => stream.push({
      t, pitch: foot.pitch[i], qI: foot.qI[i], qJ: foot.qJ[i], qK: foot.qK[i], qR: foot.qR[i],
      heel: foot.heel[i], met1: foot.met1[i], met5: foot.met5[i], ax: foot.ax[i], ay: foot.ay[i], az: foot.az[i],
    }));
    stream.flush();
    // each stride once, and every batch stride found live. A heel strike may land a sample or two
    // apart (~9 ms each): the thresholds come from a 30 s window instead of the whole recording.
    expect(new Set(live).size).toBe(live.length);
    expect(Math.abs(live.length - batch.length)).toBeLessThanOrEqual(1);
    const matched = batch.filter((h) => live.some((l) => Math.abs(l - h) <= 30)).length;
    expect(matched).toBeGreaterThanOrEqual(batch.length - 1);
  }
});

test('the live gate rejects a ~62 Hz stream, as the pipeline does', () => {
  const foot = loadFoot('gait_spriha_R.csv.gz');
  const gated: boolean[] = [];
  const stream = new GaitStream((r) => gated.push(r.gate.gated));
  foot.t.forEach((t, i) => stream.push({
    t, pitch: foot.pitch[i], qI: foot.qI[i], qJ: foot.qJ[i], qK: foot.qK[i], qR: foot.qR[i],
    heel: foot.heel[i], met1: foot.met1[i], met5: foot.met5[i], ax: foot.ax[i], ay: foot.ay[i], az: foot.az[i],
  }));
  stream.flush();
  expect(gated.length).toBeGreaterThan(0);
  expect(gated.every((g) => g)).toBe(true);
});
