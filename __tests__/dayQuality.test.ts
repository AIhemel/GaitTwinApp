import { FSR_HEADER, FSR_KEYS, FsrMinute, FsrMinuteAccumulator, fsrHealth, fsrRow, parseFsrRow, fsrStatus } from '../src/health/fsr';
import { dayQuality, ConnectionRow, StreamStatRow } from '../src/health/dayQuality';
import { HealthEngine } from '../src/health/engine';
import { logConnection, logStreamStats } from '../src/services/DailyLogs';
import { localDate, resetDailyStoreForTests } from '../src/services/DailyStore';
import { installMemFs } from '../testUtils/memfs';
import { loadCsvGz, loadJson } from '../testUtils/fixtures';

const MIN = 60000;
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise<void>((r) => setImmediate(r)); };

describe('insole pressure-sensor health (pipeline sensor_health)', () => {
  const expected = loadJson('fsr_expected.json');

  test.each(['hemel_R', 'hemel_L', 'spriha_R', 'spriha_L'])('%s: per-minute statistics match the Python pipeline', (key) => {
    const c = loadCsvGz(`gait_${key}.csv.gz`);
    const order = c.utc_ms.map((_, i) => i).sort((a, b) => c.utc_ms[a] - c.utc_ms[b] || a - b);
    const rows: FsrMinute[] = [];
    const acc = new FsrMinuteAccumulator(key.endsWith('R') ? 'R' : 'L', (m) => rows.push(m));
    for (const i of order) acc.push(c.utc_ms[i], c.Heel_FSR[i], c.Met1_FSR[i], c.Met5_FSR[i], c.Accel_X[i], c.Accel_Y[i], c.Accel_Z[i]);
    acc.closeIfStale(Infinity);

    const exp = expected[key];
    expect(rows.map((r) => r.minute)).toEqual(exp.minutes.map((m: any) => m.minute));
    const health = fsrHealth(rows)!;
    // the app's reference (median of per-minute 95th percentiles) is within 1 % of the pipeline's
    expect(Math.abs(health.ref - exp.ref_pipeline) / exp.ref_pipeline).toBeLessThan(0.01);
    rows.forEach((r, i) => {
      const m = exp.minutes[i];
      expect(r.samples).toBe(m.samples);
      expect(r.accSd).toBeCloseTo(m.acc_sd, 6);
      for (const k of FSR_KEYS) {
        expect(r.p95[k]).toBeCloseTo(m[k].p95, 6);
        expect(r.zero[k]).toBeCloseTo(m[k].zero, 9);
        expect(r.sat[k]).toBeCloseTo(m[k].sat, 9);
        expect(fsrStatus(r.p95[k], r.zero[k], health.ref)).toBe(m[k].status);
      }
    });
    // a row survives the CSV round trip
    expect(FSR_HEADER.split(',')).toHaveLength(fsrRow(rows[0]).split(',').length);
    expect(parseFsrRow(fsrRow(rows[0]).split(','))!.p95.heel).toBeCloseTo(rows[0].p95.heel, 1);
  });

  test('dropout, loose connection, low range and clipping are told apart; still minutes are not rated', () => {
    const minute = (i: number, heel: number[], met1: number[], met5: number[], moving = true): FsrMinute[] => {
      const out: FsrMinute[] = [];
      const a = new FsrMinuteAccumulator('L', (m) => out.push(m));
      heel.forEach((_, j) => a.push(i * MIN + j * 10, heel[j], met1[j], met5[j], 0, 0, moving ? 9.8 + (j % 2 ? 4 : -4) : 9.8));
      a.closeIfStale(Infinity);
      return out;
    };
    const walk = [...Array(100)].map((_, j) => (j % 10 < 6 ? 3000 : 0)); // loaded 60 % of the time
    const rows = [
      ...minute(0, walk, walk.map(() => 0), walk.map((v) => v / 40)), // met1 dead, met5 low range (max 75)
      ...minute(1, walk, walk.map((v, j) => (j % 10 < 3 ? v : 0)), walk.map((v) => Math.min(4095, v * 2))), // met1 intermittent, met5 clips
      ...minute(2, walk.map(() => 0), walk.map(() => 0), walk.map(() => 0), false), // sitting still: not rated
    ];
    const h = fsrHealth(rows)!;
    expect(h.movingMin).toBe(2);
    expect(h.sensors.heel).toMatchObject({ ok: 2, faultyPct: 0 });
    expect(h.sensors.met1).toMatchObject({ dropout: 2, faultyPct: 100 });
    expect(h.sensors.met5).toMatchObject({ lowRange: 1, ok: 1, faultyPct: 50 });
    expect(h.sensors.met5.clippedPct).toBeCloseTo(30, 6); // 60 of 200 moving samples at 4095
  });
});

describe('day quality', () => {
  const D0 = new Date(2026, 9, 14).getTime();
  const at = (h: number, m = 0) => D0 + h * 3600000 + m * MIN;
  const conn = (t: number, node: string, event: string, detail = ''): ConnectionRow => ({ t, node, event, detail });
  const stat = (t: number, node: string, lossPct: number): StreamStatRow => ({ t, node, packets: 6700, rateHz: 112, lossPct, rssi: -70 });

  test('uptime, disconnections, warm-up and band wear from the day logs', () => {
    const q = dayQuality({
      dayStart: D0, end: D0 + 864e5,
      connections: [
        conn(at(8), 'GAIT', 'connected', 'mtu=128'), conn(at(9), 'GAIT', 'disconnected'), conn(at(9, 2), 'GAIT', 'connected'),
        conn(at(9, 30), 'GAIT', 'reboot_detected'), conn(at(10), 'GAIT', 'disconnected_by_user'),
        conn(at(10, 5), 'GAIT_LEFT', 'connect_failed', 'attempt=1;error=timeout'), conn(at(10, 6), 'GAIT_LEFT', 'connect_failed'),
        conn(at(8), 'ENVIRONMENT', 'connected'), conn(at(8, 20), 'ENVIRONMENT', 'disconnected'), conn(at(9), 'ENVIRONMENT', 'connected'),
      ],
      streamStats: [
        ...[...Array(118)].map((_, i) => stat(at(8) + i * MIN, 'GAIT', i < 59 ? 2 : 40)),
        ...[...Array(200)].map((_, i) => stat(at(8) + i * MIN, 'ENVIRONMENT', 0)),
      ],
      fsr: [],
      // band: a reading every 10 min 07:00–12:00, nothing until 14:00, then every 5 min to 15:00
      minutes: [
        ...[...Array(31)].map((_, i) => ({ minute: new Date(at(7) + i * 10 * MIN).toISOString(), hr: '70' })),
        ...[...Array(13)].map((_, i) => ({ minute: new Date(at(14) + i * 5 * MIN).toISOString(), hr: '75' })),
        { minute: new Date(at(13)).toISOString(), hr: '' },
      ],
      summary: { coverage: { gaitR: 110, gaitL: 0, environment: 190, bottle: 0, posture: 0 }, environment: { warmupMin: 50 }, gait: { gatedMin: { R: 30, L: 0 } } },
    });
    const R = q.nodes.find((n) => n.nodeId === 'GAIT')!;
    expect(R).toMatchObject({ connectedMin: 118, dataMin: 110, disconnects: 1, userOff: 1, reboots: 1, rateHz: 112, rssi: -70 });
    expect(R.lossPct).toBe(21); // median of 59 × 2 % and 59 × 40 %
    expect(q.nodes.find((n) => n.nodeId === 'GAIT_LEFT')).toMatchObject({ connectedMin: 0, failedConnects: 2, lossPct: null });
    expect(q.warmups).toEqual([{ from: at(8), to: at(8, 20) }, { from: at(9), to: at(9, 30) }]);
    expect(q.band).toMatchObject({ readings: 44, wornMin: 300 + 1 + 60, first: at(7), last: at(15) });
    expect(q.band!.offGaps).toEqual([{ from: at(12), to: at(14) }]);
    expect(q.logged).toBe(true);
    expect(q.gatedMin).toEqual({ R: 30, L: 0 });
  });

  test('a day from before the logs existed', () => {
    const q = dayQuality({ dayStart: D0, end: D0 + 864e5, connections: [], streamStats: [], fsr: [], minutes: [], summary: null });
    expect(q.logged).toBe(false);
    expect(q.band).toBeNull();
    expect(q.nodes.every((n) => n.connectedMin === 0 && n.dataMin === null)).toBe(true);
  });
});

describe('the day logs on disk', () => {
  let fs: ReturnType<typeof installMemFs>;
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date(2026, 9, 14, 15, 0), doNotFake: ['setImmediate', 'nextTick'] });
    fs = installMemFs();
    resetDailyStoreForTests();
  });
  afterEach(() => jest.useRealTimers());

  test('connections and per-minute stream stats are appended under one header', async () => {
    const t = Date.now();
    await logConnection(t, 'GAIT', 'connected', 'mtu=128');
    await logConnection(t + 5, 'GAIT', 'connect_failed', 'error=Device, disconnected');
    await logStreamStats(t, 'GAIT', { packets: 6744, rateHz: 112.4, lossPct: 3.25, delayMeanMs: null, delayMaxMs: null }, -68);
    await logStreamStats(t + MIN, 'GAIT', { packets: 0, rateHz: 0, lossPct: null, delayMeanMs: null, delayMaxMs: null }, null);
    const dir = `/mock/Downloads/GaitTwin/daily/${localDate(t)}`;
    expect(fs.files[`${dir}/connections.csv`]).toBe(
      `utc_ms,node,event,detail\n${t},GAIT,connected,mtu=128\n${t + 5},GAIT,connect_failed,"error=Device, disconnected"\n`);
    expect(fs.files[`${dir}/stream_stats.csv`]).toBe(
      `utc_ms,node,packets,rate_hz,loss_pct,rssi\n${t},GAIT,6744,112.40,3.3,-68\n${t + MIN},GAIT,0,0.00,,\n`);
  });

  test('the engine writes one pressure-sensor row per foot and minute', async () => {
    const e = new HealthEngine();
    const t0 = Date.now() - 2 * MIN;
    const s = (t: number, heel: number) => ({ t, pitch: 0, qI: 0, qJ: 0, qK: 0, qR: 1, heel, met1: 100, met5: 50, ax: 0, ay: 0, az: 9.8 });
    for (let i = 0; i < 600; i++) e.onGait('R', s(t0 + i * 10, i % 2 ? 2000 : 0)); // one full minute
    e.onGait('R', s(t0 + MIN + 5, 0)); // the next minute starts: the first one is written
    await flush();
    const path = `/mock/Downloads/GaitTwin/daily/${localDate(t0)}/fsr_minutes.csv`;
    const lines = fs.files[path].trim().split('\n');
    expect(lines[0]).toBe(FSR_HEADER);
    expect(lines).toHaveLength(2);
    const row = parseFsrRow(lines[1].split(','))!;
    expect(row).toMatchObject({ minute: t0 - (t0 % MIN), side: 'R', samples: 600, accSd: 0 });
    expect(row.zero.heel).toBe(0.5);
  });
});
