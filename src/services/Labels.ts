import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { sessionWriter } from './SessionWriter';
import { appendDaily, csvText } from './DailyStore';
import { LABELS_FILE, LABELS_HEADER } from './Labels.constants';
import { healthEngine } from '../health/engine';

export { LABELS_FILE, LABELS_HEADER };

// One-tap context labels: the ground truth for the activity and place models, and the evidence behind
// "what happened" in the daily report. Every tap goes to today's daily/labels.csv (also when not
// recording) and, during a session, to the session's events.csv with node = APP.

export interface LabelDef { id: string; label: string }

// Start/stop contexts; one active at a time (starting one stops the other).
export const CONTEXT_LABELS: LabelDef[] = [
  { id: 'walk', label: '🚶 Walk' },
  { id: 'rickshaw', label: '🛺 Rickshaw' },
  { id: 'metro_bus', label: '🚇 Metro / bus' },
];

export const POINT_LABELS: LabelDef[] = [
  { id: 'drink', label: '💧 Drink' },
  { id: 'meal', label: '🍽 Meal' },
  { id: 'ac_on', label: '❄️ AC on' },
  { id: 'ac_off', label: 'AC off' },
  { id: 'fan_on', label: '🌀 Fan on' },
  { id: 'fan_off', label: 'Fan off' },
  { id: 'window_open', label: '🪟 Window open' },
  { id: 'window_closed', label: 'Window closed' },
  { id: 'cooking', label: '🍳 Cooking' },
  { id: 'interesting', label: '⭐ Something interesting' },
  // Hop twice with both feet: the two simultaneous heel impacts let left/right alignment be checked.
  { id: 'sync_marker', label: '⇅ Hop-twice marker' },
];


const ACTIVE_KEY = 'active_context_label';

interface LabelState {
  active: { id: string; startedAt: number } | null;
  lastTap: { id: string; at: number } | null;
  setActive: (a: LabelState['active']) => void;
  setLastTap: (t: LabelState['lastTap']) => void;
}

export const useLabelStore = create<LabelState>((set) => ({
  active: null,
  lastTap: null,
  setActive: (active) => set({ active }),
  setLastTap: (lastTap) => set({ lastTap }),
}));

const clean = (note: string) => note.replace(/[\r\n]+/g, ' ').trim();

export const logLabel = async (event: string, note = '', now: number = Date.now()) => {
  const n = clean(note);
  // events.csv detail is ';'-separated key=value, so commas are dropped there; labels.csv keeps the text.
  sessionWriter.append('events', `${now},APP,${event},,${now},${n ? `note=${n.replace(/[,;]/g, ' ')}` : ''}`);
  useLabelStore.getState().setLastTap({ id: event, at: now });
  healthEngine.onLabel(now, event, n);
  await appendDaily(LABELS_FILE, LABELS_HEADER, `${now},${event},${csvText(n)}`, now);
};

const saveActive = (a: LabelState['active']) =>
  (a ? AsyncStorage.setItem(ACTIVE_KEY, JSON.stringify(a)) : AsyncStorage.removeItem(ACTIVE_KEY)).catch(() => {});

// Tapping the active context stops it; tapping another stops the active one and starts the new one.
export const toggleContext = async (id: string, now: number = Date.now()) => {
  const { active, setActive } = useLabelStore.getState();
  if (active) await logLabel(`${active.id}_stop`, '', now);
  if (active?.id === id) {
    setActive(null);
    await saveActive(null);
    return;
  }
  await logLabel(`${id}_start`, '', now);
  const next = { id, startedAt: now };
  setActive(next);
  await saveActive(next);
};

export const loadActiveContext = async () => {
  try {
    const saved = await AsyncStorage.getItem(ACTIVE_KEY);
    if (saved) useLabelStore.getState().setActive(JSON.parse(saved));
  } catch {
    // no saved context
  }
};

// At session start: a context that was already running is written into the new session too.
export const logActiveContextAtSessionStart = () => {
  const a = useLabelStore.getState().active;
  if (a) {
    const now = Date.now();
    sessionWriter.append('events', `${now},APP,${a.id}_active,,${a.startedAt},started_before_session`);
  }
};
