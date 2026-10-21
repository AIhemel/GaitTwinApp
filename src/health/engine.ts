import RNFS from 'react-native-fs';
import { GaitSample, GaitStream, Stride } from './gait';
import { BottleSample } from './bottle';
import { PoseEvent } from './posture';
import { TEMP_WARMUP_MS } from './environment';
import { FitRowLite, buildHeartData, parseFitCsv } from './heart';
import { DayInputs, DaySummary, EnvMinute, MINUTE_HEADER, computeDay } from './daySummary';
import { DAILY_DIR, appendDaily, dailyDir, localDate } from '../services/DailyStore';
import { GAITTWIN_DIR } from '../services/SessionWriter';
import { readJson, writeJsonAtomic, writeTextAtomic } from '../services/SessionMeta';
import { LABELS_FILE } from '../services/Labels.constants';
import { ResolvedRule, hydrationTargetMl, resolveRule, useAlertRulesStore } from '../store/AlertRulesStore';
import { RULE_DEFS } from '../config/alertRules';
import { RuleInputs, evaluateRules } from './rules';
import { deliverAlert } from './notify';
import { sessionWriter } from '../services/SessionWriter';
import { useHealthStore } from '../store/HealthStore';

// The on-phone analysis engine. Receives every live stream from the orchestrator (whether or not a
// session is recording), keeps today's state, and every 5 min recomputes the day:
//   Downloads/GaitTwin/daily/YYYY-MM-DD/
//     daily_summary.json   what the Today tab shows
//     minute_summary.csv   one row per minute, the pipeline's minute_table layout
//     strides_R.csv / strides_L.csv   every detected stride (appended as detected)
//     bottle.csv           live bottle samples (appended each minute)
//     engine_state.json    the rest of today's state, so an app restart loses nothing
//     labels.csv, alerts.csv (written by Labels / notify)

const MIN = 60000;
const COMPUTE_EVERY_MS = 5 * MIN;
const STRIDE_COLS: (keyof Stride)[] = [
  'hs_ms', 'stride_s', 'stance_pct', 'stance_s', 'swing_s', 'stance_imu_pct', 'stance_imu_s', 'swing_imu_s', 'pushoff_pct',
  'tilt_range_deg', 'pitch_range_deg', 'peak_acc_ms2', 'heel_share', 'met1_share', 'met5_share', 'hs_imu_ms', 'to_imu_ms', 'to_fsr_ms', 'bout',
];
const STRIDE_HEADER = STRIDE_COLS.join(',');
const BOTTLE_HEADER = 't,fused_ml,weight_g,cap_ml';
const FIT_DIR = `${GAITTWIN_DIR}/FitData`;

const dayStartOf = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const minuteOf = (ms: number) => ms - (ms % MIN);
const emptyEnvMinute = (): EnvMinute => ({ co2: [0, 0], temp: [0, 0], rh: [0, 0], pm25: [0, 0], pm10: [0, 0], dbaEnergy: [0, 0], warmup: false });
const addTo = (p: [number, number], v: number | null) => { if (v !== null && Number.isFinite(v)) { p[0] += v; p[1]++; } };

const readCsvRows = async (path: string): Promise<string[][]> => {
  if (!(await RNFS.exists(path))) return [];
  const lines = (await RNFS.readFile(path, 'utf8')).trim().split('\n');
  return lines.slice(1).filter((l) => l.trim()).map((l) => l.split(','));
};

export interface EnvReading { co2: number | null; temperature: number | null; humidity: number | null; pm1: number; pm25: number; pm10: number; dba: number | null }

export class HealthEngine {
  private date = localDate();
  private dayStart = dayStartOf(Date.now());
  private strides: { R: Stride[]; L: Stride[] } = { R: [], L: [] };
  private gaitMinutes = { R: new Set<number>(), L: new Set<number>() };
  private gatedMin = { R: 0, L: 0 };
  private env = new Map<number, EnvMinute>();
  private envConnectedAt: number | null = null;
  private bottle: BottleSample[] = [];
  private bottlePending: string[] = [];
  private poseEvents: PoseEvent[] = [];
  private postureWindows: [number, number | null][] = [];
  private labels: { t: number; label: string; note: string }[] = [];
  private gps = new Map<number, [number, number]>();
  private fitRows: FitRowLite[] = [];
  private streams = {
    R: new GaitStream((r) => this.onStrideWindow('R', r.strides, r.gate.gated, r.fromMs, r.toMs)),
    L: new GaitStream((r) => this.onStrideWindow('L', r.strides, r.gate.gated, r.fromMs, r.toMs)),
  };
  private started = false;
  private minuteTimer: ReturnType<typeof setInterval> | null = null;
  private lastCompute = 0;
  private lastSummary: DaySummary | null = null;
  private gaitAlertedWalks = new Set<string>(); // GA-1 targets alerted today (warning after N walks)
  private ruleTimer: ReturnType<typeof setTimeout> | null = null;

  async start() {
    if (this.started) return;
    this.started = true;
    await this.loadDay(this.date);
    await this.compute();
    this.minuteTimer = setInterval(() => { this.tick().catch((e) => console.warn('Health engine tick failed:', e)); }, MIN);
  }

  stop() {
    if (this.minuteTimer) clearInterval(this.minuteTimer);
    if (this.ruleTimer) clearTimeout(this.ruleTimer);
    this.minuteTimer = null;
    this.ruleTimer = null;
    this.started = false;
  }

  // Runs the minute tick now (tests; the timer does this every minute).
  runTick() {
    return this.tick();
  }

  // ---- live inputs (all cheap; heavy work happens in tick/compute) ----

  onGait(side: 'R' | 'L', s: GaitSample) {
    this.gaitMinutes[side].add(minuteOf(s.t));
    this.streams[side].push(s);
  }

  onEnvironment(t: number, e: EnvReading) {
    const m = minuteOf(t);
    const em = this.env.get(m) ?? emptyEnvMinute();
    addTo(em.co2, e.co2);
    addTo(em.temp, e.temperature);
    addTo(em.rh, e.humidity);
    // PM reads 0 on all three channels when the PMS5003 sent no frame in the window: missing, not clean air
    if (!(e.pm1 === 0 && e.pm25 === 0 && e.pm10 === 0)) { addTo(em.pm25, e.pm25); addTo(em.pm10, e.pm10); }
    if (e.dba !== null) addTo(em.dbaEnergy, 10 ** (e.dba / 10));
    if (this.envConnectedAt !== null && t - this.envConnectedAt < TEMP_WARMUP_MS) em.warmup = true;
    this.env.set(m, em);
  }

  onBottle(t: number, fused: number, weight: number, cap: number) {
    const c = cap >= 499.5 ? null : cap; // 500 mL is the capacitive sensor's invalid value
    this.bottle.push({ t, fused, weight, cap: c });
    this.bottlePending.push(`${t},${fused.toFixed(2)},${weight.toFixed(2)},${c === null ? '' : c.toFixed(2)}`);
  }

  onPosture(utcMs: number | null, pose: string, replayed: boolean) {
    this.poseEvents.push({ utcMs, pose, replayed });
  }

  onConnection(nodeId: string, connected: boolean, t: number) {
    if (nodeId === 'POSTURE') {
      const last = this.postureWindows[this.postureWindows.length - 1];
      if (connected && !(last && last[1] === null)) this.postureWindows.push([t, null]);
      if (!connected && last && last[1] === null) last[1] = t;
    }
    if (nodeId === 'ENVIRONMENT' && connected) this.envConnectedAt = t;
    // a disconnected foot: analyse what's buffered now rather than waiting for its next packet
    if (!connected && nodeId === 'GAIT') this.streams.R.flush();
    if (!connected && nodeId === 'GAIT_LEFT') this.streams.L.flush();
  }

  onLabel(t: number, label: string, note: string) {
    this.labels.push({ t, label, note });
  }

  onGps(t: number, speed: number | null) {
    if (speed === null || !Number.isFinite(speed)) return;
    const m = minuteOf(t);
    const g = this.gps.get(m) ?? [0, 0];
    this.gps.set(m, [g[0] + speed, g[1] + 1]);
  }

  onFitRows(rows: FitRowLite[]) {
    const keep = this.dayStart - 24 * 3600000; // yesterday evening's sleep belongs to today's night
    this.fitRows.push(...rows.filter((r) => Date.parse(r.end) >= keep));
    // heart rate / SpO2 arrive in batches with each Health Connect sync: check the heart rules right
    // away rather than at the next minute tick (debounced: one sync writes several batches)
    if (this.started && !this.ruleTimer) {
      this.ruleTimer = setTimeout(() => {
        this.ruleTimer = null;
        this.runRules().catch((e) => console.warn('Alert rules failed:', e));
      }, 3000);
    }
  }

  private onStrideWindow(side: 'R' | 'L', strides: Stride[], gated: boolean, fromMs: number, toMs: number) {
    if (gated) {
      const a = Math.max(fromMs, this.dayStart);
      if (toMs > a) this.gatedMin[side] += (toMs - a) / MIN;
    }
    for (const s of strides) {
      const row = STRIDE_COLS.map((c) => (Number.isFinite(s[c]) ? String(+(s[c] as number).toFixed(4)) : '')).join(',');
      appendDaily(`strides_${side}.csv`, STRIDE_HEADER, row, s.hs_ms).catch(() => {});
      if (s.hs_ms >= this.dayStart) this.strides[side].push(s);
    }
  }

  // ---- periodic work ----

  private async tick() {
    const now = Date.now();
    if (this.bottlePending.length) {
      const rows = this.bottlePending;
      this.bottlePending = [];
      await appendDaily('bottle.csv', BOTTLE_HEADER, rows.join('\n'), now).catch(() => {});
    }
    if (localDate(now) !== this.date) {
      await this.compute(); // close the finished day with everything it got
      this.resetForDay(now);
    }
    if (now - this.lastCompute >= COMPUTE_EVERY_MS) await this.compute();
    await this.runRules(now);
  }

  // What the alert rules look at right now (cheap: no full-day recomputation).
  ruleInputs(now: number = Date.now()): RuleInputs {
    const dayEnd = this.dayStart + 24 * 3600000;
    const heart = buildHeartData(this.fitRows, this.dayStart, dayEnd);
    const wakeAt = heart.sleep && heart.sleep.end > this.dayStart && heart.sleep.end < dayEnd ? heart.sleep.end : this.dayStart + 7 * 3600000;
    // bottle drinks come from the last 5-min summary (plateau detection over the whole day); taps are live
    const bottleDrinks = (this.lastSummary?.date === this.date ? this.lastSummary.hydration.drinks : [])
      .filter((d) => d.source === 'bottle').map((d) => ({ t: d.t, ml: d.ml }));
    const taps = this.labels.filter((l) => l.label === 'drink' && !bottleDrinks.some((d) => Math.abs(d.t - l.t) <= 10 * MIN))
      .map((l) => ({ t: l.t, ml: null }));
    const open = [...this.postureWindows].reverse().find((w) => w[1] === null) ?? null;
    const pose = open ? this.poseEvents.filter((e) => !e.replayed && e.utcMs !== null && (e.utcMs as number) >= open[0] - 15000).pop() : undefined;
    return {
      now,
      env: [...this.env.entries()].filter(([m]) => m >= now - 120 * MIN),
      heart,
      strides: this.strides,
      labels: this.labels,
      drinks: [...bottleDrinks, ...taps].sort((a, b) => a.t - b.t),
      hydrationTracked: this.bottle.length > 0 || taps.length > 0 || bottleDrinks.length > 0,
      totalMl: bottleDrinks.length ? bottleDrinks.reduce((a, d) => a + (d.ml ?? 0), 0) : this.bottle.length ? 0 : null,
      targetMl: hydrationTargetMl(),
      wakeAt,
      posture: { windowStart: open ? open[0] : null, pose: pose?.pose ?? null, poseOnset: pose ? (pose.utcMs as number) - 10000 : null },
      gaitWalksAlertedToday: this.gaitAlertedWalks.size,
      date: this.date,
    };
  }

  async runRules(now: number = Date.now()) {
    const resolved: Record<string, ResolvedRule> = {};
    for (const d of RULE_DEFS) if (d.id !== 'DQ-1') resolved[d.id] = resolveRule(d.id); // DQ-1 runs in the orchestrator
    for (const f of evaluateRules(this.ruleInputs(now), resolved)) {
      const rule = resolved[f.ruleId];
      const res = await deliverAlert({
        ruleId: f.ruleId, target: f.target, severity: f.severity ?? rule.severity, cooldownMin: rule.cooldownMin,
        title: f.title, body: f.body, values: f.values, params: rule.params,
      }, now);
      if (res.reason === 'cooldown' || res.reason === 'snoozed') continue;
      if (f.ruleId === 'GA-1') this.gaitAlertedWalks.add(f.target);
      sessionWriter.append('events', `${now},APP,alert_${f.ruleId},,${now},alert_id=${res.id};delivered=${res.delivered ? 1 : 0}${res.reason ? `;suppressed=${res.reason}` : ''}`);
    }
  }

  private resetForDay(now: number) {
    const open = this.postureWindows.find((w) => w[1] === null);
    this.date = localDate(now);
    this.dayStart = dayStartOf(now);
    this.strides = { R: [], L: [] };
    this.gaitMinutes = { R: new Set(), L: new Set() };
    this.gatedMin = { R: 0, L: 0 };
    this.env = new Map();
    this.bottle = [];
    // A pose held across midnight continues: it counts from 00:00 in the new day (its commit time is
    // moved to 00:00 + the 10 s commit delay, so the segment starts exactly at midnight).
    const held = this.poseEvents.filter((e) => !e.replayed && e.utcMs !== null).pop();
    this.poseEvents = held && open ? [{ ...held, utcMs: this.dayStart + 10000 }] : [];
    this.postureWindows = open ? [[this.dayStart, null]] : [];
    this.labels = [];
    this.gps = new Map();
    this.gaitAlertedWalks = new Set();
    this.fitRows = this.fitRows.filter((r) => Date.parse(r.end) >= this.dayStart - 24 * 3600000);
  }

  private inputs(now: number, previousDays: DayInputs['previousDays']): DayInputs {
    const { analysis } = useAlertRulesStore.getState();
    const dayEnd = this.dayStart + 24 * 3600000;
    return {
      date: this.date, dayStart: this.dayStart, dayEnd, now,
      strides: this.strides,
      gaitMinutes: { R: [...this.gaitMinutes.R], L: [...this.gaitMinutes.L] },
      gaitGatedMin: { R: Math.round(this.gatedMin.R), L: Math.round(this.gatedMin.L) },
      env: [...this.env.entries()],
      bottle: this.bottle,
      poseEvents: this.poseEvents,
      postureWindows: this.postureWindows,
      labels: this.labels,
      gps: [...this.gps.entries()],
      heart: buildHeartData(this.fitRows, this.dayStart, dayEnd),
      settings: { tempOffsetC: analysis.tempOffsetC, leanForwardIsUpright: analysis.leanForwardIsUpright, targetMl: hydrationTargetMl() },
      previousDays,
    };
  }

  // Recompute today, write the outputs, publish to the Today tab.
  async compute(): Promise<DaySummary> {
    const now = Date.now();
    this.lastCompute = now;
    const previousDays = await this.previousWater(2);
    const { summary, minuteRows } = computeDay(this.inputs(now, previousDays));
    const dir = dailyDir(this.dayStart);
    try {
      if (!(await RNFS.exists(dir))) await RNFS.mkdir(dir);
      await writeJsonAtomic(`${dir}/daily_summary.json`, summary);
      await writeTextAtomic(`${dir}/minute_summary.csv`, [MINUTE_HEADER, ...minuteRows].join('\n') + '\n');
      await writeJsonAtomic(`${dir}/engine_state.json`, this.snapshot());
    } catch (e) {
      console.warn('Daily summary write failed:', e);
    }
    this.lastSummary = summary;
    useHealthStore.getState().setToday(summary);
    return summary;
  }

  private snapshot() {
    return {
      date: this.date,
      savedAt: Date.now(),
      env: [...this.env.entries()],
      envConnectedAt: this.envConnectedAt,
      poseEvents: this.poseEvents,
      postureWindows: this.postureWindows,
      gps: [...this.gps.entries()],
      gaitMinutes: { R: [...this.gaitMinutes.R], L: [...this.gaitMinutes.L] },
      gatedMin: this.gatedMin,
      gaitAlertedWalks: [...this.gaitAlertedWalks],
    };
  }

  // Restores today after an app restart from what was written to disk.
  private async loadDay(date: string) {
    const dir = `${DAILY_DIR}/${date}`;
    const st = await readJson(`${dir}/engine_state.json`);
    if (st && st.date === date) {
      this.env = new Map(st.env);
      this.envConnectedAt = st.envConnectedAt ?? null;
      this.poseEvents = st.poseEvents ?? [];
      // A window still open at the last save lasted at least until then; the app can't know more (it
      // may have died right after). A cushion still connected opens a new window when it reconnects.
      const savedAt = st.savedAt ?? Date.now();
      this.postureWindows = (st.postureWindows ?? []).map(([a, b]: [number, number | null]) => [a, b ?? Math.max(a, savedAt)] as [number, number]);
      this.gps = new Map(st.gps);
      this.gaitMinutes = { R: new Set(st.gaitMinutes?.R ?? []), L: new Set(st.gaitMinutes?.L ?? []) };
      this.gatedMin = st.gatedMin ?? { R: 0, L: 0 };
      this.gaitAlertedWalks = new Set(st.gaitAlertedWalks ?? []);
    }
    for (const side of ['R', 'L'] as const) {
      this.strides[side] = (await readCsvRows(`${dir}/strides_${side}.csv`)).map((f) => {
        const s = {} as Record<string, number>;
        STRIDE_COLS.forEach((c, i) => { s[c] = f[i] === '' || f[i] === undefined ? NaN : Number(f[i]); });
        return s as unknown as Stride;
      });
    }
    this.bottle = (await readCsvRows(`${dir}/bottle.csv`)).map((f) => ({
      t: Number(f[0]), fused: Number(f[1]), weight: Number(f[2]), cap: f[3] === '' ? null : Number(f[3]),
    }));
    this.labels = (await readCsvRows(`${dir}/${LABELS_FILE}`)).map((f) => ({ t: Number(f[0]), label: f[1], note: f.slice(2).join(',') }));
    // Health Connect rows: the sync only delivers new changes, so today's and yesterday's band data are
    // read back from the app's own Fit_YYYY-MM-DD.csv files.
    for (const d of [localDate(this.dayStart - 3600000), date]) {
      const path = `${FIT_DIR}/Fit_${d}.csv`;
      if (await RNFS.exists(path)) this.onFitRows(parseFitCsv(await RNFS.readFile(path, 'utf8')));
    }
  }

  private async previousWater(n: number) {
    const out: { date: string; waterMl: number | null }[] = [];
    for (let k = n; k >= 1; k--) {
      const d = localDate(this.dayStart - k * 24 * 3600000 + 3600000);
      const s = await readJson(`${DAILY_DIR}/${d}/daily_summary.json`);
      out.push({ date: d, waterMl: s?.hydration?.totalMl ?? null });
    }
    return out;
  }

  // Past days for the Today tab's day picker.
  async listDays(): Promise<string[]> {
    if (!(await RNFS.exists(DAILY_DIR))) return [];
    const entries = await RNFS.readDir(DAILY_DIR);
    return entries.filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name)).map((e) => e.name).sort().reverse();
  }

  async readDay(date: string): Promise<DaySummary | null> {
    if (date === this.date) return this.compute();
    return readJson(`${DAILY_DIR}/${date}/daily_summary.json`);
  }
}

export const healthEngine = new HealthEngine();
