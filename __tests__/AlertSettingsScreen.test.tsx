import React from 'react';
import { Switch, Text, TextInput, TouchableOpacity } from 'react-native';
import ReactTestRenderer from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AlertSettingsScreen } from '../src/screens/AlertSettingsScreen';
import { RULE_DEFS } from '../src/config/alertRules';
import { resolveRule, useAlertRulesStore } from '../src/store/AlertRulesStore';

const textOf = (n: ReactTestRenderer.ReactTestInstance): string =>
  n.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');

beforeEach(async () => {
  await AsyncStorage.clear();
  useAlertRulesStore.setState({ overrides: {}, policyOverride: {} });
});

test('every rule is listed and can be switched off, edited within its range, and reset', async () => {
  let tree: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<AlertSettingsScreen visible onClose={() => {}} />);
  });
  const root = tree!.root;
  const texts = root.findAllByType(Text).map(textOf);
  for (const d of RULE_DEFS) expect(texts).toContain(d.label);

  // the "Stuffy room (CO₂)" rule card
  const card = () => root.findAll((n) => n.props?.def?.id === 'EN-3')[0];
  await ReactTestRenderer.act(async () => { card().findByType(Switch).props.onValueChange(false); });
  expect(resolveRule('EN-3').enabled).toBe(false);

  // open it and edit the CO₂ level: 650 is accepted, 99 (below the 500 minimum) is refused
  await ReactTestRenderer.act(async () => { card().findAllByType(TouchableOpacity)[0].props.onPress(); });
  const levelInput = () => card().findAllByType(TextInput)[0];
  await ReactTestRenderer.act(async () => { levelInput().props.onChangeText('650'); });
  await ReactTestRenderer.act(async () => { levelInput().props.onEndEditing(); });
  expect(resolveRule('EN-3').params.co2).toBe(650);
  await ReactTestRenderer.act(async () => { levelInput().props.onChangeText('99'); });
  await ReactTestRenderer.act(async () => { levelInput().props.onEndEditing(); });
  expect(resolveRule('EN-3').params.co2).toBe(650);
  expect(card().findAllByType(Text).map(textOf)).toContain('Enter 500–5000');

  // reset brings back the defaults
  const reset = card().findAllByType(TouchableOpacity).find((b) => textOf(b) === 'Reset to defaults')!;
  await ReactTestRenderer.act(async () => { reset.props.onPress(); });
  expect(resolveRule('EN-3')).toMatchObject({ enabled: true, params: { co2: 1000 } });
});
