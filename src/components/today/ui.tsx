import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

// Building blocks shared by the Today tab's views (Day, Timeline, Gait, Trends, Data).

export type Chip = { label: string; tone: 'ok' | 'info' | 'warn' | 'alert' };
export const CHIP_COLORS: Record<Chip['tone'], [string, string]> = {
  ok: ['#e6f4ea', '#1e7a3c'], info: ['#e8f0fb', '#2b5c9e'], warn: ['#fdf1e3', '#a05a10'], alert: ['#fde8e8', '#b3261e'],
};

export const FOOT_COLORS = { R: '#2b6cb0', L: '#dd6b20' };

export const hhmm = (ms: number | null | undefined) => (ms === null || ms === undefined ? '—' : new Date(ms).toTimeString().slice(0, 5));
export const n0 = (x: number | null | undefined) => (x === null || x === undefined ? '—' : x.toFixed(0));
export const fx = (x: number | null | undefined, d: number) => (x === null || x === undefined || !Number.isFinite(x) ? '—' : x.toFixed(d));

export const Card = ({ title, chip, children }: { title: string; chip?: Chip; children: React.ReactNode }) => (
  <View style={ui.card}>
    <View style={ui.cardHead}>
      <Text style={ui.cardTitle}>{title}</Text>
      {chip && (
        <View style={[ui.chip, { backgroundColor: CHIP_COLORS[chip.tone][0] }]}>
          <Text style={[ui.chipText, { color: CHIP_COLORS[chip.tone][1] }]}>{chip.label}</Text>
        </View>
      )}
    </View>
    {children}
  </View>
);

export const Kv = ({ items }: { items: [string, string][] }) => (
  <View style={ui.kv}>
    {items.map(([v, k]) => (
      <View key={k} style={ui.kvItem}><Text style={ui.kvVal}>{v}</Text><Text style={ui.kvKey}>{k}</Text></View>
    ))}
  </View>
);

export const Bar = ({ frac, color }: { frac: number; color: string }) => (
  <View style={ui.barBg}><View style={[ui.barFill, { width: `${Math.max(0, Math.min(1, frac)) * 100}%`, backgroundColor: color }]} /></View>
);

export const Swatch = ({ color }: { color: string }) => <View style={[ui.swatch, { backgroundColor: color }]} />;

// A row of mutually exclusive choices (view switcher, 7/30 days, seconds/scaled).
export function Segmented<T extends string>({ options, value, onChange, small }: {
  options: [T, string][]; value: T; onChange: (v: T) => void; small?: boolean;
}) {
  return (
    <View style={[ui.seg, small && ui.segSmall]}>
      {options.map(([k, label]) => (
        <TouchableOpacity key={k} style={[ui.segItem, value === k && ui.segItemOn]} onPress={() => onChange(k)}>
          <Text style={[ui.segText, small && ui.segTextSmall, value === k && ui.segTextOn]}>{label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

export const ui = StyleSheet.create({
  card: { backgroundColor: '#fff', padding: 14, borderRadius: 12, marginBottom: 12, elevation: 1 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  cardTitle: { fontSize: 15, fontWeight: 'bold', color: '#2d3748', marginBottom: 4, flexShrink: 1 },
  chip: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, marginLeft: 8 },
  chipText: { fontSize: 11, fontWeight: 'bold' },
  kv: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  kvItem: { flex: 1, alignItems: 'center' },
  kvVal: { fontSize: 17, fontWeight: 'bold', color: '#2b6cb0' },
  kvKey: { fontSize: 10.5, color: '#a0aec0', textAlign: 'center' },
  barBg: { height: 8, backgroundColor: '#edf2f7', borderRadius: 4, overflow: 'hidden', marginTop: 6 },
  barFill: { height: 8, borderRadius: 4 },
  small: { fontSize: 12, color: '#4a5568', marginTop: 4, lineHeight: 17 },
  tiny: { fontSize: 10.5, color: '#a0aec0', marginTop: 4, lineHeight: 15 },
  label: { fontSize: 12.5, fontWeight: 'bold', color: '#2d3748', marginTop: 10, marginBottom: 3 },
  warnText: { color: '#a05a10' },
  alertText: { color: '#b3261e' },
  okText: { color: '#1e7a3c' },
  muted: { color: '#a0aec0' },
  row: { flexDirection: 'row', alignItems: 'center' },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  divider: { borderTopWidth: 1, borderColor: '#edf2f7', paddingTop: 8, marginTop: 8 },
  swatch: { width: 10, height: 10, borderRadius: 2, marginRight: 5 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 6 },
  legendItem: { flexDirection: 'row', alignItems: 'center', marginRight: 12, marginBottom: 4 },
  legendText: { fontSize: 11, color: '#4a5568' },
  seg: { flexDirection: 'row', backgroundColor: '#e2e8f0', borderRadius: 10, padding: 3, marginBottom: 12 },
  segSmall: { alignSelf: 'flex-start', marginBottom: 8 },
  segItem: { flex: 1, paddingVertical: 7, paddingHorizontal: 8, borderRadius: 8, alignItems: 'center' },
  segItemOn: { backgroundColor: '#fff', elevation: 1 },
  segText: { fontSize: 12.5, fontWeight: '600', color: '#4a5568' },
  segTextSmall: { fontSize: 11.5 },
  segTextOn: { color: '#2196F3' },
  axis: { flexDirection: 'row', justifyContent: 'space-between' },
  axisText: { fontSize: 10, color: '#a0aec0' },
});
