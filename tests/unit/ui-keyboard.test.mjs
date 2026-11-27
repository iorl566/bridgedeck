// tests/unit/ui-keyboard.test.mjs —— extension/ui/lib/keyboard.js 纯键盘模型单测。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KEY_BINDINGS,
  NAVIGATION_INTENTS,
  hasCommandModifier,
  intentToIndex,
  intentsFor,
  isComposingEvent,
  isEditableTarget,
  keyLabel,
  keyOf,
  matchesShortcut,
  moveIndex,
  resolveEvent,
  shortcutIntent,
  typeaheadMatch,
} from '../../extension/ui/lib/keyboard.js';

test('keyOf / isComposingEvent / isEditableTarget / hasCommandModifier', () => {
  assert.equal(keyOf({ key: 'ArrowDown' }), 'ArrowDown');
  assert.equal(keyOf(null), '');
  assert.equal(keyOf({}), '');

  assert.equal(isComposingEvent({ isComposing: true }), true);
  assert.equal(isComposingEvent({ keyCode: 229 }), true);
  assert.equal(isComposingEvent({ which: 229 }), true);
  assert.equal(isComposingEvent({ key: 'a' }), false);

  assert.equal(isEditableTarget({ tagName: 'INPUT' }), true);
  assert.equal(isEditableTarget({ tagName: 'textarea' }), true);
  assert.equal(isEditableTarget({ tagName: 'SELECT' }), true);
  assert.equal(isEditableTarget({ isContentEditable: true }), true);
  assert.equal(isEditableTarget({ tagName: 'DIV', getAttribute: () => 'textbox' }), true);
  assert.equal(isEditableTarget({ tagName: 'DIV' }), false);
  assert.equal(isEditableTarget(null), false);

  assert.equal(hasCommandModifier({ ctrlKey: true }), true);
  assert.equal(hasCommandModifier({ metaKey: true }), true);
  assert.equal(hasCommandModifier({ altKey: true }), true);
  assert.equal(hasCommandModifier({ shiftKey: true }), false);
  assert.equal(hasCommandModifier({}), false);
});

test('resolveEvent：导航/激活/选择/关闭', () => {
  assert.equal(resolveEvent({ key: 'ArrowUp' }).intent, 'up');
  assert.equal(resolveEvent({ key: 'ArrowDown' }).intent, 'down');
  assert.equal(resolveEvent({ key: 'PageUp' }).intent, 'page-up');
  assert.equal(resolveEvent({ key: 'Enter' }).intent, 'activate');
  assert.equal(resolveEvent({ key: ' ' }).intent, 'select');
  assert.equal(resolveEvent({ key: 'j' }).intent, 'down', 'vim 键位默认开启');
  assert.equal(resolveEvent({ key: 'j' }, { vimKeys: false }).intent, null);
  const escape = resolveEvent({ key: 'Escape' });
  assert.equal(escape.intent, 'close');
  assert.equal(escape.handled, true);
  const slash = resolveEvent({ key: '/' });
  assert.equal(slash.intent, 'open-filter');
  assert.equal(resolveEvent({ key: '/', editable: true }).handled, false, '输入态不抢 /');
  assert.equal(resolveEvent({ key: 'q' }).handled, false, '未绑定键不处理');
  assert.equal(resolveEvent({ key: 'q' }).reason, 'unbound');
});

test('resolveEvent：输入法/修饰键/输入控件/长按', () => {
  const composing = resolveEvent({ key: 'ArrowDown', isComposing: true });
  assert.equal(composing.handled, false);
  assert.equal(composing.reason, 'composing');

  const ctrlR = resolveEvent({ key: 'r', ctrlKey: true });
  assert.equal(ctrlR.handled, false);
  assert.equal(ctrlR.reason, 'modifier');

  const ctrlA = resolveEvent({ key: 'a', ctrlKey: true });
  assert.equal(ctrlA.intent, 'select-all');
  assert.equal(ctrlA.handled, true);
  assert.equal(resolveEvent({ key: 'a', ctrlKey: true, target: { tagName: 'INPUT' } }).handled, false, '输入框里 Ctrl+A 交给浏览器');

  const inInput = resolveEvent({ key: 'ArrowDown', target: { tagName: 'INPUT' } });
  assert.equal(inInput.handled, false);
  assert.equal(inInput.editable, true);
  assert.equal(inInput.reason, 'editable');
  assert.equal(resolveEvent({ key: 'Escape', target: { tagName: 'INPUT' } }).intent, 'close', '输入框里 Esc 仍要关闭预览');

  const repeatNav = resolveEvent({ key: 'ArrowDown', repeat: true });
  assert.equal(repeatNav.handled, true, '导航键允许长按重复');
  const repeatEnter = resolveEvent({ key: 'Enter', repeat: true });
  assert.equal(repeatEnter.handled, false);
  assert.equal(repeatEnter.reason, 'repeat');

  assert.equal(resolveEvent({ key: 'ArrowDown', shiftKey: true }).shift, true);
});

test('intentsFor / NAVIGATION_INTENTS', () => {
  assert.deepEqual(intentsFor('ArrowDown'), ['down']);
  assert.deepEqual(intentsFor('Spacebar'), ['select']);
  assert.deepEqual(intentsFor(''), []);
  assert.ok(NAVIGATION_INTENTS.includes('down'));
  assert.ok(NAVIGATION_INTENTS.includes('page-down'));
  assert.ok(KEY_BINDINGS.up.includes('ArrowUp'));
  assert.ok(KEY_BINDINGS.reset.includes('0'));
});

test('matchesShortcut / shortcutIntent 修饰键组合优先', () => {
  assert.equal(matchesShortcut({ key: 'k', ctrlKey: true }, 'Ctrl+k'), true);
  assert.equal(matchesShortcut({ key: 'K', ctrlKey: true }, 'Ctrl+k'), true);
  assert.equal(matchesShortcut({ key: 'k' }, 'Ctrl+k'), false);
  assert.equal(matchesShortcut({ key: 'k', ctrlKey: true }, 'k'), false);
  assert.equal(matchesShortcut({ key: 'Enter', shiftKey: true }, 'Shift+Enter'), true);
  assert.equal(matchesShortcut({ key: 'Enter' }, 'Shift+Enter'), false);
  assert.equal(matchesShortcut({ key: 'a' }, ''), false);

  const bindings = { k: 'focus', 'Ctrl+k': 'palette', r: 'refresh' };
  assert.equal(shortcutIntent({ key: 'k', ctrlKey: true }, bindings), 'palette', '更长的组合优先');
  assert.equal(shortcutIntent({ key: 'k' }, bindings), 'focus');
  assert.equal(shortcutIntent({ key: 'r' }, bindings), 'refresh');
  assert.equal(shortcutIntent({ key: 'z' }, bindings), null);
});

test('moveIndex / intentToIndex 边界与循环', () => {
  assert.equal(moveIndex(0, 1, 5), 1);
  assert.equal(moveIndex(4, 1, 5), 4);
  assert.equal(moveIndex(0, -1, 5), 0);
  assert.equal(moveIndex(0, -1, 5, { wrap: true }), 4);
  assert.equal(moveIndex(4, 1, 5, { wrap: true }), 0);
  assert.equal(moveIndex(0, 1, 0), -1);

  assert.equal(intentToIndex('down', { index: -1, total: 5 }), 0);
  assert.equal(intentToIndex('up', { index: 0, total: 5 }), 0);
  assert.equal(intentToIndex('home', { index: 3, total: 5 }), 0);
  assert.equal(intentToIndex('end', { index: 0, total: 5 }), 4);
  assert.equal(intentToIndex('page-down', { index: 0, total: 20, pageSize: 5 }), 5);
  assert.equal(intentToIndex('page-up', { index: 3, total: 20, pageSize: 5 }), 0);
  assert.equal(intentToIndex('activate', { index: 2, total: 5 }), 2, '非导航意图不改索引');
  assert.equal(intentToIndex('down', { index: 0, total: 0 }), -1);
});

test('typeaheadMatch / keyLabel', () => {
  assert.equal(typeaheadMatch(['alpha', 'beta', 'gamma'], 'be'), 1);
  assert.equal(typeaheadMatch(['alpha', 'beta'], 'zz'), -1);
  assert.equal(typeaheadMatch(['alpha'], ''), -1);
  assert.equal(typeaheadMatch(null, 'a'), -1);
  assert.equal(typeaheadMatch([null, 'Beta'], 'be'), 1);
  assert.equal(keyLabel('ArrowUp'), '↑');
  assert.equal(keyLabel('ArrowDown'), '↓');
  assert.equal(keyLabel(' '), 'Space');
  assert.equal(keyLabel('Escape'), 'Esc');
  assert.equal(keyLabel('X'), 'X');
});
