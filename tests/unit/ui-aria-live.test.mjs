// tests/unit/ui-aria-live.test.mjs —— 播报队列（extension/ui/lib/aria-live.js）单测。
//
// 覆盖：节流/去重、assertive 优先、队列上限、注入时钟（不 sleep）、aria 属性、
// 多条播报合并、选择/过滤/排序/列/导入导出/差异的位置播报。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MAX_QUEUE,
  DEFAULT_THROTTLE_MS,
  POLITENESS,
  ariaDescribe,
  bindAnnouncerToNode,
  createAnnouncer,
  describeColumns,
  describeDiffPosition,
  describeFilter,
  describeSelection,
  describeSort,
  describeTransfer,
  joinAnnouncements,
  liveRegionAttrs,
} from '../../extension/ui/lib/aria-live.js';

function clock(start = 1000) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; return value; } };
}

test('播报：礼貌队列、去重节流、注入时钟', () => {
  const time = clock();
  const announcer = createAnnouncer({ now: time.now, throttleMs: 1000 });
  const first = announcer.announce('已选择 3 项');
  assert.equal(first.accepted, true);
  const duplicate = announcer.announce('已选择 3 项');
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, 'throttled');
  time.advance(1200);
  assert.equal(announcer.announce('已选择 3 项').accepted, true);
  assert.equal(announcer.pending, 2);
  // 空文本不播报。
  assert.equal(announcer.announce('   ').reason, 'empty');
  assert.equal(POLITENESS.includes('polite'), true);
  assert.equal(POLITENESS.includes('assertive'), true);
  assert.ok(DEFAULT_THROTTLE_MS >= 500);
});

test('播报：assertive 优先取出；take 消费；last 记录', () => {
  const announcer = createAnnouncer({ now: () => 0, throttleMs: 0 });
  announcer.announce('普通');
  announcer.alert('危险');
  const snapshot = announcer.snapshot();
  assert.deepEqual(snapshot.assertive, ['危险']);
  assert.deepEqual(snapshot.polite, ['普通']);
  assert.equal(announcer.peek().text, '危险');
  const first = announcer.take();
  assert.equal(first.text, '危险');
  assert.equal(first.politeness, 'assertive');
  assert.equal(announcer.take().text, '普通');
  assert.equal(announcer.take(), null);
  assert.equal(announcer.snapshot().last, '普通');
});

test('播报：队列上限丢最旧礼貌消息，assertive 不丢', () => {
  const announcer = createAnnouncer({ now: () => 0, throttleMs: 0, maxQueue: 3 });
  announcer.alert('a1');
  for (let index = 0; index < 5; index += 1) announcer.announce('p' + index);
  const snapshot = announcer.snapshot();
  assert.equal(snapshot.size, 3);
  assert.equal(snapshot.assertive[0], 'a1', 'assertive 不应被挤掉');
  assert.deepEqual(snapshot.polite, ['p3', 'p4']);
  assert.ok(DEFAULT_MAX_QUEUE >= snapshot.size);
});

test('播报：订阅/退订、清空、onAnnounce 回调、监听器异常不影响队列', () => {
  const announcer = createAnnouncer({ now: () => 0, throttleMs: 0 });
  const seen = [];
  const off = announcer.subscribe((payload) => { seen.push(payload.size); throw new Error('listener boom'); });
  announcer.announce('x');
  assert.equal(seen.length, 1);
  off();
  announcer.announce('y');
  assert.equal(seen.length, 1);
  const announced = [];
  const second = createAnnouncer({ now: () => 0, throttleMs: 0, onAnnounce: (item) => announced.push(item.text) });
  second.announce('z');
  assert.deepEqual(announced, ['z']);
  second.clear();
  assert.equal(second.pending, 0);
});

test('aria 属性：polite → status，assertive → alert，未知回退 polite', () => {
  assert.deepEqual(liveRegionAttrs('polite'), { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', 'aria-relevant': 'text' });
  assert.equal(liveRegionAttrs('assertive').role, 'alert');
  assert.equal(liveRegionAttrs('assertive')['aria-live'], 'assertive');
  assert.equal(liveRegionAttrs('weird').role, 'status');
});

test('播报文案：选择/过滤/排序/列/差异位置', () => {
  assert.equal(describeSelection(3, 10, 'zh'), '3 / 10 项已选');
  assert.equal(describeSelection(3, 10, 'en'), '3 of 10 selected');
  assert.equal(describeFilter(2, 9, 'zh'), '2 / 9 行匹配');
  assert.equal(describeSort('耗时', 'desc', 'zh'), '已按 耗时 降序排序');
  assert.equal(describeColumns(3, 5, 'zh'), '3 / 5 列可见');
  assert.equal(describeDiffPosition(2, 5, 'zh'), '第 2 / 5 处差异');
  assert.equal(describeDiffPosition(0, 0, 'en'), 'Change 0 of 0');
});

test('播报合并：单条原样、多条用分隔符、空值过滤', () => {
  assert.equal(joinAnnouncements(['a']), 'a');
  assert.equal(joinAnnouncements(['a', 'b']), 'a；b');
  assert.equal(joinAnnouncements(['a', '', null, 'b']), 'a；b');
  assert.equal(joinAnnouncements([]), '');
  assert.equal(joinAnnouncements(['a', 'b'], { separator: ' / ' }), 'a / b');
});

test('导入/导出播报：行数/脱敏/截断', () => {
  assert.equal(describeTransfer('export', { rows: 0 }, 'zh'), '没有可导出的行');
  const exported = describeTransfer('export', { rows: 5, redacted: 2, truncated: true }, 'zh');
  assert.match(exported, /5 行/);
  assert.match(exported, /2 处/);
  assert.match(exported, /截断/);
  assert.match(describeTransfer('import', { rows: 3, invalid: 1 }, 'zh'), /3 行/);
  assert.equal(describeTransfer('unknown', {}), '');
});

test('bindAnnouncerToNode：没有 DOM/节点时安全返回 dispose', () => {
  const binding = bindAnnouncerToNode(null, null);
  assert.equal(typeof binding.dispose, 'function');
  assert.doesNotThrow(() => binding.dispose());
  // 假节点：take 队列写入 textContent（Node 里没有 document，用空对象作为 doc 注入）。
  const announcer = createAnnouncer({ now: () => 0, throttleMs: 0 });
  const node = { textContent: '' };
  const bound = bindAnnouncerToNode(announcer, node, { doc: {} });
  announcer.announce('hello');
  assert.equal(bound.flush(), true);
  assert.equal(node.textContent, 'hello');
  assert.equal(bound.flush(), false);
  bound.dispose();
});

test('ariaDescribe：拼接描述（忽略空值）', () => {
  assert.equal(ariaDescribe('base', { 'aria-describedby': 'x', empty: '' }), 'base aria-describedby=x');
  assert.equal(ariaDescribe('', { a: 1 }), 'a=1');
  assert.equal(ariaDescribe(undefined, {}), '');
});
