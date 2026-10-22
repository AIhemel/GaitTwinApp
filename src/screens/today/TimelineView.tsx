import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CtxKind, CTX_STYLE, buildTimeline } from '../../health/timeline';
import { DayFiles } from '../../health/history';
import { fmtDuration } from '../../health/daySummary';
import { PIN_COLORS, TimelineChart } from '../../components/today/TimelineChart';
import { Card, Swatch, hhmm, ui } from '../../components/today/ui';

// Timeline: the day as one picture (FEATURE_HEALTH_TWIN.md §6 screen 2).

const PIN_NAMES = { drink: 'Drink', alert: 'Alert', tap: 'Your tap' };

export const TimelineView = ({ files, isToday }: { files: DayFiles; isToday: boolean }) => {
  const tl = useMemo(() => buildTimeline(files.dayStart, files.minutes, files.alerts, files.labels), [files]);
  const now = new Date();
  const nowMin = isToday ? now.getHours() * 60 + now.getMinutes() : null;
  const kinds = (Object.keys(CTX_STYLE) as CtxKind[]).filter((k) => k !== 'none' && tl.contextMin[k]);

  if (!files.minutes.length) {
    return <Card title="Timeline"><Text style={ui.small}>No minute table for this day yet.</Text></Card>;
  }
  return (
    <>
      <Card title="Your day">
        <TimelineChart tl={tl} nowMin={nowMin} />
        <View style={ui.legend}>
          {kinds.map((k) => (
            <View key={k} style={ui.legendItem}>
              <Swatch color={CTX_STYLE[k].color} />
              <Text style={ui.legendText}>{CTX_STYLE[k].label} {fmtDuration(tl.contextMin[k] as number)}</Text>
            </View>
          ))}
        </View>
        <Text style={ui.tiny}>
          Activity comes from the band's sleep record, your walk / rickshaw / metro taps, insole strides and the posture
          cushion. Heart rate, PM2.5 and steps are 5-minute values; PM2.5 colours are the EPA air-quality bands.
        </Text>
      </Card>

      <Card title="Events">
        {!tl.pins.length ? <Text style={ui.small}>No drinks, alerts or taps on this day.</Text> : tl.pins.map((p, i) => (
          <View key={`${p.t}-${i}`} style={[ui.row, styles.event]}>
            <Swatch color={PIN_COLORS[p.kind]} />
            <Text style={[ui.small, styles.eventText]}>
              {hhmm(p.t)} · {PIN_NAMES[p.kind]}: {p.text}
            </Text>
          </View>
        ))}
      </Card>
    </>
  );
};

const styles = StyleSheet.create({
  event: { marginTop: 5 },
  eventText: { marginTop: 0, flex: 1 },
});
