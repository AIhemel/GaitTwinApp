import { percentile } from './signal';

// Insole pressure-sensor health, after the pipeline's sensor_health (daily_analysis.py). Every minute
// a foot streams, the engine stores per-sensor statistics in daily/<date>/fsr_minutes.csv; the Data
// tab rates each minute in which that foot was moving:
//   dropout:   no signal (95th percentile < 2), or a full-range signal that reads exactly 0 in more
//              than half of the samples (open circuit / loose solder joint)
//   low range: signal present but its 95th percentile below 10 % of the foot's strongest sensor
//              (e.g. a replacement sensor with a smaller output range)
// The pipeline takes "strongest" as the session-wide 95th percentile; here it is the median of the
// per-minute 95th percentiles over the day's moving minutes (the phone doesn't keep raw samples).

const MIN = 60000;
export const FSR_KEYS = ['heel', 'met1', 'met5'] as const;
export type FsrKey = typeof FSR_KEYS[number];
export const FSR_NAMES: Record<FsrKey, string> = { heel: 'Heel', met1: 'Met1 (big toe ball)', met5: 'Met5 (little toe ball)' };
export const MOVING_ACC_SD = 2.0; // m/s²: SD of |acceleration| within the minute above this = foot moving
export const FSR_FULL_SCALE = 4095; // 12-bit ADC maximum. Clipping here is expected and not a fault; the
// share of clipped samples is only kept in the file (sat columns) for the record.
export const FSR_FAULTY_FRACTION = 0.25; // thresholds.json data_quality.fsr_fault_fraction_of_minute

export interface FsrMinute {
  minute: number; side: 'R' | 'L'; samples: number; accSd: number;
  p95: Record<FsrKey, number>; zero: Record<FsrKey, number>; sat: Record<FsrKey, number>;
}

export const FSR_FILE = 'fsr_minutes.csv';
export const FSR_HEADER = `minute,side,samples,acc_sd,${FSR_KEYS.map((k) => `${k}_p95,${k}_zero,${k}_sat`).join(',')}`;

export const fsrRow = (m: FsrMinute) =>
  [m.minute, m.side, m.samples, m.accSd.toFixed(3), ...FSR_KEYS.flatMap((k) => [m.p95[k].toFixed(1), m.zero[k].toFixed(3), m.sat[k].toFixed(3)])].join(',');

export const parseFsrRow = (f: string[]): FsrMinute | null => {
  if (f.length < 4 + 3 * FSR_KEYS.length || (f[1] !== 'R' && f[1] !== 'L')) return null;
  const p95 = {} as Record<FsrKey, number>, zero = {} as Record<FsrKey, number>, sat = {} as Record<FsrKey, number>;
  FSR_KEYS.forEach((k, i) => { p95[k] = Number(f[4 + 3 * i]); zero[k] = Number(f[5 + 3 * i]); sat[k] = Number(f[6 + 3 * i]); });
  return { minute: Number(f[0]), side: f[1], samples: Number(f[2]), accSd: Number(f[3]), p95, zero, sat };
};

// Collects one foot's samples for the current minute and emits its statistics when the minute ends.
export class FsrMinuteAccumulator {
  private minute: number | null = null;
  private vals: Record<FsrKey, number[]> = { heel: [], met1: [], met5: [] };
  private accSum = 0;
  private accSq = 0;
  private n = 0;

  constructor(private readonly side: 'R' | 'L', private readonly onMinute: (m: FsrMinute) => void) {}

  push(t: number, heel: number, met1: number, met5: number, ax: number, ay: number, az: number) {
    const m = t - (t % MIN);
    if (this.minute !== null && m !== this.minute) this.close();
    this.minute = m;
    this.vals.heel.push(heel);
    this.vals.met1.push(met1);
    this.vals.met5.push(met5);
    const a = Math.hypot(ax, ay, az);
    this.accSum += a;
    this.accSq += a * a;
    this.n++;
  }

  // A foot that stopped streaming: close its last minute once that minute is over.
  closeIfStale(now: number) {
    if (this.minute !== null && now - this.minute >= 2 * MIN) this.close();
  }

  private close() {
    const n = this.n;
    if (this.minute !== null && n >= 2) {
      const p95 = {} as Record<FsrKey, number>, zero = {} as Record<FsrKey, number>, sat = {} as Record<FsrKey, number>;
      for (const k of FSR_KEYS) {
        const v = this.vals[k];
        p95[k] = percentile(v, 95);
        zero[k] = v.filter((x) => x === 0).length / v.length;
        sat[k] = v.filter((x) => x >= FSR_FULL_SCALE).length / v.length;
      }
      // sample SD (pandas std, ddof = 1)
      const accSd = Math.sqrt(Math.max(0, (this.accSq - (this.accSum * this.accSum) / n) / (n - 1)));
      this.onMinute({ minute: this.minute, side: this.side, samples: n, accSd, p95, zero, sat });
    }
    this.minute = null;
    this.vals = { heel: [], met1: [], met5: [] };
    this.accSum = 0;
    this.accSq = 0;
    this.n = 0;
  }
}

export type FsrStatus = 'ok' | 'low range' | 'dropout';

export const fsrStatus = (p95: number, zero: number, ref: number): FsrStatus =>
  p95 < 2 ? 'dropout' : p95 < 0.1 * ref ? 'low range' : zero > 0.5 ? 'dropout' : 'ok';

export interface FsrSensorHealth { ok: number; lowRange: number; dropout: number; faultyPct: number; clippedPct: number }
export interface FsrSideHealth { movingMin: number; ref: number; sensors: Record<FsrKey, FsrSensorHealth> }

const med = (x: number[]) => {
  const s = [...x].sort((a, b) => a - b);
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
};

// One foot's day: minutes per status for each sensor, over the minutes the foot was moving.
export const fsrHealth = (rows: FsrMinute[]): FsrSideHealth | null => {
  const moving = rows.filter((r) => r.accSd > MOVING_ACC_SD);
  if (!moving.length) return null;
  const ref = Math.max(...FSR_KEYS.map((k) => med(moving.map((r) => r.p95[k]))));
  const sensors = {} as Record<FsrKey, FsrSensorHealth>;
  for (const k of FSR_KEYS) {
    const h = { ok: 0, lowRange: 0, dropout: 0, faultyPct: 0, clippedPct: 0 };
    let sat = 0;
    for (const r of moving) {
      const st = fsrStatus(r.p95[k], r.zero[k], ref);
      if (st === 'ok') h.ok++; else if (st === 'low range') h.lowRange++; else h.dropout++;
      sat += r.sat[k];
    }
    h.faultyPct = (100 * (h.lowRange + h.dropout)) / moving.length;
    h.clippedPct = (100 * sat) / moving.length; // share of samples at full scale
    sensors[k] = h;
  }
  return { movingMin: moving.length, ref, sensors };
};
