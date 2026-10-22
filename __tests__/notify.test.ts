import notifee from '@notifee/react-native';
import { deliverAlert, resetAlertStateForTests, AlertRequest, ALERTS_HEADER, handleNotificationEvent, snoozeRule, RESPONSES_HEADER } from '../src/health/notify';
import { EventType } from '@notifee/react-native';
import { useAlertRulesStore } from '../src/store/AlertRulesStore';
import { parseCsvText, resetDailyStoreForTests } from '../src/services/DailyStore';
import { installMemFs } from '../testUtils/memfs';

let fs: ReturnType<typeof installMemFs>;
const at = (h: number, m = 0) => new Date(2026, 9, 21, h, m).getTime();
const req = (over: Partial<AlertRequest> = {}): AlertRequest => ({
  ruleId: 'DQ-1', target: 'GAIT:silent', severity: 'info', cooldownMin: 60,
  title: 'Right insole: no data for 2 min', body: 'Check it, please', values: { silent_min: 2.1 }, params: { silentMinGait: 2 }, ...over,
});
const flush = () => new Promise<void>((r) => setImmediate(() => r()));
const alertRows = () => {
  const path = Object.keys(fs.files).find((p) => p.endsWith('/alerts.csv'));
  return path ? fs.files[path].trim().split('\n') : [];
};

beforeEach(async () => {
  fs = installMemFs();
  resetDailyStoreForTests();
  resetAlertStateForTests();
  (notifee.displayNotification as jest.Mock).mockClear();
  await useAlertRulesStore.getState().resetPolicy();
});

test('delivers, logs the alert with its values and parameters', async () => {
  const r = await deliverAlert(req(), at(10));
  await flush();
  expect(r.delivered).toBe(true);
  expect(notifee.displayNotification).toHaveBeenCalledTimes(1);
  const rows = alertRows();
  expect(rows[0]).toBe(ALERTS_HEADER);
  expect(rows[1]).toContain(',DQ-1,GAIT:silent,info,1,,');
  expect(rows[1]).toContain('silent_min=2.1');
  expect(rows[1]).toContain('silentMinGait=2');
});

test('the event times go in the last two columns; an older file gets the new header', async () => {
  const dir = '/mock/Downloads/GaitTwin/daily/2026-10-21';
  fs.dirs.add(dir);
  const OLD = 'alert_id,utc_ms,rule_id,target,severity,delivered,suppressed_reason,title,message,values,params';
  fs.files[`${dir}/alerts.csv`] = `${OLD}\nold-1,${at(9)},HY-1,gap,nudge,1,,No water,Drink,gap_h=2.5,gapHours=2.5\n`;
  await deliverAlert(req({ onsetMs: at(9, 58), dueMs: at(10) }), at(10, 1));
  await flush();
  const rows = alertRows();
  expect(rows[0]).toBe(ALERTS_HEADER);
  expect(rows[1]).toBe(`old-1,${at(9)},HY-1,gap,nudge,1,,No water,Drink,gap_h=2.5,gapHours=2.5`); // kept as it was
  expect(rows[2].endsWith(`,${at(9, 58)},${at(10)}`)).toBe(true);
  expect(parseCsvText(rows[2])[0]).toHaveLength(ALERTS_HEADER.split(',').length);
});

test('the same rule + target is silent during its cooldown, then fires again', async () => {
  await deliverAlert(req(), at(10));
  expect((await deliverAlert(req(), at(10, 30))).reason).toBe('cooldown');
  expect((await deliverAlert(req({ target: 'GAIT_LEFT:silent' }), at(10, 30))).delivered).toBe(true);
  expect((await deliverAlert(req(), at(11, 1))).delivered).toBe(true);
});

test('quiet hours hold non-urgent alerts (logged as suppressed); urgent ones still notify', async () => {
  const quiet = await deliverAlert(req(), at(23, 30));
  expect(quiet).toMatchObject({ delivered: false, reason: 'quiet_hours' });
  expect((await deliverAlert(req({ severity: 'urgent', target: 'x' }), at(23, 30))).delivered).toBe(true);
  await flush();
  expect(alertRows().some((r) => r.includes(',0,quiet_hours,'))).toBe(true);
});

test('policy edits apply at once: quiet hours off, daily cap of 2', async () => {
  await useAlertRulesStore.getState().setPolicy({ quietHoursEnabled: false, maxNonUrgentPerDay: 2 });
  expect((await deliverAlert(req({ target: 'a' }), at(23, 30))).delivered).toBe(true);
  expect((await deliverAlert(req({ target: 'b' }), at(23, 31))).delivered).toBe(true);
  expect((await deliverAlert(req({ target: 'c' }), at(23, 32))).reason).toBe('daily_cap');
});

test('every notification carries Useful / Not useful / Wrong buttons, and a press is recorded for that alert', async () => {
  const r = await deliverAlert(req(), at(10));
  const shown = (notifee.displayNotification as jest.Mock).mock.calls[0][0];
  expect(shown.android.actions.map((a: any) => a.pressAction.id)).toEqual(['useful', 'not_useful', 'wrong']);
  await handleNotificationEvent({
    type: EventType.ACTION_PRESS,
    detail: { notification: { id: r.id, data: shown.data }, pressAction: { id: 'not_useful' } },
  } as any);
  const path = Object.keys(fs.files).find((p) => p.endsWith('/alert_responses.csv'))!;
  expect(path).toContain('/2026-10-21/');
  expect(fs.files[path].trim().split('\n')).toEqual([RESPONSES_HEADER, expect.stringMatching(new RegExp(`^${r.id},\\d+,not_useful,DQ-1$`))]);
  expect(notifee.cancelNotification).toHaveBeenCalledWith(r.id);
});

test('presses on the test notification are not recorded', async () => {
  await handleNotificationEvent({ type: EventType.ACTION_PRESS, detail: { notification: { id: 'x', data: {} }, pressAction: { id: 'test_useful' } } } as any);
  expect(Object.keys(fs.files).some((p) => p.endsWith('/alert_responses.csv'))).toBe(false);
});

test('a paused rule stays quiet until the pause ends, other rules are unaffected', async () => {
  snoozeRule('DQ-1', 60, at(10));
  expect((await deliverAlert(req(), at(10, 30))).reason).toBe('snoozed');
  expect((await deliverAlert(req({ ruleId: 'EN-1', target: 'pm25' }), at(10, 30))).delivered).toBe(true);
  expect((await deliverAlert(req(), at(11, 1))).delivered).toBe(true);
});
