// Maps a streaming node's own clock (ESP32 millis() at sample time) onto the phone's UTC clock.
//
// Every packet gives one observation: rxMs - deviceMs = offset + delay, where delay (BLE queueing,
// connection-event wait, JS scheduling) is always >= 0. So the smallest observed (rx - device)
// over a recent window is the best estimate of the true offset, plus the stack's minimum latency.
// That minimum latency is roughly the same for every node on the same phone, so it cancels out
// when aligning nodes against each other — which is what left/right gait comparison needs.
//
// The window slides, so slow crystal drift (ESP32 ~±20 ppm ≈ 70 ms/hour) is followed rather than
// accumulated. The raw rxMs and deviceMs are still written to every CSV row, so a better
// whole-session fit can always be recomputed offline from the same data.

export type ObserveResult = 'ok' | 'reboot';

// A backwards jump larger than this means the node restarted (millis() reset to ~0).
const REBOOT_JUMP_MS = 1000;
// Below this many observations the estimate is usable but still settling.
const LOCK_MIN_SAMPLES = 20;

export class ClockSync {
  // Monotonic deque of (rxMs, offset): offsets increase from head to tail, so the head is the
  // window minimum. Amortized O(1) per packet — this runs ~100x/s per gait node.
  private rx: number[] = [];
  private off: number[] = [];
  private head = 0;
  private lastDeviceMs: number | null = null;
  private samples = 0;
  private lastDelay: number | null = null;

  constructor(private readonly windowMs = 10000) {}

  reset() {
    this.rx = [];
    this.off = [];
    this.head = 0;
    this.lastDeviceMs = null;
    this.samples = 0;
    this.lastDelay = null;
  }

  observe(deviceMs: number, rxMs: number): ObserveResult {
    let result: ObserveResult = 'ok';
    if (this.lastDeviceMs !== null && deviceMs < this.lastDeviceMs - REBOOT_JUMP_MS) {
      this.reset();
      result = 'reboot';
    }
    this.lastDeviceMs = deviceMs;

    const offset = rxMs - deviceMs;
    while (this.off.length > this.head && this.off[this.off.length - 1] >= offset) {
      this.off.pop();
      this.rx.pop();
    }
    this.off.push(offset);
    this.rx.push(rxMs);
    while (this.rx[this.head] < rxMs - this.windowMs) this.head++;
    // Compact occasionally so the arrays don't grow for the whole session.
    if (this.head > 1024) {
      this.rx = this.rx.slice(this.head);
      this.off = this.off.slice(this.head);
      this.head = 0;
    }

    this.samples++;
    this.lastDelay = offset - this.off[this.head];
    return result;
  }

  get offsetMs(): number | null {
    return this.off.length > this.head ? this.off[this.head] : null;
  }

  get locked(): boolean {
    return this.samples >= LOCK_MIN_SAMPLES;
  }

  get sampleCount(): number {
    return this.samples;
  }

  // Delay of the most recent packet relative to the fastest one in the window — a live view of
  // how much transport jitter the min-filter is removing.
  get lastDelayMs(): number | null {
    return this.lastDelay;
  }

  toUtc(deviceMs: number): number | null {
    const offset = this.offsetMs;
    return offset === null ? null : deviceMs + offset;
  }
}
