import AsyncStorage from '@react-native-async-storage/async-storage';
import { resolveRule, resolvePolicy, useAlertRulesStore } from '../src/store/AlertRulesStore';

beforeEach(async () => {
  await AsyncStorage.clear();
  useAlertRulesStore.setState({ overrides: {}, policyOverride: {} });
});

test('defaults come from the rule definitions', () => {
  expect(resolveRule('DQ-1')).toMatchObject({ enabled: true, severity: 'info', cooldownMin: 60, params: { silentMinGait: 2, expectedGaitHz: 112 } });
});

test('an edit overrides only what was changed, and is clamped to the allowed range', async () => {
  await useAlertRulesStore.getState().setRuleOverride('DQ-1', { params: { silentMinGait: 5 } });
  await useAlertRulesStore.getState().setRuleOverride('DQ-1', { severity: 'warning', params: { minRateFraction: 500 } });
  const r = resolveRule('DQ-1');
  expect(r.params).toMatchObject({ silentMinGait: 5, minRateFraction: 100, silentMinHydration: 10 });
  expect(r.severity).toBe('warning');
});

test('edits survive an app restart, and reset brings back the defaults', async () => {
  await useAlertRulesStore.getState().setRuleOverride('DQ-1', { enabled: false });
  await useAlertRulesStore.getState().setPolicy({ quietStartHour: 22 });
  useAlertRulesStore.setState({ overrides: {}, policyOverride: {} }); // "restart"
  await useAlertRulesStore.getState().load();
  expect(resolveRule('DQ-1').enabled).toBe(false);
  expect(resolvePolicy().quietStartHour).toBe(22);

  await useAlertRulesStore.getState().resetRule('DQ-1');
  expect(resolveRule('DQ-1').enabled).toBe(true);
});
