import React, { useEffect, useState } from 'react';
import { Modal, ScrollView, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { RULE_DEFS, RuleDef, RuleParam, SEVERITIES, Severity, DEFAULT_POLICY } from '../config/alertRules';
import { resolveRule, resolvePolicy, useAlertRulesStore, DEFAULT_ANALYSIS } from '../store/AlertRulesStore';
import { sendTestNotification } from '../health/notify';

// "Alerts & reminders": every rule's on/off, severity, cooldown and thresholds are editable here; edits
// apply at the next check (rules read their settings each time they run). Plus the profile and the
// analysis options the daily view uses.

const DOMAINS: { id: RuleDef['domain']; title: string }[] = [
  { id: 'gait', title: 'Gait' },
  { id: 'hydration', title: 'Water' },
  { id: 'posture', title: 'Posture' },
  { id: 'environment', title: 'Environment' },
  { id: 'heart', title: 'Heart & SpO₂' },
  { id: 'data', title: 'Sensors' },
];

const SEV_LABEL: Record<Severity, string> = { info: 'Info', nudge: 'Nudge', warning: 'Warning', urgent: 'Urgent' };

// A number field that only commits valid values (within [min, max]); shows the range and an error.
const NumberField = ({ label, unit, value, min, max, onCommit, allowEmpty = false }: {
  label: string; unit: string; value: number | null; min: number; max: number; onCommit: (v: number | null) => void; allowEmpty?: boolean;
}) => {
  const [text, setText] = useState(value === null ? '' : String(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setText(value === null ? '' : String(value)); }, [value]);
  const commit = () => {
    const t = text.trim();
    if (!t && allowEmpty) { setError(null); onCommit(null); return; }
    const v = Number(t);
    if (!t || !Number.isFinite(v) || v < min || v > max) {
      setError(`Enter ${min}–${max}`);
      setText(value === null ? '' : String(value));
      return;
    }
    setError(null);
    if (v !== value) onCommit(v);
  };
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.fieldRight}>
        <TextInput style={styles.input} value={text} onChangeText={setText} onEndEditing={commit} onSubmitEditing={commit} keyboardType="numeric" />
        <Text style={styles.unit}>{unit}</Text>
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
};

const RuleCard = ({ def }: { def: RuleDef }) => {
  const override = useAlertRulesStore((s) => s.overrides[def.id]);
  const set = useAlertRulesStore((s) => s.setRuleOverride);
  const reset = useAlertRulesStore((s) => s.resetRule);
  const [open, setOpen] = useState(false);
  const r = resolveRule(def.id);
  const changed = !!override && Object.keys(override).length > 0;
  return (
    <View style={styles.rule}>
      <View style={styles.ruleHead}>
        <TouchableOpacity style={styles.ruleTitleBox} onPress={() => setOpen(!open)}>
          <Text style={styles.ruleTitle}>{def.label}</Text>
          <Text style={styles.ruleSub}>{def.id} · {SEV_LABEL[r.severity]}{changed ? ' · edited' : ''} · {open ? 'hide' : 'edit'}</Text>
        </TouchableOpacity>
        <Switch value={r.enabled} onValueChange={(enabled) => set(def.id, { enabled })} />
      </View>
      {open && (
        <View>
          <Text style={styles.desc}>{def.description}</Text>
          <Text style={styles.fieldLabel}>Severity</Text>
          <View style={styles.chips}>
            {SEVERITIES.map((sv) => (
              <TouchableOpacity key={sv} style={[styles.chip, r.severity === sv && styles.chipOn]} onPress={() => set(def.id, { severity: sv })}>
                <Text style={[styles.chipText, r.severity === sv && styles.chipTextOn]}>{SEV_LABEL[sv]}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {def.params.map((p: RuleParam) => (
            <NumberField key={p.key} label={p.label} unit={p.unit} value={r.params[p.key]} min={p.min} max={p.max}
              onCommit={(v) => set(def.id, { params: { [p.key]: v as number } })} />
          ))}
          <NumberField label="Don't repeat within" unit="min" value={r.cooldownMin} min={1} max={1440}
            onCommit={(v) => set(def.id, { cooldownMin: v as number })} />
          {changed && (
            <TouchableOpacity style={styles.resetBtn} onPress={() => reset(def.id)}>
              <Text style={styles.resetText}>Reset to defaults</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
    </View>
  );
};

export const AlertSettingsScreen = ({ visible, onClose }: { visible: boolean; onClose: () => void }) => {
  const profile = useAlertRulesStore((s) => s.profile);
  const analysis = useAlertRulesStore((s) => s.analysis);
  useAlertRulesStore((s) => s.policyOverride); // re-render on policy edits
  const setProfile = useAlertRulesStore((s) => s.setProfile);
  const setAnalysis = useAlertRulesStore((s) => s.setAnalysis);
  const setPolicy = useAlertRulesStore((s) => s.setPolicy);
  const policy = resolvePolicy();
  const [tested, setTested] = useState(false);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.screen}>
        <View style={styles.header}>
          <Text style={styles.title}>Alerts & reminders</Text>
          <TouchableOpacity onPress={onClose}><Text style={styles.done}>Done</Text></TouchableOpacity>
        </View>
        <ScrollView>
          <Text style={styles.section}>Profile</Text>
          <View style={styles.card}>
            <Text style={styles.fieldLabel}>Sex (sets the daily water target: 2.0 L male, 1.6 L female)</Text>
            <View style={styles.chips}>
              {([null, 'male', 'female'] as const).map((sx) => (
                <TouchableOpacity key={String(sx)} style={[styles.chip, profile.sex === sx && styles.chipOn]} onPress={() => setProfile({ sex: sx })}>
                  <Text style={[styles.chipText, profile.sex === sx && styles.chipTextOn]}>{sx === null ? 'Not set' : sx === 'male' ? 'Male' : 'Female'}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <NumberField label="Height" unit="m" value={profile.heightM} min={1} max={2.5} allowEmpty onCommit={(v) => setProfile({ heightM: v })} />
            <NumberField label="Weight" unit="kg" value={profile.massKg} min={20} max={250} allowEmpty onCommit={(v) => setProfile({ massKg: v })} />
          </View>

          <Text style={styles.section}>Analysis</Text>
          <View style={styles.card}>
            <NumberField label="Daily water target (empty = from profile)" unit="mL" value={analysis.hydrationTargetMl} min={500} max={6000} allowEmpty
              onCommit={(v) => setAnalysis({ hydrationTargetMl: v })} />
            <NumberField label={`Environment temperature correction (default ${DEFAULT_ANALYSIS.tempOffsetC})`} unit="°C" value={analysis.tempOffsetC} min={-20} max={10}
              onCommit={(v) => setAnalysis({ tempOffsetC: v as number })} />
            <View style={styles.switchRow}>
              <Text style={[styles.fieldLabel, styles.flex]}>The cushion reports my upright sitting as LEAN_FORWARD (count it as upright)</Text>
              <Switch value={analysis.leanForwardIsUpright} onValueChange={(v) => setAnalysis({ leanForwardIsUpright: v })} />
            </View>
          </View>

          <Text style={styles.section}>Notifications</Text>
          <View style={styles.card}>
            <View style={styles.switchRow}>
              <Text style={[styles.fieldLabel, styles.flex]}>Quiet hours (only urgent alerts notify)</Text>
              <Switch value={policy.quietHoursEnabled} onValueChange={(v) => setPolicy({ quietHoursEnabled: v })} />
            </View>
            <NumberField label="Quiet from" unit="h" value={policy.quietStartHour} min={0} max={23} onCommit={(v) => setPolicy({ quietStartHour: v as number })} />
            <NumberField label="Quiet until" unit="h" value={policy.quietEndHour} min={0} max={23} onCommit={(v) => setPolicy({ quietEndHour: v as number })} />
            <NumberField label={`Most non-urgent notifications a day (default ${DEFAULT_POLICY.maxNonUrgentPerDay})`} unit="" value={policy.maxNonUrgentPerDay} min={1} max={100}
              onCommit={(v) => setPolicy({ maxNonUrgentPerDay: v as number })} />
            <TouchableOpacity style={styles.testBtn} onPress={() => { sendTestNotification().then(() => setTested(true)).catch(() => {}); }}>
              <Text style={styles.testText}>{tested ? 'Sent — check the notification shade' : 'Send a test notification'}</Text>
            </TouchableOpacity>
          </View>

          {DOMAINS.map((d) => (
            <View key={d.id}>
              <Text style={styles.section}>{d.title}</Text>
              <View style={styles.card}>
                {RULE_DEFS.filter((r) => r.domain === d.id).map((r) => <RuleCard key={r.id} def={r} />)}
              </View>
            </View>
          ))}
          <Text style={styles.footer}>Every alert, including ones held back by quiet hours or the daily limit, is saved with the settings in force at the time in Downloads/GaitTwin/daily/&lt;date&gt;/alerts.csv.</Text>
        </ScrollView>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f4f6f9', padding: 15 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  title: { fontSize: 20, fontWeight: 'bold', color: '#1a202c' },
  done: { fontSize: 16, fontWeight: 'bold', color: '#2196F3' },
  section: { fontSize: 13, fontWeight: 'bold', color: '#718096', marginTop: 14, marginBottom: 6, textTransform: 'uppercase' },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 12, elevation: 1 },
  rule: { borderBottomWidth: 1, borderColor: '#edf2f7', paddingVertical: 8 },
  ruleHead: { flexDirection: 'row', alignItems: 'center' },
  ruleTitleBox: { flex: 1 },
  ruleTitle: { fontSize: 14, fontWeight: '600', color: '#2d3748' },
  ruleSub: { fontSize: 11, color: '#a0aec0', marginTop: 2 },
  desc: { fontSize: 12, color: '#4a5568', marginVertical: 6, lineHeight: 17 },
  field: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  fieldLabel: { fontSize: 12.5, color: '#2d3748', flexShrink: 1, maxWidth: '68%' },
  fieldRight: { flexDirection: 'row', alignItems: 'center' },
  input: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 6, minWidth: 64, height: 36, paddingHorizontal: 8, textAlign: 'right', color: '#1a202c' },
  unit: { fontSize: 12, color: '#718096', marginLeft: 6, minWidth: 34 },
  error: { width: '100%', fontSize: 11, color: '#b3261e', textAlign: 'right' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 4, marginBottom: 4 },
  chip: { backgroundColor: '#edf2f7', borderRadius: 14, paddingHorizontal: 12, paddingVertical: 6, marginRight: 6, marginBottom: 6 },
  chipOn: { backgroundColor: '#2196F3' },
  chipText: { fontSize: 12.5, fontWeight: '600', color: '#4a5568' },
  chipTextOn: { color: '#fff' },
  switchRow: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  flex: { flex: 1, maxWidth: '100%' },
  resetBtn: { alignSelf: 'flex-start', marginTop: 8 },
  resetText: { color: '#b3261e', fontWeight: '600', fontSize: 12.5 },
  testBtn: { backgroundColor: '#2d3748', borderRadius: 8, padding: 10, alignItems: 'center', marginTop: 12 },
  testText: { color: '#fff', fontWeight: 'bold', fontSize: 13 },
  footer: { fontSize: 11, color: '#a0aec0', marginVertical: 20, textAlign: 'center' },
});
