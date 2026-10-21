import { computeDay, DayInputs, EnvMinute } from '../src/health/daySummary';
import { buildHeartData, FitRowLite, parseFitCsv } from '../src/health/heart';
import { analyzeFoot } from '../src/health/gait';
import { loadCsvGz, loadFoot } from '../testUtils/fixtures';

const DAY0 = new Date(2026, 9, 14).getTime(); // local midnight
const MIN = 60000;
const at = (h: number, m = 0) => DAY0 + h * 3600000 + m * MIN;

const envMinute = (o: Partial<{ co2: number; temp: number; pm25: number; dba: number; warmup: boolean }>): EnvMinute => ({
  co2: o.co2 !== undefined ? [o.co2, 1] : [0, 0], temp: o.temp !== undefined ? [o.temp, 1] : [0, 0], rh: [50, 1],
  pm25: o.pm25 !== undefined ? [o.pm25, 1] : [0, 0], pm10: [80, 1],
  dbaEnergy: o.dba !== undefined ? [10 ** (o.dba / 10), 1] : [0, 0], warmup: o.warmup ?? false,
});

const hr = (t: number, v: number, src = 'nodomain.freeyourgadget.gadgetbridge'): FitRowLite =>
  ({ start: new Date(t).toISOString(), end: new Date(t).toISOString(), dataType: 'HEART_RATE', value: v, sourceApp: src, extraJSON: '' });

const baseInputs = (): DayInputs => ({
  date: '2026-10-14', dayStart: DAY0, dayEnd: DAY0 + 24 * 3600000, now: at(20),
  strides: { R: [], L: [] }, gaitMinutes: { R: [], L: [] }, gaitGatedMin: { R: 0, L: 0 },
  env: [], bottle: [], poseEvents: [], postureWindows: [], labels: [], gps: [],
  heart: buildHeartData([], DAY0, DAY0 + 24 * 3600000),
  settings: { tempOffsetC: -5, leanForwardIsUpright: false, targetMl: 2000 }, previousDays: [],
});

test('environment: averages, extremes, time per band, 5-min bins; warm-up temperature excluded', () => {
  const inp = baseInputs();
  inp.env = [
    [at(10, 0), envMinute({ pm25: 30, co2: 700, dba: 60, temp: 40, warmup: true })],
    [at(10, 1), envMinute({ pm25: 60, co2: 1200, dba: 60, temp: 36 })],
    [at(10, 2), envMinute({ pm25: 300, co2: 1600, dba: 90, temp: 35 })],
  ];
  const { summary } = computeDay(inp);
  const e = summary.environment;
  expect(e.vars.pm25).toMatchObject({ mean: 130, min: 30, max: 300, maxAt: at(10, 2), minutes: 3 });
  expect(e.vars.pm25.bandMinutes).toEqual([0, 1, 0, 1, 0, 1]);
  expect(e.pollutedMin).toBe(2);
  expect(e.vars.temp).toMatchObject({ minutes: 2, min: 30, max: 31 }); // -5 °C offset, warm-up minute dropped
  expect(e.vars.dba.mean).toBeCloseTo(10 * Math.log10((2 * 10 ** 6 + 10 ** 9) / 3), 6); // energy average
  expect(e.vars.co2.bins[120]).toBeCloseTo(3500 / 3, 6); // 10:00-10:05 bin
  expect(e.vars.co2.bins.filter((b) => b !== null)).toHaveLength(1);
  expect(summary.insights[0]).toMatch(/PM2.5 was in the unhealthy range .* for 2 min; highest 300 µg\/m³ at 10:02/);
});

test("gait: Hemel's real strides become walks with steps, cadence and a left/right verdict", () => {
  const inp = baseInputs();
  inp.strides = { R: analyzeFoot(loadFoot('gait_hemel_R.csv.gz')).strides, L: analyzeFoot(loadFoot('gait_hemel_L.csv.gz')).strides };
  const { summary } = computeDay({ ...inp, now: Date.now() });
  const g = summary.gait;
  expect(g.strides).toEqual({ R: 112, L: 111 });
  expect(g.walks.length).toBeGreaterThanOrEqual(1);
  const w = g.walks[0];
  expect(w.steps).toBe(224);
  expect(w.cadence!).toBeGreaterThan(80);
  expect(w.cadence!).toBeLessThan(130);
  expect(w.feet.R).not.toBeNull();
  expect(w.feet.L).not.toBeNull();
  expect(w.feedback.length).toBeGreaterThan(10);
});

test("hydration: Hemel's bottle drinks are counted; taps near a bottle drink aren't double counted", () => {
  const h = loadCsvGz('hydration_hemel.csv.gz');
  const inp = baseInputs();
  inp.bottle = h.rx_ms.map((rx, i) => ({ i, rx })).filter(({ i }) => h.offline[i] === 0).map(({ i, rx }) => ({
    t: Number.isNaN(h.utc_ms[i]) ? rx : h.utc_ms[i], fused: h.Fused_mL[i], weight: h.Weight_g[i], cap: null,
  }));
  const first = computeDay({ ...inp, now: inp.bottle[inp.bottle.length - 1].t + MIN }).summary.hydration;
  const bottleDrinks = first.drinks.filter((d) => d.source === 'bottle');
  expect(bottleDrinks.length).toBeGreaterThan(0);
  expect(first.totalMl).toBeCloseTo(bottleDrinks.reduce((s, d) => s + (d.ml as number), 0), 6);

  inp.labels = [{ t: bottleDrinks[0].t + 2 * MIN, label: 'drink', note: '' }, { t: at(22), label: 'drink', note: '' }];
  const second = computeDay({ ...inp, now: at(23) }).summary.hydration;
  expect(second.drinks.filter((d) => d.source === 'tap')).toHaveLength(1); // only the 22:00 one
  expect(second.totalMl).toBeCloseTo(first.totalMl as number, 6); // a tap has no volume
});

test('posture: minutes per pose, upright vs poor, longest sitting stretch; LEAN_FORWARD relabel', () => {
  const inp = baseInputs();
  inp.postureWindows = [[at(9), at(10)], [at(11), null]];
  inp.poseEvents = [
    { utcMs: at(9, 0) + 10000, pose: 'STRAIGHT', replayed: false },
    { utcMs: at(9, 30) + 10000, pose: 'SLOUCH', replayed: false },
    { utcMs: at(11, 0) + 10000, pose: 'LEAN_FORWARD', replayed: false },
    { utcMs: null, pose: 'SLOUCH', replayed: true },
  ];
  const p = computeDay({ ...inp, now: at(11, 40) }).summary.posture!;
  expect(p.byPose).toEqual({ STRAIGHT: 30, SLOUCH: 30, LEAN_FORWARD: 40 });
  expect(p).toMatchObject({ uprightMin: 30, poorMin: 30, longestSitMin: 60, monitoredMin: 100 });
  const relabeled = computeDay({ ...inp, now: at(11, 40), settings: { ...inp.settings, leanForwardIsUpright: true } }).summary.posture!;
  expect(relabeled.uprightMin).toBe(70);
});

test('heart: duplicate band rows dropped, one source only, cadence-lock minutes removed, sleep night chosen', () => {
  const rows: FitRowLite[] = [
    hr(at(15), 125), hr(at(15), 125), hr(at(15, 1), 130), hr(at(15, 2), 126), // resting high, duplicated row
    hr(at(15), 60, 'com.google.android.apps.fitness'), // another app's HR: ignored
    hr(at(16), 101), hr(at(16, 1), 102), // during a walk, matching the step rate: cadence lock
    hr(at(3), 58), hr(at(4), 60), // asleep
    { start: new Date(at(-1)).toISOString(), end: new Date(at(6)).toISOString(), dataType: 'SLEEP_SESSION', value: 420, sourceApp: 'gb',
      extraJSON: JSON.stringify({ stages: [
        { startTime: new Date(at(-1)).toISOString(), endTime: new Date(at(5)).toISOString(), stage: 4 },
        { startTime: new Date(at(5)).toISOString(), endTime: new Date(at(6)).toISOString(), stage: 1 }] }) },
    { start: new Date(at(12)).toISOString(), end: new Date(at(12)).toISOString(), dataType: 'OXYGEN_SATURATION', value: 93, sourceApp: 'gb', extraJSON: '' },
  ];
  const inp = baseInputs();
  inp.heart = buildHeartData(rows, DAY0, DAY0 + 24 * 3600000);
  // insole strides at 16:00-16:01: 50 strides/min = 100 steps/min
  const mk = (t: number) => ({ hs_ms: t, stride_s: 1.2 } as any);
  inp.strides.R = [...Array(50)].map((_, i) => mk(at(16) + i * 1200)).concat([...Array(51)].map((_, i) => mk(at(16, 1) + i * 1176)));
  const h = computeDay(inp).summary;
  expect(h.heart.restingHighMin).toBe(3);
  expect(h.heart.cadenceLockMin).toBe(2);
  expect(h.heart.sleepMeanHr).toBe(59);
  expect(h.heart.minSpo2).toBe(93);
  expect(h.sleep).toMatchObject({ inBedMin: 420, asleepMin: 360 });
  expect(h.insights.some((s) => s.includes('120 bpm or more while not moving for 3 min'))).toBe(true);
});

test("the app's own Fit CSV (quoted ExtraJSON) parses back into rows", () => {
  const csv = 'Wall_Clock_Start_ISO,Wall_Clock_End_ISO,DataType,Value,Unit,SourceApp,ExtraJSON\n'
    + '2026-10-13T22:00:00Z,2026-10-14T01:00:00Z,SLEEP_SESSION,180,min,gb,"{""stages"":[{""stage"":4}]}"\n'
    + '2026-10-14T08:00:00Z,2026-10-14T08:00:00Z,HEART_RATE,72,bpm,gb,\n';
  const rows = parseFitCsv(csv);
  expect(rows).toHaveLength(2);
  expect(JSON.parse(rows[0].extraJSON).stages[0].stage).toBe(4);
  expect(rows[1]).toMatchObject({ dataType: 'HEART_RATE', value: 72 });
});

test('minute table has the pipeline columns and one row per minute so far', () => {
  const inp = baseInputs();
  const { minuteRows } = computeDay({ ...inp, now: at(1, 30) });
  expect(minuteRows).toHaveLength(90);
  expect(minuteRows[0].split(',')).toHaveLength(19);
});
