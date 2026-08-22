import React, { useCallback, useEffect, useState } from 'react';
import { Modal, View, Text, FlatList, TouchableOpacity, TextInput, Alert, StyleSheet, ScrollView } from 'react-native';
import { listFitFiles, renameFitFile, deleteFitFile, loadFitFileValues, FitFileInfo } from '../services/FitDataService';
import { HEALTH_DATA_TYPES_BY_ID } from '../config/HealthConnectRegistry';
import { Sparkline } from '../components/Sparkline';

interface FitDataManagerScreenProps {
  visible: boolean;
  onClose: () => void;
}

export const FitDataManagerScreen = ({ visible, onClose }: FitDataManagerScreenProps) => {
  const [files, setFiles] = useState<FitFileInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [renamingFile, setRenamingFile] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  const [previewValues, setPreviewValues] = useState<Record<string, number[]> | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listFitFiles();
      setFiles(list);
    } catch (e) {
      console.error('Failed to list Fit files:', e);
      Alert.alert('Error', 'Could not read Fit data files.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) refresh();
    else {
      setPreviewFile(null);
      setPreviewValues(null);
    }
  }, [visible, refresh]);

  const handleDelete = (fileName: string) => {
    Alert.alert(
      'Delete Fit Data',
      `Permanently delete "${fileName}.csv"? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteFitFile(fileName);
              if (previewFile === fileName) { setPreviewFile(null); setPreviewValues(null); }
              refresh();
            } catch {
              Alert.alert('Error', 'Could not delete this file.');
            }
          },
        },
      ]
    );
  };

  const startRename = (fileName: string) => {
    setRenamingFile(fileName);
    setRenameInput(fileName);
  };

  const confirmRename = async () => {
    if (!renamingFile) return;
    const newName = renameInput.trim();
    if (!newName || newName === renamingFile) {
      setRenamingFile(null);
      return;
    }
    try {
      await renameFitFile(renamingFile, newName);
      setRenamingFile(null);
      refresh();
    } catch {
      Alert.alert('Error', 'Could not rename this file (name may already be in use).');
    }
  };

  const openPreview = async (fileName: string) => {
    if (previewFile === fileName) {
      setPreviewFile(null);
      setPreviewValues(null);
      return;
    }
    setPreviewFile(fileName);
    setPreviewLoading(true);
    try {
      const values = await loadFitFileValues(fileName);
      setPreviewValues(values);
    } catch (e) {
      console.error('Failed to load Fit file preview:', e);
      Alert.alert('Error', 'Could not read this file.');
      setPreviewFile(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent={true}>
      <View style={styles.overlay}>
        <View style={styles.content}>
          <Text style={styles.title}>Fit Data</Text>
          <Text style={styles.subtitle}>Downloads/GaitTwin/FitData/</Text>

          <FlatList
            data={files}
            keyExtractor={(item) => item.fileName}
            refreshing={loading}
            onRefresh={refresh}
            ListEmptyComponent={<Text style={styles.empty}>No Fit data recorded yet.</Text>}
            renderItem={({ item }) => (
              <View>
                <View style={styles.fileRow}>
                  {renamingFile === item.fileName ? (
                    <View style={styles.renameRow}>
                      <TextInput style={styles.renameInput} value={renameInput} onChangeText={setRenameInput} autoFocus />
                      <TouchableOpacity style={styles.smallBtn} onPress={confirmRename}>
                        <Text style={styles.smallBtnText}>Save</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.smallBtnCancel} onPress={() => setRenamingFile(null)}>
                        <Text style={styles.smallBtnText}>Cancel</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <>
                      <TouchableOpacity style={{ flex: 1 }} onPress={() => openPreview(item.fileName)}>
                        <Text style={styles.fileName}>{item.fileName}.csv</Text>
                        <Text style={styles.meta}>
                          {item.metadata?.minTimestamp && item.metadata?.maxTimestamp
                            ? `${new Date(item.metadata.minTimestamp).toLocaleString()} – ${new Date(item.metadata.maxTimestamp).toLocaleTimeString()}`
                            : `Modified ${item.modifiedTime.toLocaleString()}`}
                          {' · '}{(item.size / 1024).toFixed(1)} KB
                        </Text>
                        {!item.metadata && <Text style={styles.metaWarning}>metadata unavailable</Text>}
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.smallBtn} onPress={() => startRename(item.fileName)}>
                        <Text style={styles.smallBtnText}>Rename</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={styles.smallBtnDelete} onPress={() => handleDelete(item.fileName)}>
                        <Text style={styles.smallBtnText}>Delete</Text>
                      </TouchableOpacity>
                    </>
                  )}
                </View>

                {previewFile === item.fileName && (
                  <View style={styles.previewBox}>
                    {previewLoading ? (
                      <Text style={styles.meta}>Loading…</Text>
                    ) : (
                      <ScrollView style={{ maxHeight: 220 }}>
                        {Object.entries(previewValues ?? {}).map(([typeId, values]) => (
                          <View key={typeId} style={styles.previewRow}>
                            <View style={{ flex: 1 }}>
                              <Text style={styles.previewLabel}>{HEALTH_DATA_TYPES_BY_ID[typeId]?.label ?? typeId}</Text>
                              <Text style={styles.meta}>{values.length} records</Text>
                            </View>
                            <Sparkline data={values.slice(-60)} color={HEALTH_DATA_TYPES_BY_ID[typeId]?.color ?? '#2b6cb0'} />
                          </View>
                        ))}
                        {previewValues && Object.keys(previewValues).length === 0 && (
                          <Text style={styles.meta}>No data rows in this file.</Text>
                        )}
                      </ScrollView>
                    )}
                  </View>
                )}
              </View>
            )}
          />

          <TouchableOpacity style={styles.closeButton} onPress={onClose}>
            <Text style={{ color: 'white', fontWeight: 'bold' }}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 20 },
  content: { backgroundColor: '#fff', borderRadius: 15, padding: 20, maxHeight: '85%' },
  title: { fontSize: 20, fontWeight: 'bold', textAlign: 'center' },
  subtitle: { fontSize: 12, color: '#a0aec0', textAlign: 'center', marginBottom: 10 },
  empty: { textAlign: 'center', color: '#a0aec0', paddingVertical: 20 },
  fileRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderColor: '#eee' },
  fileName: { fontSize: 15, fontWeight: '600', color: '#2d3748' },
  meta: { fontSize: 11, color: '#a0aec0', marginTop: 2 },
  metaWarning: { fontSize: 11, color: '#d69e2e', marginTop: 2 },
  smallBtn: { backgroundColor: '#e2e8f0', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, marginLeft: 8 },
  smallBtnCancel: { backgroundColor: '#cbd5e1', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, marginLeft: 8 },
  smallBtnDelete: { backgroundColor: '#F44336', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, marginLeft: 8 },
  smallBtnText: { fontSize: 12, fontWeight: 'bold', color: '#2d3748' },
  renameRow: { flexDirection: 'row', alignItems: 'center', flex: 1 },
  renameInput: { flex: 1, borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 6, paddingHorizontal: 10, height: 36 },
  closeButton: { backgroundColor: '#4a5568', padding: 15, borderRadius: 8, alignItems: 'center', marginTop: 15 },
  previewBox: { backgroundColor: '#f7fafc', borderRadius: 8, padding: 10, marginBottom: 8 },
  previewRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
  previewLabel: { fontSize: 13, fontWeight: '600', color: '#2d3748' },
});
