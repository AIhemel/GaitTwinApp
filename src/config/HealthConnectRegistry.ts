import type { RecordType } from 'react-native-health-connect';

// One entry per Health Connect record type this app reads. Adding a new type is just a new
// row here plus a matching <uses-permission> line in AndroidManifest.xml — no other file needs
// a structural change, since HealthConnectService.ts's row-builders operate on `shape`, not on
// individual record types.
export type HealthDataShape = 'instant' | 'interval' | 'session' | 'series';

export interface HealthDataTypeConfig {
  id: string;
  recordType: RecordType;
  shape: HealthDataShape;
  permission: string;
  unit: string;
  label: string;
  color: string;
}

// Deliberately excludes Health Connect's reproductive-health record types (MenstruationFlow,
// MenstruationPeriod, OvulationTest, CervicalMucus, SexualActivity, IntermenstrualBleeding) —
// not part of fitness-band tracking, and requesting them would add permission-consent friction
// with no benefit here. Add more types below if needed later.
export const HEALTH_DATA_TYPES: HealthDataTypeConfig[] = [
  { id: 'STEPS', recordType: 'Steps', shape: 'interval', permission: 'android.permission.health.READ_STEPS', unit: 'steps', label: 'Steps', color: '#2b6cb0' },
  { id: 'DISTANCE', recordType: 'Distance', shape: 'interval', permission: 'android.permission.health.READ_DISTANCE', unit: 'm', label: 'Distance', color: '#2b6cb0' },
  { id: 'HEART_RATE', recordType: 'HeartRate', shape: 'series', permission: 'android.permission.health.READ_HEART_RATE', unit: 'bpm', label: 'Heart Rate', color: '#e53e3e' },
  { id: 'RESTING_HEART_RATE', recordType: 'RestingHeartRate', shape: 'instant', permission: 'android.permission.health.READ_RESTING_HEART_RATE', unit: 'bpm', label: 'Resting Heart Rate', color: '#e53e3e' },
  { id: 'BLOOD_PRESSURE', recordType: 'BloodPressure', shape: 'instant', permission: 'android.permission.health.READ_BLOOD_PRESSURE', unit: 'mmHg', label: 'Blood Pressure', color: '#e53e3e' },
  { id: 'SLEEP_SESSION', recordType: 'SleepSession', shape: 'session', permission: 'android.permission.health.READ_SLEEP', unit: 'min', label: 'Sleep', color: '#805ad5' },
  { id: 'ACTIVE_CALORIES_BURNED', recordType: 'ActiveCaloriesBurned', shape: 'interval', permission: 'android.permission.health.READ_ACTIVE_CALORIES_BURNED', unit: 'kcal', label: 'Active Calories', color: '#dd6b20' },
  { id: 'TOTAL_CALORIES_BURNED', recordType: 'TotalCaloriesBurned', shape: 'interval', permission: 'android.permission.health.READ_TOTAL_CALORIES_BURNED', unit: 'kcal', label: 'Total Calories', color: '#dd6b20' },
  { id: 'OXYGEN_SATURATION', recordType: 'OxygenSaturation', shape: 'instant', permission: 'android.permission.health.READ_OXYGEN_SATURATION', unit: '%', label: 'SpO2', color: '#3182ce' },
  { id: 'EXERCISE_SESSION', recordType: 'ExerciseSession', shape: 'session', permission: 'android.permission.health.READ_EXERCISE', unit: 'min', label: 'Exercise', color: '#38a169' },
  { id: 'SPEED', recordType: 'Speed', shape: 'series', permission: 'android.permission.health.READ_SPEED', unit: 'm/s', label: 'Speed', color: '#2b6cb0' },
  { id: 'FLOORS_CLIMBED', recordType: 'FloorsClimbed', shape: 'interval', permission: 'android.permission.health.READ_FLOORS_CLIMBED', unit: 'floors', label: 'Floors Climbed', color: '#2b6cb0' },
  { id: 'VO2_MAX', recordType: 'Vo2Max', shape: 'instant', permission: 'android.permission.health.READ_VO2_MAX', unit: 'mL/kg/min', label: 'VO2 Max', color: '#38a169' },
  { id: 'RESPIRATORY_RATE', recordType: 'RespiratoryRate', shape: 'instant', permission: 'android.permission.health.READ_RESPIRATORY_RATE', unit: 'breaths/min', label: 'Respiratory Rate', color: '#3182ce' },
  { id: 'BODY_TEMPERATURE', recordType: 'BodyTemperature', shape: 'instant', permission: 'android.permission.health.READ_BODY_TEMPERATURE', unit: '°C', label: 'Body Temperature', color: '#d69e2e' },
  { id: 'WEIGHT', recordType: 'Weight', shape: 'instant', permission: 'android.permission.health.READ_WEIGHT', unit: 'kg', label: 'Weight', color: '#718096' },
  { id: 'HEIGHT', recordType: 'Height', shape: 'instant', permission: 'android.permission.health.READ_HEIGHT', unit: 'm', label: 'Height', color: '#718096' },
];

export const HEALTH_DATA_TYPES_BY_ID: Record<string, HealthDataTypeConfig> =
  Object.fromEntries(HEALTH_DATA_TYPES.map((t) => [t.id, t]));
