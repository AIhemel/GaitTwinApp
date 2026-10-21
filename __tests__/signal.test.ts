import {
  butter2Lowpass, filtfilt, gradient, percentile, rollingQuantileCentered, roundHalfEven,
} from '../src/health/signal';
import { loadJson } from '../testUtils/fixtures';

// Expected values computed by SciPy / NumPy / pandas (scripts/make_health_fixtures.py).
const E = loadJson('signal_expected.json');

const maxAbsDiff = (a: ArrayLike<number>, b: number[]) => {
  let m = 0;
  for (let i = 0; i < b.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

test('Butterworth coefficients match scipy.signal.butter(2, 6/(fs/2))', () => {
  const { b, a } = butter2Lowpass(6 / (E.fs / 2));
  expect(maxAbsDiff(b, E.butter_b)).toBeLessThan(1e-12);
  expect(maxAbsDiff(a, E.butter_a)).toBeLessThan(1e-12);
});

test('filtfilt matches scipy.signal.filtfilt (odd padding, steady-state start)', () => {
  const { b, a } = butter2Lowpass(6 / (E.fs / 2));
  expect(maxAbsDiff(filtfilt(b, a, E.x), E.filtfilt)).toBeLessThan(1e-9);
});

test('centered rolling quantiles match pandas (odd and even windows, min_periods, bfill/ffill)', () => {
  expect(maxAbsDiff(rollingQuantileCentered(E.x, 101, 25, 0.05), E.rolling_q05_w101)).toBeLessThan(1e-9);
  expect(maxAbsDiff(rollingQuantileCentered(E.sub, 20, 5, 0.95), E.rolling_q95_w20_sub)).toBeLessThan(1e-9);
});

test('percentile and gradient on uneven spacing match NumPy', () => {
  expect(percentile(E.x, 95)).toBeCloseTo(E.percentile_95, 9);
  expect(percentile(E.x, 5)).toBeCloseTo(E.percentile_5, 9);
  const t = E.t_nonuni.map((v: number) => v / 1000);
  expect(maxAbsDiff(gradient(E.y_nonuni, t), E.gradient_nonuni)).toBeLessThan(1e-9);
});

test("round() like Python's (halves to even)", () => {
  expect([roundHalfEven(10.5), roundHalfEven(11.5), roundHalfEven(11.24)]).toEqual([10, 12, 11]);
});
