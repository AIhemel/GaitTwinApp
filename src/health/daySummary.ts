import { Stride, steady } from './gait';
import { BottleSample, bottleEvents } from './bottle';
import { PoseEvent, POOR_POSES, UPRIGHT_POSES, postureSegments } from './posture';
import { ENV_BANDS, ENV_VARS, EnvVar, POLLUTED_PM25, bandIndex } from './environment';
import { HeartData } from './heart';
import { contextAt as spanAt, contextSpans, insoleStepsPerMinute, isCadenceLocked, isInactive } from './context';

// Everything the Today tab shows for one day, computed from that day's inputs. Pure: the engine
// (engine.ts) collects the inputs and stores the result; tests feed inputs directly.

export interface EnvMinute {
  co2: [number, number]; temp: [number, number]; rh: [number, number]; pm25: [number, number]; pm10: [number, number];
  dbaEnergy: [number, number]; // sum of 10^(dBA/10), count — sound is averaged as energy
  warmup: boolean; // within 30 min of the node connecting: temperature unreliable (self-heating)
}

export interface DayInputs {
  date: string; dayStart: number; dayEnd: number; now: number;
  strides: { R: Stride[]; L: Stride[] };
  gaitMinutes: { R: number[]; L: number[] }; // minutes in which insole packets arrived
  gaitGatedMin: { R: number; L: number }; // minutes the stride analysis rejected (stream too sparse)
  env: [number, EnvMinute][];
  bottle: BottleSample[];
  poseEvents: PoseEvent[];
  postureWindows: [number, number | null][]; // cushion connected (= seat occupied); null end = still
  labels: { t: number; label: string; note: string }[];
  gps: [number, [number, number]][];
  heart: HeartData;
  settings: { tempOffsetC: number; leanForwardIsUpright: boolean; targetMl: number };
  previousDays: { date: string; waterMl: number | null }[];
}

export interface EnvVarSummary {
  mean: number | null; min: number | null; max: number | null; maxAt: number | null;
  minutes: number; bandMinutes: number[]; bins: (number | null)[]; // 288 five-minute bins
}

export interface WalkSummary {
  start: number; end: number; steps: number; cadence: number | null; strideS: number | null;
  feet: Record<'R' | 'L', null | { strides: number; stanceImuPct: number; swingImuS: number; pushoffPct: number | null; tiltRangeDeg: number; strideS: number }>;
  si: Record<string, number | null>; // symmetry index, % (R vs L)
  uneven: string[]; // measures beyond the absolute floor
  feedback: string;
}

export interface DaySummary {
  date: string; generatedAt: number;
  coverage: Record<'gaitR' | 'gaitL' | 'environment' | 'posture' | 'bottle' | 'heartRate' | 'gps', number>;
  environment: { vars: Record<EnvVar, EnvVarSummary>; pollutedMin: number; tempOffsetC: number; warmupMin: number };
  gait: { stepsInsole: number; walkingMin: number; strides: { R: number; L: number }; gatedMin: { R: number; L: number }; walks: WalkSummary[] };
  hydration: { totalMl: number | null; drinks: { t: number; ml: number | null; source: 'bottle' | 'tap' }[]; longestGapMin: number | null; targetMl: number; pacePct: number | null; history: { date: string; waterMl: number | null }[]; verdict: string };
  posture: { monitoredMin: number; byPose: Record<string, number>; uprightMin: number; poorMin: number; longestSitMin: number; uprightPct: number | null } | null;
  heart: { awakeMeanHr: number | null; maxHr: number | null; maxHrAt: number | null; restingHighMin: number; sleepMeanHr: number | null; minSpo2: number | null; minSpo2At: number | null; spo2Readings: number; hrMinutes: number; cadenceLockMin: number };
  sleep: { asleepMin: number; inBedMin: number; start: number; end: number; stageMin: Record<string, number> } | null;
  insights: string[];
}

export const MINUTE_HEADER = 'minute,hr,steps_band,steps_insole,stride_time_s,stance_pct,co2_ppm,temp_c,rh_pct,pm25,pm10,dba,gps_speed_mps,posture,sleep_stage,water_ml,hr_cadence_lock,event,context';

// Symmetry index floors (thresholds.json gait_asymmetry.metrics.*.abs_floor_pct)
export const SI_FLOORS: Record<string, number> = { stanceImuPct: 5, swingImuS: 10, pushoffPct: 5, tiltRangeDeg: 15, strideS: 3 };
const SI_NAMES: Record<string, string> = { stanceImuPct: 'stance (time on the ground)', swingImuS: 'swing time', pushoffPct: 'push-off timing', tiltRangeDeg: 'foot tilt range', strideS: 'stride time' };
const SI_FMT: Record<string, (v: number) => string> = {
  stanceImuPct: (v) => `${v.toFixed(1)} % of the stride`, swingImuS: (v) => `${v.toFixed(2)} s`,
  pushoffPct: (v) => `${v.toFixed(1)} % of the stride`, tiltRangeDeg: (v) => `${v.toFixed(0)}°`, strideS: (v) => `${v.toFixed(2)} s`,
};

const MIN = 60000;
const mean = (x: number[]) => (x.length ? x.reduce((s, v) => s + v, 0) / x.length : null);
const med = (x: number[]) => {
  const s = x.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
};
const avg = (p: [number, number]) => (p[1] ? p[0] / p[1] : null);
const hhmm = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
export const fmtDuration = (min: number) => {
  const m = Math.round(min);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`;
};
const si = (r: number | null, l: number | null) => (r === null || l === null || r + l === 0 ? null : (100 * (r - l)) / (0.5 * (r + l)));

const envValue = (m: EnvMinute, v: EnvVar, tempOffset: number): number | null => {
  if (v === 'pm25') return avg(m.pm25);
  if (v === 'co2') return avg(m.co2);
  if (v === 'dba') return m.dbaEnergy[1] ? 10 * Math.log10(m.dbaEnergy[0] / m.dbaEnergy[1]) : null;
  const t = avg(m.temp);
  return t === null || m.warmup ? null : t + tempOffset;
};

const summariseEnv = (inp: DayInputs) => {
  const vars = {} as Record<EnvVar, EnvVarSummary>;
  for (const v of ENV_VARS) {
    const vals: [number, number][] = [];
    for (const [m, e] of inp.env) {
      const x = envValue(e, v, inp.settings.tempOffsetC);
      if (x !== null && Number.isFinite(x)) vals.push([m, x]);
    }
    const bandMinutes = ENV_BANDS[v].bands.map(() => 0);
    const binAcc: [number, number][] = Array.from({ length: 288 }, () => [0, 0]);
    let maxAt: number | null = null, max: number | null = null, min: number | null = null;
    for (const [m, x] of vals) {
      bandMinutes[bandIndex(v, x)]++;
      if (max === null || x > max) { max = x; maxAt = m; }
      if (min === null || x < min) min = x;
      const bin = Math.floor((m - inp.dayStart) / (5 * MIN));
      if (bin >= 0 && bin < 288) {
        binAcc[bin][0] += v === 'dba' ? 10 ** (x / 10) : x;
        binAcc[bin][1]++;
      }
    }
    vars[v] = {
      mean: v === 'dba'
        ? (vals.length ? 10 * Math.log10(vals.reduce((s, [, x]) => s + 10 ** (x / 10), 0) / vals.length) : null)
        : mean(vals.map(([, x]) => x)),
      min, max, maxAt, minutes: vals.length, bandMinutes,
      bins: binAcc.map(([s, n]) => (n ? (v === 'dba' ? 10 * Math.log10(s / n) : s / n) : null)),
    };
  }
  return {
    vars,
    pollutedMin: inp.env.filter(([, e]) => (avg(e.pm25) ?? 0) > POLLUTED_PM25).length,
    tempOffsetC: inp.settings.tempOffsetC,
    warmupMin: inp.env.filter(([, e]) => e.warmup).length,
  };
};

const footStats = (strides: Stride[]) => {
  const s = steady(strides);
  if (s.length < 10) return null;
  return {
    strides: strides.length,
    stanceImuPct: med(s.map((x) => x.stance_imu_pct)) as number,
    swingImuS: med(s.map((x) => x.swing_imu_s)) as number,
    pushoffPct: med(s.map((x) => x.pushoff_pct)),
    tiltRangeDeg: med(s.map((x) => x.tilt_range_deg)) as number,
    strideS: med(s.map((x) => x.stride_s)) as number,
  };
};

// Walks: strides of either foot, split where nothing was detected for > 60 s; at least 20 strides.
const summariseWalks = (R: Stride[], L: Stride[]): WalkSummary[] => {
  const all = [...R.map((s) => ({ s, f: 'R' as const })), ...L.map((s) => ({ s, f: 'L' as const }))].sort((a, b) => a.s.hs_ms - b.s.hs_ms);
  const groups: typeof all[] = [];
  for (const x of all) {
    const g = groups[groups.length - 1];
    if (g && x.s.hs_ms - g[g.length - 1].s.hs_ms <= 60000) g.push(x); else groups.push([x]);
  }
  return groups.filter((g) => g.length >= 20).map((g) => {
    // per-foot bouts are renumbered inside the walk (strides come from separate live windows)
    const rebout = (xs: Stride[]) => xs.map((s) => ({ ...s, bout: 0 })).map((s, i, arr) => {
      if (i > 0) s.bout = arr[i - 1].bout + ((s.hs_ms - arr[i - 1].hs_ms) / 1000 > 2.5 ? 1 : 0);
      return s;
    });
    const r = rebout(g.filter((x) => x.f === 'R').map((x) => x.s));
    const l = rebout(g.filter((x) => x.f === 'L').map((x) => x.s));
    const feet = { R: footStats(r), L: footStats(l) };
    const strideS = med([...r, ...l].map((s) => s.stride_s));
    const sis: Record<string, number | null> = {};
    const uneven: string[] = [];
    for (const k of Object.keys(SI_FLOORS)) {
      const v = feet.R && feet.L ? si((feet.R as any)[k], (feet.L as any)[k]) : null;
      sis[k] = v;
      if (v !== null && Math.abs(v) > SI_FLOORS[k]) uneven.push(k);
    }
    const steps = 2 * Math.max(r.length, l.length);
    let feedback: string;
    if (!feet.R || !feet.L) {
      const missing = !feet.R && !feet.L ? 'either insole' : !feet.R ? 'the right insole' : 'the left insole';
      feedback = `Not enough steady walking from ${missing} for a left/right comparison.`;
    } else if (uneven.length) {
      const k = uneven.sort((a, b) => Math.abs(sis[b] as number) / SI_FLOORS[b] - Math.abs(sis[a] as number) / SI_FLOORS[a])[0];
      const v = sis[k] as number;
      const fmt = SI_FMT[k];
      feedback = `Uneven ${SI_NAMES[k]}: right ${fmt((feet.R as any)[k])}, left ${fmt((feet.L as any)[k])} — ${Math.abs(v).toFixed(0)} % apart (alert threshold ±${SI_FLOORS[k]} %).`;
    } else {
      feedback = `Left and right were even (stance ${feet.R.stanceImuPct.toFixed(0)} % vs ${feet.L.stanceImuPct.toFixed(0)} % of the stride).`;
    }
    return {
      start: g[0].s.hs_ms, end: g[g.length - 1].s.hs_ms + 1000 * g[g.length - 1].s.stride_s,
      steps, strideS, cadence: strideS ? 120 / strideS : null, feet, si: sis, uneven, feedback,
    };
  });
};

const summariseHydration = (inp: DayInputs, wakeAt: number) => {
  const { events } = bottleEvents(inp.bottle);
  const drinks: { t: number; ml: number | null; source: 'bottle' | 'tap' }[] = events
    .filter((e) => e.kind === 'removed').map((e) => ({ t: e.t, ml: -e.changeMl, source: 'bottle' as const }));
  // a tapped drink within 10 min of a bottle drink is the same drink
  for (const l of inp.labels.filter((x) => x.label === 'drink')) {
    if (!drinks.some((d) => d.source === 'bottle' && Math.abs(d.t - l.t) <= 10 * MIN)) drinks.push({ t: l.t, ml: null, source: 'tap' });
  }
  drinks.sort((a, b) => a.t - b.t);
  const hasData = inp.bottle.length > 0 || drinks.length > 0;
  const totalMl = hasData ? drinks.reduce((s, d) => s + (d.ml ?? 0), 0) : null;
  const end = Math.min(inp.now, inp.dayEnd);
  let longestGapMin: number | null = null;
  if (hasData) {
    const pts = [wakeAt, ...drinks.map((d) => d.t).filter((t) => t >= wakeAt), end];
    longestGapMin = Math.max(...pts.slice(1).map((t, i) => (t - pts[i]) / MIN));
  }
  // expected pace: target spread over a 16 h waking window (thresholds.json hydration.pace_check)
  const awakeFrac = Math.min(1, Math.max(0, (end - wakeAt) / (16 * 3600000)));
  const pacePct = totalMl !== null && awakeFrac > 0.05 ? (100 * totalMl) / (inp.settings.targetMl * awakeFrac) : null;
  const target = inp.settings.targetMl;
  let verdict: string;
  if (totalMl === null) verdict = 'No bottle data or drink taps today.';
  else if (totalMl >= target) verdict = `Enough water today (${(totalMl / 1000).toFixed(2)} L of ${(target / 1000).toFixed(1)} L).`;
  else if (inp.now < inp.dayEnd && pacePct !== null && pacePct >= 60) verdict = `On track: ${(totalMl / 1000).toFixed(2)} L so far of ${(target / 1000).toFixed(1)} L.`;
  else verdict = `Drink more: ${(totalMl / 1000).toFixed(2)} L of ${(target / 1000).toFixed(1)} L${inp.now < inp.dayEnd ? ' so far' : ''}.`;
  return { totalMl, drinks, longestGapMin, targetMl: target, pacePct, history: [...inp.previousDays, { date: inp.date, waterMl: totalMl }], verdict };
};

const summarisePosture = (inp: DayInputs) => {
  if (!inp.postureWindows.length) return null;
  const end = Math.min(inp.now, inp.dayEnd);
  const windows = inp.postureWindows.map(([a, b]) => [Math.max(a, inp.dayStart), Math.min(b ?? end, inp.dayEnd)] as [number, number]).filter(([a, b]) => b > a);
  const segs = postureSegments(inp.poseEvents, windows, inp.settings.leanForwardIsUpright ? { LEAN_FORWARD: 'UPRIGHT' } : {});
  const byPose: Record<string, number> = {};
  for (const s of segs) byPose[s.pose] = (byPose[s.pose] ?? 0) + (s.end - s.start) / MIN;
  const total = Object.values(byPose).reduce((a, b) => a + b, 0);
  const uprightMin = UPRIGHT_POSES.reduce((a, p) => a + (byPose[p] ?? 0), 0);
  return {
    monitoredMin: windows.reduce((a, [s, e]) => a + (e - s) / MIN, 0),
    byPose, uprightMin,
    poorMin: POOR_POSES.reduce((a, p) => a + (byPose[p] ?? 0), 0),
    longestSitMin: Math.max(0, ...windows.map(([s, e]) => (e - s) / MIN)),
    uprightPct: total > 0 ? (100 * uprightMin) / total : null,
  };
};

export const computeDay = (inp: DayInputs): { summary: DaySummary; minuteRows: string[] } => {
  const { heart } = inp;
  const sleepSpan = heart.sleep ? [heart.sleep.start, heart.sleep.end] : null;
  const inSleep = (m: number) => !!heart.sleep && heart.sleep.segments.some(([a, b]) => m >= a && m < b);
  const wakeAt = heart.sleep && heart.sleep.end > inp.dayStart && heart.sleep.end < inp.dayEnd ? heart.sleep.end : inp.dayStart + 7 * 3600000;

  // per-minute right-foot strides (stride time, stance columns), insole steps, user contexts
  const stridesPerMin = { R: new Map<number, Stride[]>(), L: new Map<number, Stride[]>() };
  for (const f of ['R', 'L'] as const) for (const s of inp.strides[f]) {
    const m = s.hs_ms - (s.hs_ms % MIN);
    stridesPerMin[f].set(m, [...(stridesPerMin[f].get(m) ?? []), s]);
  }
  const steps = insoleStepsPerMinute(inp.strides);
  const stepsInsole = (m: number) => steps.get(m) ?? null;
  const ctxSpans = contextSpans(inp.labels, inp.now);
  const ctxAt = (m: number) => spanAt(ctxSpans, m);
  const cadenceLock = (m: number) => isCadenceLocked(heart.hrByMinute, steps, m);

  // ---- heart
  const awakeHr: number[] = [], sleepHr: number[] = [];
  let maxHr: number | null = null, maxHrAt: number | null = null, restingHighMin = 0, lockMin = 0;
  for (const [m, hr] of heart.hrByMinute) {
    if (cadenceLock(m)) { lockMin++; continue; }
    if (inSleep(m)) { sleepHr.push(hr); continue; }
    awakeHr.push(hr);
    if (maxHr === null || hr > maxHr) { maxHr = hr; maxHrAt = m; }
    if (hr >= 120 && isInactive(heart.stepsByMinute, steps, ctxSpans, m)) restingHighMin++;
  }
  const spo2 = heart.spo2;
  const minSpo2 = spo2.length ? spo2.reduce((a, b) => (b.v < a.v ? b : a)) : null;

  const env = summariseEnv(inp);
  const walks = summariseWalks(inp.strides.R, inp.strides.L);
  const hydration = summariseHydration(inp, wakeAt);
  const posture = summarisePosture(inp);

  // ---- minute table (pipeline layout)
  const envMap = new Map(inp.env);
  const gpsMap = new Map(inp.gps);
  const segsByMinute = new Map<number, string>();
  if (posture) {
    const end = Math.min(inp.now, inp.dayEnd);
    const windows = inp.postureWindows.map(([a, b]) => [a, b ?? end] as [number, number]);
    for (const s of postureSegments(inp.poseEvents, windows, inp.settings.leanForwardIsUpright ? { LEAN_FORWARD: 'UPRIGHT' } : {})) {
      for (let m = s.start - (s.start % MIN); m < s.end; m += MIN) if (m + 30000 >= s.start && m + 30000 < s.end) segsByMinute.set(m, s.pose);
    }
  }
  const waterByMinute = new Map<number, number>();
  for (const d of hydration.drinks) if (d.ml !== null) { const m = d.t - (d.t % MIN); waterByMinute.set(m, (waterByMinute.get(m) ?? 0) + d.ml); }
  const eventAt = (m: number) => inp.labels.filter((l) => l.t >= m && l.t < m + MIN).map((l) => l.label).join(' ');
  const f = (x: number | null | undefined, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '' : x.toFixed(d));
  const minuteRows: string[] = [];
  const last = Math.min(inp.now, inp.dayEnd);
  for (let m = inp.dayStart; m < last; m += MIN) {
    const e = envMap.get(m);
    const r = stridesPerMin.R.get(m);
    const hr = heart.hrByMinute.get(m);
    const g = gpsMap.get(m);
    const row = [
      new Date(m).toISOString(), f(hr), f(heart.stepsByMinute.get(m), 0), f(stepsInsole(m), 0),
      f(r ? med(r.map((s) => s.stride_s)) : null, 3), f(r ? med(r.map((s) => s.stance_imu_pct)) : null, 1),
      f(e ? envValue(e, 'co2', 0) : null), f(e ? envValue(e, 'temp', inp.settings.tempOffsetC) : null, 2), f(e ? avg(e.rh) : null, 2),
      f(e ? envValue(e, 'pm25', 0) : null), f(e ? avg(e.pm10) : null), f(e ? envValue(e, 'dba', 0) : null),
      f(g ? g[0] / g[1] : null, 2), segsByMinute.get(m) ?? '', '',
      f(waterByMinute.get(m) ?? (hydration.totalMl !== null ? 0 : null), 0), cadenceLock(m) ? '1' : '0',
      eventAt(m), inSleep(m) ? 'sleep' : ctxAt(m) ?? (stepsInsole(m) ? 'walking' : segsByMinute.has(m) ? 'sitting' : hr !== undefined ? 'awake' : ''),
    ];
    minuteRows.push(row.join(','));
  }

  const coverage = {
    gaitR: inp.gaitMinutes.R.length, gaitL: inp.gaitMinutes.L.length, environment: inp.env.length,
    posture: Math.round(posture?.monitoredMin ?? 0),
    bottle: new Set(inp.bottle.map((b) => b.t - (b.t % MIN))).size,
    heartRate: heart.hrByMinute.size, gps: inp.gps.length,
  };

  // ---- insights: plain sentences from what was measured (no causal claims)
  const insights: string[] = [];
  const pm = env.vars.pm25;
  if (pm.minutes) {
    insights.push(env.pollutedMin
      ? `PM2.5 was in the unhealthy range (above 35 µg/m³) for ${fmtDuration(env.pollutedMin)}; highest ${pm.max?.toFixed(0)} µg/m³ at ${hhmm(pm.maxAt as number)}.`
      : `PM2.5 stayed at or below the moderate range all day (average ${pm.mean?.toFixed(0)} µg/m³).`);
  }
  const co2Stuffy = env.vars.co2.bandMinutes.slice(2).reduce((a, b) => a + b, 0);
  if (co2Stuffy >= 10) insights.push(`The air was stuffy (CO₂ above 1,000 ppm) for ${fmtDuration(co2Stuffy)}; peak ${env.vars.co2.max?.toFixed(0)} ppm at ${hhmm(env.vars.co2.maxAt as number)}.`);
  const loud = env.vars.dba.bandMinutes.slice(2).reduce((a, b) => a + b, 0);
  if (loud >= 15) insights.push(`It was loud (above 70 dBA) for ${fmtDuration(loud)}.`);
  if (hydration.totalMl !== null) insights.push(`${hydration.verdict}${hydration.longestGapMin !== null && hydration.longestGapMin >= 150 ? ` Longest stretch without a drink: ${fmtDuration(hydration.longestGapMin)}.` : ''}`);
  const unevenWalks = walks.filter((w) => w.uneven.length);
  if (walks.length) {
    insights.push(unevenWalks.length
      ? `${unevenWalks.length} of ${walks.length} walk${walks.length > 1 ? 's' : ''} had uneven steps. ${unevenWalks[0].feedback}`
      : `${walks.length} walk${walks.length > 1 ? 's' : ''} (${walks.reduce((a, w) => a + w.steps, 0)} steps); left and right were even.`);
  }
  if (posture && posture.monitoredMin >= 5) {
    insights.push(`Seated ${fmtDuration(posture.monitoredMin)}: upright ${fmtDuration(posture.uprightMin)}, slouched or leaning ${fmtDuration(posture.poorMin)}; longest sitting stretch ${fmtDuration(posture.longestSitMin)}.`);
  }
  if (restingHighMin) insights.push(`Heart rate was 120 bpm or more while not moving for ${fmtDuration(restingHighMin)}.`);
  if (minSpo2 && minSpo2.v < 95) insights.push(`Lowest SpO₂ reading: ${minSpo2.v.toFixed(0)} % at ${hhmm(minSpo2.t)}.`);

  const allStrides = [...inp.strides.R, ...inp.strides.L];
  return {
    summary: {
      date: inp.date, generatedAt: inp.now, coverage, environment: env,
      gait: {
        stepsInsole: [...new Set([...stridesPerMin.R.keys(), ...stridesPerMin.L.keys()])].reduce((a, m) => a + (stepsInsole(m) ?? 0), 0),
        walkingMin: allStrides.length ? new Set(allStrides.map((s) => s.hs_ms - (s.hs_ms % MIN))).size : 0,
        strides: { R: inp.strides.R.length, L: inp.strides.L.length }, gatedMin: inp.gaitGatedMin, walks,
      },
      hydration, posture,
      heart: {
        awakeMeanHr: mean(awakeHr), maxHr, maxHrAt, restingHighMin, sleepMeanHr: mean(sleepHr),
        minSpo2: minSpo2?.v ?? null, minSpo2At: minSpo2?.t ?? null, spo2Readings: spo2.length,
        hrMinutes: heart.hrByMinute.size, cadenceLockMin: lockMin,
      },
      sleep: heart.sleep && sleepSpan ? { asleepMin: heart.sleep.asleepMin, inBedMin: heart.sleep.inBedMin, start: sleepSpan[0], end: sleepSpan[1], stageMin: heart.sleep.stageMin } : null,
      insights,
    },
    minuteRows,
  };
};
