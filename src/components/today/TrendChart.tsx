import React, { useState } from 'react';
import { LayoutChangeEvent, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import { TrendSeries } from '../../health/trends';
import { fx, ui } from './ui';

// One measure over 7 or 30 days: a dot per recorded day, your usual range as a shaded band with its
// median dashed, and days outside the band in orange.

const H = 70;
const PAD = 6;

export const TrendChart = ({ s }: { s: TrendSeries }) => {
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);
  const { def, points, band } = s;
  const vals = points.map((p) => p.value).filter((v): v is number => v !== null);
  const lo0 = Math.min(...vals, ...(band ? [band.lo] : []));
  const hi0 = Math.max(...vals, ...(band ? [band.hi] : []));
  const span = hi0 - lo0 || Math.abs(hi0) || 1;
  const lo = lo0 - 0.08 * span;
  const hi = hi0 + 0.08 * span;
  const y = (v: number) => PAD + (1 - (v - lo) / (hi - lo)) * (H - 2 * PAD);
  const step = points.length > 1 ? (width - 2 * PAD) / (points.length - 1) : 0;
  const x = (i: number) => PAD + i * step;
  let d = '';
  let pen = false;
  points.forEach((p, i) => {
    if (p.value === null) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)} `;
    pen = true;
  });
  const last = [...points].reverse().find((p) => p.value !== null);

  return (
    <View style={styles.wrap} onLayout={onLayout}>
      <View style={ui.between}>
        <Text style={styles.title}>{def.label}</Text>
        <Text style={styles.value}>{last ? `${fx(last.value, def.digits)} ${def.unit}` : '—'}</Text>
      </View>
      {width > 0 && vals.length > 0 && (
        <Svg width={width} height={H}>
          <Rect x={0} y={0} width={width} height={H} fill="#f7fafc" />
          {band && <Rect x={0} y={y(band.hi)} width={width} height={Math.max(1, y(band.lo) - y(band.hi))} fill="#c6f6d5" />}
          {band && <Line x1={0} x2={width} y1={y(band.median)} y2={y(band.median)} stroke="#38a169" strokeWidth={1} strokeDasharray="4,3" />}
          <Path d={d.trim()} stroke="#4a5568" strokeWidth={1.2} fill="none" />
          {points.map((p, i) => (p.value === null ? null : (
            <Circle key={p.date} cx={x(i)} cy={y(p.value)} r={points.length > 10 ? 2.5 : 3.5} fill={p.outside ? '#dd6b20' : '#2d3748'} />
          )))}
        </Svg>
      )}
      {width > 0 && vals.length === 0 && <Text style={ui.tiny}>No values in this period.</Text>}
      <Text style={ui.tiny}>
        {band
          ? `Usual ${fx(band.lo, def.digits)}–${fx(band.hi, def.digits)} ${def.unit} (median ${fx(band.median, def.digits)}, ${band.days} days)` +
            (s.days ? ` · ${s.outsideDays} of ${s.days} day${s.days > 1 ? 's' : ''} outside` : '')
          : `Usual range not learned yet · ${s.days} day${s.days === 1 ? '' : 's'} with data`}
        {` · ${def.note}`}
      </Text>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { marginTop: 12 },
  title: { fontSize: 12.5, fontWeight: 'bold', color: '#2d3748' },
  value: { fontSize: 12.5, fontWeight: 'bold', color: '#2b6cb0' },
});
