// Per-node stream health: packet rate, data loss and queueing delay.
//
// Loss without sequence numbers: the nodes stamp every packet with their own clock (gait/hydration
// millis(); environment is timed on arrival), so a jump in that clock much larger than the normal
// packet spacing is time the node streamed but the phone never received. loss % = time inside such
// jumps / time covered. On Spriha's right insole this gives ~50 % (30 s of 60 s missing, in ~180 ms
// chunks), the left insole ~0 %.

export interface WindowStats {
  packets: number;
  rateHz: number;
  lossPct: number | null; // null when no clock-continuous packets arrived in the window
  delayMeanMs: number | null; // arrival delay above the clock estimate (queueing), millis nodes only
  delayMaxMs: number | null;
}

interface Bucket { packets: number; gapMs: number; spanMs: number; delaySum: number; delayN: number; delayMax: number }

const emptyBucket = (): Bucket => ({ packets: 0, gapMs: 0, spanMs: 0, delaySum: 0, delayN: 0, delayMax: 0 });

export class StreamMonitor {
  private current = emptyBucket();
  private seconds: Bucket[] = []; // last 60 completed one-second buckets, newest last
  private lastT: number | null = null;
  lastPacketAt: number | null = null;
  rssi: number | null = null;
  connectedSince: number | null = null;

  // gapMs: a clock step larger than this counts as lost data (gait ~9 ms spacing -> 40 ms;
  // hydration 1 s -> 3 s; environment 10 s -> 15 s).
  constructor(private readonly gapMs: number) {}

  // t: the node's own continuous clock for this packet (device_ms, or arrival time for nodes without
  // one); null for packets that must not count toward loss (e.g. replayed offline records).
  onPacket(rxMs: number, t: number | null, delayMs: number | null = null) {
    const b = this.current;
    b.packets++;
    this.lastPacketAt = rxMs;
    if (delayMs !== null && Number.isFinite(delayMs)) {
      b.delaySum += delayMs;
      b.delayN++;
      if (delayMs > b.delayMax) b.delayMax = delayMs;
    }
    if (t === null) return;
    if (this.lastT !== null && t > this.lastT) {
      const step = t - this.lastT;
      b.spanMs += step;
      if (step > this.gapMs) b.gapMs += step;
    }
    // A backwards step (reboot) just restarts the chain.
    this.lastT = t;
  }

  // A new connection: the previous packet is not a valid neighbour for the next one.
  resetChain() {
    this.lastT = null;
  }

  // Called once per second by the UI pump.
  tickSecond() {
    this.seconds.push(this.current);
    if (this.seconds.length > 60) this.seconds.shift();
    this.current = emptyBucket();
  }

  // Stats over the last `n` completed seconds.
  window(n: number): WindowStats {
    const recent = this.seconds.slice(-n);
    const sum = recent.reduce((a, b) => ({
      packets: a.packets + b.packets, gapMs: a.gapMs + b.gapMs, spanMs: a.spanMs + b.spanMs,
      delaySum: a.delaySum + b.delaySum, delayN: a.delayN + b.delayN, delayMax: Math.max(a.delayMax, b.delayMax),
    }), emptyBucket());
    return {
      packets: sum.packets,
      rateHz: recent.length ? sum.packets / recent.length : 0,
      lossPct: sum.spanMs > 0 ? (100 * sum.gapMs) / sum.spanMs : null,
      delayMeanMs: sum.delayN ? sum.delaySum / sum.delayN : null,
      delayMaxMs: sum.delayN ? sum.delayMax : null,
    };
  }
}
