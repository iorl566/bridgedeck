import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecordStep } from '../../extension/src/record-steps.js';
import {
  DEFAULT_MERGE_WINDOW_MS,
  KNOWN_SOURCES,
  RECORD_MERGE_VERSION,
  createMergeIndex,
  dedupeEventList,
  eventActionFingerprint,
  eventFingerprintHex,
  eventIdentity,
  eventSourceOf,
  mergeEventPair,
  mergeEventStreams,
  summarizeMerge,
} from '../../extension/src/record-merge.js';

const AT = 1_700_000_000_000;

/** 构造一条“录制事件”（带 step v2），seq/documentId/source 可覆盖。 */
function event(overrides = {}) {
  const seq = overrides.seq == null ? 1 : overrides.seq;
  const documentId = overrides.documentId === undefined ? 'doc-1' : overrides.documentId;
  const payload = {
    kind: 'click',
    selector: '#go',
    seq,
    ts: AT + (overrides.offset || 0),
    documentId,
    ...overrides,
  };
  delete payload.offset;
  const step = buildRecordStep(payload, { seq, index: 0, frameId: 0, documentId, now: AT + (overrides.offset || 0) });
  return { ...payload, recordStep: step };
}

test('eventSourceOf：显式 source/capture 优先，actor 退化，frame 识别', () => {
  assert.equal(eventSourceOf({ source: 'content' }), 'content');
  assert.equal(eventSourceOf({ capture: 'Injected' }), 'injected');
  assert.equal(eventSourceOf({ actor: 'agent' }), 'agent');
  assert.equal(eventSourceOf({ actor: 'human' }), 'human');
  assert.equal(eventSourceOf({ frameId: 3 }), 'frame');
  assert.equal(eventSourceOf({ frameId: 0 }), 'page');
  assert.equal(eventSourceOf({ source: 'custom-source' }), 'custom-source');
  assert.equal(eventSourceOf(null), 'unknown');
  assert.equal(KNOWN_SOURCES.includes('content'), true);
});

test('eventIdentity：document+seq+kind+签名决定身份；缺失退化为 frame', () => {
  const first = event({ seq: 7 });
  assert.equal(eventIdentity(first), eventIdentity(event({ seq: 7 })));
  assert.notEqual(eventIdentity(first), eventIdentity(event({ seq: 8 })));
  assert.notEqual(eventIdentity(event({ seq: 7, documentId: 'doc-1' })), eventIdentity(event({ seq: 7, documentId: 'doc-2' })));
  const override = eventIdentity(first, { seq: 99, documentId: 'doc-x' });
  assert.equal(override.startsWith('doc-x|99|'), true);
  assert.equal(eventFingerprintHex(first), eventFingerprintHex(event({ seq: 7 })));
  assert.match(eventFingerprintHex(first), /^[0-9a-f]{8}$/);
});

test('eventActionFingerprint：同动作同目标/值一致，不同值不同', () => {
  const first = event({ seq: 1, selector: '#go' });
  const second = event({ seq: 2, selector: '#go' });
  const other = event({ seq: 3, selector: '#other' });
  assert.equal(eventActionFingerprint(first), eventActionFingerprint(second));
  assert.notEqual(eventActionFingerprint(first), eventActionFingerprint(other));
  assert.equal(eventActionFingerprint({ kind: 'nothing' }), '');
});

test('mergeEventPair：补空缺字段/记录冲突/合并来源', () => {
  const canonical = event({ seq: 1, source: 'content' });
  canonical.observation = '';
  canonical.screenshot = '';
  const incoming = event({ seq: 1, source: 'injected' });
  incoming.observation = '页面状态 A';
  incoming.screenshot = 'data:image/png;base64,AAAA';
  const merged = mergeEventPair(canonical, incoming, { windowMs: 60, now: AT });
  assert.equal(merged.event.observation, '页面状态 A');
  assert.equal(merged.event.screenshot, 'data:image/png;base64,AAAA');
  assert.equal(merged.changed, true);
  assert.equal(merged.event.recordDedupe.merged, true);
  assert.deepEqual(merged.event.recordDedupe.sources, ['content', 'injected']);
  assert.equal(merged.conflicts.length, 0);

  const conflictEvent = event({ seq: 2, source: 'content' });
  conflictEvent.observation = '状态 A';
  const other = event({ seq: 2, source: 'injected' });
  other.observation = '状态 B';
  const conflict = mergeEventPair(conflictEvent, other, { now: AT });
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.conflicts[0].field, 'observation');
  assert.equal(conflict.event.observation, '状态 A', 'canonical 值不被静默覆盖');
  assert.equal(conflict.event.recordDedupe.conflicts, 1);

  // fill 的 value 缺省补齐
  const fillCanonical = event({ kind: 'input', selector: '#q', value: undefined, seq: 3, source: 'content' });
  const fillIncoming = event({ kind: 'input', selector: '#q', value: 'hello', seq: 3, source: 'injected' });
  const fillMerged = mergeEventPair(fillCanonical, fillIncoming, { now: AT });
  assert.equal(fillMerged.event.recordStep.params.value, 'hello');

  assert.deepEqual(mergeEventPair(null, incoming).event, incoming);
  assert.equal(mergeEventPair(canonical, null).event, canonical);
});

test('dedupeEventList：严格重复丢弃并合并增量，多源同动作标注合并', () => {
  const canonical = event({ seq: 1, source: 'content', offset: 0 });
  canonical.observation = '';
  const duplicate = event({ seq: 1, source: 'injected', offset: 5 });
  duplicate.observation = 'merged observation';
  const later = event({ seq: 2, source: 'content', offset: 500 });
  const list = [canonical, duplicate, later];
  const result = dedupeEventList(list, { windowMs: 60 });
  assert.equal(result.stats.total, 3);
  assert.equal(result.stats.kept, 2);
  assert.equal(result.stats.dropped, 1);
  assert.equal(result.dropped[0].reason, 'strict_duplicate');
  assert.equal(result.dropped[0].index, 1);
  assert.equal(result.events[0].observation, 'merged observation');
  assert.equal(result.events[0].recordDedupe.duplicates, 1);
  assert.deepEqual(result.events[0].recordDedupe.sources.sort(), ['content', 'injected']);
  assert.equal(result.events[1].seq, 2);
});

test('dedupeEventList：不同 seq 的同动作多源 → merged 标注（默认不丢）', () => {
  const first = event({ seq: 1, source: 'content', offset: 0 });
  const second = event({ seq: 2, source: 'injected', offset: 10 });
  const result = dedupeEventList([first, second], { windowMs: 60 });
  assert.equal(result.stats.kept, 2);
  assert.equal(result.stats.merged, 1);
  assert.equal(result.merged[0].source, 'injected');
  assert.equal(result.merged[0].gapMs, 10);
  assert.equal(result.events[1].recordMerge.mergedInto.length > 0, true);
  assert.equal(result.events[1].recordMerge.version, RECORD_MERGE_VERSION);

  const dropped = dedupeEventList([first, second], { windowMs: 60, dropMerged: true });
  assert.equal(dropped.stats.kept, 1);
  assert.equal(dropped.dropped[0].reason, 'multi_source_merged');
});

test('dedupeEventList：同源快速重复不算多源合并；超出时间窗也不合并', () => {
  const first = event({ seq: 1, source: 'content', offset: 0 });
  const sameSource = event({ seq: 2, source: 'content', offset: 10 });
  const sameSourceResult = dedupeEventList([first, sameSource], { windowMs: 60 });
  assert.equal(sameSourceResult.stats.merged, 0);
  assert.equal(sameSourceResult.stats.kept, 2);

  const outside = event({ seq: 2, source: 'injected', offset: DEFAULT_MERGE_WINDOW_MS + 1 });
  const outsideResult = dedupeEventList([first, outside], { windowMs: 60 });
  assert.equal(outsideResult.stats.merged, 0);
  assert.equal(outsideResult.stats.kept, 2);
});

test('mergeEventStreams：多路合并/排序/来源统计', () => {
  const content = [event({ seq: 1, source: 'content', offset: 0 }), event({ seq: 3, source: 'content', offset: 300 })];
  const injected = [event({ seq: 2, source: 'injected', offset: 100 })];
  const result = mergeEventStreams([{ source: 'content', events: content }, { source: 'injected', events: injected }]);
  assert.equal(result.events.length, 3);
  assert.deepEqual(result.events.map((item) => item.seq), [1, 2, 3]);
  assert.equal(result.stats.sources.content, 2);
  assert.equal(result.stats.sources.injected, 1);
  assert.equal(result.stats.streams, 2);

  const arrays = mergeEventStreams([[event({ seq: 1, source: 'content' })], [event({ seq: 1, source: 'injected', offset: 1 })]]);
  assert.equal(arrays.events.length, 1, '同 seq 同签名视为同一事件');
  assert.equal(arrays.stats.dropped, 1);

  const summary = summarizeMerge(result);
  assert.equal(summary.total, 3);
  assert.equal(summary.kept, 3);
  assert.equal(summary.merged, 0);
  assert.equal(summary.windowMs, DEFAULT_MERGE_WINDOW_MS);
  assert.equal(summarizeMerge(null), null);
});

test('createMergeIndex：classify new/duplicate/merged，remember/touch/size/clear', () => {
  const index = createMergeIndex({ windowMs: 60, limit: 8 });
  assert.equal(index.windowMs, 60);
  const first = event({ seq: 1, source: 'content', offset: 0 });
  assert.equal(index.classify(first).kind, 'new');
  index.remember(first, 0);
  assert.equal(index.size(), 1);

  const duplicate = event({ seq: 1, source: 'injected', offset: 2 });
  const duplicateDecision = index.classify(duplicate);
  assert.equal(duplicateDecision.kind, 'duplicate');
  assert.equal(duplicateDecision.canonicalIndex, 0);
  assert.equal(duplicateDecision.canonical.seq, 1);

  const mergedEvent = event({ seq: 2, source: 'injected', offset: 10 });
  const mergedDecision = index.classify(mergedEvent);
  assert.equal(mergedDecision.kind, 'merged');
  assert.equal(mergedDecision.gapMs, 10);
  index.remember(mergedEvent, 1);
  assert.equal(index.size(), 2);

  // 合并后更新 canonical 引用
  const updated = { ...first, observation: 'new obs' };
  index.touch(0, updated);
  assert.equal(index.classify(duplicate).canonical.observation, 'new obs');

  index.clear();
  assert.equal(index.size(), 0);
  assert.equal(index.classify(first).kind, 'new');

  // limit 生效：过期身份被清出
  const tiny = createMergeIndex({ limit: 4 });
  for (let seq = 1; seq <= 6; seq += 1) tiny.remember(event({ seq, source: 'content', offset: seq }), seq);
  assert.equal(tiny.size() <= 6, true);
});

test('dedupeEventList：非法输入容错与空列表', () => {
  const empty = dedupeEventList([]);
  assert.equal(empty.events.length, 0);
  assert.equal(empty.stats.total, 0);
  const withJunk = dedupeEventList([null, undefined, 42, event({ seq: 1 })]);
  assert.equal(withJunk.events.length, 1);
  assert.equal(dedupeEventList(null).events.length, 0);
});
