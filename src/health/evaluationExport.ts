import RNFS from 'react-native-fs';
import { EvalAlert, Evaluation, RuleEval, evaluate } from './evaluation';
import { isAppDay, listDailyDates, readAlerts } from './history';
import { lastDates } from './trends';
import { GAITTWIN_DIR } from '../services/SessionWriter';
import { csvText, localDate } from '../services/DailyStore';
import { writeJsonAtomic, writeTextAtomic } from '../services/SessionMeta';
import pkg from '../../package.json';

// Loads the alert evaluation for a period and exports it for the thesis:
//   Downloads/GaitTwin/evaluation/alerts_evaluation.csv   one row per alert, with its answer and timing
//   Downloads/GaitTwin/evaluation/rules_evaluation.csv    one row per rule, plus "ALL"
//   Downloads/GaitTwin/evaluation/evaluation_summary.json the same numbers, the definitions, per-day counts
// Each export replaces the previous one (everything is recomputed from the daily logs).

export const EVAL_DIR = `${GAITTWIN_DIR}/evaluation`;
export type EvalPeriod = 'all' | '30' | '7';

export const DEFINITIONS: Record<string, string> = {
  answered: 'Alerts rated Useful, Not useful or Wrong (notification button or Today tab).',
  precision: '(useful + not useful) / answered: the alert was right about what happened, whether or not it helped. 95 % Wilson interval.',
  useful_rate: 'useful / answered.',
  false_alarms_per_day: 'Alerts rated Wrong per monitored day. The worst case also counts every unanswered alert as wrong; the true rate lies between the two.',
  monitored_day: 'A day the app ran and wrote a day summary (imported thesis days are not counted).',
  repeat: 'An alert whose event was already going on when the same rule (same target) last alerted: a reminder after the cooldown, not a new event.',
  delay_s: 'Alert time minus the event due time: the earliest moment the rule\'s definition was met, on the data\'s own clock (sensor -> phone -> Health Connect sync -> minute tick). First notified alert of each event only.',
  since_onset_s: 'Alert time minus the event onset; includes the duration each rule requires by design (e.g. 10 min of high heart rate).',
  suppressed: 'Logged but not notified: quiet hours, daily cap, or a failed notification. Cooldown and pause repeats are not logged.',
  battery: 'Not recorded by the app; measured by hand.',
};

const iso = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const f = (x: number | null | undefined, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? '' : x.toFixed(d));

export const loadEvaluation = async (period: EvalPeriod, today: string = localDate()): Promise<Evaluation> => {
  const window = period === 'all' ? null : new Set(lastDates(today, Number(period)));
  const dates = (await listDailyDates()).filter((d) => d <= today && (!window || window.has(d)));
  const days: { date: string; alerts: Awaited<ReturnType<typeof readAlerts>> }[] = [];
  const monitored: string[] = [];
  for (const date of dates) {
    days.push({ date, alerts: await readAlerts(date) });
    if (await isAppDay(date)) monitored.push(date);
  }
  return evaluate(days, monitored);
};

export const ALERTS_EVAL_HEADER = 'date,alert_id,utc_ms,local_time,rule_id,rule,target,severity,delivered,suppressed_reason,repeat,event_onset_ms,event_due_ms,since_onset_s,delay_s,response,response_utc_ms,response_delay_s,title,values';
export const RULES_EVAL_HEADER = 'rule_id,rule,logged,delivered,suppressed_quiet_hours,suppressed_daily_cap,suppressed_other,repeats,answered,useful,not_useful,wrong,unanswered,precision,precision_ci_low,precision_ci_high,useful_rate,false_alarms_per_day,false_alarms_per_day_worst,delivered_per_day,delay_n,delay_median_s,delay_p90_s,delay_max_s,since_onset_median_s,response_delay_median_s';

const alertRow = (a: EvalAlert, ruleName: string) => [
  a.date, a.id, a.t, iso(a.t), a.rule, csvText(ruleName), csvText(a.target), a.severity, a.delivered ? 1 : 0, a.reason, a.repeat ? 1 : 0,
  a.onsetMs ?? '', a.dueMs ?? '', f(a.sinceOnsetS), f(a.delayS), a.response ?? '', a.respondedAt ?? '', f(a.responseDelayS),
  csvText(a.title), csvText(a.values),
].join(',');

const ruleRow = (r: RuleEval) => {
  const other = Object.entries(r.suppressed).filter(([k]) => k !== 'quiet_hours' && k !== 'daily_cap').reduce((s, [, v]) => s + v, 0);
  return [
    r.ruleId, csvText(r.name), r.logged, r.delivered, r.suppressed.quiet_hours ?? 0, r.suppressed.daily_cap ?? 0, other, r.repeats,
    r.answered, r.useful, r.notUseful, r.wrong, r.unanswered, f(r.precision, 3), f(r.precisionCi?.[0], 3), f(r.precisionCi?.[1], 3),
    f(r.usefulRate, 3), f(r.falseAlarmsPerDay, 3), f(r.falseAlarmsPerDayWorst, 3), f(r.deliveredPerDay, 3),
    r.delay.n, f(r.delay.medianS), f(r.delay.p90S), f(r.delay.maxS), f(r.sinceOnset.medianS), f(r.responseDelay.medianS),
  ].join(',');
};

export const exportEvaluation = async (ev: Evaluation, period: EvalPeriod, now: number = Date.now()): Promise<string[]> => {
  if (!(await RNFS.exists(EVAL_DIR))) await RNFS.mkdir(EVAL_DIR);
  const names = Object.fromEntries([...ev.rules].map((r) => [r.ruleId, r.name]));
  const paths = [`${EVAL_DIR}/alerts_evaluation.csv`, `${EVAL_DIR}/rules_evaluation.csv`, `${EVAL_DIR}/evaluation_summary.json`];
  await writeTextAtomic(paths[0], [ALERTS_EVAL_HEADER, ...ev.alerts.map((a) => alertRow(a, names[a.rule] ?? a.rule))].join('\n') + '\n');
  await writeTextAtomic(paths[1], [RULES_EVAL_HEADER, ...ev.rules.map(ruleRow), ruleRow(ev.overall)].join('\n') + '\n');
  await writeJsonAtomic(paths[2], {
    generatedAt: new Date(now).toISOString(),
    appVersion: pkg.version,
    period: { selected: period, from: ev.from, to: ev.to, monitoredDays: ev.days },
    definitions: DEFINITIONS,
    overall: ev.overall,
    rules: ev.rules,
    perDay: ev.perDay,
  });
  // so the files show up over USB and in the Files app straight away
  await Promise.all(paths.map((p) => RNFS.scanFile(p).catch(() => {})));
  return paths;
};
