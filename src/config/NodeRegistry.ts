export const NODES = {
  GAIT: {
    id: 'GAIT',
    name: 'Gait-Twin-Node',
    serviceUUID: "4fafc201-1fb5-459e-8fcc-c5c9c331914b",
    charUUID: "beb5483e-36e1-4688-b7f5-ea07361b26a8",
  },
  GAIT_LEFT: {
    id: 'GAIT_LEFT',
    name: 'Gait-Twin-Node-Left',
    // Same service/characteristic UUIDs as GAIT (right foot) by design — the firmware reuses
    // them deliberately; nodes are told apart by BLE device name and by which MAC address gets
    // bound to which node id in the app, not by UUID.
    serviceUUID: "4fafc201-1fb5-459e-8fcc-c5c9c331914b",
    charUUID: "beb5483e-36e1-4688-b7f5-ea07361b26a8",
  },
  POSTURE: {
    id: 'POSTURE',
    name: 'Posture-Twin-Node',
    serviceUUID: "YOUR_POSTURE_SERVICE_UUID", // Replace with actual UUID
    charUUID: "YOUR_POSTURE_CHAR_UUID",
  },
  HYDRATION: {
    id: 'HYDRATION',
    name: 'Hydro-Twin-Node',
    serviceUUID: "5c027419-72c6-4bb5-8664-9ed31e8c148e",
    charUUID: "6d8d6dc4-3323-4416-9289-5418bd018260", // TX (ESP32 -> Phone)
    rxCharUUID: "a4f00ce0-b472-4752-9b2e-07a82c6a0c5c", // RX (Phone -> ESP32)
  },
  ENVIRONMENT: {
    id: 'ENVIRONMENT',
    name: 'Env-Twin-Node',
    serviceUUID: "YOUR_ENV_SERVICE_UUID",
    charUUID: "YOUR_ENV_CHAR_UUID",
  }
};