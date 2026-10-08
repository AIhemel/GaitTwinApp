import { Buffer } from 'buffer';

// Byte layouts of every node's BLE notification, matching the ESP32 firmware's
// `__attribute__((packed))` structs exactly. All fields little-endian. If a firmware struct changes,
// change it here and in the node's CSV header (SessionWriter.STREAM_HEADERS) together.

const finiteOrNull = (x: number): number | null => (Number.isFinite(x) ? x : null);

// ==========================================
// GAIT (both feet, same firmware struct SensorData, 46 bytes)
//   uint32 timestamp (millis) @0, float pitch @4, roll @8, qI @12, qJ @16, qK @20, qR @24,
//   uint16 fsrHeel @28, fsrMet1 @30, fsrMet5 @32, float accX @34, accY @38, accZ @42
// ==========================================
export const GAIT_PACKET_BYTES = 46;

export interface GaitPacket {
  deviceMs: number;
  pitch: number; roll: number; yaw: number;
  qI: number; qJ: number; qK: number; qR: number;
  heel: number; mid: number; toe: number;
  accX: number; accY: number; accZ: number;
}

// The firmware sends the quaternion but no yaw, so yaw is derived (standard ZYX-Euler yaw for an
// x,y,z,w quaternion). Not independently verified against this BNO08x mounting's axis convention —
// sanity-check it against a known rotation (turning the foot ~90° should move it ~90°); if it's off,
// the fix is a sign flip or swapped axis here, not a decode offset.
export const quaternionToYawDegrees = (qI: number, qJ: number, qK: number, qR: number): number =>
  Math.atan2(2 * (qR * qK + qI * qJ), 1 - 2 * (qJ * qJ + qK * qK)) * (180 / Math.PI);

export const decodeGait = (buf: Buffer): GaitPacket | null => {
  if (buf.length !== GAIT_PACKET_BYTES) return null;
  const qI = buf.readFloatLE(12);
  const qJ = buf.readFloatLE(16);
  const qK = buf.readFloatLE(20);
  const qR = buf.readFloatLE(24);
  return {
    deviceMs: buf.readUInt32LE(0),
    pitch: buf.readFloatLE(4),
    roll: buf.readFloatLE(8),
    yaw: quaternionToYawDegrees(qI, qJ, qK, qR),
    qI, qJ, qK, qR,
    heel: buf.readUInt16LE(28),
    mid: buf.readUInt16LE(30),
    toe: buf.readUInt16LE(32),
    accX: buf.readFloatLE(34),
    accY: buf.readFloatLE(38),
    accZ: buf.readFloatLE(42),
  };
};

// ==========================================
// HYDRATION (HydrationData, 16 bytes)
//   uint32 timestamp (millis) @0, float weightGrams @4, capVolumeML @8, fusedVolumeML @12
// ==========================================
export const HYDRATION_PACKET_BYTES = 16;

export interface HydrationPacket { deviceMs: number; weightGrams: number; capVolumeML: number; fusedVolumeML: number }

export const decodeHydration = (buf: Buffer): HydrationPacket | null => {
  if (buf.length !== HYDRATION_PACKET_BYTES) return null;
  return {
    deviceMs: buf.readUInt32LE(0),
    weightGrams: buf.readFloatLE(4),
    capVolumeML: buf.readFloatLE(8),
    fusedVolumeML: buf.readFloatLE(12),
  };
};

// ==========================================
// ENVIRONMENT (EnvNodeData, 34 bytes) — one packet per 10 s averaging window, live only
// (the node keeps nothing while disconnected).
//   uint32 timestamp (Unix SECONDS from GPS; 0 until the first GPS time fix) @0,
//   float co2 @4, temperature @8, humidity @12, uint16 pm1 @16, pm25 @18, pm10 @20,
//   float dBA @22, float LONGITUDE @26, float LATITUDE @30   <- longitude comes first
// NaN = no valid samples in the window (SCD30 / noise) or no fresh GPS fix (lat/lon).
// PM is 0 when the PMS5003 gave no frame — the firmware can't tell that apart from a real 0.
// ==========================================
export const ENVIRONMENT_PACKET_BYTES = 34;
export const ENVIRONMENT_WINDOW_MS = 10000;

export interface EnvironmentPacket {
  deviceUtcS: number | null;
  co2: number | null; temperature: number | null; humidity: number | null;
  pm1: number; pm25: number; pm10: number;
  dba: number | null;
  latitude: number | null; longitude: number | null;
}

export const decodeEnvironment = (buf: Buffer): EnvironmentPacket | null => {
  if (buf.length !== ENVIRONMENT_PACKET_BYTES) return null;
  const ts = buf.readUInt32LE(0);
  return {
    deviceUtcS: ts > 0 ? ts : null,
    co2: finiteOrNull(buf.readFloatLE(4)),
    temperature: finiteOrNull(buf.readFloatLE(8)),
    humidity: finiteOrNull(buf.readFloatLE(12)),
    pm1: buf.readUInt16LE(16),
    pm25: buf.readUInt16LE(18),
    pm10: buf.readUInt16LE(20),
    dba: finiteOrNull(buf.readFloatLE(22)),
    longitude: finiteOrNull(buf.readFloatLE(26)),
    latitude: finiteOrNull(buf.readFloatLE(30)),
  };
};

// ==========================================
// POSTURE CUSHION (PostureData, 5 bytes) — one packet per COMMITTED pose change (a new pose held
// for 10 s). EMPTY and UNKNOWN are never sent: leaving the seat shows up only as the cushion going
// to deep sleep ~10 s later, i.e. a BLE disconnect.
//   uint32 timestamp (Unix SECONDS from the cushion's clock, set by the app; 0 if never set) @0,
//   uint8 pose @4
// Events committed while no phone is connected are queued on the cushion (max 32, oldest dropped)
// and replayed only when the app writes "sync" to the control characteristic.
// ==========================================
export const POSTURE_PACKET_BYTES = 5;
export const POSTURE_SETTLE_MS = 10000;

export const POSE_NAMES: Record<number, string> = {
  0: 'EMPTY', 1: 'STRAIGHT', 2: 'SLOUCH', 3: 'LEAN_RIGHT', 4: 'LEAN_LEFT', 5: 'LEAN_FORWARD', 6: 'LEAN_BACKWARD', 255: 'UNKNOWN',
};
export const poseName = (pose: number) => POSE_NAMES[pose] ?? `POSE_${pose}`;

export interface PosturePacket { deviceUtcS: number | null; pose: number }

export const decodePosture = (buf: Buffer): PosturePacket | null => {
  if (buf.length !== POSTURE_PACKET_BYTES) return null;
  const ts = buf.readUInt32LE(0);
  return { deviceUtcS: ts > 0 ? ts : null, pose: buf.readUInt8(4) };
};

// Control characteristic writes (base64 for react-native-ble-plx).
// SET CLOCK: exactly 4 bytes, uint32 LE Unix seconds.
export const encodePostureClock = (epochS: number): string => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(Math.floor(epochS), 0);
  return b.toString('base64');
};
// SYNC: the firmware treats ANY 4-byte write as a clock value, so a bare "sync" (4 bytes) is
// swallowed as an invalid epoch. The trailing newline makes it 5 bytes; the firmware trims it.
export const POSTURE_SYNC_COMMAND = Buffer.from('sync\n', 'utf8').toString('base64');
