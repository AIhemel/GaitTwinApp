import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { CONTEXT_LABELS, POINT_LABELS, logLabel, toggleContext, useLabelStore } from '../services/Labels';

// One-tap context labels (APP_FIXES §3). Usable any time: taps always go to today's labels.csv,
// and into the session's events.csv while recording.
const LABEL_NAMES: Record<string, string> = Object.fromEntries([...CONTEXT_LABELS, ...POINT_LABELS].map((l) => [l.id, l.label]));

const describe = (event: string) => {
  const m = event.match(/^(.*)_(start|stop)$/);
  if (m && LABEL_NAMES[m[1]]) return `${LABEL_NAMES[m[1]]} ${m[2] === 'start' ? 'started' : 'stopped'}`;
  return LABEL_NAMES[event] ?? event;
};

export const LabelPanel = () => {
  const active = useLabelStore((s) => s.active);
  const lastTap = useLabelStore((s) => s.lastTap);
  const [note, setNote] = useState('');

  const saveNote = () => {
    if (!note.trim()) return;
    logLabel('note', note);
    setNote('');
  };

  return (
    <View style={styles.card}>
      <Text style={styles.title}>What's happening?</Text>
      <Text style={styles.hint}>Tap when it starts and again when it ends. Times are saved automatically.</Text>
      <View style={styles.row}>
        {CONTEXT_LABELS.map((l) => {
          const on = active?.id === l.id;
          return (
            <TouchableOpacity key={l.id} style={[styles.chip, styles.contextChip, on && styles.chipOn]} onPress={() => toggleContext(l.id)}>
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{l.label}{on ? ' ●' : ''}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
      <View style={styles.row}>
        {POINT_LABELS.map((l) => (
          <TouchableOpacity key={l.id} style={styles.chip} onPress={() => logLabel(l.id)}>
            <Text style={styles.chipText}>{l.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.noteRow}>
        <TextInput style={styles.noteInput} value={note} onChangeText={setNote} placeholder="Add a note (optional)" onSubmitEditing={saveNote} />
        <TouchableOpacity style={[styles.saveBtn, !note.trim() && styles.saveBtnOff]} onPress={saveNote} disabled={!note.trim()}>
          <Text style={styles.saveText}>Save</Text>
        </TouchableOpacity>
      </View>
      {lastTap && (
        <Text style={styles.hint}>✓ {lastTap.id === 'note' ? 'Note' : describe(lastTap.id)} at {new Date(lastTap.at).toLocaleTimeString()}</Text>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  card: { backgroundColor: '#fff', padding: 15, borderRadius: 12, marginBottom: 20, elevation: 2 },
  title: { fontSize: 16, fontWeight: 'bold', color: '#2d3748' },
  hint: { fontSize: 11, color: '#a0aec0', marginTop: 4 },
  row: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 10 },
  chip: { backgroundColor: '#edf2f7', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7, marginRight: 8, marginBottom: 8 },
  contextChip: { borderWidth: 1, borderColor: '#cbd5e0' },
  chipOn: { backgroundColor: '#2196F3', borderColor: '#2196F3' },
  chipText: { fontSize: 13, color: '#2d3748', fontWeight: '600' },
  chipTextOn: { color: '#fff' },
  noteRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  noteInput: { flex: 1, borderWidth: 1, borderColor: '#CBD5E1', borderRadius: 8, paddingHorizontal: 10, height: 40, marginRight: 8 },
  saveBtn: { backgroundColor: '#10B981', paddingHorizontal: 16, height: 40, justifyContent: 'center', borderRadius: 8 },
  saveBtnOff: { opacity: 0.5 },
  saveText: { color: '#fff', fontWeight: 'bold' },
});
