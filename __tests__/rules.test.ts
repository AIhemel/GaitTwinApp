import { evaluateRules, RuleInputs, Finding } from '../src/health/rules';
import { RULE_DEFS } from '../src/config/alertRules';
import { ResolvedRule } from '../src/store/AlertRulesStore';
import { EnvMinute } from '../src/health/daySummary';
import { HeartData } from '../src/health/heart';
import { Stride } from '../src/health/gait';
import { gaitWindows } from '../src/health/symmetry';

const MIN = 60000;
const DAY0 = new Date(2026, 9, 14).getTime();
const at = (h: number, m = 0) => DAY0 + h * 3600000 + m * MIN;

const defaults = (): Record<string, ResolvedRule> => Object.fromEntries(RULE_DEFS.map((d) => [d.id, {
  id: d.id, enabled: d.enabled, severity: d.severity, cooldownMin: d.cooldownMin,
  params: Object.fromEntries(d.params.map((p) => [p.key, p.default])),
}]));

const noHeart = (): HeartData => ({ hrByMinute: new Map(), stepsByMinute: new Map(), spo2: [], sleep: null });
const base = (now: number): RuleInputs => ({
  now, env: [], heart: noHeart(), strides: { R: [], L: [] }, labels: [], drinks: [], hydrationTracked: false,
  totalMl: null, targetMl: 2000, wakeAt: at(7), posture: { windowStart: null, pose: null, poseOnset: null },
  gaitWalksAlertedToday: 0, date: '2026-10-14',
  baselines: null, minBaselineDays: 3, place: 'indoor', sleepMeanHr: null,
});
const ids = (fs: Finding[]) => fs.map((f) => f.ruleId).sort();

const envMinutes = (from: number, n: number, v: Partial<{ pm25: number; co2: number; dba: number }>): [number, EnvMinute][] =>
  [...Array(n)].map((_, i) => [from + i * MIN, {
    co2: v.co2 !== undefined ? [v.co2, 1] : [0, 0], temp: [0, 0], rh: [0, 0],
    pm25: v.pm25 !== undefined ? [v.pm25, 1] : [0, 0], pm10: [0, 0],
    dbaEnergy: v.dba !== undefined ? [10 ** (v.dba / 10), 1] : [0, 0], warmup: false,
  }]);

describe('environment', () => {
  test('PM2.5 5-min mean of 160 -> very high particles; 300 -> hazardous only (it replaces the lower alert)', () => {
    const inp = base(at(12, 10));
    inp.env = envMinutes(at(12, 5), 5, { pm25: 160 });
    expect(ids(evaluateRules(inp, defaults()))).toEqual(['EN-1']);
    inp.env = envMinutes(at(12, 5), 5, { pm25: 300 });
    const f = evaluateRules(inp, defaults());
    expect(ids(f)).toEqual(['EN-2']);
    expect(f[0].body).toContain('300 µg/m³');
  });

  test('a reading that stopped arriving (node went quiet) does not alert', () => {
    const inp = base(at(12, 30));
    inp.env = envMinutes(at(12, 5), 5, { pm25: 300 });
    expect(evaluateRules(inp, defaults())).toEqual([]);
  });

  test('CO₂ and noise: stuffy/poor and loud/hearing-risk levels', () => {
    const inp = base(at(12, 30));
    inp.env = envMinutes(at(12, 0), 30, { co2: 1200, dba: 88 });
    expect(ids(evaluateRules(inp, defaults()))).toEqual(['EN-3', 'EN-4H']);
  });

  test('an edited threshold takes effect: CO₂ alert from 600 ppm', () => {
    const inp = base(at(12, 30));
    inp.env = envMinutes(at(12, 20), 10, { co2: 700 });
    expect(evaluateRules(inp, defaults())).toEqual([]);
    const R = defaults();
    R['EN-3'].params.co2 = 600;
    expect(ids(evaluateRules(inp, R))).toEqual(['EN-3']);
    R['EN-3'].enabled = false;
    expect(evaluateRules(inp, R)).toEqual([]);
  });
});

describe('heart', () => {
  const heartAt = (start: number, n: number, bpm: number, bandSteps = 0): HeartData => ({
    ...noHeart(),
    hrByMinute: new Map([...Array(n)].map((_, i) => [start + i * MIN, bpm])),
    stepsByMinute: new Map([...Array(n)].map((_, i) => [start + i * MIN, bandSteps])),
  });

  test('125 bpm for 10 min sitting still -> HR-1; 155 -> HR-2 only, with the seek-help line', () => {
    const inp = base(at(15, 12));
    inp.heart = heartAt(at(15), 10, 125);
    expect(ids(evaluateRules(inp, defaults()))).toEqual(['HR-1']);
    inp.heart = heartAt(at(15), 10, 155);
    const f = evaluateRules(inp, defaults());
    expect(ids(f)).toEqual(['HR-2']);
    expect(f[0].body).toContain('If you feel unwell, seek help.');
  });

  test('high heart rate while walking (band steps) or in a rickshaw (toggle) is not an alert', () => {
    const inp = base(at(15, 12));
    inp.heart = heartAt(at(15), 10, 125, 90);
    expect(evaluateRules(inp, defaults())).toEqual([]);
    inp.heart = heartAt(at(15), 10, 125, 0);
    inp.labels = [{ t: at(14, 50), label: 'rickshaw_start' }];
    expect(evaluateRules(inp, defaults())).toEqual([]);
  });

  test('old heart data (synced late) does not alert', () => {
    const inp = base(at(17));
    inp.heart = heartAt(at(15), 10, 125);
    expect(evaluateRules(inp, defaults())).toEqual([]);
  });

  test('low heart rate awake -> HR-3', () => {
    const inp = base(at(15, 12));
    inp.heart = heartAt(at(15), 10, 38);
    expect(ids(evaluateRules(inp, defaults()))).toEqual(['HR-3']);
  });

  test('SpO₂: two readings below 90 within 10 min -> SP-1; one is not enough', () => {
    const inp = base(at(15, 20));
    inp.heart = { ...noHeart(), spo2: [{ t: at(15, 5), v: 88 }] };
    expect(evaluateRules(inp, defaults())).toEqual([]);
    inp.heart = { ...noHeart(), spo2: [{ t: at(15, 5), v: 88 }, { t: at(15, 12), v: 87 }] };
    const f = evaluateRules(inp, defaults());
    expect(ids(f)).toEqual(['SP-1']);
    expect(f[0].values.spo2_min).toBe(87);
  });
});

describe('hydration', () => {
  test('no drink for 2.5 h -> HY-1, counted from the last drink (taps count)', () => {
    const inp = base(at(14));
    inp.hydrationTracked = true;
    inp.drinks = [{ t: at(11, 0), ml: null }];
    const f = evaluateRules(inp, defaults());
    expect(ids(f)).toEqual(['HY-1']); // taps only: no volume, so no pace or goal alerts
    expect(f[0].title).toBe('No water for 3 h');
  });

  test('not tracking water today (no bottle, no taps): no reminders at all', () => {
    expect(evaluateRules(base(at(18)), defaults())).toEqual([]);
  });

  test('bottle in use: behind on pace -> HY-2; target reached -> HY-3 only', () => {
    const inp = base(at(15));
    inp.hydrationTracked = true;
    inp.drinks = [{ t: at(14, 30), ml: 300 }];
    inp.totalMl = 300;
    expect(ids(evaluateRules(inp, defaults()))).toEqual(['HY-2']);
    inp.totalMl = 2100;
    expect(ids(evaluateRules(inp, defaults()))).toEqual(['HY-3']);
  });
});

describe('posture', () => {
  test('slouching 25 min -> PO-1; seated 55 min -> PO-2; seat empty -> nothing', () => {
    const inp = base(at(10, 55));
    inp.posture = { windowStart: at(10, 0), pose: 'SLOUCH', poseOnset: at(10, 30) };
    const f = evaluateRules(inp, defaults());
    expect(ids(f)).toEqual(['PO-1', 'PO-2']);
    expect(f.find((x) => x.ruleId === 'PO-1')!.title).toBe('Slouching for 25 min');
    inp.posture = { windowStart: null, pose: null, poseOnset: null };
    expect(evaluateRules(inp, defaults())).toEqual([]);
  });

  test('LEAN_FORWARD is never poor posture (it is how some users sit upright)', () => {
    const inp = base(at(10, 30));
    inp.posture = { windowStart: at(10, 0), pose: 'LEAN_FORWARD', poseOnset: at(10, 0) };
    expect(evaluateRules(inp, defaults())).toEqual([]);
  });
});

describe('gait asymmetry', () => {
  const walk = (start: number, n: number, stanceR: number, stanceL: number) => {
    const mk = (i: number, stance: number, off: number): Stride => ({
      hs_ms: start + i * 1100 + off, stride_s: 1.1, stance_pct: stance, stance_s: 0.7, swing_s: 0.4,
      stance_imu_pct: stance, stance_imu_s: 0.7, swing_imu_s: 0.4, pushoff_pct: 65, tilt_range_deg: 55,
      pitch_range_deg: 40, peak_acc_ms2: 30, heel_share: 0.4, met1_share: 0.3, met5_share: 0.3,
      hs_imu_ms: start + i * 1100 + off, to_imu_ms: 0, to_fsr_ms: 0, bout: 0,
    });
    return { R: [...Array(n)].map((_, i) => mk(i, stanceR, 0)), L: [...Array(n)].map((_, i) => mk(i, stanceL, 550)) };
  };

  test('even steps: nothing; right stance 66 % vs left 60 % over 2 blocks of 60 strides -> GA-1', () => {
    const inp = base(at(9, 1)); // a minute after the walk
    inp.strides = walk(at(9) - 160 * 1100, 160, 62, 62);
    expect(evaluateRules(inp, defaults())).toEqual([]);
    inp.strides = walk(at(9) - 160 * 1100, 160, 66, 60);
    const f = evaluateRules(inp, defaults());
    expect(ids(f)).toEqual(['GA-1']);
    expect(f[0].body).toContain('Right stance (time on the ground) 66.0 % of the stride, left 60.0 %');
    expect(f[0].severity).toBeUndefined();
  });

  test('too short a walk, or only one uneven block: nothing', () => {
    const inp = base(at(9, 1)); // a minute after the walk
    inp.strides = walk(at(9) - 90 * 1100, 90, 66, 60); // 99 s < 120 s
    expect(evaluateRules(inp, defaults())).toEqual([]);
  });

  test('the third uneven walk of the day becomes a warning', () => {
    const inp = base(at(9, 1)); // a minute after the walk
    inp.strides = walk(at(9) - 160 * 1100, 160, 66, 60);
    inp.gaitWalksAlertedToday = 2;
    expect(evaluateRules(inp, defaults())[0].severity).toBe('warning');
  });
});

// Each finding says when its event began (onset) and when the rule's definition was first met (due),
// for the evaluation's "time from event to notification".
describe('event timing', () => {
  const find = (inp: RuleInputs, id: string) => evaluateRules(inp, defaults()).find((f) => f.ruleId === id)!;

  test('PM2.5: the first over-limit minute, and the tick the 5-min mean first crossed', () => {
    const inp = base(at(12, 10));
    inp.env = envMinutes(at(12, 0), 10, { pm25: 200 });
    // the 5-min mean needs 3 of its 5 minutes: first possible at 12:02
    expect(find(inp, 'EN-1')).toMatchObject({ onsetMs: at(12, 0), dueMs: at(12, 2) });
  });

  test('heart rate: the run of high minutes, due once it lasted the required 10 min', () => {
    const inp = base(at(15, 30));
    inp.heart = { ...noHeart(), hrByMinute: new Map([...Array(25)].map((_, i) => [at(15, 4) + i * MIN, 125])), stepsByMinute: new Map() };
    expect(find(inp, 'HR-1')).toMatchObject({ onsetMs: at(15, 4), dueMs: at(15, 14) });
    inp.heart.spo2 = [{ t: at(15, 5), v: 88 }, { t: at(15, 12), v: 87 }];
    expect(find(inp, 'SP-1')).toMatchObject({ onsetMs: at(15, 5), dueMs: at(15, 12) });
  });

  test('water: dry spell from the last drink; behind on pace since before a small drink; goal reached by a drink', () => {
    const inp = base(at(15));
    inp.hydrationTracked = true;
    inp.drinks = [{ t: at(11), ml: null }];
    expect(find(inp, 'HY-1')).toMatchObject({ onsetMs: at(11), dueMs: at(13, 30) });
    // 300 mL at 14:30 wasn't enough to catch up: behind since 0.15 x 16 h after waking (07:00 + 2 h 24)
    inp.drinks = [{ t: at(14, 30), ml: 300 }];
    inp.totalMl = 300;
    expect(find(inp, 'HY-2')).toMatchObject({ onsetMs: at(9, 24), dueMs: at(9, 24) });
    inp.drinks = [{ t: at(10), ml: 1000 }, { t: at(13), ml: 1100 }];
    inp.totalMl = 2100;
    expect(find(inp, 'HY-3')).toMatchObject({ onsetMs: at(13), dueMs: at(13) });
  });

  test('posture: from the pose (or sitting down) plus the minutes the rule waits', () => {
    const inp = base(at(10, 55));
    inp.posture = { windowStart: at(10, 0), pose: 'SLOUCH', poseOnset: at(10, 30) };
    expect(find(inp, 'PO-1')).toMatchObject({ onsetMs: at(10, 30), dueMs: at(10, 50) });
    expect(find(inp, 'PO-2')).toMatchObject({ onsetMs: at(10, 0), dueMs: at(10, 50) });
  });

  test('uneven steps: from the first uneven block to the end of the last one', () => {
    const s0 = at(9) - 160 * 1100;
    const mk = (i: number, stance: number, off: number): Stride => ({
      hs_ms: s0 + i * 1100 + off, stride_s: 1.1, stance_pct: stance, stance_s: 0.7, swing_s: 0.4,
      stance_imu_pct: stance, stance_imu_s: 0.7, swing_imu_s: 0.4, pushoff_pct: 65, tilt_range_deg: 55,
      pitch_range_deg: 40, peak_acc_ms2: 30, heel_share: 0.4, met1_share: 0.3, met5_share: 0.3,
      hs_imu_ms: s0 + i * 1100 + off, to_imu_ms: 0, to_fsr_ms: 0, bout: 0,
    });
    const inp = base(at(9, 1));
    inp.strides = { R: [...Array(160)].map((_, i) => mk(i, 66, 0)), L: [...Array(160)].map((_, i) => mk(i, 60, 550)) };
    // the two blocks of 60 steady right strides the rule compared
    const wins = gaitWindows(inp.strides.R, inp.strides.L, 60);
    expect(wins).toHaveLength(2);
    expect(find(inp, 'GA-1')).toMatchObject({ onsetMs: wins[0].start, dueMs: wins[1].end });
    expect(wins[1].end).toBeLessThan(inp.now);
  });
});
