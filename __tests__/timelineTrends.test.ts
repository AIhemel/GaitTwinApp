import { buildTimeline } from '../src/health/timeline';
import { dayMetrics, DayMetrics, lastDates, trendSeries, TREND_METRICS, usualBand } from '../src/health/trends';
import { gaitDetail } from '../src/health/gaitDetail';
import { analyzeFoot, Stride } from '../src/health/gait';
import { buildBaselines, PastDay } from '../src/health/baselines';
import { loadDayMetrics, METRICS_CACHE } from '../src/health/history';
import { MINUTE_HEADER } from '../src/health/daySummary';
import { resetDailyStoreForTests } from '../src/services/DailyStore';
import { installMemFs } from '../testUtils/memfs';
import { loadFoot } from '../testUtils/fixtures';
import { readFixtureText } from '../testUtils/readFixtureFile';

const MIN = 60000;
const D0 = new Date(2026, 9, 14).getTime();
const at = (h: number, m = 0) => D0 + h * 3600000 + m * MIN;
const row = (t: number, cols: Record<string, string>) => ({ minute: new Date(t).toISOString(), ...cols });

describe('timeline', () => {
  test('activity ribbon, 5-minute values and event pins for one day', () => {
    const minutes = [
      ...[...Array(420)].map((_, i) => row(at(0, i), { context: 'sleep', hr: '60' })),
      ...[...Array(30)].map((_, i) => row(at(8, i), { context: 'walk', hr: '100', steps_band: '100' })),
      ...[...Array(20)].map((_, i) => row(at(9, i), { context: 'sitting', posture: 'SLOUCH' })),
      ...[...Array(40)].map((_, i) => row(at(9, 20 + i), { context: 'sitting', posture: 'STRAIGHT', pm25: '40' })),
      ...[...Array(20)].map((_, i) => row(at(10, i), { context: 'rickshaw', pm25: '150' })),
      row(at(11), { context: '', co2_ppm: '700', water_ml: '250' }),
      row(at(12), { context: '', water_ml: '0' }), // nothing measured in this minute
    ];
    const tl = buildTimeline(D0, minutes,
      [{ t: at(13), title: 'Stuffy room: CO₂ 1,050 ppm', severity: 'nudge' }],
      [{ t: at(11, 5), label: 'drink', note: '' }, { t: at(14), label: 'drink', note: '' }, { t: at(12), label: 'ac_on', note: 'office' }]);

    expect(tl.contextMin).toEqual({ sleep: 420, walk: 30, seated_poor: 20, seated_upright: 40, rickshaw: 20, other: 1 });
    expect(tl.context.reduce((a, c) => a + c.to - c.from, 0)).toBe(1440);
    expect(tl.hr[0]).toBe(60);
    expect(tl.hr[8 * 12]).toBe(100); // 08:00–08:05
    expect(tl.steps[8 * 12]).toBe(500);
    expect(tl.steps[0]).toBeNull();
    expect(tl.stepsSource).toBe('band');
    expect(tl.pm25[10 * 12]).toBe(150);
    // the 11:05 tap is the bottle's 11:00 drink; the 14:00 tap is a separate one
    expect(tl.pins.map((p) => [p.t, p.kind, p.text])).toEqual([
      [at(11), 'drink', '250 mL'], [at(12), 'tap', 'ac on: office'], [at(13), 'alert', 'Stuffy room: CO₂ 1,050 ppm'], [at(14), 'drink', 'drink (tapped)'],
    ]);
  });

  test("an imported thesis day (Hemel's day 7)", () => {
    const [head, ...rows] = readFixtureText('imported_2026-10-14/minute_summary.csv').trim().split('\n').map((l) => l.split(','));
    expect(head.join(',')).toBe(MINUTE_HEADER);
    const minutes = rows.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
    const tl = buildTimeline(new Date(2026, 9, 14).getTime(), minutes, [], []);
    expect(tl.contextMin.walk).toBe(9);
    expect(tl.contextMin.rickshaw).toBe(5);
    expect(tl.stepsSource).toBe('band');
    expect(tl.pins.filter((p) => p.kind === 'drink').length).toBeGreaterThan(0);
  });
});

// someone whose usual day: ~5,200 steps, sitting HR 70, indoor PM2.5 50, right stance ~8 % longer
const walk = (start: number, n: number, stanceR: number, stanceL: number) => {
  const mk = (i: number, stance: number, off: number): Stride => ({
    hs_ms: start + i * 1100 + off, stride_s: 1.1, stance_pct: stance, stance_s: 0.7, swing_s: 0.4,
    stance_imu_pct: stance, stance_imu_s: 0.7, swing_imu_s: 0.4, pushoff_pct: 65, tilt_range_deg: 55,
    pitch_range_deg: 40, peak_acc_ms2: 30, heel_share: 0.4, met1_share: 0.3, met5_share: 0.3,
    hs_imu_ms: start + i * 1100 + off, to_imu_ms: 0, to_fsr_ms: 0, bout: 0,
  });
  return { R: [...Array(n)].map((_, i) => mk(i, stanceR, 0)), L: [...Array(n)].map((_, i) => mk(i, stanceL, 550)) };
};
const pastDay = (date: string, k: number): PastDay => ({
  date,
  strides: walk(new Date(`${date}T09:00:00`).getTime(), 200, 64, 59),
  minutes: [...Array(120)].map((_, i) => ({
    minute: '', hr: String(69 + (i % 3)), steps_band: '0', steps_insole: '', context: 'awake', hr_cadence_lock: '0',
    pm25: String(48 + (i % 5)), co2_ppm: String(600 + (i % 20)), dba: i % 2 ? '40' : '50',
  })),
  summary: { gait: { stepsBand: 5000 + k * 100 }, heart: { awakeMeanHr: 80, sleepMeanHr: 60 }, hydration: { totalMl: 1500 }, posture: { uprightPct: 70 }, sleep: { asleepMin: 390 } },
});

describe('trends', () => {
  test('one value per day, computed like the baselines', () => {
    const m = dayMetrics(pastDay('2026-10-10', 2), 60);
    expect(m).toMatchObject({ steps: 5200, sittingHr: 70, pm25: 50, awakeHr: 80, sleepHr: 60, sleepH: 6.5, waterMl: 1500, uprightPct: 70 });
    expect(m.cadence).toBeCloseTo(120 / 1.1, 6);
    expect(m.stanceSi).toBeCloseTo((100 * 5) / 61.5, 6);
    expect(m.dba).toBeCloseTo(10 * Math.log10((1e4 + 1e5) / 2), 6); // energy average, not 45
  });

  test('usual band from the days before, and days outside it', () => {
    const dates = lastDates('2026-10-14', 7);
    expect(lastDates('2026-11-02', 4)).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    const metrics: DayMetrics[] = dates.slice(0, 5).map((d, k) => dayMetrics(pastDay(d, k), 60));
    metrics.push({ ...dayMetrics(pastDay('2026-10-14', 0), 60), steps: 8000 });
    const opts = { windowDays: 14, minDays: 3 };
    // steps 5000..5400: median 5200, MAD 100 -> spread floored at 500 steps, band ± 2 × 500
    expect(usualBand(metrics, 'steps', '2026-10-14', opts)).toEqual({ median: 5200, lo: 4200, hi: 6200, days: 5 });
    const s = trendSeries(metrics, TREND_METRICS.find((d) => d.key === 'steps')!, dates, opts);
    expect(s.points.map((p) => p.value)).toEqual([5000, 5100, 5200, 5300, 5400, null, 8000]);
    expect(s.points[6].outside).toBe('above');
    expect(s).toMatchObject({ outsideDays: 1, days: 6 });
    // not enough days yet: no band, nothing flagged
    expect(trendSeries(metrics, TREND_METRICS[0], dates, { windowDays: 14, minDays: 6 }).band).toBeNull();
  });

  describe('per-day values are cached next to the day', () => {
    let fs: ReturnType<typeof installMemFs>;
    const dir = '/mock/Downloads/GaitTwin/daily/2026-10-14';
    beforeEach(() => {
      jest.useFakeTimers({ now: new Date(2026, 9, 20, 12, 0), doNotFake: ['setImmediate', 'nextTick'] });
      fs = installMemFs();
      resetDailyStoreForTests();
      fs.dirs.add(dir);
      for (const f of ['minute_summary.csv', 'strides_R.csv', 'strides_L.csv', 'daily_summary.json']) {
        fs.files[`${dir}/${f}`] = readFixtureText(`imported_2026-10-14/${f}`);
      }
    });
    afterEach(() => jest.useRealTimers());

    test('read once, then from the cache until a file changes', async () => {
      const [first] = await loadDayMetrics(['2026-10-14', '2026-10-15'], 60);
      expect(first).toMatchObject({ date: '2026-10-14', steps: 146, waterMl: 336, uprightPct: 60, awakeHr: 94 });
      expect(first.cadence).toBeGreaterThan(90);
      const cache = JSON.parse(fs.files[`${dir}/${METRICS_CACHE}`]);
      fs.files[`${dir}/${METRICS_CACHE}`] = JSON.stringify({ ...cache, metrics: { ...cache.metrics, steps: -1 } });
      expect((await loadDayMetrics(['2026-10-14'], 60))[0].steps).toBe(-1); // from the cache
      fs.files[`${dir}/daily_summary.json`] = fs.files[`${dir}/daily_summary.json`].replace('146.0', '1460.0');
      expect((await loadDayMetrics(['2026-10-14'], 60))[0].steps).toBe(1460); // changed file: recomputed
    });
  });
});

describe('gait detail', () => {
  const strides = { R: analyzeFoot(loadFoot('gait_hemel_R.csv.gz')).strides, L: analyzeFoot(loadFoot('gait_hemel_L.csv.gz')).strides };

  test("Hemel's walk: left vs right, stride-time distribution, body-size scaling", () => {
    const d = gaitDetail(strides, { heightM: 1.7145 });
    expect(d.strides).toEqual({ R: 112, L: 111 });
    expect(d.measures.map((m) => m.key)).toEqual(['stanceImuPct', 'swingImuS', 'pushoffPct', 'tiltRangeDeg', 'strideS']);
    for (const m of d.measures) {
      expect(m.si).toBeCloseTo((100 * ((m.R as number) - (m.L as number))) / (0.5 * ((m.R as number) + (m.L as number))), 9);
      expect(m.personal).toBe(false); // no usual yet: 0 ± the fixed limit
      expect(m.centre).toBe(0);
    }
    expect(d.measures[0].limit).toBe(5);
    const counted = d.hist!.R.reduce((a, b) => a + b, 0) + d.hist!.L.reduce((a, b) => a + b, 0);
    expect(counted).toBeGreaterThanOrEqual(0.95 * 223); // 1st–99th percentile range
    expect(d.legM).toBeCloseTo(0.53 * 1.7145, 9);
    expect(d.scaleS).toBeCloseTo(Math.sqrt((0.53 * 1.7145) / 9.81), 9);
    expect(d.medianStrideS.R).toBeGreaterThan(1.0);
    expect(d.cvPct.R).toBeGreaterThan(0);
    expect(d.walks).toHaveLength(1);
    expect(gaitDetail(strides, { heightM: null }).scaleS).toBeNull();
  });

  test('with a learned usual the even range is centred on it', () => {
    const days = ['2026-10-10', '2026-10-11', '2026-10-12'].map((d, k) => pastDay(d, k));
    const d = gaitDetail(walk(at(9), 160, 64, 59), { heightM: null, baselines: buildBaselines(days), minBaselineDays: 3 });
    const stance = d.measures[0];
    expect(stance.personal).toBe(true);
    expect(stance.centre).toBeCloseTo((100 * 5) / 61.5, 6);
    expect(stance.uneven).toBe(false); // 8 % is this person's usual
  });
});
