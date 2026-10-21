import { DqNodeState, evaluateDataQuality } from '../src/health/dataQuality';
import { RULE_DEFS_BY_ID } from '../src/config/alertRules';

const params = Object.fromEntries(RULE_DEFS_BY_ID['DQ-1'].params.map((p) => [p.key, p.default]));
const T0 = 1_790_000_000_000;
const MIN = 60000;

const node = (over: Partial<DqNodeState>): DqNodeState => ({
  nodeId: 'GAIT', kind: 'gait', lastPacketAt: T0, connectedSince: T0 - 10 * MIN, rateHz60: 112, lossPct60: 0, ...over,
});

test('healthy nodes produce nothing', () => {
  expect(evaluateDataQuality([node({})], T0 - 30 * MIN, T0 + 1000, params)).toEqual([]);
});

test('an insole silent for 2 min is reported (environment node stopping mid-session is the same rule)', () => {
  const out = evaluateDataQuality(
    [node({ nodeId: 'GAIT_LEFT', lastPacketAt: T0, connectedSince: null }), node({ nodeId: 'ENVIRONMENT', kind: 'environment', lastPacketAt: T0 })],
    T0 - 30 * MIN, T0 + 2 * MIN + 5000, params);
  expect(out.map((f) => [f.target, f.problem])).toEqual([['GAIT_LEFT', 'silent'], ['ENVIRONMENT', 'silent']]);
  expect(out[0].title).toBe('Left insole: no data for 2 min');
});

test('the bottle gets 10 min before it counts as silent', () => {
  const bottle = node({ nodeId: 'HYDRATION', kind: 'hydration', lastPacketAt: T0 });
  expect(evaluateDataQuality([bottle], T0 - MIN, T0 + 5 * MIN, params)).toEqual([]);
  expect(evaluateDataQuality([bottle], T0 - MIN, T0 + 10 * MIN, params)).toHaveLength(1);
});

test('a node that never sent anything counts silence from the session start', () => {
  const out = evaluateDataQuality([node({ lastPacketAt: null, connectedSince: null })], T0, T0 + 3 * MIN, params);
  expect(out[0].values.silent_min).toBe(3);
});

test('an insole streaming at 61 Hz (below 80 % of 112) is reported with its loss', () => {
  const out = evaluateDataQuality([node({ rateHz60: 61, lossPct60: 48 })], T0 - 30 * MIN, T0, params);
  expect(out).toHaveLength(1);
  expect(out[0].problem).toBe('low_rate');
  expect(out[0].body).toContain('48 % of the data lost');
});

test('no low-rate alert in the first minute after connecting (the rate window is still filling)', () => {
  const out = evaluateDataQuality([node({ rateHz60: 30, connectedSince: T0 - 30000 })], T0 - 30 * MIN, T0, params);
  expect(out).toEqual([]);
});

test('edited parameters apply: a 60 % threshold accepts 80 Hz', () => {
  const out = evaluateDataQuality([node({ rateHz60: 80 })], T0 - 30 * MIN, T0, { ...params, minRateFraction: 60 });
  expect(out).toEqual([]);
});
