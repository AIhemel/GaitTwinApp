import { StreamMonitor } from '../src/services/StreamMonitor';

// Feeds `seconds` of a ~112 Hz insole stream into a monitor. lossPattern(t) = true drops the packet,
// mimicking Spriha's right insole (data missing in ~180 ms chunks, about half the time).
const feed = (m: StreamMonitor, seconds: number, drop: (t: number) => boolean, delay = 10) => {
  let t = 0;
  for (let s = 0; s < seconds; s++) {
    for (; t < (s + 1) * 1000; t += 9) {
      if (!drop(t)) m.onPacket(1_790_000_000_000 + t + delay, 5000 + t, delay);
    }
    m.tickSecond();
  }
};

test('a healthy insole: ~111 Hz, no loss', () => {
  const m = new StreamMonitor(40);
  feed(m, 30, () => false);
  const w = m.window(10);
  expect(w.rateHz).toBeCloseTo(111, 0);
  expect(w.lossPct).toBe(0);
  expect(w.delayMeanMs).toBe(10);
});

test("Spriha's right insole: data missing in 180 ms chunks reads as ~50 % loss at ~56 Hz", () => {
  const m = new StreamMonitor(40);
  feed(m, 60, (t) => Math.floor(t / 180) % 2 === 1);
  const w = m.window(60);
  expect(w.lossPct!).toBeGreaterThan(45);
  expect(w.lossPct!).toBeLessThan(55);
  expect(w.rateHz).toBeGreaterThan(50);
  expect(w.rateHz).toBeLessThan(62);
});

test('packets without a node clock (replayed records) count toward rate, not loss', () => {
  const m = new StreamMonitor(3000);
  m.onPacket(1000, null);
  m.onPacket(1100, null);
  m.tickSecond();
  expect(m.window(1)).toMatchObject({ packets: 2, lossPct: null });
});

test('a reconnect does not count the time away as loss', () => {
  const m = new StreamMonitor(40);
  m.onPacket(0, 1000);
  m.onPacket(9, 1009);
  m.resetChain();
  m.onPacket(60000, 61000); // 60 s later, after a disconnect
  m.onPacket(60009, 61009);
  m.tickSecond();
  expect(m.window(1).lossPct).toBe(0);
});
