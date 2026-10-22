import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { gaitDetail, LEG_FRACTION } from '../../health/gaitDetail';
import { DayFiles } from '../../health/history';
import { SI_NAMES } from '../../health/daySummary';
import { useHealthStore } from '../../store/HealthStore';
import { resolvePolicy, resolveRule, useAlertRulesStore } from '../../store/AlertRulesStore';
import { MeasureCompare, StrideHistogram } from '../../components/today/GaitCharts';
import { Card, FOOT_COLORS, Kv, Segmented, Swatch, fx, hhmm, n0, ui } from '../../components/today/ui';

// Gait detail for one day (FEATURE_HEALTH_TWIN.md §6 screen 4): left vs right per measure with the
// symmetry index and your usual band, the stride-time distribution (also scaled for body size), and
// every walk. The two insoles keep separate clocks, so each foot's measures use only its own data.

export const GaitDetailView = ({ files }: { files: DayFiles }) => {
  const baselines = useHealthStore((st) => st.baselines);
  const heightM = useAlertRulesStore((st) => st.profile.heightM);
  // edits to the uneven-steps rule or the learning settings change the even ranges
  const overrides = useAlertRulesStore((st) => st.overrides);
  const policyOverride = useAlertRulesStore((st) => st.policyOverride);
  const [axis, setAxis] = useState<'s' | 'scaled'>('s');
  const d = useMemo(() => gaitDetail(files.strides, {
    baselines, minBaselineDays: resolvePolicy().minBaselineDays, gaitLimits: resolveRule('GA-1').params, heightM,
  }), [files, baselines, heightM, overrides, policyOverride]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!d.strides.R && !d.strides.L) {
    return <Card title="Gait"><Text style={ui.small}>No strides detected by the insoles on this day.</Text></Card>;
  }
  const scaled = axis === 'scaled' && d.scaleS !== null;
  return (
    <>
      <Card title="Left vs right" chip={d.measures.some((m) => m.uneven) ? { label: 'Uneven', tone: 'warn' } : { label: 'Even', tone: 'ok' }}>
        <Kv items={[[`${d.strides.R} / ${d.strides.L}`, 'strides R / L'], [`${d.steady.R} / ${d.steady.L}`, 'steady R / L']]} />
        <View style={ui.legend}>
          <View style={ui.legendItem}><Swatch color={FOOT_COLORS.R} /><Text style={ui.legendText}>Right</Text></View>
          <View style={ui.legendItem}><Swatch color={FOOT_COLORS.L} /><Text style={ui.legendText}>Left</Text></View>
          <View style={ui.legendItem}><Swatch color="#c6f6d5" /><Text style={ui.legendText}>Even range</Text></View>
        </View>
        {d.measures.map((m) => <MeasureCompare key={m.key} m={m} />)}
        <Text style={ui.tiny}>
          Medians over steady strides. Symmetry index SI = 100 × (R − L) / mean(R, L). Stance, swing and push-off come
          from the foot's motion sensor, so they stay valid when a pressure sensor is faulty or replaced.
        </Text>
      </Card>

      <Card title="Stride time">
        <Kv items={[
          [`${fx(d.medianStrideS.R, 2)} / ${fx(d.medianStrideS.L, 2)} s`, 'median R / L'],
          [`${fx(d.cvPct.R, 1)} / ${fx(d.cvPct.L, 1)} %`, 'variability (CV) R / L'],
          [d.usualStrideS !== null ? `${d.usualStrideS.toFixed(2)} s` : '—', 'your usual'],
        ]} />
        {d.scaleS !== null && (
          <Segmented options={[['s', 'Seconds'], ['scaled', 'Scaled for body size']]} value={axis} onChange={setAxis} small />
        )}
        {d.hist && <StrideHistogram hist={d.hist} scale={scaled ? (d.scaleS as number) : 1} unit={scaled ? '' : 's'} />}
        <Text style={ui.tiny}>
          {scaled
            ? `Stride time ÷ √(leg length / g), leg length = ${LEG_FRACTION} × height = ${fx(d.legM, 2)} m, so √(L/g) = ${fx(d.scaleS, 3)} s. This removes body size (a longer leg swings more slowly), so strides can be compared between people. Median scaled: R ${fx(d.medianStrideS.R !== null ? d.medianStrideS.R / (d.scaleS as number) : null, 2)}, L ${fx(d.medianStrideS.L !== null ? d.medianStrideS.L / (d.scaleS as number) : null, 2)}.`
            : 'All detected strides, 0.05 s bins. Variability (coefficient of variation) is over steady strides.'}
          {d.scaleS === null ? ' Set your height under ⚙ Alerts & reminders → Profile to see the body-size-scaled view.' : ''}
        </Text>
      </Card>

      <Card title={`Walks (${d.walks.length})`}>
        {!d.walks.length && <Text style={ui.small}>No walk of 20+ strides on this day.</Text>}
        {d.walks.map((w) => (
          <View key={w.start} style={ui.divider}>
            <Text style={styles.walkTitle}>{hhmm(w.start)}–{hhmm(w.end)} · {w.steps} steps · {n0(w.cadence)} steps/min · stride {fx(w.strideS, 2)} s</Text>
            <Text style={ui.small}>
              {Object.entries(w.si).filter(([, v]) => v !== null).map(([k, v]) => `${SI_NAMES[k].replace(/ \(.*\)/, '')} ${(v as number) >= 0 ? '+' : ''}${(v as number).toFixed(1)} %`).join(' · ') || 'One foot only: no left/right comparison.'}
            </Text>
            <Text style={[ui.small, w.uneven.length ? ui.warnText : ui.okText]}>{w.feedback}</Text>
            {w.vsUsual && <Text style={ui.small}>{w.vsUsual}</Text>}
          </View>
        ))}
      </Card>
    </>
  );
};

const styles = StyleSheet.create({
  walkTitle: { fontSize: 13, fontWeight: '600', color: '#2d3748' },
});
