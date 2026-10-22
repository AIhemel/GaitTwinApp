import { buildBaselines, PastDay, robustStat, robustZ, sleepingHrBaseline, usable } from '../src/health/baselines';
import { evaluateRules, RuleInputs } from '../src/health/rules';
import { RULE_DEFS } from '../src/config/alertRules';
import { ResolvedRule } from '../src/store/AlertRulesStore';
import { EnvMinute } from '../src/health/daySummary';
import { Stride } from '../src/health/gait';

const MIN = 60000;
const DAY0 = new Date(2026, 9, 14).getTime();
const at = (h: number, m = 0) => DAY0 + h * 3600000 + m * MIN;

// A walk of n strides per foot starting at `start`, with the given stance % per foot.
const walk = (start: number, n: number, stanceR: number, stanceL: number) => {
  const mk = (i: number, stance: number, off: number): Stride => ({
    hs_ms: start + i * 1100 + off, stride_s: 1.1, stance_pct: stance, stance_s: 0.7, swing_s: 0.4,
    stance_imu_pct: stance, stance_imu_s: 0.7, swing_imu_s: 0.4, pushoff_pct: 65, tilt_range_deg: 55,
    pitch_range_deg: 40, peak_acc_ms2: 30, heel_share: 0.4, met1_share: 0.3, met5_share: 0.3,
    hs_imu_ms: start + i * 1100 + off, to_imu_ms: 0, to_fsr_ms: 0, bout: 0,
  });
  return { R: [...Array(n)].map((_, i) => mk(i, stanceR, 0)), L: [...Array(n)].map((_, i) => mk(i, stanceL, 550)) };
};

// A past day: someone whose right stance is always ~8 % longer, sitting HR ~70, indoor PM2.5 ~50.
const pastDay = (k: number): PastDay => ({
  date: `2026-10-0${k + 1}`,
  strides: walk(DAY0 - (10 - k) * 86400000, 200, 64 + (k % 2) * 0.4, 59),
  minutes: [...Array(120)].map((_, i) => ({
    hr: String(69 + (i % 3)), steps_band: '0', steps_insole: '', context: 'awake', hr_cadence_lock: '0',
    pm25: String(48 + (i % 5)), co2_ppm: String(600 + (i % 20)), dba: '45',
  })),
  summary: { gait: { stepsBand: 5000 + k * 100 }, heart: { awakeMeanHr: 80, sleepMeanHr: 60 + (k % 3) }, hydration: { totalMl: 1500 }, posture: { uprightPct: 70 } },
});

describe('baseline maths', () => {
  test('median and MAD per measure, counted per day', () => {
    const s = robustStat([['a', 1], ['a', 2], ['b', 3], ['b', 4], ['c', 100]])!;
    expect(s).toEqual({ median: 3, mad: 1, n: 5, days: 3 });
    expect(robustZ(10, s, 0)).toBeCloseTo(7 / 1.4826, 6);
    expect(robustZ(10, { ...s, mad: 0 }, 2)).toBe(3.5); // spread floored
    expect(usable(s, 3)).toBe(true);
    expect(usable(s, 4)).toBe(false);
  });

  test('learned from past days: asymmetry, walks, sitting HR, air per place, nightly HR, daily totals', () => {
    const b = buildBaselines([0, 1, 2].map(pastDay));
    expect(b.days).toHaveLength(3);
    expect(b.gaitSi.floorStance.median).toBeGreaterThan(7.5);
    expect(b.gaitSi.floorStance.days).toBe(3);
    expect(b.gaitWalk.cadence.median).toBeCloseTo(120 / 1.1, 3);
    expect(b.sittingHr).toMatchObject({ median: 70, days: 3 });
    expect(b.envByPlace.indoor?.pm25?.median).toBe(50);
    expect(b.envByPlace.outdoor).toBeUndefined();
    expect(b.daily.steps?.median).toBe(5100);
    expect(sleepingHrBaseline(b, 7)).toEqual({ median: 61, nights: 3 });
  });
});

describe('personal rules', () => {
  const R = (): Record<string, ResolvedRule> => Object.fromEntries(RULE_DEFS.map((d) => [d.id, {
    id: d.id, enabled: d.enabled, severity: d.severity, cooldownMin: d.cooldownMin,
    params: Object.fromEntries(d.params.map((p) => [p.key, p.default])),
  }]));
  const env = (from: number, n: number, pm25: number): [number, EnvMinute][] =>
    [...Array(n)].map((_, i) => [from + i * MIN, { co2: [0, 0], temp: [0, 0], rh: [0, 0], pm25: [pm25, 1], pm10: [0, 0], dbaEnergy: [0, 0], warmup: false }]);
  const inputs = (now: number, over: Partial<RuleInputs> = {}): RuleInputs => ({
    now, env: [], heart: { hrByMinute: new Map(), stepsByMinute: new Map(), spo2: [], sleep: null },
    strides: { R: [], L: [] }, labels: [], drinks: [], hydrationTracked: false, totalMl: null, targetMl: 2000,
    wakeAt: at(7), posture: { windowStart: null, pose: null, poseOnset: null }, gaitWalksAlertedToday: 0,
    date: '2026-10-14', baselines: buildBaselines([0, 1, 2].map(pastDay)), minBaselineDays: 3, place: 'indoor', sleepMeanHr: null, ...over,
  });

  test('someone who always walks ~8 % asymmetric is not alerted at 8 % (their usual), but is at 25 %', () => {
    const usualWalk = inputs(at(9, 1), { strides: walk(at(9) - 160 * 1100, 160, 64, 59) });
    expect(evaluateRules(usualWalk, R()).map((f) => f.ruleId)).not.toContain('GA-1');
    // the same 8 % without a learned usual: the fixed ±5 % limit applies
    expect(evaluateRules({ ...usualWalk, baselines: null }, R()).map((f) => f.ruleId)).toContain('GA-1');
    const worse = evaluateRules(inputs(at(9, 1), { strides: walk(at(9) - 160 * 1100, 160, 72, 56) }), R());
    const f = worse.find((x) => x.ruleId === 'GA-1')!;
    expect(f.body).toMatch(/your usual difference is \+8\.\d %/);
  });

  test('sitting heart rate far above your usual (70) for 15 min -> HR-4; not before 3 days of data', () => {
    const hr = new Map([...Array(15)].map((_, i) => [at(15) + i * MIN, 92]));
    const inp = inputs(at(15, 16), { heart: { hrByMinute: hr, stepsByMinute: new Map(), spo2: [], sleep: null } });
    expect(evaluateRules(inp, R()).map((f) => f.ruleId)).toEqual(['HR-4']);
    expect(evaluateRules({ ...inp, minBaselineDays: 4 }, R())).toEqual([]);
  });

  test('sleeping heart rate 6 above the median of past nights -> HR-5 morning note', () => {
    const f = evaluateRules(inputs(at(8), { sleepMeanHr: 67 }), R());
    expect(f.map((x) => x.ruleId)).toEqual(['HR-5']);
    expect(f[0].body).toContain('6 above your usual 61');
    expect(evaluateRules(inputs(at(8), { sleepMeanHr: 65 }), R())).toEqual([]);
  });

  test('indoor PM2.5 of 110: below the fixed 150 limit, but far above your usual 50 indoors -> EN-6', () => {
    const f = evaluateRules(inputs(at(12, 5), { env: env(at(12), 5, 110) }), R());
    expect(f.map((x) => x.ruleId)).toEqual(['EN-6']);
    expect(f[0].title).toBe('Unusual indoors: PM2.5 110');
    // over the fixed limit: only the fixed-limit alert, not both
    expect(evaluateRules(inputs(at(12, 5), { env: env(at(12), 5, 200) }), R()).map((x) => x.ruleId)).toEqual(['EN-1']);
    // no usual learned for vehicles yet
    expect(evaluateRules(inputs(at(12, 5), { env: env(at(12), 5, 110), place: 'vehicle' }), R())).toEqual([]);
  });
});
