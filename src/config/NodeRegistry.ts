// Every node streams live BLE notifications while connected; packet layouts are in
// src/protocol/NodePackets.ts.
//
// deviceClock — how a node's own timestamp should be read:
//   'millis'  ms since the node booted (gait, hydration). ClockSync maps it onto phone UTC.
//   'epoch_s' Unix seconds from the node's own clock (environment: GPS; posture: set by the app),
//             0 until that clock is set. Live packets are timed by phone receive time instead,
//             which is ms-precise; the device seconds are still logged raw.
export type DeviceClock = 'millis' | 'epoch_s';

export interface NodeConfig {
  id: string;
  name: string; // BLE advertised name
  deviceClock: DeviceClock;
  serviceUUID: string;
  charUUID: string; // notify characteristic (node -> phone)
  rxCharUUID?: string; // write characteristic (phone -> node): hydration OTA commands, posture control
  // Not advertising is this node's normal idle state, not a dropped link (the posture cushion deep-
  // sleeps whenever the seat is empty), so it must not trigger "node disconnected" recording warnings.
  sleepsWhenIdle?: boolean;
}

export const NODES = {
  GAIT: {
    id: 'GAIT',
    name: 'Gait-Twin-Node',
    deviceClock: 'millis',
    serviceUUID: "4fafc201-1fb5-459e-8fcc-c5c9c331914b",
    charUUID: "beb5483e-36e1-4688-b7f5-ea07361b26a8",
  },
  GAIT_LEFT: {
    id: 'GAIT_LEFT',
    name: 'Gait-Twin-Node-Left',
    deviceClock: 'millis',
    // Same service/characteristic UUIDs as GAIT (right foot) by design — the firmware reuses
    // them deliberately; nodes are told apart by BLE device name and by which MAC address gets
    // bound to which node id in the app, not by UUID.
    serviceUUID: "4fafc201-1fb5-459e-8fcc-c5c9c331914b",
    charUUID: "beb5483e-36e1-4688-b7f5-ea07361b26a8",
  },
  POSTURE: {
    id: 'POSTURE',
    name: 'Posture-Cushion',
    deviceClock: 'epoch_s',
    serviceUUID: "f0de0001-1c8a-4b9e-9c3a-6d5e4f3a2b1c",
    charUUID: "f0de0003-1c8a-4b9e-9c3a-6d5e4f3a2b1c", // DATA (notify)
    rxCharUUID: "f0de0002-1c8a-4b9e-9c3a-6d5e4f3a2b1c", // CONTROL (clock set, "sync")
    sleepsWhenIdle: true,
  },
  HYDRATION: {
    id: 'HYDRATION',
    name: 'Hydro-Twin-Node',
    deviceClock: 'millis',
    serviceUUID: "5c027419-72c6-4bb5-8664-9ed31e8c148e",
    charUUID: "6d8d6dc4-3323-4416-9289-5418bd018260", // TX (ESP32 -> Phone)
    rxCharUUID: "a4f00ce0-b472-4752-9b2e-07a82c6a0c5c", // RX (Phone -> ESP32)
  },
  ENVIRONMENT: {
    id: 'ENVIRONMENT',
    name: 'Environment-Node',
    deviceClock: 'epoch_s',
    serviceUUID: "9d3b1001-4d4f-4e45-8e4d-454e564e4f44",
    charUUID: "9d3b1002-4d4f-4e45-8e4d-454e564e4f44",
  },
} satisfies Record<string, NodeConfig>;

export type NodeId = keyof typeof NODES;
export const NODE_LIST: NodeConfig[] = Object.values(NODES);
export const NODES_BY_ID: Record<string, NodeConfig> = NODES;
