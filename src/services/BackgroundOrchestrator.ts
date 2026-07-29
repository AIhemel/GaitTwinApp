import BackgroundJob from 'react-native-background-actions';
import { BleManager } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import RNFS from 'react-native-fs';
import { useSensorStore } from '../store/SensorStore';
import { NODES } from '../config/NodeRegistry';

// --- FIX 1: Cast global to 'any' so TypeScript doesn't complain ---
(globalThis as any).Buffer = Buffer;
export const manager = new BleManager(); // Exported so App.tsx can use it for scanning

let csvBuffer: string[] = [];

// --- FIX 2: Use ReturnType<typeof setInterval> instead of NodeJS.Timeout ---
let logTimer: ReturnType<typeof setInterval> | null = null;
let saveTimer: ReturnType<typeof setInterval> | null = null;

// --- BURST SYNC REFS FOR HYDRATION ---
let hydrationSyncBuffer: any[] = [];
let hydrationSyncTimeout: ReturnType<typeof setTimeout> | null = null;
let lastHydrationPacketTime = 0;

const sleep = (time: number) => new Promise<void>((resolve) => setTimeout(() => resolve(), time));

// --- 1. THE SYNCHRONOUS LOGGER (50Hz) ---
const startMasterClock = () => {
  if (logTimer) return;
  
  // UPGRADE: New Header includes Fused Vol, Weight, and Capacitance
  csvBuffer = ["System_MS,Gait_Pitch,Gait_Roll,Gait_Yaw,Gait_Heel,Gait_Mid,Gait_Toe,Posture_Spine,Hydro_Fused_mL,Hydro_Weight_g,Hydro_Cap_mL,Env_Temp,Env_Hum"];
  const startTime = Date.now();

  logTimer = setInterval(() => {
    const store = useSensorStore.getState();
    if (!store.isRecording) return;

    const t = Date.now() - startTime;
    const { gait, posture, hydration, environment } = store;

    // UPGRADE: Time-aligned snapshot with the 3 new Hydration metrics
    const row = `${t},${gait.pitch.toFixed(2)},${gait.roll.toFixed(2)},${gait.yaw.toFixed(2)},${gait.heel},${gait.mid},${gait.toe},${posture.spineAngle},${hydration.fusedVolumeML.toFixed(1)},${hydration.weightGrams.toFixed(1)},${hydration.capVolumeML.toFixed(1)},${environment.temp},${environment.humidity}`;
    csvBuffer.push(row);
  }, 20);

  saveTimer = setInterval(async () => {
    if (csvBuffer.length > 1) {
      const dataToSave = csvBuffer.join('\n') + '\n';
      csvBuffer = []; 
      
      const currentFileName = useSensorStore.getState().fileName || 'DHT_Master_Log';
      const path = `${RNFS.DownloadDirectoryPath}/${currentFileName}.csv`;
      
      try {
        await RNFS.appendFile(path, dataToSave, 'utf8');
        await RNFS.scanFile(path); // Force Android MediaStore to index the file
      } catch (e) {
        console.error("FS Error:", e);
      }
    }
  }, 5000);
};

// --- 2. THE BLE CONNECTION MANAGER ---
const orchestratorTask = async (taskDataArguments: any) => {
  startMasterClock();

  // The infinite background loop
  await new Promise<void>(async (resolve) => {
    manager.startDeviceScan(null, null, (error, device) => {
      if (error || !device) return;

      const store = useSensorStore.getState();
      const { activeInterests, connectedNodes, nodeBindings, addConnectedNode, removeConnectedNode, updateGait, updateHydration } = store;

      // ==========================================
      // NODE 1: GAIT ANALYSIS (46-Byte Payload - KEPT EXACTLY AS YOU HAD IT)
      // ==========================================
      if (device.id === nodeBindings.GAIT && activeInterests.includes(NODES.GAIT.id) && !connectedNodes.includes(NODES.GAIT.id)) {
        addConnectedNode(NODES.GAIT.id);
        
        device.connect()
          .then(dev => dev.requestMTU(128))
          .then(dev => dev.discoverAllServicesAndCharacteristics())
          .then(dev => {
            dev.monitorCharacteristicForService(NODES.GAIT.serviceUUID, NODES.GAIT.charUUID, (err, char) => {
              if (err) {
                removeConnectedNode(NODES.GAIT.id);
                return;
              }
              if (char?.value) {
                const buf = Buffer.from(char.value, 'base64');
                if (buf.length === 46) {
                   updateGait({
                     pitch: buf.readFloatLE(4),
                     roll: buf.readFloatLE(8),
                     yaw: buf.readFloatLE(12),
                     heel: buf.readUInt16LE(28),
                     mid: buf.readUInt16LE(30),
                     toe: buf.readUInt16LE(32)
                   });
                }
              }
            });
          })
          .catch(() => removeConnectedNode(NODES.GAIT.id));
      }

      // ==========================================
      // NODE 2: HYDRATION (16-Byte Payload + Direct-To-Disk Injection)
      // ==========================================
      if (device.id === nodeBindings.HYDRATION && activeInterests.includes(NODES.HYDRATION.id) && !connectedNodes.includes(NODES.HYDRATION.id)) {
        addConnectedNode(NODES.HYDRATION.id);
        
        device.connect()
          .then(dev => dev.requestMTU(128)) 
          .then(dev => dev.discoverAllServicesAndCharacteristics())
          .then(dev => {
            dev.monitorCharacteristicForService(NODES.HYDRATION.serviceUUID, NODES.HYDRATION.charUUID, (err, char) => {
              if (err) {
                removeConnectedNode(NODES.HYDRATION.id);
                return;
              }
              if (char?.value) {
                const buf = Buffer.from(char.value, 'base64');
                
                // UPGRADE: Now cracks the 16-byte payload
                if (buf.length !== 16) return; 

                const timestamp = buf.readUInt32LE(0);
                const weightGrams = buf.readFloatLE(4);
                const capVolumeML = buf.readFloatLE(8);
                const fusedVolumeML = buf.readFloatLE(12);

                const now = Date.now();
                const timeSinceLastPacket = now - lastHydrationPacketTime;
                lastHydrationPacketTime = now;

                // BURST DETECTION (< 200ms)
                if (timeSinceLastPacket < 200) {
                  if (useSensorStore.getState().setIsSyncing) {
                    useSensorStore.getState().setIsSyncing(true);
                  }
                  
                  // Push to UI background buffer
                  hydrationSyncBuffer.push({ weightGrams, capVolumeML, fusedVolumeML });

                  // UPGRADE: DIRECT-TO-DISK INJECTION (Fixes the data loss bug)
                  if (useSensorStore.getState().isRecording) {
                     const { gait, posture, environment } = useSensorStore.getState();
                     const historicalRow = `[OFFLINE_${timestamp}],${gait.pitch.toFixed(2)},${gait.roll.toFixed(2)},${gait.yaw.toFixed(2)},${gait.heel},${gait.mid},${gait.toe},${posture.spineAngle},${fusedVolumeML.toFixed(1)},${weightGrams.toFixed(1)},${capVolumeML.toFixed(1)},${environment.temp},${environment.humidity}`;
                     csvBuffer.push(historicalRow); // Force it straight into the CSV memory!
                  }
                } else {
                  // Standard Live Packet
                  updateHydration({ weightGrams, capVolumeML, fusedVolumeML });
                }

                // AUTO-HEAL: If 500ms pass with no rapid packets, the flush is over
                if (hydrationSyncTimeout) clearTimeout(hydrationSyncTimeout);
                hydrationSyncTimeout = setTimeout(() => {
                  const currentState = useSensorStore.getState();
                  if (currentState.isSyncing && currentState.setIsSyncing) {
                    currentState.setIsSyncing(false);
                    
                    // Update UI to the final packet of the burst
                    if (hydrationSyncBuffer.length > 0) {
                      const finalPacket = hydrationSyncBuffer[hydrationSyncBuffer.length - 1];
                      updateHydration({ 
                        weightGrams: finalPacket.weightGrams,
                        capVolumeML: finalPacket.capVolumeML,
                        fusedVolumeML: finalPacket.fusedVolumeML
                      });
                      hydrationSyncBuffer = []; 
                    }
                  }
                }, 500);
              }
            });
          })
          .catch(() => removeConnectedNode(NODES.HYDRATION.id));
      }
      
      // (Future Posture and Environment nodes go here...)
    });

    // Keep the task alive forever
    while (true) {
      await sleep(1000);
    }
  });
};

// --- 3. EXPORT THE START COMMAND ---
export const startBackgroundOrchestrator = async () => {
  const options = {
    taskName: 'WBAN_Orchestrator',
    taskTitle: 'Digital Twin Active',
    taskDesc: 'Monitoring WBAN Nodes in Background...',
    taskIcon: { name: 'ic_launcher', type: 'mipmap' },
    color: '#2196F3',
    parameters: { delay: 1000 },
  };

  if (!BackgroundJob.isRunning()) {
    await BackgroundJob.start(orchestratorTask, options);
  }
};

// --- 4. TWO-WAY BLE COMMAND TRANSMITTER ---
export const sendHydrationCommand = async (command: string) => {
  const store = useSensorStore.getState();
  const macAddress = store.nodeBindings.HYDRATION;
  
  if (!macAddress || !store.connectedNodes.includes(NODES.HYDRATION.id)) {
    console.warn("Cannot send command: Hydration node offline.");
    return;
  }

  // UPGRADE: Added .trim() to ensure no hidden spaces break the ESP32 parser
  const base64Command = Buffer.from(command.trim(), 'utf-8').toString('base64');

  try {
    await manager.writeCharacteristicWithResponseForDevice(
      macAddress,
      NODES.HYDRATION.serviceUUID,
      NODES.HYDRATION.rxCharUUID, 
      base64Command
    );
    console.log(`[BLE TX SUCCESS] Sent Command: ${command}`);
  } catch (error) {
    console.error(`[BLE TX ERROR] Failed to send ${command}:`, error);
  }
};