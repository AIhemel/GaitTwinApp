import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Evaluation, RuleEval, Spread } from '../health/evaluation';
import { DEFINITIONS, EvalPeriod, exportEvaluation, loadEvaluation } from '../health/evaluationExport';
import { useHealthStore } from '../store/HealthStore';
import { Card, Kv, Segmented, ui } from '../components/today/ui';

// Thesis evaluation of the alerts: precision from your answers, false alarms per day, and the delay
// from an event to its notification, with an export for the write-up (FEATURE_HEALTH_TWIN.md §7.6).

const pct = (x: number | null) => (x === null ? '—' : `${Math.round(100 * x)} %`);
const secs = (s: number | null) => (s === null ? '—' : s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const delayText = (d: Spread) => (d.n ? `${secs(d.medianS)} median, ${secs(d.p90S)} p90 (${d.n})` : '—');

const RuleRow = ({ r }: { r: RuleEval }) => (
  <View style={ui.divider}>
    <View style={ui.between}>
      <Text style={styles.rule}>{r.name} <Text style={ui.muted}>{r.ruleId}</Text></Text>
      <Text style={styles.ruleRight}>{r.delivered} notified</Text>
    </View>
    <Text style={ui.small}>
      Answered {r.answered} of {r.logged}: useful {r.useful}, not useful {r.notUseful}, wrong {r.wrong}
      {r.answered ? ` · precision ${pct(r.precision)}` : ''}
    </Text>
    <Text style={ui.small}>
      Delay {delayText(r.delay)}{r.repeats ? ` · ${r.repeats} repeat${r.repeats > 1 ? 's' : ''}` : ''}
      {Object.keys(r.suppressed).length ? ` · not notified: ${Object.entries(r.suppressed).map(([k, v]) => `${k.replace('_', ' ')} ${v}`).join(', ')}` : ''}
    </Text>
  </View>
);

export const EvaluationScreen = ({ visible, onClose }: { visible: boolean; onClose: () => void }) => {
  const [period, setPeriod] = useState<EvalPeriod>('all');
  const [ev, setEv] = useState<Evaluation | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alertsVersion = useHealthStore((st) => st.alertsVersion);

  const load = useCallback(() => {
    setSaved(null);
    return loadEvaluation(period).then(setEv).catch((e) => { console.warn('Evaluation failed:', e); setEv(null); });
  }, [period]);
  useEffect(() => { if (visible) load(); }, [visible, load, alertsVersion]);

  const onExport = async () => {
    if (!ev) return;
    setBusy(true);
    try {
      await exportEvaluation(ev, period);
      setSaved('Saved to Downloads/GaitTwin/evaluation/: alerts_evaluation.csv, rules_evaluation.csv, evaluation_summary.json');
    } catch (e) {
      setSaved(`Export failed: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setBusy(false);
    }
  };

  const o = ev?.overall;
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.screen}>
        <View style={styles.header}>
          <Text style={styles.title}>Alert evaluation</Text>
          <TouchableOpacity onPress={onClose}><Text style={styles.done}>Done</Text></TouchableOpacity>
        </View>
        <Segmented options={[['all', 'All days'], ['30', 'Last 30 days'], ['7', 'Last 7 days']]} value={period} onChange={setPeriod} />
        {!ev || !o ? <ActivityIndicator /> : (
          <ScrollView>
            <Card title={ev.from ? `${ev.from} – ${ev.to} · ${ev.days} day${ev.days === 1 ? '' : 's'}` : 'No days yet'}>
              <Kv items={[
                [String(o.logged), 'alerts'],
                [String(o.delivered), 'notified'],
                [`${o.answered}`, 'answered'],
              ]} />
              <Kv items={[
                [pct(o.precision), 'precision'],
                [o.falseAlarmsPerDay === null ? '—' : o.falseAlarmsPerDay.toFixed(2), 'false alarms / day'],
                [secs(o.delay.medianS), 'median delay'],
              ]} />
              {o.answered > 0 && o.precisionCi && (
                <Text style={ui.small}>
                  Precision {pct(o.precision)} (95 % interval {pct(o.precisionCi[0])}–{pct(o.precisionCi[1])}); useful {pct(o.usefulRate)} of answered alerts.
                </Text>
              )}
              {o.unanswered > 0 && (
                <Text style={[ui.small, ui.warnText]}>
                  {o.unanswered} alert{o.unanswered > 1 ? 's' : ''} not answered yet: false alarms per day are between {o.falseAlarmsPerDay?.toFixed(2)} and {o.falseAlarmsPerDayWorst?.toFixed(2)} (if every unanswered alert were wrong). Answer them on the Today tab to narrow this.
                </Text>
              )}
              <Text style={ui.small}>
                {o.deliveredPerDay !== null ? `${o.deliveredPerDay.toFixed(1)} notifications per day. ` : ''}
                Delay from event to notification: {delayText(o.delay)}; from the event's start: {delayText(o.sinceOnset)}. You answered after {delayText(o.responseDelay)}.
              </Text>
            </Card>

            <Card title="Per rule">
              {!ev.rules.length && <Text style={ui.small}>No alerts in this period.</Text>}
              {ev.rules.map((r) => <RuleRow key={r.ruleId} r={r} />)}
            </Card>

            <Card title="Export for the thesis">
              <Text style={ui.small}>
                Writes one row per alert (with your answer, event times and delay) and one row per rule, plus a JSON summary with
                the definitions below. Each export replaces the previous one.
              </Text>
              <TouchableOpacity style={styles.btn} disabled={busy} onPress={onExport}>
                <Text style={styles.btnText}>{busy ? 'Exporting…' : 'Export CSV + JSON'}</Text>
              </TouchableOpacity>
              {saved && <Text style={[ui.small, saved.startsWith('Export failed') ? ui.alertText : ui.okText]}>{saved}</Text>}
            </Card>

            <Card title="Definitions">
              {Object.entries(DEFINITIONS).map(([k, v]) => (
                <Text key={k} style={ui.small}><Text style={styles.term}>{k.replace(/_/g, ' ')}: </Text>{v}</Text>
              ))}
            </Card>
          </ScrollView>
        )}
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f4f6f9', padding: 15 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  title: { fontSize: 20, fontWeight: 'bold', color: '#1a202c' },
  done: { fontSize: 16, fontWeight: 'bold', color: '#2196F3' },
  rule: { fontSize: 13, fontWeight: '600', color: '#2d3748', flexShrink: 1 },
  ruleRight: { fontSize: 12, color: '#4a5568', marginLeft: 8 },
  btn: { backgroundColor: '#2d3748', borderRadius: 8, padding: 10, alignItems: 'center', marginTop: 10 },
  btnText: { color: '#fff', fontWeight: 'bold', fontSize: 13 },
  term: { fontWeight: 'bold', color: '#2d3748' },
});
