import type { AlertRow } from './history';
import { RULE_DEFS, RULE_DEFS_BY_ID } from '../config/alertRules';
import { percentile } from './signal';

// Thesis evaluation of the alerts (FEATURE_HEALTH_TWIN.md §7.6), from the daily alert logs and the
// user's answers. Pure: history.ts reads the days, this computes, evaluationExport.ts writes the files.
//
// Definitions (also written into the export):
//   answered       alerts the user rated Useful / Not useful / Wrong (notification button or Today tab)
//   precision      (useful + not useful) / answered: the alert was right about what happened, whether
//                  or not it helped; with a Wilson 95 % interval, since the counts are small
//   useful rate    useful / answered
//   false alarms   alerts rated Wrong, per monitored day; "worst case" also counts every unanswered
//                  alert as wrong, so the true rate lies between the two
//   repeat         an alert whose event was already going on when the same rule (same target) last
//                  alerted: the reminder after the cooldown, not a new event
//   delay          alert time - event due time (the earliest moment the rule's definition was met, on the
//                  data's own clock): sensor -> phone -> Health Connect sync -> minute tick. First alert
//                  of each event only, and only notified ones.
//   since onset    alert time - event onset (includes the duration each rule requires by design)
// Battery use is measured by hand, outside the app.

export interface EvalAlert extends AlertRow {
  date: string;
  repeat: boolean;
  delayS: number | null; // due -> alert
  sinceOnsetS: number | null; // onset -> alert
  responseDelayS: number | null; // alert -> the user's answer
}

export interface Spread { n: number; medianS: number | null; p90S: number | null; maxS: number | null }

export interface RuleEval {
  ruleId: string; name: string;
  logged: number; delivered: number; suppressed: Record<string, number>; repeats: number;
  answered: number; useful: number; notUseful: number; wrong: number; unanswered: number;
  precision: number | null; precisionCi: [number, number] | null; usefulRate: number | null;
  falseAlarmsPerDay: number | null; falseAlarmsPerDayWorst: number | null; deliveredPerDay: number | null;
  delay: Spread; sinceOnset: Spread; responseDelay: Spread;
}

export interface Evaluation {
  from: string | null; to: string | null;
  days: number; // monitored days in the period
  overall: RuleEval;
  rules: RuleEval[]; // rules with at least one alert, in the order of the rule list
  alerts: EvalAlert[];
  perDay: { date: string; logged: number; delivered: number; answered: number; wrong: number }[];
}

// Wilson score interval for a proportion k/n.
export const wilson = (k: number, n: number, z = 1.96): [number, number] | null => {
  if (!n) return null;
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
};

const spread = (xs: (number | null)[]): Spread => {
  const v = xs.filter((x): x is number => x !== null && Number.isFinite(x));
  return v.length
    ? { n: v.length, medianS: percentile(v, 50), p90S: percentile(v, 90), maxS: Math.max(...v) }
    : { n: 0, medianS: null, p90S: null, maxS: null };
};

const summarise = (ruleId: string, name: string, alerts: EvalAlert[], days: number): RuleEval => {
  const count = (f: (a: EvalAlert) => boolean) => alerts.filter(f).length;
  const useful = count((a) => a.response === 'useful');
  const notUseful = count((a) => a.response === 'not_useful');
  const wrong = count((a) => a.response === 'wrong');
  const answered = useful + notUseful + wrong;
  const suppressed: Record<string, number> = {};
  for (const a of alerts) if (!a.delivered) suppressed[a.reason || 'unknown'] = (suppressed[a.reason || 'unknown'] ?? 0) + 1;
  const firsts = alerts.filter((a) => a.delivered && !a.repeat);
  return {
    ruleId, name,
    logged: alerts.length, delivered: count((a) => a.delivered), suppressed, repeats: count((a) => a.repeat),
    answered, useful, notUseful, wrong, unanswered: alerts.length - answered,
    precision: answered ? (useful + notUseful) / answered : null,
    precisionCi: wilson(useful + notUseful, answered),
    usefulRate: answered ? useful / answered : null,
    falseAlarmsPerDay: days ? wrong / days : null,
    falseAlarmsPerDayWorst: days ? (wrong + alerts.length - answered) / days : null,
    deliveredPerDay: days ? count((a) => a.delivered) / days : null,
    delay: spread(firsts.map((a) => a.delayS)),
    sinceOnset: spread(firsts.map((a) => a.sinceOnsetS)),
    responseDelay: spread(alerts.map((a) => a.responseDelayS)),
  };
};

// days: each day's alerts (readAlerts); monitoredDates: the days the app was running in the period.
export const evaluate = (days: { date: string; alerts: AlertRow[] }[], monitoredDates: string[]): Evaluation => {
  const dates = [...new Set([...monitoredDates, ...days.filter((d) => d.alerts.length).map((d) => d.date)])].sort();
  const raw = days.flatMap((d) => d.alerts.map((a) => ({ ...a, date: d.date }))).sort((a, b) => a.t - b.t);
  const lastByKey = new Map<string, number>();
  const alerts: EvalAlert[] = raw.map((a) => {
    const key = `${a.rule}|${a.target}`;
    const prev = lastByKey.get(key);
    lastByKey.set(key, a.t);
    return {
      ...a,
      repeat: prev !== undefined && a.onsetMs !== null && prev >= a.onsetMs,
      delayS: a.dueMs === null ? null : (a.t - a.dueMs) / 1000,
      sinceOnsetS: a.onsetMs === null ? null : (a.t - a.onsetMs) / 1000,
      responseDelayS: a.respondedAt === null ? null : (a.respondedAt - a.t) / 1000,
    };
  });
  const n = dates.length;
  const order = RULE_DEFS.map((r) => r.id);
  const ruleIds = [...new Set(alerts.map((a) => a.rule))].sort((x, y) => {
    const i = order.indexOf(x), j = order.indexOf(y);
    return (i < 0 ? 999 : i) - (j < 0 ? 999 : j) || x.localeCompare(y);
  });
  return {
    from: dates[0] ?? null, to: dates[dates.length - 1] ?? null, days: n,
    overall: summarise('ALL', 'All alerts', alerts, n),
    rules: ruleIds.map((id) => summarise(id, RULE_DEFS_BY_ID[id]?.label ?? id, alerts.filter((a) => a.rule === id), n)),
    alerts,
    perDay: dates.map((date) => {
      const xs = alerts.filter((a) => a.date === date);
      return {
        date, logged: xs.length, delivered: xs.filter((a) => a.delivered).length,
        answered: xs.filter((a) => a.response).length, wrong: xs.filter((a) => a.response === 'wrong').length,
      };
    }),
  };
};
