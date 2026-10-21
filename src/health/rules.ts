import { Stride, steady } from './gait';
import { EnvMinute } from './daySummary';
import { HeartData } from './heart';
import { POOR_POSES } from './posture';
import { contextSpans, insoleStepsPerMinute, isCadenceLocked, isInactive } from './context';
import { Severity } from '../config/alertRules';
import type { ResolvedRule } from '../store/AlertRulesStore';

// The alert/reminder rules (handoff/docs/FEATURE_HEALTH_TWIN.md §4, defaults from thresholds.json).
// Pure: evaluated every minute (and after each Health Connect sync) on a snapshot of the live data.
// "Must persist for N minutes" is checked from the data itself (not from earlier ticks), so a restart
// doesn't reset it; repeats are limited by each rule's cooldown in notify.ts.
// Message rules: the measured value, the threshold or usual value, one concrete action, no diagnosis.

export interface RuleInputs {
  now: number;
  env: [number, EnvMinute][]; // recent environment minutes
  heart: HeartData;
  strides: { R: Stride[]; L: Stride[] };
  labels: { t: number; label: string }[];
  drinks: { t: number; ml: number | null }[]; // bottle drinks + drink taps, today
  hydrationTracked: boolean; // the bottle sent data today or a drink was tapped
  totalMl: number | null;
  targetMl: number;
  wakeAt: number;
  posture: { windowStart: number | null; pose: string | null; poseOnset: number | null };
  gaitWalksAlertedToday: number;
  date: string;
}

export interface Finding {
  ruleId: string;
  target: string; // cooldown key within the rule
  severity?: Severity; // overrides the rule's severity (GA-1 escalation)
  title: string;
  body: string;
  values: Record<string, number | string | null>;
}

const MIN = 60000;
const fmtMin = (m: number) => { const r = Math.round(m); return r < 60 ? `${r} min` : `${Math.floor(r / 60)} h${r % 60 ? ` ${r % 60} min` : ''}`; };
const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
const median = (x: number[]) => {
  const s = x.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
};

// ---------------------------------------------------------------- environment
// Mean of the per-minute values in the last `windowMin` minutes; needs at least half the minutes and a
// reading in the last 3 min (an old value from a node that has since gone quiet doesn't count).
const envMean = (inp: RuleInputs, windowMin: number, pick: (e: EnvMinute) => number | null, energy = false): number | null => {
  const from = inp.now - windowMin * MIN;
  const vals: number[] = [];
  let latest = 0;
  for (const [m, e] of inp.env) {
    if (m < from || m > inp.now) continue;
    const v = pick(e);
    if (v === null || !Number.isFinite(v)) continue;
    vals.push(v);
    latest = Math.max(latest, m);
  }
  if (vals.length < Math.ceil(windowMin / 2) || inp.now - latest > 3 * MIN) return null;
  return energy
    ? 10 * Math.log10(vals.reduce((s, v) => s + 10 ** (v / 10), 0) / vals.length)
    : vals.reduce((s, v) => s + v, 0) / vals.length;
};
const avg = (p: [number, number]) => (p[1] ? p[0] / p[1] : null);
const dbaOf = (e: EnvMinute) => (e.dbaEnergy[1] ? 10 * Math.log10(e.dbaEnergy[0] / e.dbaEnergy[1]) : null);

// A pair of rules on one variable (e.g. EN-1 / EN-2): only the higher one notifies when both apply.
const envPair = (
  inp: RuleInputs, R: Record<string, ResolvedRule>, low: string, high: string, key: 'pm25' | 'co2' | 'dba',
  pick: (e: EnvMinute) => number | null, text: (v: number, limit: number, high: boolean) => [string, string],
): Finding[] => {
  for (const [id, isHigh] of [[high, true], [low, false]] as [string, boolean][]) {
    const r = R[id];
    if (!r?.enabled) continue;
    const v = envMean(inp, r.params.windowMin, pick, key === 'dba');
    if (v !== null && v >= r.params[key]) {
      const [title, body] = text(v, r.params[key], isHigh);
      return [{ ruleId: id, target: key, title, body, values: { [`${key}_mean`]: +v.toFixed(1), window_min: r.params.windowMin } }];
    }
  }
  return [];
};

// ---------------------------------------------------------------- heart
const hrRule = (inp: RuleInputs, r: ResolvedRule | undefined, id: string, high: boolean): Finding | null => {
  if (!r?.enabled) return null;
  const { hrByMinute, stepsByMinute } = inp.heart;
  const latest = Math.max(0, ...hrByMinute.keys());
  if (!latest || inp.now - latest > r.params.maxAgeMin * MIN) return null;
  const steps = insoleStepsPerMinute(inp.strides);
  const spans = contextSpans(inp.labels, inp.now);
  const span = r.params.minutes;
  const vals: number[] = [];
  for (let m = latest - (span - 1) * MIN; m <= latest; m += MIN) {
    const hr = hrByMinute.get(m);
    if (hr === undefined) continue;
    if (isCadenceLocked(hrByMinute, steps, m)) return null; // the band was reading steps, not pulse
    if (high && !isInactive(stepsByMinute, steps, spans, m)) return null; // moving: high HR is expected
    vals.push(hr);
  }
  if (vals.length < Math.ceil(0.8 * span)) return null;
  const ok = high ? vals.every((v) => v >= r.params.bpm) : vals.every((v) => v < r.params.bpm);
  if (!ok) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const urgent = id === 'HR-2';
  return {
    ruleId: id, target: 'hr',
    title: high ? `Heart rate ${mean.toFixed(0)} bpm at rest` : `Heart rate low: ${mean.toFixed(0)} bpm`,
    body: high
      ? `Your heart rate has been about ${mean.toFixed(0)} bpm for ${span} min while you were not moving (limit ${r.params.bpm}). Sit down, breathe slowly and drink some water.${urgent ? ' If you feel unwell, seek help.' : ''}`
      : `Your heart rate has been about ${mean.toFixed(0)} bpm for ${span} min while awake (below ${r.params.bpm}). If you feel dizzy or faint, sit down and tell someone.`,
    values: { hr_mean: +mean.toFixed(1), minutes: vals.length, until: hhmm(latest) },
  };
};

const spo2Rule = (inp: RuleInputs, r: ResolvedRule | undefined): Finding | null => {
  if (!r?.enabled) return null;
  const recent = inp.heart.spo2.filter((x) => inp.now - x.t <= r.params.maxAgeMin * MIN && x.v < r.params.spo2);
  for (let i = 0; i + r.params.readings - 1 < recent.length; i++) {
    const group = recent.slice(i, i + r.params.readings);
    if (group[group.length - 1].t - group[0].t <= r.params.withinMin * MIN) {
      const lowest = Math.min(...group.map((x) => x.v));
      return {
        ruleId: 'SP-1', target: 'spo2',
        title: `Blood oxygen reading ${lowest.toFixed(0)} %`,
        body: `${group.length} SpO₂ readings below ${r.params.spo2} % (lowest ${lowest.toFixed(0)} %) by ${hhmm(group[group.length - 1].t)}. Check the band sits snugly and repeat the measurement while still; if it stays low or you feel short of breath, seek help.`,
        values: { spo2_min: lowest, readings: group.length },
      };
    }
  }
  return null;
};

// ---------------------------------------------------------------- gait
const SI_KEYS: [string, keyof Stride, string, (v: number) => string][] = [
  ['floorStance', 'stance_imu_pct', 'stance (time on the ground)', (v) => `${v.toFixed(1)} % of the stride`],
  ['floorSwing', 'swing_imu_s', 'swing time', (v) => `${v.toFixed(2)} s`],
  ['floorPushoff', 'pushoff_pct', 'push-off timing', (v) => `${v.toFixed(1)} % of the stride`],
  ['floorTilt', 'tilt_range_deg', 'foot tilt range', (v) => `${v.toFixed(0)}°`],
  ['floorStride', 'stride_s', 'stride time', (v) => `${v.toFixed(2)} s`],
];

export interface GaitWindow { start: number; end: number; si: Record<string, number | null>; med: Record<string, { R: number | null; L: number | null }> }

// Blocks of `windowStrides` steady right-foot strides, each compared with the left foot's steady strides
// in the same stretch of time (each foot's measures use only its own clock).
export const gaitWindows = (R: Stride[], L: Stride[], windowStrides: number): GaitWindow[] => {
  const rebout = (xs: Stride[]) => xs.map((s) => ({ ...s, bout: 0 })).map((s, i, arr) => {
    if (i > 0) s.bout = arr[i - 1].bout + ((s.hs_ms - arr[i - 1].hs_ms) / 1000 > 2.5 ? 1 : 0);
    return s;
  });
  // the first 5 strides of a walk are speeding up (thresholds.json gait_asymmetry.exclude)
  const sr = steady(rebout(R.slice(5)));
  const sl = steady(rebout(L.slice(5)));
  const out: GaitWindow[] = [];
  for (let k = 0; (k + 1) * windowStrides <= sr.length; k++) {
    const block = sr.slice(k * windowStrides, (k + 1) * windowStrides);
    const start = block[0].hs_ms;
    const end = block[block.length - 1].hs_ms + 1000 * block[block.length - 1].stride_s;
    const lb = sl.filter((s) => s.hs_ms >= start && s.hs_ms < end);
    if (lb.length < windowStrides / 2) continue; // left foot too sparse in this stretch
    const si: Record<string, number | null> = {};
    const med: Record<string, { R: number | null; L: number | null }> = {};
    for (const [key, col] of SI_KEYS) {
      const r = median(block.map((s) => s[col] as number));
      const l = median(lb.map((s) => s[col] as number));
      med[key] = { R: r, L: l };
      si[key] = r !== null && l !== null && r + l !== 0 ? (100 * (r - l)) / (0.5 * (r + l)) : null;
    }
    out.push({ start, end, si, med });
  }
  return out;
};

const gaitRule = (inp: RuleInputs, r: ResolvedRule | undefined): Finding | null => {
  if (!r?.enabled) return null;
  // the current (or just-finished) walk: strides of either foot with no pause over 60 s
  const all = [...inp.strides.R, ...inp.strides.L].sort((a, b) => a.hs_ms - b.hs_ms);
  if (!all.length || inp.now - all[all.length - 1].hs_ms > 5 * MIN) return null;
  let i = all.length - 1;
  while (i > 0 && all[i].hs_ms - all[i - 1].hs_ms <= 60000) i--;
  const walkStart = all[i].hs_ms;
  if ((all[all.length - 1].hs_ms - walkStart) / 1000 < r.params.minWalkS) return null;
  const R = inp.strides.R.filter((s) => s.hs_ms >= walkStart);
  const L = inp.strides.L.filter((s) => s.hs_ms >= walkStart);
  const wins = gaitWindows(R, L, r.params.windowStrides);
  const n = r.params.consecutiveWindows;
  if (wins.length < n) return null;
  const last = wins.slice(-n);
  for (const [key, , name, fmt] of SI_KEYS) {
    const floor = r.params[key];
    if (!last.every((w) => w.si[key] !== null && Math.abs(w.si[key] as number) > floor)) continue;
    const w = last[last.length - 1];
    const v = w.si[key] as number;
    const escalate = inp.gaitWalksAlertedToday + 1 >= r.params.walksForWarning;
    return {
      ruleId: 'GA-1', target: `walk:${walkStart}`, severity: escalate ? 'warning' : undefined,
      title: 'Your steps are uneven',
      body: `Right ${name} ${fmt(w.med[key].R as number)}, left ${fmt(w.med[key].L as number)}: ${Math.abs(v).toFixed(0)} % apart for the last ${n} blocks of ${r.params.windowStrides} strides (limit ±${floor} %). Check both shoes and insoles sit comfortably${escalate ? `; this is walk ${inp.gaitWalksAlertedToday + 1} today with uneven steps` : ''}.`,
      values: { measure: key.replace('floor', '').toLowerCase(), si_pct: +v.toFixed(1), right: +(w.med[key].R as number).toFixed(3), left: +(w.med[key].L as number).toFixed(3), walk_start: hhmm(walkStart) },
    };
  }
  return null;
};

// ---------------------------------------------------------------- hydration
const hydrationRules = (inp: RuleInputs, R: Record<string, ResolvedRule>): Finding[] => {
  if (!inp.hydrationTracked || inp.now < inp.wakeAt) return [];
  const out: Finding[] = [];
  // Volumes come only from the bottle; tapped drinks have none. So the goal and pace rules need the
  // bottle (totalMl !== null), while the no-drink reminder also works from taps alone.
  const total = inp.totalMl ?? 0;
  const target = inp.targetMl;
  const volumeKnown = inp.totalMl !== null;
  const r3 = R['HY-3'];
  if (r3?.enabled && volumeKnown && total >= target) {
    out.push({ ruleId: 'HY-3', target: inp.date, title: 'Daily water goal reached', body: `${(total / 1000).toFixed(2)} L today — your target is ${(target / 1000).toFixed(1)} L. Well done.`, values: { total_ml: total, target_ml: target } });
    return out;
  }
  const r1 = R['HY-1'];
  if (r1?.enabled) {
    const lastDrink = Math.max(inp.wakeAt, ...inp.drinks.map((d) => d.t));
    const gapH = (inp.now - lastDrink) / 3600000;
    if (gapH >= r1.params.gapHours) {
      out.push({
        ruleId: 'HY-1', target: 'gap', title: `No water for ${fmtMin(gapH * 60)}`,
        body: `${lastDrink === inp.wakeAt ? 'No drink since you woke up' : `Last drink at ${hhmm(lastDrink)}`} — ${fmtMin(gapH * 60)} ago (reminder after ${r1.params.gapHours} h). Have a glass of water now.`,
        values: { gap_h: +gapH.toFixed(2), total_ml: total },
      });
    }
  }
  const r2 = R['HY-2'];
  if (r2?.enabled && volumeKnown) {
    const frac = Math.min(1, (inp.now - inp.wakeAt) / (r2.params.wakingHours * 3600000));
    const expected = target * frac;
    if (frac >= 0.15 && total < (r2.params.paceFraction / 100) * expected) {
      out.push({
        ruleId: 'HY-2', target: 'pace', title: 'Behind on water today',
        body: `You're at ${(total / 1000).toFixed(2)} L of ${(target / 1000).toFixed(1)} L by ${hhmm(inp.now)}; about ${(expected / 1000).toFixed(1)} L would be on pace. Drink a glass now and keep the bottle in reach.`,
        values: { total_ml: total, expected_ml: Math.round(expected), target_ml: target },
      });
    }
  }
  return out;
};

// ---------------------------------------------------------------- posture
const postureRules = (inp: RuleInputs, R: Record<string, ResolvedRule>): Finding[] => {
  const out: Finding[] = [];
  const { windowStart, pose, poseOnset } = inp.posture;
  if (windowStart === null) return out; // cushion asleep = seat empty
  const r1 = R['PO-1'];
  // LEAN_FORWARD is never counted as poor: for some users it is how the cushion reports upright sitting
  if (r1?.enabled && pose && poseOnset !== null && POOR_POSES.includes(pose)) {
    const min = (inp.now - Math.max(poseOnset, windowStart)) / MIN;
    if (min >= r1.params.minutes) {
      const name = pose.replace('LEAN_', 'leaning ').replace('SLOUCH', 'slouching').toLowerCase();
      out.push({
        ruleId: 'PO-1', target: `pose:${poseOnset}`, title: `${name[0].toUpperCase()}${name.slice(1)} for ${fmtMin(min)}`,
        body: `The cushion has read ${name} for ${fmtMin(min)} (reminder after ${r1.params.minutes} min). Sit back, feet flat, and straighten up.`,
        values: { pose, minutes: +min.toFixed(1) },
      });
    }
  }
  const r2 = R['PO-2'];
  if (r2?.enabled) {
    const min = (inp.now - windowStart) / MIN;
    if (min >= r2.params.minutes) {
      out.push({
        ruleId: 'PO-2', target: `sit:${windowStart}`, title: `Seated for ${fmtMin(min)}`,
        body: `You've been sitting since ${hhmm(windowStart)} (${fmtMin(min)}; reminder after ${r2.params.minutes} min). Stand up and move for 2-3 minutes.`,
        values: { minutes: +min.toFixed(1) },
      });
    }
  }
  return out;
};

export const evaluateRules = (inp: RuleInputs, R: Record<string, ResolvedRule>): Finding[] => {
  const out: Finding[] = [];
  out.push(...envPair(inp, R, 'EN-1', 'EN-2', 'pm25', (e) => avg(e.pm25), (v, lim, high) => [
    high ? `Hazardous air: PM2.5 ${v.toFixed(0)}` : `Very high particles: PM2.5 ${v.toFixed(0)}`,
    `PM2.5 has averaged ${v.toFixed(0)} µg/m³ over the last few minutes (alert level ${lim}). Move away from smoke or fumes, or ventilate the room.`,
  ]));
  out.push(...envPair(inp, R, 'EN-3', 'EN-3H', 'co2', (e) => avg(e.co2), (v, lim, high) => [
    high ? `Poor air: CO₂ ${v.toFixed(0)} ppm` : `Stuffy room: CO₂ ${v.toFixed(0)} ppm`,
    `CO₂ has averaged ${v.toFixed(0)} ppm (level ${lim}). Open a window or door for a few minutes.`,
  ]));
  out.push(...envPair(inp, R, 'EN-4', 'EN-4H', 'dba', dbaOf, (v, lim, high) => [
    high ? `Very loud: ${v.toFixed(0)} dBA` : `Loud: ${v.toFixed(0)} dBA`,
    `The sound level has averaged ${v.toFixed(0)} dBA (level ${lim}).${high ? ' Consider ear protection or a quieter place.' : ' A quieter spot would give your ears a rest.'}`,
  ]));
  const hr2 = hrRule(inp, R['HR-2'], 'HR-2', true);
  const hr1 = hr2 ? null : hrRule(inp, R['HR-1'], 'HR-1', true);
  const hr3 = hrRule(inp, R['HR-3'], 'HR-3', false);
  for (const f of [hr2, hr1, hr3, spo2Rule(inp, R['SP-1']), gaitRule(inp, R['GA-1'])]) if (f) out.push(f);
  out.push(...hydrationRules(inp, R));
  out.push(...postureRules(inp, R));
  return out;
};
