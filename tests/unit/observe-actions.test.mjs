import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveActions, findHealingAction } from '../../lib/observe-actions.mjs';

const nodes = [
  { ref: '@e1', tag: 'a', role: 'link', name: 'Dashboard', clickable: true },
  { ref: '@e2', tag: 'input', role: 'textbox', name: 'Email', inputType: 'email' },
  { ref: '@e3', tag: 'input', role: 'checkbox', name: 'Remember me', inputType: 'checkbox' },
  { ref: '@e4', tag: 'select', role: 'combobox', name: 'Plan' },
  { ref: '@e7', tag: 'div', role: 'combobox', name: 'Custom plan' },
  { ref: '@e5', tag: 'button', role: 'button', name: 'Submit' },
  { ref: '@e6', tag: 'button', role: 'button', name: 'Disabled', disabled: true },
  { ref: null, tag: 'div', role: 'generic', name: 'x' },
];

test('deriveActions 只返回可执行且带 ref 的候选', () => {
  const actions = deriveActions(nodes);
  assert.deepEqual(actions.map((item) => item.ref), ['@e1', '@e2', '@e3', '@e4', '@e7', '@e5']);
  assert.equal(actions[0].action, 'click');
  assert.equal(actions[1].action, 'fill');
  assert.equal(actions[2].action, 'click');
  assert.equal(actions[3].action, 'select');
  assert.equal(actions[4].action, 'click');
  assert.equal(actions[5].action, 'click');
});

test('findHealingAction 按 action+name+role 找新 ref', () => {
  const actions = deriveActions([
    { ref: '@e9', tag: 'input', role: 'textbox', name: 'Email', inputType: 'email' },
    { ref: '@e10', tag: 'button', role: 'button', name: 'Email' },
  ]);
  const found = findHealingAction(actions, { action: 'fill', role: 'textbox', name: 'Email' }, 'fill');
  assert.equal(found.ref, '@e9');
  assert.equal(findHealingAction(actions, { action: 'fill', role: 'textbox', name: 'Missing' }, 'fill'), null);
});
