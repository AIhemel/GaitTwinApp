// Default alert/reminder rules. Every value here is a DEFAULT: the user can change any of them in the
// app (overrides are stored by AlertRulesStore and merged over these, so new defaults still arrive).
// Source of the numbers: handoff/config/thresholds.json (thesis recordings, Dhaka, Oct 2026).

export type Severity = 'info' | 'nudge' | 'warning' | 'urgent';
export const SEVERITIES: Severity[] = ['info', 'nudge', 'warning', 'urgent'];

export interface RuleParam {
  key: string;
  label: string;
  unit: string;
  default: number;
  min: number;
  max: number;
}

export interface RuleDef {
  id: string;
  domain: 'data' | 'heart' | 'gait' | 'environment' | 'hydration' | 'posture';
  label: string;
  description: string;
  severity: Severity;
  enabled: boolean;
  cooldownMin: number; // the same rule (for the same node/target) can't notify again within this
  params: RuleParam[];
}

const P = (key: string, label: string, unit: string, def: number, min: number, max: number): RuleParam =>
  ({ key, label, unit, default: def, min, max });

export const RULE_DEFS: RuleDef[] = [
  // ---- gait
  {
    id: 'GA-1', domain: 'gait', label: 'Uneven steps during a walk', severity: 'nudge', enabled: true, cooldownMin: 60,
    description: 'Compares the left and right insole over blocks of steady strides while you walk (each foot uses its own clock, so this works even when the insoles are not in sync). Notifies when a measure differs by more than its limit in consecutive blocks; becomes a warning when it happens on several walks in a day. The limits below are fixed values from the thesis data.',
    params: [
      P('windowStrides', 'Strides per foot per block', 'strides', 60, 20, 200),
      P('consecutiveWindows', 'Uneven blocks in a row', 'blocks', 2, 1, 5),
      P('minWalkS', 'Only walks longer than', 's', 120, 30, 1800),
      P('floorStance', 'Stance difference limit', '%', 5, 1, 50),
      P('floorSwing', 'Swing time difference limit', '%', 10, 1, 50),
      P('floorPushoff', 'Push-off timing difference limit', '%', 5, 1, 50),
      P('floorTilt', 'Foot tilt range difference limit', '%', 15, 1, 80),
      P('floorStride', 'Stride time difference limit', '%', 3, 1, 30),
      P('walksForWarning', 'Warning when it happens on this many walks a day', 'walks', 3, 1, 10),
    ],
  },
  // ---- hydration
  {
    id: 'HY-1', domain: 'hydration', label: 'No drink for a while', severity: 'nudge', enabled: true, cooldownMin: 60,
    description: 'Reminds you to drink when no drink was detected by the bottle or tapped for this long while awake. Only active on days you use the bottle or tap drinks, so it never nags when water is not being tracked.',
    params: [P('gapHours', 'Remind after', 'h', 2.5, 0.5, 8)],
  },
  {
    id: 'HY-2', domain: 'hydration', label: 'Falling behind on water', severity: 'nudge', enabled: true, cooldownMin: 60,
    description: 'Checks your total against the target spread over your waking hours, and nudges when you are well behind for the time of day.',
    params: [P('paceFraction', 'Nudge below this share of the expected amount', '%', 60, 10, 100), P('wakingHours', 'Waking day length', 'h', 16, 8, 20)],
  },
  {
    id: 'HY-3', domain: 'hydration', label: 'Daily water goal reached', severity: 'info', enabled: true, cooldownMin: 60,
    description: 'A quiet note when you reach your daily water target (set in the profile below).',
    params: [],
  },
  // ---- posture
  {
    id: 'PO-1', domain: 'posture', label: 'Poor posture held', severity: 'nudge', enabled: true, cooldownMin: 60,
    description: 'The cushion has reported slouching or leaning (left, right or back) without a change for this long.',
    params: [P('minutes', 'Notify after', 'min', 20, 5, 120)],
  },
  {
    id: 'PO-2', domain: 'posture', label: 'Sitting too long', severity: 'nudge', enabled: true, cooldownMin: 60,
    description: 'You have been sitting on the cushion without getting up for this long. Standing resets it.',
    params: [P('minutes', 'Remind after', 'min', 50, 10, 240)],
  },
  // ---- environment
  {
    id: 'EN-1', domain: 'environment', label: 'Very high particles (PM2.5)', severity: 'warning', enabled: true, cooldownMin: 60,
    description: 'The average PM2.5 over the last few minutes is very high (smoke, fumes, a crowded or polluted place). Typical Dhaka levels (50-80) are shown in the Today tab instead of notifying all day.',
    params: [P('pm25', 'Level', 'µg/m³', 150, 35, 1000), P('windowMin', 'Averaged over', 'min', 5, 1, 60)],
  },
  {
    id: 'EN-2', domain: 'environment', label: 'Hazardous air (PM2.5)', severity: 'urgent', enabled: true, cooldownMin: 60,
    description: 'PM2.5 at a hazardous level. Takes the place of the very-high alert when both apply.',
    params: [P('pm25', 'Level', 'µg/m³', 250, 50, 3333), P('windowMin', 'Averaged over', 'min', 5, 1, 60)],
  },
  {
    id: 'EN-3', domain: 'environment', label: 'Stuffy room (CO₂)', severity: 'nudge', enabled: true, cooldownMin: 60,
    description: 'CO₂ builds up in closed or crowded rooms. Note: this sensor has read low in the thesis recordings (below outdoor air), so real levels may be higher than shown.',
    params: [P('co2', 'Level', 'ppm', 1000, 500, 5000), P('windowMin', 'Averaged over', 'min', 10, 1, 60)],
  },
  {
    id: 'EN-3H', domain: 'environment', label: 'Poor air (CO₂)', severity: 'warning', enabled: true, cooldownMin: 60,
    description: 'CO₂ high enough that ventilating is overdue. Takes the place of the stuffy-room nudge when both apply.',
    params: [P('co2', 'Level', 'ppm', 1500, 600, 10000), P('windowMin', 'Averaged over', 'min', 10, 1, 60)],
  },
  {
    id: 'EN-4', domain: 'environment', label: 'Loud surroundings', severity: 'info', enabled: true, cooldownMin: 60,
    description: 'The sound level, averaged as energy (Leq), has been loud for a while.',
    params: [P('dba', 'Level', 'dBA', 70, 50, 120), P('windowMin', 'Averaged over', 'min', 15, 1, 120)],
  },
  {
    id: 'EN-4H', domain: 'environment', label: 'Loud enough to risk hearing', severity: 'warning', enabled: true, cooldownMin: 60,
    description: 'Sustained loud sound at a level where hearing protection is advised. Takes the place of the loud note when both apply.',
    params: [P('dba', 'Level', 'dBA', 85, 60, 130), P('windowMin', 'Averaged over', 'min', 30, 1, 240)],
  },
  // ---- heart (from the band via Health Connect: arrives with each sync, every 5-15 min)
  {
    id: 'HR-1', domain: 'heart', label: 'High heart rate at rest', severity: 'warning', enabled: true, cooldownMin: 60,
    description: 'Heart rate above the level for this long while you were not walking or riding (band steps and insoles quiet). Minutes where the band read your step rhythm instead of your pulse are left out. Heart data arrives with each Health Connect sync.',
    params: [P('bpm', 'Above', 'bpm', 120, 90, 200), P('minutes', 'For', 'min', 10, 3, 60), P('maxAgeMin', 'Only from data in the last', 'min', 30, 10, 120)],
  },
  {
    id: 'HR-2', domain: 'heart', label: 'Very high heart rate at rest', severity: 'urgent', enabled: true, cooldownMin: 60,
    description: 'As above, at a much higher level. Takes the place of the high-heart-rate alert when both apply.',
    params: [P('bpm', 'Above', 'bpm', 150, 100, 220), P('minutes', 'For', 'min', 10, 3, 60), P('maxAgeMin', 'Only from data in the last', 'min', 30, 10, 120)],
  },
  {
    id: 'HR-3', domain: 'heart', label: 'Low heart rate while awake', severity: 'warning', enabled: true, cooldownMin: 60,
    description: 'Heart rate below the level for this long outside sleep and quiet hours.',
    params: [P('bpm', 'Below', 'bpm', 40, 25, 60), P('minutes', 'For', 'min', 10, 3, 60), P('maxAgeMin', 'Only from data in the last', 'min', 30, 10, 120)],
  },
  {
    id: 'SP-1', domain: 'heart', label: 'Low blood oxygen (SpO₂)', severity: 'warning', enabled: true, cooldownMin: 60,
    description: 'Several SpO₂ readings below the level close together. The band measures SpO₂ only now and then, so this can only be as quick as its readings.',
    params: [P('spo2', 'Below', '%', 90, 80, 96), P('readings', 'Readings needed', 'readings', 2, 1, 5), P('withinMin', 'Within', 'min', 10, 1, 60), P('maxAgeMin', 'Only from data in the last', 'min', 30, 10, 120)],
  },
  // ---- data quality
  {
    id: 'DQ-1',
    domain: 'data',
    label: 'Sensor dropout during a session',
    description: 'A node that is switched on stops sending data, or an insole streams well below its normal rate. Only checked while recording. The posture cushion is exempt: it sleeps whenever the seat is empty.',
    severity: 'info',
    enabled: true,
    cooldownMin: 60,
    params: [
      { key: 'silentMinGait', label: 'Insole silent for', unit: 'min', default: 2, min: 1, max: 60 },
      { key: 'silentMinEnvironment', label: 'Environment node silent for', unit: 'min', default: 2, min: 1, max: 60 },
      { key: 'silentMinHydration', label: 'Bottle silent for', unit: 'min', default: 10, min: 1, max: 120 },
      { key: 'expectedGaitHz', label: 'Normal insole rate', unit: 'Hz', default: 112, min: 10, max: 200 },
      { key: 'minRateFraction', label: 'Alert below this share of the normal rate', unit: '%', default: 80, min: 10, max: 100 },
    ],
  },
];

export const RULE_DEFS_BY_ID: Record<string, RuleDef> = Object.fromEntries(RULE_DEFS.map((r) => [r.id, r]));

export interface NotificationPolicy {
  maxNonUrgentPerDay: number;
  quietHoursEnabled: boolean;
  quietStartHour: number; // local hour, 0-23; only 'urgent' notifies inside quiet hours
  quietEndHour: number;
  groupWithinS: number;
}

export const DEFAULT_POLICY: NotificationPolicy = {
  maxNonUrgentPerDay: 8,
  quietHoursEnabled: true,
  quietStartHour: 23,
  quietEndHour: 7,
  groupWithinS: 120,
};
