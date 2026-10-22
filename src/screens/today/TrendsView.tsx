import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text } from 'react-native';
import { DayMetrics, TREND_METRICS, USUAL_K, lastDates, trendSeries } from '../../health/trends';
import { loadDayMetrics } from '../../health/history';
import { useHealthStore } from '../../store/HealthStore';
import { resolvePolicy, resolveRule } from '../../store/AlertRulesStore';
import { TrendChart } from '../../components/today/TrendChart';
import { Card, Segmented, ui } from '../../components/today/ui';

// Trends: each headline measure over the last 7 or 30 days against your usual range
// (FEATURE_HEALTH_TWIN.md §6 screens 3 and 5).

const GROUPS = ['Movement', 'Heart & sleep', 'Hydration & posture', 'Environment'] as const;

export const TrendsView = ({ endDate, version }: { endDate: string; version: number }) => {
  const [span, setSpan] = useState<'7' | '30'>('7');
  const [metrics, setMetrics] = useState<DayMetrics[] | null>(null);
  const days = useHealthStore((st) => st.days);
  const policy = resolvePolicy();
  const windowStrides = resolveRule('GA-1').params.windowStrides;

  useEffect(() => {
    let alive = true;
    // the view's 30 calendar days, plus enough earlier recorded days to learn the usual range from
    const view = new Set(lastDates(endDate, 30));
    const earlier = days.filter((d) => d < endDate).slice(0, policy.baselineWindowDays);
    const dates = [...new Set([...days.filter((d) => view.has(d)), ...earlier, endDate])].sort();
    loadDayMetrics(dates, windowStrides)
      .then((m) => { if (alive) setMetrics(m); })
      .catch((e) => { console.warn('Trends load failed:', e); if (alive) setMetrics([]); });
    return () => { alive = false; };
  }, [endDate, days, policy.baselineWindowDays, windowStrides, version]);

  const dates = useMemo(() => lastDates(endDate, Number(span)), [endDate, span]);
  const opts = { windowDays: policy.baselineWindowDays, minDays: policy.minBaselineDays };

  return (
    <>
      <Segmented options={[['7', 'Last 7 days'], ['30', 'Last 30 days']]} value={span} onChange={setSpan} small />
      <Text style={[ui.tiny, styles.explain]}>
        Green band = your usual range: the median of the {opts.windowDays} recorded days before {endDate} ± {USUAL_K} robust
        standard deviations (1.4826 × median absolute deviation). It appears once a measure has {opts.minDays} days of data.
        Orange dots are days outside it.
      </Text>
      {!metrics ? <ActivityIndicator /> : GROUPS.map((g) => (
        <Card key={g} title={g}>
          {TREND_METRICS.filter((m) => m.group === g).map((def) => (
            <TrendChart key={def.key} s={trendSeries(metrics, def, dates, opts)} />
          ))}
        </Card>
      ))}
    </>
  );
};

const styles = StyleSheet.create({
  explain: { marginBottom: 8 },
});
