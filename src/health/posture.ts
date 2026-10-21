// Port of the pipeline's posture_segments: how long each pose was held.
// A pose event is committed after the pose was held 10 s, so it started ~10 s earlier. A segment runs
// from that onset to the next event's onset, or to the end of the cushion's connection window (the
// cushion deep-sleeps ~10 s after the seat empties, so a disconnect is "stood up"). Replayed queue
// events have no reliable time and are not used for durations.

export interface PoseEvent { utcMs: number | null; pose: string; replayed: boolean }
export interface PoseSegment { pose: string; start: number; end: number }

export const POSE_COMMIT_MS = 10000;

export const postureSegments = (
  events: PoseEvent[], windows: [number, number][], relabel: Record<string, string> = {},
): PoseSegment[] => {
  const live = events
    .filter((e) => !e.replayed && e.utcMs !== null)
    .map((e) => ({ onset: (e.utcMs as number) - POSE_COMMIT_MS, pose: relabel[e.pose] ?? e.pose }));
  const segs: PoseSegment[] = [];
  for (const [w0, w1] of windows) {
    const inside = live.filter((e) => e.onset >= w0 - 15000 && e.onset < w1).sort((a, b) => a.onset - b.onset);
    inside.forEach((e, i) => {
      const end = i + 1 < inside.length ? inside[i + 1].onset : w1;
      segs.push({ pose: e.pose, start: Math.max(e.onset, w0), end });
    });
  }
  return segs;
};

// The cushion's poses, and which of them count as poor (thresholds.json posture.sustained_poor_posture).
export const UPRIGHT_POSES = ['STRAIGHT', 'UPRIGHT'];
export const POOR_POSES = ['SLOUCH', 'LEAN_BACKWARD', 'LEAN_LEFT', 'LEAN_RIGHT'];
