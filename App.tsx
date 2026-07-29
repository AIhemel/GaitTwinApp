import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View, TouchableOpacity, SafeAreaView, TextInput, ScrollView, Switch, Alert, Modal, FlatList, ActivityIndicator } from 'react-native';
import { useSensorStore } from './src/store/SensorStore';
import { startBackgroundOrchestrator, sendHydrationCommand } from './src/services/BackgroundOrchestrator';
import { NODES } from './src/config/NodeRegistry';
import { PermissionsAndroid, Platform } from 'react-native';
import { BleManager, Device } from 'react-native-ble-plx';

const scannerManager = new BleManager();

export default function App() {
  const {
    activeInterests, connectedNodes, isRecording, isSyncing, fileName, nodeBindings,
    gait, posture, hydration, environment,
    addInterest, removeInterest, setRecording, setFileName, bindNode, loadBindings
  } = useSensorStore();

  // Scanner Modal States
  const [isModalVisible, setModalVisible] = useState(false);
  const [scanningNode, setScanningNode] = useState<string | null>(null);
  const [discoveredDevices, setDiscoveredDevices] = useState<Device[]>([]);
  const [isScanning, setIsScanning] = useState(false);

  // OTA Calibration Input States
  const [calibWeightInput, setCalibWeightInput] = useState('');
  const [calibCapacitanceInput, setCalibCapacitanceInput] = useState('');

  useEffect(() => {
    const bootSequence = async () => {
      await loadBindings(); // Load saved MAC addresses from yesterday
      if (Platform.OS === 'android') {
        try {
          const granted = await PermissionsAndroid.requestMultiple([
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
            PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
            PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
            PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS, 
          ]);
          if (granted['android.permission.BLUETOOTH_CONNECT'] === PermissionsAndroid.RESULTS.GRANTED) {
            await startBackgroundOrchestrator();
          }
        } catch (e) {
          console.error("Boot failed:", e);
        }
      }
    };
    bootSequence();
  }, []);

  const handleNodeToggle = (nodeId: string, isEnabled: boolean) => {
    if (isEnabled && !nodeBindings[nodeId]) {
      Alert.alert("Unbound Node", "Please assign a hardware device to this node first.");
      return;
    }
    isEnabled ? addInterest(nodeId) : removeInterest(nodeId);
  };

  const openScanner = (nodeId: string) => {
    setScanningNode(nodeId);
    setDiscoveredDevices([]);
    setModalVisible(true);
    setIsScanning(true);

    scannerManager.startDeviceScan(null, null, (error, device) => {
      if (device && device.name) {
        setDiscoveredDevices(prev => {
          if (!prev.find(d => d.id === device.id)) return [...prev, device];
          return prev;
        });
      }
    });

    // Auto-stop scan after 10 seconds to save battery
    setTimeout(() => {
      scannerManager.stopDeviceScan();
      setIsScanning(false);
    }, 10000);
  };

  const stopScan = () => {
    scannerManager.stopDeviceScan();
    setIsScanning(false);
  };

  const assignDevice = (macAddress: string) => {
    if (scanningNode) {
      bindNode(scanningNode, macAddress);
      stopScan();
      setModalVisible(false);
    }
  };

  const toggleRecordingSession = () => {
    if (!isRecording) {
      if (activeInterests.length === 0) return Alert.alert("Warning", "Activate a node first.");
      setRecording(true);
    } else {
      setRecording(false);
      Alert.alert("Session Saved", `Data successfully written to Downloads/${fileName}.csv`);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View style={styles.logoCircle}><Text style={styles.logoText}>⚡</Text></View>
        <Text style={styles.title}>DHT Orchestrator</Text>
        <Text style={styles.subtitle}>Digital Health Twin Multi-Node Framework</Text>
      </View>

      {/* --- THE MISSING SYNC BANNER --- */}
      {isSyncing && (
        <View style={styles.syncBanner}>
          <ActivityIndicator size="small" color="#FFF" />
          <Text style={styles.syncText}> Synchronizing Offline Data...</Text>
        </View>
      )}

      <ScrollView style={styles.scrollArea}>
        {/* CONNECTION POOL & BINDER */}
        <View style={styles.sectionCard}>
          <Text style={styles.sectionTitle}>Node Assignments</Text>
          {Object.values(NODES).map((node) => {
            const isTargeted = activeInterests.includes(node.id);
            const isLive = connectedNodes.includes(node.id);
            const macAddress = nodeBindings[node.id];

            return (
              <View key={node.id} style={styles.nodeRow}>
                <View style={{flex: 1}}>
                  <Text style={styles.nodeName}>{node.name}</Text>
                  <Text style={[styles.nodeStatus, { color: isLive ? '#4CAF50' : macAddress ? '#2196F3' : '#F44336' }]}>
                    {isLive ? '🟢 Connected' : macAddress ? `🔗 Bound: ${macAddress}` : '🔴 Unassigned'}
                  </Text>
                </View>
                
                <TouchableOpacity style={styles.bindButton} onPress={() => openScanner(node.id)}>
                  <Text style={styles.bindButtonText}>{macAddress ? 'Rebind' : 'Bind'}</Text>
                </TouchableOpacity>

                <Switch value={isTargeted} onValueChange={(val) => handleNodeToggle(node.id, val)} />
              </View>
            );
          })}
        </View>

        {/* DATA CARDS */}
        <Text style={styles.sectionHeader}>Live Core Metrics</Text>
        
        <View style={styles.dataCard}>
          <Text style={styles.cardHeader}>Gait Analysis Node</Text>
          <View style={styles.grid}>
            <View style={styles.gridItem}><Text style={styles.label}>Pitch</Text><Text style={styles.val}>{gait.pitch.toFixed(1)}°</Text></View>
            <View style={styles.gridItem}><Text style={styles.label}>Roll</Text><Text style={styles.val}>{gait.roll.toFixed(1)}°</Text></View>
            <View style={styles.gridItem}><Text style={styles.label}>Yaw</Text><Text style={styles.val}>{gait.yaw.toFixed(1)}°</Text></View>
          </View>
          <View style={styles.grid}>
            <View style={styles.gridItem}><Text style={styles.label}>Heel FSR</Text><Text style={styles.val}>{gait.heel}</Text></View>
            <View style={styles.gridItem}><Text style={styles.label}>Met1 FSR</Text><Text style={styles.val}>{gait.mid}</Text></View>
            <View style={styles.gridItem}><Text style={styles.label}>Met5 FSR</Text><Text style={styles.val}>{gait.toe}</Text></View>
          </View>
        </View>

        <View style={styles.dataCard}>
          <Text style={styles.cardHeader}>Posture Analysis Node</Text>
          <View style={styles.grid}>
            <View style={styles.gridItem}><Text style={styles.label}>Spine Angle</Text><Text style={styles.val}>{posture.spineAngle.toFixed(1)}°</Text></View>
          </View>
        </View>

  {/* HYDRATION DATA CARD (UPDATED METRICS) */}
        <View style={[styles.dataCard, isSyncing && { borderColor: '#3B82F6', borderWidth: 2 }]}>
          <Text style={styles.cardHeader}>Biometric Hydration Node (Fused System)</Text>
          <View style={styles.grid}>
            <View style={styles.gridItem}>
              <Text style={styles.label}>Final Fused Vol</Text>
              <Text style={[styles.val, { fontSize: 24, color: '#2563EB' }]}>{hydration.fusedVolumeML.toFixed(1)} mL</Text>
            </View>
          </View>
          <View style={[styles.grid, { marginTop: 10, borderTopWidth: 1, borderColor: '#edf2f7', paddingTop: 10 }]}>
            <View style={styles.gridItem}>
              <Text style={styles.label}>Load Cell Wt.</Text>
              <Text style={[styles.val, { fontSize: 16, color: '#805ad5' }]}>{hydration.weightGrams.toFixed(1)} g</Text>
            </View>
            <View style={styles.gridItem}>
              <Text style={styles.label}>FDC Capacitance</Text>
              <Text style={[styles.val, { fontSize: 16, color: '#d69e2e' }]}>{hydration.capVolumeML.toFixed(1)} mL</Text>
            </View>
          </View>
        </View>

        {/* OTA HYDRATION CALIBRATION PANEL */}
        {connectedNodes.includes('HYDRATION') && (
          <View style={[styles.dataCard, { backgroundColor: '#F1F5F9' }]}>
            <Text style={styles.cardHeader}>OTA Hydration Calibration</Text>
            
            <TouchableOpacity 
              style={[styles.recordButton, { backgroundColor: '#0EA5E9', marginBottom: 15 }]} 
              onPress={() => {
                sendHydrationCommand("TARE");
                Alert.alert("Command Sent", "Tare system initiated.");
              }}
            >
              <Text style={styles.buttonText}>🔄 TARE SYSTEM</Text>
            </TouchableOpacity>

            <View style={styles.inputRow}>
              <TextInput 
                style={styles.otaInput} 
                keyboardType="numeric" 
                placeholder="Load Cell (g)" 
                value={calibWeightInput} 
                onChangeText={setCalibWeightInput} 
              />
              <TouchableOpacity 
                style={styles.otaSendBtn} 
                onPress={() => { 
                  sendHydrationCommand(`CAL_W:${calibWeightInput}`); 
                  setCalibWeightInput(''); 
                  Alert.alert("Command Sent", `Calibrating weight to ${calibWeightInput}g`);
                }}>
                <Text style={styles.buttonText}>CAL W</Text>
              </TouchableOpacity>
            </View>
            
            <View style={styles.inputRow}>
              <TextInput 
                style={styles.otaInput} 
                keyboardType="numeric" 
                placeholder="Capacitance (mL)" 
                value={calibCapacitanceInput} 
                onChangeText={setCalibCapacitanceInput} 
              />
              <TouchableOpacity 
                style={styles.otaSendBtn} 
                onPress={() => { 
                  sendHydrationCommand(`CAL_C:${calibCapacitanceInput}`); 
                  setCalibCapacitanceInput(''); 
                  Alert.alert("Command Sent", `Calibrating capacitance to ${calibCapacitanceInput}mL`);
                }}>
                <Text style={styles.buttonText}>CAL C</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        <View style={styles.dataCard}>
          <Text style={styles.cardHeader}>Environmental Context Node</Text>
          <View style={styles.grid}>
            <View style={styles.gridItem}><Text style={styles.label}>Temperature</Text><Text style={styles.val}>{environment.temp.toFixed(1)}°C</Text></View>
            <View style={styles.gridItem}><Text style={styles.label}>Humidity</Text><Text style={styles.val}>{environment.humidity.toFixed(1)}%</Text></View>
          </View>
        </View>

        {/* BACKGROUND RECORDER */}
        <View style={styles.recordSection}>
          <Text style={styles.sectionTitleWhite}>Synchronous Flight Logger</Text>
          <TextInput style={styles.input} value={fileName} onChangeText={setFileName} placeholder="Enter custom CSV name" editable={!isRecording} />
          <TouchableOpacity style={[styles.recordButton, { backgroundColor: isRecording ? '#F44336' : '#4CAF50' }]} onPress={toggleRecordingSession}>
            <Text style={styles.buttonText}>{isRecording ? '🛑 STOP & FLUSH CSV' : '⏺️ START RECORDING'}</Text>
          </TouchableOpacity>
        </View>

        {/* CREDITS */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>Developed and designed by</Text>
          <Text style={styles.footerName}>Asraful Islam Hemel</Text>
          <Text style={styles.footerLab}>MAIM LAB, RMEDU</Text>
        </View>
      </ScrollView>

      {/* SCANNER MODAL */}
      <Modal visible={isModalVisible} animationType="slide" transparent={true}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Select Hardware Device</Text>
            <Text style={{textAlign: 'center', marginBottom: 15}}>{isScanning ? 'Radar Active...' : 'Scan Complete'}</Text>
            
            <FlatList
              data={discoveredDevices}
              keyExtractor={(item) => item.id}
              renderItem={({item}) => (
                <TouchableOpacity style={styles.deviceRow} onPress={() => assignDevice(item.id)}>
                  <Text style={{fontWeight: 'bold'}}>{item.name || 'Unknown Device'}</Text>
                  <Text style={{fontSize: 12, color: '#666'}}>{item.id}</Text>
                </TouchableOpacity>
              )}
            />
            
            <TouchableOpacity style={styles.closeButton} onPress={() => { stopScan(); setModalVisible(false); }}>
              <Text style={{color: 'white', fontWeight: 'bold'}}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f4f6f9', padding: 15 },
  header: { alignItems: 'center', marginVertical: 20 },
  logoCircle: { width: 60, height: 60, borderRadius: 30, backgroundColor: '#2196F3', justifyContent: 'center', alignItems: 'center', marginBottom: 10, elevation: 4 },
  logoText: { fontSize: 30 },
  title: { fontSize: 26, fontWeight: 'bold', color: '#1a202c' },
  subtitle: { fontSize: 13, color: '#718096', marginTop: 4 },
  syncBanner: { backgroundColor: '#3B82F6', padding: 10, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', borderRadius: 8, marginHorizontal: 5, marginBottom: 15 },
  syncText: { color: '#FFF', fontWeight: 'bold', marginLeft: 8 },
  scrollArea: { flex: 1 },
  sectionCard: { backgroundColor: '#fff', padding: 15, borderRadius: 12, marginBottom: 20, elevation: 2 },
  sectionTitle: { fontSize: 16, fontWeight: 'bold', color: '#2d3748', marginBottom: 10 },
  sectionTitleWhite: { fontSize: 16, fontWeight: 'bold', color: '#fff', marginBottom: 10 },
  sectionHeader: { fontSize: 18, fontWeight: 'bold', color: '#2d3748', marginVertical: 10, paddingLeft: 5 },
  nodeRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderColor: '#edf2f7' },
  nodeName: { fontSize: 15, fontWeight: '600', color: '#2d3748' },
  nodeStatus: { fontSize: 11, marginTop: 2, fontWeight: '600' },
  bindButton: { backgroundColor: '#e2e8f0', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6, marginRight: 10 },
  bindButtonText: { fontSize: 12, fontWeight: 'bold', color: '#4a5568' },
  dataCard: { backgroundColor: '#fff', padding: 14, borderRadius: 12, marginBottom: 12, elevation: 1 },
  cardHeader: { fontSize: 14, fontWeight: 'bold', color: '#4a5568', borderBottomWidth: 1, borderColor: '#edf2f7', paddingBottom: 6, marginBottom: 8 },
  grid: { flexDirection: 'row', justifyContent: 'space-between', marginVertical: 4 },
  gridItem: { flex: 1, alignItems: 'center' },
  label: { fontSize: 11, color: '#a0aec0', marginBottom: 2 },
  val: { fontSize: 18, fontWeight: 'bold', color: '#2b6cb0' },
  recordSection: { backgroundColor: '#1a202c', padding: 15, borderRadius: 12, marginTop: 15, marginBottom: 20 },
  input: { backgroundColor: '#fff', padding: 12, borderRadius: 8, marginBottom: 12, fontSize: 14, color: '#2d3748' },
  recordButton: { padding: 14, borderRadius: 8, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 14, fontWeight: 'bold' },
  inputRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  otaInput: { flex: 1, backgroundColor: '#fff', borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8, paddingHorizontal: 15, height: 45, marginRight: 10, fontSize: 15 },
  otaSendBtn: { backgroundColor: '#10B981', paddingHorizontal: 20, justifyContent: 'center', alignItems: 'center', borderRadius: 8 },
  footer: { alignItems: 'center', paddingVertical: 25, borderTopWidth: 1, borderColor: '#e2e8f0', marginTop: 10 },
  footerText: { fontSize: 12, color: '#a0aec0' },
  footerName: { fontSize: 14, fontWeight: 'bold', color: '#4a5568', marginTop: 2 },
  footerLab: { fontSize: 12, fontWeight: '600', color: '#2196F3', marginTop: 2 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 20 },
  modalContent: { backgroundColor: '#fff', borderRadius: 15, padding: 20, maxHeight: '80%' },
  modalTitle: { fontSize: 20, fontWeight: 'bold', textAlign: 'center', marginBottom: 5 },
  deviceRow: { padding: 15, borderBottomWidth: 1, borderColor: '#eee' },
  closeButton: { backgroundColor: '#F44336', padding: 15, borderRadius: 8, alignItems: 'center', marginTop: 15 }
});