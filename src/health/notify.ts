import notifee, { AndroidImportance, AndroidStyle, Event, EventType } from '@notifee/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Severity } from '../config/alertRules';
import { resolvePolicy } from '../store/AlertRulesStore';
import { appendDaily, csvText, localDate } from '../services/DailyStore';
import { useHealthStore } from '../store/HealthStore';

// Every alert goes through here: policy (cooldown, quiet hours, daily cap) -> notification -> log.
// The log (daily/YYYY-MM-DD/alerts.csv) records suppressed alerts too, with the reason, plus the
// rule parameters in force at that moment — it is the thesis's evaluation data for the alerts.
// event_onset_ms / event_due_ms: when the event began and when the rule's definition was first met,
// on the data's own clock (see rules.ts); utc_ms - event_due_ms is the delay to the notification.

export const ALERTS_FILE = 'alerts.csv';
export const ALERTS_HEADER = 'alert_id,utc_ms,rule_id,target,severity,delivered,suppressed_reason,title,message,values,params,event_onset_ms,event_due_ms';
// The user's answer to an alert (notification buttons or the Today tab), in the alert's day folder.
export const RESPONSES_FILE = 'alert_responses.csv';
export const RESPONSES_HEADER = 'alert_id,utc_ms,response,rule_id';
export type AlertResponse = 'useful' | 'not_useful' | 'wrong';
export const RESPONSE_LABELS: Record<AlertResponse, string> = { useful: 'Useful', not_useful: 'Not useful', wrong: 'Wrong' };

export interface AlertRequest {
  ruleId: string;
  target: string; // what the alert is about (a node id, 'PM25', ...); cooldown is per rule + target
  severity: Severity;
  cooldownMin: number;
  title: string;
  body: string;
  values: Record<string, number | string | null>;
  params: Record<string, number>;
  onsetMs?: number | null;
  dueMs?: number | null;
}

export interface AlertResult {
  id: string;
  delivered: boolean;
  reason?: 'cooldown' | 'snoozed' | 'quiet_hours' | 'daily_cap' | 'notification_failed';
}

const CHANNELS: Record<Severity, { id: string; name: string; importance: AndroidImportance }> = {
  info: { id: 'alerts_info', name: 'Information', importance: AndroidImportance.LOW },
  nudge: { id: 'alerts_nudge', name: 'Reminders and nudges', importance: AndroidImportance.DEFAULT },
  warning: { id: 'alerts_warning', name: 'Warnings', importance: AndroidImportance.HIGH },
  urgent: { id: 'alerts_urgent', name: 'Urgent', importance: AndroidImportance.HIGH },
};

const STATE_KEY = 'alert_state_v1';
interface AlertState { lastFired: Record<string, number>; day: string; nonUrgentToday: number; snoozedUntil: Record<string, number> }
let state: AlertState = { lastFired: {}, day: localDate(), nonUrgentToday: 0, snoozedUntil: {} };
const saveState = () => AsyncStorage.setItem(STATE_KEY, JSON.stringify(state)).catch(() => {});

export const loadAlertState = async () => {
  try {
    const saved = await AsyncStorage.getItem(STATE_KEY);
    if (saved) state = { ...state, ...JSON.parse(saved) };
  } catch {
    // keep the empty state
  }
};

export const resetAlertStateForTests = () => {
  state = { lastFired: {}, day: localDate(), nonUrgentToday: 0, snoozedUntil: {} };
};

// Pause one rule (all its targets) for a while, e.g. from the Today tab.
export const snoozeRule = (ruleId: string, minutes: number, now: number = Date.now()) => {
  state.snoozedUntil[ruleId] = now + minutes * 60000;
  saveState();
};

export const snoozedUntil = (ruleId: string): number | null => {
  const t = state.snoozedUntil[ruleId];
  return t && t > Date.now() ? t : null;
};

export const setupNotifications = async () => {
  await notifee.requestPermission();
  for (const c of Object.values(CHANNELS)) await notifee.createChannel(c);
};

const uuid = () =>
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    return (ch === 'x' ? r : 8 + (r % 4)).toString(16);
  });

const inQuietHours = (ms: number, start: number, end: number) => {
  const h = new Date(ms).getHours();
  return start <= end ? h >= start && h < end : h >= start || h < end; // e.g. 23 -> 7 wraps midnight
};

const timeCell = (t: number | null | undefined) => (t === null || t === undefined || !Number.isFinite(t) ? '' : String(Math.round(t)));

const kv = (o: Record<string, number | string | null>) =>
  Object.entries(o).map(([k, v]) => `${k}=${v === null ? '' : typeof v === 'number' ? +v.toFixed(3) : v}`).join(';');

export const deliverAlert = async (req: AlertRequest, now: number = Date.now()): Promise<AlertResult> => {
  const policy = resolvePolicy();
  const id = uuid();
  const key = `${req.ruleId}:${req.target}`;
  const today = localDate(now);
  if (state.day !== today) state = { ...state, day: today, nonUrgentToday: 0 };

  let reason: AlertResult['reason'];
  const last = state.lastFired[key];
  if (last !== undefined && now - last < req.cooldownMin * 60000) reason = 'cooldown';
  else if ((state.snoozedUntil[req.ruleId] ?? 0) > now) reason = 'snoozed';
  else if (req.severity !== 'urgent' && policy.quietHoursEnabled && inQuietHours(now, policy.quietStartHour, policy.quietEndHour)) reason = 'quiet_hours';
  else if (req.severity !== 'urgent' && state.nonUrgentToday >= policy.maxNonUrgentPerDay) reason = 'daily_cap';

  // Cooldown and snooze suppressions aren't logged: a repeat row every minute would only bury the
  // alert that was delivered (or that the user chose to pause).
  if (reason === 'cooldown' || reason === 'snoozed') return { id, delivered: false, reason };

  if (!reason) {
    try {
      await notifee.displayNotification({
        id,
        title: req.title,
        body: req.body,
        data: { ruleId: req.ruleId, date: today },
        android: {
          channelId: CHANNELS[req.severity].id,
          smallIcon: 'ic_launcher',
          pressAction: { id: 'default', launchActivity: 'default' },
          style: { type: AndroidStyle.BIGTEXT, text: req.body }, // the whole message, not one line
          // Every alert asks for feedback: the answers are the thesis's evaluation of the alerts.
          actions: (Object.keys(RESPONSE_LABELS) as AlertResponse[]).map((r) => ({ title: RESPONSE_LABELS[r], pressAction: { id: r } })),
        },
      });
    } catch (e) {
      console.warn('Notification failed:', e);
      reason = 'notification_failed';
    }
  }
  // Quiet-hours and cap suppressions also start the cooldown, so they're logged once, not every tick.
  state.lastFired[key] = now;
  if (!reason && req.severity !== 'urgent') state.nonUrgentToday++;
  saveState();

  appendDaily(ALERTS_FILE, ALERTS_HEADER,
    [id, now, req.ruleId, req.target, req.severity, reason ? 0 : 1, reason ?? '', csvText(req.title), csvText(req.body),
      csvText(kv(req.values)), csvText(kv(req.params)), timeCell(req.onsetMs), timeCell(req.dueMs)].join(','), now)
    .then(() => useHealthStore.getState().bumpAlerts())
    .catch(() => {});
  return { id, delivered: !reason, reason };
};

// Records the user's answer to an alert in that alert's day folder and clears the notification.
export const recordResponse = async (alertId: string, ruleId: string, response: AlertResponse, alertDay: string | null, now: number = Date.now()) => {
  const dayMs = alertDay ? new Date(`${alertDay}T12:00:00`).getTime() : now;
  await appendDaily(RESPONSES_FILE, RESPONSES_HEADER, `${alertId},${now},${response},${ruleId}`, dayMs);
  notifee.cancelNotification(alertId).catch(() => {});
  useHealthStore.getState().bumpAlerts();
};

// Notification button presses, foreground or background (registered in index.js and App.tsx).
export const handleNotificationEvent = async ({ type, detail }: Event) => {
  if (type !== EventType.ACTION_PRESS || !detail.notification?.id || !detail.pressAction) return;
  const response = detail.pressAction.id as AlertResponse;
  if (!(response in RESPONSE_LABELS)) return;
  const data = detail.notification.data ?? {};
  await recordResponse(detail.notification.id, String(data.ruleId ?? ''), response, data.date ? String(data.date) : null);
};

// A sample notification from the settings screen (not logged, ignores quiet hours and the cap).
export const sendTestNotification = async () => {
  await notifee.displayNotification({
    title: 'Test notification',
    body: 'Alerts look like this. The buttons below record whether an alert was useful; that feedback is kept with the alert log.',
    android: {
      channelId: CHANNELS.nudge.id, smallIcon: 'ic_launcher', pressAction: { id: 'default', launchActivity: 'default' },
      style: { type: AndroidStyle.BIGTEXT, text: 'Alerts look like this. The buttons below record whether an alert was useful; that feedback is kept with the alert log.' },
      actions: (Object.keys(RESPONSE_LABELS) as AlertResponse[]).map((r) => ({ title: RESPONSE_LABELS[r], pressAction: { id: `test_${r}` } })),
    },
  });
};
