// DQ-1: a node that should be streaming has gone silent, or an insole is streaming far below its
// normal rate (= packets being lost). Pure function: the orchestrator supplies the node states and
// the rule parameters (resolveRule('DQ-1').params), and delivers whatever comes back.

export type DqKind = 'gait' | 'environment' | 'hydration';

export interface DqNodeState {
  nodeId: string;
  kind: DqKind;
  lastPacketAt: number | null;
  connectedSince: number | null; // null while not connected
  rateHz60: number; // packets/s over the last 60 s
  lossPct60: number | null;
}

export interface DqFinding {
  target: string;
  problem: 'silent' | 'low_rate';
  title: string;
  body: string;
  values: Record<string, number | string | null>;
}

export const NODE_LABELS: Record<string, string> = {
  GAIT: 'Right insole',
  GAIT_LEFT: 'Left insole',
  ENVIRONMENT: 'Environment node',
  HYDRATION: 'Smart bottle',
  POSTURE: 'Posture cushion',
};

const SILENT_PARAM: Record<DqKind, string> = {
  gait: 'silentMinGait',
  environment: 'silentMinEnvironment',
  hydration: 'silentMinHydration',
};

export const evaluateDataQuality = (
  nodes: DqNodeState[], sessionStartMs: number, now: number, params: Record<string, number>,
): DqFinding[] => {
  const out: DqFinding[] = [];
  for (const n of nodes) {
    const name = NODE_LABELS[n.nodeId] ?? n.nodeId;
    // Silence counts from the session start for a node that hasn't sent anything since.
    const since = Math.max(n.lastPacketAt ?? sessionStartMs, sessionStartMs);
    const silentMin = (now - since) / 60000;
    if (silentMin >= params[SILENT_PARAM[n.kind]]) {
      const m = Math.floor(silentMin);
      out.push({
        target: n.nodeId,
        problem: 'silent',
        title: `${name}: no data for ${m} min`,
        body: `No data from the ${name.toLowerCase()} for ${m} min while recording. Check it is switched on and near the phone; the app reconnects automatically when it comes back.`,
        values: { silent_min: +silentMin.toFixed(1), connected: n.connectedSince === null ? 0 : 1 },
      });
      continue;
    }
    if (n.kind !== 'gait' || n.connectedSince === null || now - n.connectedSince < 60000) continue;
    const minHz = (params.expectedGaitHz * params.minRateFraction) / 100;
    if (n.rateHz60 < minHz) {
      const hz = Math.round(n.rateHz60);
      const loss = n.lossPct60 === null ? null : Math.round(n.lossPct60);
      out.push({
        target: n.nodeId,
        problem: 'low_rate',
        title: `${name} streaming at ${hz} Hz`,
        body: `The ${name.toLowerCase()} is sending ${hz} samples/s instead of about ${params.expectedGaitHz}${loss !== null ? ` (${loss} % of the data lost)` : ''}. Try keeping the phone closer to that foot, e.g. in a pocket on the same side.`,
        values: { rate_hz: +n.rateHz60.toFixed(1), loss_pct: loss, expected_hz: params.expectedGaitHz },
      });
    }
  }
  return out;
};
