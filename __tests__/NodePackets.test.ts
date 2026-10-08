import { Buffer } from 'buffer';
import {
  decodeGait, decodeHydration, decodeEnvironment, decodePosture,
  encodePostureClock, POSTURE_SYNC_COMMAND, poseName,
} from '../src/protocol/NodePackets';

// Each buffer is laid out field by field exactly like the firmware's packed struct.

test('gait SensorData (46 bytes)', () => {
  const b = Buffer.alloc(46);
  b.writeUInt32LE(123456, 0);
  b.writeFloatLE(10.5, 4); // pitch
  b.writeFloatLE(-3.25, 8); // roll
  b.writeFloatLE(0, 12); b.writeFloatLE(0, 16); b.writeFloatLE(Math.SQRT1_2, 20); b.writeFloatLE(Math.SQRT1_2, 24); // 90° about Z
  b.writeUInt16LE(1500, 28); b.writeUInt16LE(800, 30); b.writeUInt16LE(40, 32);
  b.writeFloatLE(0.5, 34); b.writeFloatLE(-0.25, 38); b.writeFloatLE(9.75, 42);

  const p = decodeGait(b)!;
  expect(p).toMatchObject({ deviceMs: 123456, pitch: 10.5, roll: -3.25, heel: 1500, mid: 800, toe: 40, accX: 0.5, accY: -0.25, accZ: 9.75 });
  expect(p.yaw).toBeCloseTo(90, 3);
  expect(decodeGait(Buffer.from(b.subarray(0, 20)))).toBeNull(); // truncated (MTU not negotiated)
});

test('hydration HydrationData (16 bytes)', () => {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(5000, 0); b.writeFloatLE(250.5, 4); b.writeFloatLE(240, 8); b.writeFloatLE(250.5, 12);
  expect(decodeHydration(b)).toEqual({ deviceMs: 5000, weightGrams: 250.5, capVolumeML: 240, fusedVolumeML: 250.5 });
});

test('environment EnvNodeData (34 bytes): longitude before latitude, NaN -> null, 0 timestamp -> null', () => {
  const b = Buffer.alloc(34);
  b.writeUInt32LE(1790856000, 0);
  b.writeFloatLE(612, 4); b.writeFloatLE(27.5, 8); b.writeFloatLE(64.25, 12);
  b.writeUInt16LE(8, 16); b.writeUInt16LE(14, 18); b.writeUInt16LE(21, 20);
  b.writeFloatLE(48.5, 22);
  b.writeFloatLE(90.5, 26); // longitude
  b.writeFloatLE(23.75, 30); // latitude
  expect(decodeEnvironment(b)).toEqual({
    deviceUtcS: 1790856000, co2: 612, temperature: 27.5, humidity: 64.25,
    pm1: 8, pm25: 14, pm10: 21, dba: 48.5, longitude: 90.5, latitude: 23.75,
  });

  b.writeUInt32LE(0, 0);
  b.writeFloatLE(NaN, 4); b.writeFloatLE(NaN, 22); b.writeFloatLE(NaN, 26); b.writeFloatLE(NaN, 30);
  expect(decodeEnvironment(b)).toMatchObject({ deviceUtcS: null, co2: null, dba: null, longitude: null, latitude: null });
});

test('posture PostureData (5 bytes)', () => {
  const b = Buffer.alloc(5);
  b.writeUInt32LE(1790856000, 0);
  b.writeUInt8(3, 4);
  expect(decodePosture(b)).toEqual({ deviceUtcS: 1790856000, pose: 3 });
  expect(poseName(3)).toBe('LEAN_RIGHT');
  b.writeUInt32LE(0, 0);
  expect(decodePosture(b)?.deviceUtcS).toBeNull();
});

test('posture control writes', () => {
  const clock = Buffer.from(encodePostureClock(1790856000), 'base64');
  expect(clock.length).toBe(4); // exactly 4 bytes = the firmware's clock-set path
  expect(clock.readUInt32LE(0)).toBe(1790856000);
  // Must NOT be 4 bytes, or the firmware reads it as an (invalid) epoch instead of the command.
  const sync = Buffer.from(POSTURE_SYNC_COMMAND, 'base64');
  expect(sync.length).not.toBe(4);
  expect(sync.toString('utf8').trim()).toBe('sync');
});
