import { ClockSync } from '../src/services/ClockSync';

// Deterministic PRNG so the test is repeatable.
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

// Simulates a node whose clock started `bootOffsetMs` before the phone's epoch reference and
// runs `ppm` fast, sampled every `periodMs`, with BLE/JS delay = minDelay + exponential jitter.
const simulate = (opts: { ppm: number; periodMs: number; minDelayMs: number; seconds: number; seed: number }) => {
  const rand = rng(opts.seed);
  const phoneStart = 1_790_000_000_000;
  const samples: { deviceMs: number; rxMs: number; trueUtc: number }[] = [];
  for (let t = 0; t < opts.seconds * 1000; t += opts.periodMs) {
    const trueUtc = phoneStart + t;
    const deviceMs = Math.round(12345 + t * (1 + opts.ppm * 1e-6));
    const delay = opts.minDelayMs + -Math.log(1 - rand()) * 15 + (rand() < 0.02 ? 200 : 0);
    samples.push({ deviceMs, rxMs: Math.round(trueUtc + delay), trueUtc });
  }
  return samples;
};

test('min-delay filter recovers true sample time to within the stack minimum latency, through drift', () => {
  const minDelayMs = 4;
  const clock = new ClockSync();
  const samples = simulate({ ppm: 40, periodMs: 10, minDelayMs, seconds: 600, seed: 7 });
  let worst = 0;
  samples.forEach((s, i) => {
    clock.observe(s.deviceMs, s.rxMs);
    if (i > 2000) {
      // Bias is the constant minimum latency (cancels between nodes); what remains must be small.
      const err = clock.toUtc(s.deviceMs)! - s.trueUtc - minDelayMs;
      worst = Math.max(worst, Math.abs(err));
    }
  });
  expect(worst).toBeLessThanOrEqual(2);
  expect(clock.locked).toBe(true);
});

test('two nodes started minutes apart align to within a few ms', () => {
  const right = new ClockSync();
  const left = new ClockSync();
  const r = simulate({ ppm: 25, periodMs: 10, minDelayMs: 4, seconds: 400, seed: 1 });
  // The left foot powered on 4 minutes later: different device clock, same phone time base.
  const l = simulate({ ppm: -30, periodMs: 10, minDelayMs: 4, seconds: 400, seed: 2 })
    .map((s) => ({ ...s, deviceMs: s.deviceMs - 240000 }));
  r.forEach((s) => right.observe(s.deviceMs, s.rxMs));
  l.forEach((s) => left.observe(s.deviceMs, s.rxMs));
  // The same physical instant (last sample) maps to the same utc on both feet.
  const rLast = r[r.length - 1];
  const lLast = l[l.length - 1];
  expect(Math.abs(right.toUtc(rLast.deviceMs)! - left.toUtc(lLast.deviceMs)!)).toBeLessThanOrEqual(3);
});

test('a backwards jump in device time is reported as a reboot and resets the estimate', () => {
  const clock = new ClockSync();
  expect(clock.observe(50000, 1000050000)).toBe('ok');
  expect(clock.observe(50020, 1000050021)).toBe('ok');
  expect(clock.observe(100, 1000060000)).toBe('reboot');
  expect(clock.offsetMs).toBe(1000060000 - 100);
  expect(clock.sampleCount).toBe(1);
});

test('no estimate before the first packet', () => {
  expect(new ClockSync().toUtc(1000)).toBeNull();
});
