import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import RNFS from 'react-native-fs';
import { evaluate, wilson } from '../src/health/evaluation';
import { ALERTS_EVAL_HEADER, RULES_EVAL_HEADER, exportEvaluation, loadEvaluation } from '../src/health/evaluationExport';
import { AlertRow } from '../src/health/history';
import { ALERTS_HEADER, RESPONSES_HEADER } from '../src/health/notify';
import { EvaluationScreen } from '../src/screens/EvaluationScreen';
import { parseCsvText, resetDailyStoreForTests } from '../src/services/DailyStore';
import { installMemFs } from '../testUtils/memfs';

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const alert = (id: string, t: number, rule: string, target: string, over: Partial<AlertRow> = {}): AlertRow => ({
  id, t, rule, target, severity: 'nudge', delivered: true, reason: '', title: `${rule} alert`, body: '', values: '',
  onsetMs: null, dueMs: null, response: null, respondedAt: null, ...over,
});

// Two days of alerts, a third day without any; checked by hand:
//   a1 HY-1 notified 1 min after due, useful | a2 the same dry spell an hour later (a repeat), not useful
//   a3 HR-1 30 min after due (Health Connect sync), wrong | a4 EN-3 in quiet hours (not notified), unanswered
//   a5 HR-1 2 min after due, useful | a6 PO-1 logged before event times existed, unanswered
const DAYS = [
  { date: '2026-10-14', alerts: [
    alert('a1', at(14, 13, 31), 'HY-1', 'gap', { onsetMs: at(14, 11), dueMs: at(14, 13, 30), response: 'useful', respondedAt: at(14, 13, 40) }),
    alert('a2', at(14, 14, 31), 'HY-1', 'gap', { onsetMs: at(14, 11), dueMs: at(14, 13, 30), response: 'not_useful', respondedAt: at(14, 14, 35) }),
    alert('a3', at(14, 15, 40), 'HR-1', 'hr', { onsetMs: at(14, 15), dueMs: at(14, 15, 10), response: 'wrong', respondedAt: at(14, 15, 41) }),
    alert('a4', at(14, 23, 30), 'EN-3', 'co2', { delivered: false, reason: 'quiet_hours', onsetMs: at(14, 23, 20), dueMs: at(14, 23, 28) }),
  ] },
  { date: '2026-10-15', alerts: [
    alert('a5', at(15, 10, 12), 'HR-1', 'hr', { onsetMs: at(15, 10), dueMs: at(15, 10, 10), response: 'useful', respondedAt: at(15, 10, 20) }),
    alert('a6', at(15, 11), 'PO-1', 'pose:1'),
  ] },
  { date: '2026-10-16', alerts: [] },
];

describe('alert evaluation', () => {
  test('precision, false alarms per day, repeats and delays', () => {
    const ev = evaluate(DAYS, ['2026-10-14', '2026-10-15', '2026-10-16']);
    expect(ev).toMatchObject({ from: '2026-10-14', to: '2026-10-16', days: 3 });
    const o = ev.overall;
    expect(o).toMatchObject({ logged: 6, delivered: 5, repeats: 1, answered: 4, useful: 2, notUseful: 1, wrong: 1, unanswered: 2, suppressed: { quiet_hours: 1 } });
    expect(o.precision).toBe(0.75);
    expect(o.precisionCi![0]).toBeCloseTo(0.301, 3);
    expect(o.precisionCi![1]).toBeCloseTo(0.954, 3);
    expect(o.usefulRate).toBe(0.5);
    expect(o.falseAlarmsPerDay).toBeCloseTo(1 / 3, 9);
    expect(o.falseAlarmsPerDayWorst).toBe(1); // if both unanswered alerts were wrong
    // delay: first notified alert of each event with a due time — a1 60 s, a3 1800 s, a5 120 s
    expect(o.delay).toEqual({ n: 3, medianS: 120, p90S: 120 + 0.8 * 1680, maxS: 1800 });
    expect(o.sinceOnset.medianS).toBe(40 * 60); // 12, 40 and 151 min
    expect(o.responseDelay.medianS).toBe(360); // answered after 1, 4, 8 and 9 min

    const rule = (id: string) => ev.rules.find((r) => r.ruleId === id)!;
    expect(ev.rules.map((r) => r.ruleId).sort()).toEqual(['EN-3', 'HR-1', 'HY-1', 'PO-1']);
    expect(rule('HR-1')).toMatchObject({ name: 'High heart rate at rest', logged: 2, precision: 0.5, wrong: 1 });
    expect(rule('HR-1').delay.medianS).toBe(960);
    expect(rule('HY-1')).toMatchObject({ repeats: 1, precision: 1, delay: { n: 1, medianS: 60 } });
    expect(ev.alerts.find((a) => a.id === 'a2')!.repeat).toBe(true);
    expect(ev.perDay).toEqual([
      { date: '2026-10-14', logged: 4, delivered: 3, answered: 3, wrong: 1 },
      { date: '2026-10-15', logged: 2, delivered: 2, answered: 1, wrong: 0 },
      { date: '2026-10-16', logged: 0, delivered: 0, answered: 0, wrong: 0 },
    ]);
  });

  test('no answers yet: no precision, and the interval of nothing is nothing', () => {
    const ev = evaluate([{ date: '2026-10-14', alerts: [alert('x', at(14, 9), 'HY-1', 'gap')] }], ['2026-10-14']);
    expect(ev.overall).toMatchObject({ precision: null, precisionCi: null, falseAlarmsPerDay: 0, falseAlarmsPerDayWorst: 1 });
    expect(wilson(0, 0)).toBeNull();
  });
});

describe('from the daily logs to the export', () => {
  const D = '/mock/Downloads/GaitTwin/daily';
  let fs: ReturnType<typeof installMemFs>;
  const csvRow = (a: AlertRow) => [a.id, a.t, a.rule, a.target, a.severity, a.delivered ? 1 : 0, a.reason, a.title, 'msg', 'v=1', 'p=2', a.onsetMs ?? '', a.dueMs ?? ''].join(',');

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date(2026, 9, 16, 12, 0), doNotFake: ['setImmediate', 'nextTick'] });
    fs = installMemFs();
    resetDailyStoreForTests();
    fs.dirs.add(D);
    for (const { date, alerts } of DAYS) {
      fs.dirs.add(`${D}/${date}`);
      fs.files[`${D}/${date}/daily_summary.json`] = JSON.stringify({ date });
      if (!alerts.length) continue;
      // a6 was logged by an older version: 11 columns, no event times
      fs.files[`${D}/${date}/alerts.csv`] = [ALERTS_HEADER, ...alerts.map((a) => (a.id === 'a6' ? csvRow(a).split(',').slice(0, 11).join(',') : csvRow(a)))].join('\n') + '\n';
      fs.files[`${D}/${date}/alert_responses.csv`] = [RESPONSES_HEADER, ...alerts.filter((a) => a.response).map((a) => `${a.id},${a.respondedAt},${a.response},${a.rule}`)].join('\n') + '\n';
    }
    // an imported thesis day is not a monitored day
    fs.dirs.add(`${D}/2026-10-01`);
    fs.files[`${D}/2026-10-01/daily_summary.json`] = JSON.stringify({ date: '2026-10-01', imported: true });
  });
  afterEach(() => jest.useRealTimers());

  test('the same numbers come back from the files, and three files are written', async () => {
    const ev = await loadEvaluation('all');
    expect(ev).toMatchObject({ from: '2026-10-14', to: '2026-10-16', days: 3 });
    expect(ev.overall).toMatchObject({ logged: 6, answered: 4, wrong: 1, repeats: 1 });
    expect(ev.overall.delay.n).toBe(3);
    expect((await loadEvaluation('7', '2026-10-16')).days).toBe(3);
    expect((await loadEvaluation('7', '2026-10-22')).days).toBe(1); // only the 16th is in the last 7 days

    const paths = await exportEvaluation(ev, 'all');
    const E = '/mock/Downloads/GaitTwin/evaluation';
    expect(paths).toEqual([`${E}/alerts_evaluation.csv`, `${E}/rules_evaluation.csv`, `${E}/evaluation_summary.json`]);
    const alertsCsv = parseCsvText(fs.files[paths[0]].trim());
    expect(alertsCsv[0].join(',')).toBe(ALERTS_EVAL_HEADER);
    expect(alertsCsv).toHaveLength(7);
    const a3 = alertsCsv.find((r) => r[1] === 'a3')!;
    expect(a3[alertsCsv[0].indexOf('delay_s')]).toBe('1800.0');
    expect(a3[alertsCsv[0].indexOf('response')]).toBe('wrong');
    const rulesCsv = parseCsvText(fs.files[paths[1]].trim());
    expect(rulesCsv[0].join(',')).toBe(RULES_EVAL_HEADER);
    expect(rulesCsv[rulesCsv.length - 1].slice(0, 3)).toEqual(['ALL', 'All alerts', '6']);
    const summary = JSON.parse(fs.files[paths[2]]);
    expect(summary.period).toEqual({ selected: 'all', from: '2026-10-14', to: '2026-10-16', monitoredDays: 3 });
    expect(summary.definitions.battery).toMatch(/measured by hand/);
    expect(RNFS.scanFile).toHaveBeenCalledWith(paths[0]);
  });

  test('the Evaluation screen shows the numbers and exports', async () => {
    let tree: ReactTestRenderer.ReactTestRenderer;
    await ReactTestRenderer.act(async () => { tree = ReactTestRenderer.create(<EvaluationScreen visible onClose={() => {}} />); });
    await ReactTestRenderer.act(async () => { for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r)); });
    const root = tree!.root;
    const textOf = (n: ReactTestRenderer.ReactTestInstance): string => n.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
    const texts = () => root.findAllByType(Text).map(textOf).join(' | ');
    expect(texts()).toContain('2026-10-14 – 2026-10-16 · 3 days');
    expect(texts()).toContain('75 % | precision');
    expect(texts()).toMatch(/Precision 75 % \(95 % interval 30 %–95 %\)/);
    expect(texts()).toMatch(/2 alerts not answered yet: false alarms per day are between 0\.33 and 1\.00/);
    expect(texts()).toContain('High heart rate at rest');
    const btn = root.findAllByType(TouchableOpacity).find((b) => textOf(b) === 'Export CSV + JSON')!;
    await ReactTestRenderer.act(async () => { await btn.props.onPress(); });
    expect(texts()).toContain('Saved to Downloads/GaitTwin/evaluation/');
    expect(fs.files['/mock/Downloads/GaitTwin/evaluation/rules_evaluation.csv']).toBeDefined();
    await ReactTestRenderer.act(async () => { tree!.unmount(); });
  });
});
