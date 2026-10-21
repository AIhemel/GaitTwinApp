// Port of the pipeline's smart-bottle analysis (daily_analysis.py: bottle_plateaus, analyze_bottle).
// Fused_mL is the primary channel. A drink is a step DOWN between two stable plateaus of the bottle
// content (removals count as drinks, thesis rule), timed when the bottle leaves the load cell.

export interface BottleSample { t: number; fused: number; weight: number; cap: number | null }
export interface Plateau { t0: number; t1: number; level: number; n: number }
export interface BottleEvent {
  t: number; beforeMl: number; afterMl: number; changeMl: number; kind: 'added' | 'removed'; lifted: boolean;
}

// pandas rolling(w, center=True, min_periods=mp) max - min.
const rollingRange = (v: number[], w: number, mp: number): number[] => {
  const left = Math.floor(w / 2);
  const right = Math.ceil(w / 2) - 1;
  return v.map((_, i) => {
    let lo = Infinity, hi = -Infinity, n = 0;
    for (let j = Math.max(0, i - left); j <= Math.min(v.length - 1, i + right); j++) {
      if (Number.isNaN(v[j])) continue;
      n++;
      lo = Math.min(lo, v[j]);
      hi = Math.max(hi, v[j]);
    }
    return n >= mp ? hi - lo : NaN;
  });
};

const medianOf = (x: number[]) => {
  const s = [...x].sort((a, b) => a - b);
  const m = (s.length - 1) / 2;
  return (s[Math.floor(m)] + s[Math.ceil(m)]) / 2;
};

// bottle_plateaus(t, w, tol_g=3, min_n=20, max_gap_s=10): stable stretches (20-sample range within
// 3 g) not spanning a data gap; neighbouring plateaus closer than 4 g are merged (load-cell drift).
export const bottlePlateaus = (t: number[], w: number[], tolG = 3, minN = 20, maxGapS = 10): Plateau[] => {
  const n = t.length;
  const run: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) run[i] = run[i - 1] + ((t[i] - t[i - 1]) / 1000 > maxGapS ? 1 : 0);
  const rng: number[] = new Array(n).fill(NaN);
  for (let a = 0; a < n;) {
    let b = a;
    while (b < n && run[b] === run[a]) b++;
    rollingRange(w.slice(a, b), minN, Math.floor(minN / 2)).forEach((r, k) => { rng[a + k] = r; });
    a = b;
  }
  const stable = rng.map((r) => !Number.isNaN(r) && r <= tolG);
  const ps: Plateau[] = [];
  for (let i = 0; i < n;) {
    if (!stable[i]) { i++; continue; }
    let j = i;
    while (j < n && stable[j] && run[j] === run[i]) j++;
    if (j - i >= minN) ps.push({ t0: t[i], t1: t[j - 1], level: medianOf(w.slice(i, j)), n: j - i });
    i = j;
  }
  const merged: Plateau[] = [];
  for (const p of ps) {
    const m = merged[merged.length - 1];
    if (m && Math.abs(p.level - m.level) < 4) {
      m.level = (m.level * m.n + p.level * p.n) / (m.n + p.n);
      m.t1 = p.t1;
      m.n += p.n;
    } else merged.push({ ...p });
  }
  return merged;
};

// analyze_bottle's core: live samples only, sorted by time; plateaus of Fused_mL; plateaus where the
// bottle was lifted (load cell < 2 g while Fused holds a capacitive estimate) are not resting levels;
// steps of >= 8 mL between plateaus are events.
export const bottleEvents = (samples: BottleSample[]): { plateaus: Plateau[]; events: BottleEvent[] } => {
  const h = [...samples].sort((a, b) => a.t - b.t);
  if (h.length < 60) return { plateaus: [], events: [] };
  const t = h.map((s) => s.t);
  let pl = bottlePlateaus(t, h.map((s) => s.fused));
  pl = pl.filter((p) => {
    const ws = h.filter((s) => s.t >= p.t0 && s.t <= p.t1).map((s) => s.weight);
    return !(medianOf(ws) < 2 && p.level > 5);
  });
  const events: BottleEvent[] = [];
  for (let k = 0; k + 1 < pl.length; k++) {
    const a = pl[k], b = pl[k + 1];
    const d = b.level - a.level;
    if (Math.abs(d) < 8) continue;
    const between = h.filter((s) => s.t > a.t1 && s.t < b.t0);
    events.push({
      t: d > 0 ? b.t0 : a.t1, // a drink starts when the bottle leaves the load cell
      beforeMl: a.level, afterMl: b.level, changeMl: d, kind: d > 0 ? 'added' : 'removed',
      lifted: between.length > 0 && Math.min(...between.map((s) => s.weight)) < 2 && Math.min(a.level, b.level) > 5,
    });
  }
  return { plateaus: pl, events };
};
