import React, { useState } from 'react';
import { LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Svg, { Line, Rect } from 'react-native-svg';
import { MeasureDetail } from '../../health/gaitDetail';
import { FOOT_COLORS, fx, ui } from './ui';

const useWidth = () => {
  const [width, setWidth] = useState(0);
  return [width, (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)] as const;
};

// One measure: right and left values as bars, and the symmetry index on a gauge with the "even" range
// (your usual band, or 0 ± the fixed limit) shaded.
export const MeasureCompare = ({ m }: { m: MeasureDetail }) => {
  const [width, onLayout] = useWidth();
  const max = Math.max(m.R ?? 0, m.L ?? 0) || 1;
  const reach = Math.max(Math.abs(m.si ?? 0), Math.abs(m.centre) + m.limit) * 1.25 || 1;
  const gx = (v: number) => width / 2 + (v / reach) * (width / 2);
  const H = 18;
  return (
    <View style={ui.divider} onLayout={onLayout}>
      <View style={ui.between}>
        <Text style={styles.name}>{m.name[0].toUpperCase() + m.name.slice(1)}</Text>
        <Text style={[styles.si, m.uneven ? ui.warnText : ui.okText]}>
          {m.si === null ? 'SI —' : `SI ${m.si >= 0 ? '+' : ''}${m.si.toFixed(1)} %`}
        </Text>
      </View>
      {(['R', 'L'] as const).map((f) => (
        <View key={f} style={[ui.row, styles.barRow]}>
          <Text style={styles.foot}>{f}</Text>
          <View style={styles.barTrack}>
            <View style={[styles.bar, { width: `${((m[f] ?? 0) / max) * 100}%`, backgroundColor: FOOT_COLORS[f] }]} />
          </View>
          <Text style={styles.val}>{fx(m[f], m.digits)} {m.unit}</Text>
        </View>
      ))}
      {width > 0 && (
        <Svg width={width} height={H}>
          <Line x1={0} x2={width} y1={H / 2} y2={H / 2} stroke="#e2e8f0" strokeWidth={2} />
          <Rect x={gx(m.centre - m.limit)} y={3} width={gx(m.centre + m.limit) - gx(m.centre - m.limit)} height={H - 6} fill="#c6f6d5" />
          <Line x1={gx(0)} x2={gx(0)} y1={1} y2={H - 1} stroke="#a0aec0" strokeWidth={1} />
          {m.si !== null && <Rect x={gx(m.si) - 2} y={0} width={4} height={H} fill={m.uneven ? '#dd6b20' : '#2d3748'} />}
        </Svg>
      )}
      <Text style={ui.tiny}>
        Even range {m.centre - m.limit >= 0 ? '+' : ''}{(m.centre - m.limit).toFixed(1)} to {m.centre + m.limit >= 0 ? '+' : ''}{(m.centre + m.limit).toFixed(1)} %
        {m.personal ? ' (your usual)' : ' (fixed limit until your usual is learned)'}. Positive = right larger.
      </Text>
    </View>
  );
};

// Stride-time distribution, right and left side by side per bin. `scale` divides the axis (seconds ->
// body-size-scaled units); the counts are the same.
export const StrideHistogram = ({ hist, scale, unit }: { hist: { lo: number; binS: number; R: number[]; L: number[] }; scale: number; unit: string }) => {
  const [width, onLayout] = useWidth();
  const H = 90;
  const n = hist.R.length;
  const max = Math.max(1, ...hist.R, ...hist.L);
  const bw = width / n;
  const label = (v: number) => (v / scale).toFixed(scale === 1 ? 2 : 1);
  return (
    <View onLayout={onLayout}>
      {width > 0 && (
        <Svg width={width} height={H}>
          <Rect x={0} y={0} width={width} height={H} fill="#f7fafc" />
          {hist.R.map((c, i) => (c ? <Rect key={`R${i}`} x={i * bw + 0.5} y={H - (c / max) * (H - 4)} width={Math.max(1, bw / 2 - 0.5)} height={(c / max) * (H - 4)} fill={FOOT_COLORS.R} /> : null))}
          {hist.L.map((c, i) => (c ? <Rect key={`L${i}`} x={i * bw + bw / 2} y={H - (c / max) * (H - 4)} width={Math.max(1, bw / 2 - 0.5)} height={(c / max) * (H - 4)} fill={FOOT_COLORS.L} /> : null))}
        </Svg>
      )}
      {width > 0 && (
        <View style={[ui.axis, { width }]}>
          <Text style={ui.axisText}>{label(hist.lo)}</Text>
          <Text style={ui.axisText}>{label(hist.lo + (n * hist.binS) / 2)}</Text>
          <Text style={ui.axisText}>{label(hist.lo + n * hist.binS)} {unit}</Text>
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  name: { fontSize: 12.5, fontWeight: 'bold', color: '#2d3748', flexShrink: 1 },
  si: { fontSize: 12, fontWeight: 'bold' },
  barRow: { marginTop: 4 },
  foot: { width: 14, fontSize: 11, fontWeight: 'bold', color: '#4a5568' },
  barTrack: { flex: 1, height: 8, backgroundColor: '#edf2f7', borderRadius: 4, overflow: 'hidden', marginRight: 8 },
  bar: { height: 8, borderRadius: 4 },
  val: { width: 92, fontSize: 11, color: '#4a5568', textAlign: 'right' },
});
