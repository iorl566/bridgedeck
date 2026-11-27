// tests/unit/mcp-resources.test.mjs —— MCP resources 只读面测试（技能文档/观察快照/证据/本地状态）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  JOURNAL_MAX_EVENTS,
  MAX_PAGE_CHARS,
  MAX_RESOURCE_BYTES,
  RESOURCE_CAPABILITIES,
  RESOURCE_KINDS,
  ResourceError,
  SnapshotStore,
  createResourceRegistry,
  listSkillReferences,
  parsePagingQuery,
  parseResourceUri,
} from '../../mcp/resources.mjs';
import { resolveSnapshotLimits } from '../../mcp/snapshots.mjs';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-mcp-resources-'));
}

test('SnapshotStore 有界 LRU：淘汰最久未写的一条，latest 指向最后写入', () => {
  const store = new SnapshotStore({ limit: 2, label: 'observation' });
  assert.equal(store.size(), 0);
  store.record('a', { value: 1 });
  store.record('b', { value: 2 });
  store.record('a', { value: 3 }); // 刷新 a
  store.record('c', { value: 4 }); // 淘汰 b
  assert.equal(store.size(), 2);
  assert.equal(store.has('b'), false);
  assert.equal(store.get('a').payload.value, 3);
  assert.equal(store.get('latest').key, 'c');
  assert.equal(store.get('missing'), null);
  assert.deepEqual(store.keys(), ['a', 'c']);
  assert.throws(() => new SnapshotStore({ limit: 0 }), /正整数/);
});

test('静态资源与模板：技能主文档 / 协议摘要 / 观察入口 / 技能参考模板', () => {
  const registry = createResourceRegistry({ home: tempHome() });
  const resources = registry.list();
  const uris = resources.map((resource) => resource.uri);
  assert.ok(uris.includes('bridge://skill/SKILL.md'));
  assert.ok(uris.includes('bridge://protocol/summary'));
  assert.ok(uris.includes('bridge://update/state'));
  assert.ok(uris.includes('bridge://observation/latest'));
  assert.ok(uris.includes('bridge://debug/evidence/latest'));
  for (const resource of resources) {
    assert.equal(typeof resource.name, 'string');
    assert.equal(typeof resource.title, 'string');
    assert.equal(typeof resource.description, 'string');
    assert.ok(resource.annotations && Array.isArray(resource.annotations.audience));
  }
  assert.deepEqual(resources.map((resource) => resource.uri), [...new Set(uris)], '资源 URI 不能重复');
  assert.deepEqual(registry.templates().map((row) => row.uriTemplate), [
    'bridge://skill/references/{name}',
    'bridge://observation/{session}',
    'bridge://debug/evidence/{session}',
    'bridge://debug/journal/{session}',
  ]);
  assert.ok(listSkillReferences().length >= 10);
  // 能力声明：subscribe=true（W7-C 能力升级）+ 分页参数单一来源
  assert.deepEqual(registry.capabilities, RESOURCE_CAPABILITIES);
  assert.equal(registry.capabilities.subscribe, true);
  assert.equal(registry.capabilities.subscription.notification, 'notifications/resources/updated');
  assert.equal(registry.capabilities.subscription.uriScoped, true);
  assert.equal(registry.capabilities.pagination.cursorParam, 'cursor');
  assert.deepEqual(registry.stats().observations, { label: 'observation', size: 0, limit: 32 });
  assert.deepEqual(registry.stats().journals, { label: 'debug-journal', size: 0, limit: 16 });
  assert.ok(uris.includes('bridge://debug/journal/latest'));
});

test('按需读取技能文档：主文档 / 参考 / 未知 / 穿越', () => {
  const registry = createResourceRegistry({ home: tempHome() });
  const main = registry.read('bridge://skill/SKILL.md');
  assert.equal(main.contents.length, 1);
  assert.equal(main.contents[0].uri, 'bridge://skill/SKILL.md');
  assert.equal(main.contents[0].mimeType, 'text/markdown');
  assert.ok(main.contents[0].text.length > 500);
  const reference = registry.read('bridge://skill/references/environment.md');
  assert.ok(reference.contents[0].text.includes('环境'));

  assert.throws(() => registry.read('bridge://skill/references/not-a-real.md'), (error) => {
    assert.ok(error instanceof ResourceError);
    assert.equal(error.code, 'E_NOT_FOUND');
    return true;
  });
  assert.throws(() => registry.read('bridge://skill/references/..%2F..%2Fpackage.json'), (error) => error.code === 'E_BAD_ARG');
  assert.throws(() => registry.read('bridge://skill/references/..%5Cpackage.json'), (error) => error.code === 'E_BAD_ARG');
  assert.throws(() => registry.read('http://example.com/x'), (error) => error.code === 'E_BAD_ARG');
  assert.throws(() => registry.read('bridge://unknown/thing'), (error) => error.code === 'E_NOT_FOUND');
});

test('协议摘要资源反映方法目录（只读 JSON）', () => {
  const registry = createResourceRegistry({ home: tempHome() });
  const payload = JSON.parse(registry.read('bridge://protocol/summary').contents[0].text);
  assert.equal(payload.protocol.current, '1.9');
  assert.equal(payload.protocol.baseline, '1.8');
  assert.ok(payload.methods.total >= 160);
  assert.ok(Object.keys(payload.features).length >= 9);
  assert.ok(payload.partialMethods.includes('observe'));
  assert.ok(payload.unknownMethods.length > 0);
});

test('观察快照：工具成功后写入，按会话读取，latest 指向最后一条', () => {
  const registry = createResourceRegistry({ home: tempHome() });
  assert.throws(() => registry.read('bridge://observation/latest'), (error) => error.code === 'E_NOT_FOUND');
  registry.recordObservation('s1', { url: 'https://a.test/', title: 'A', refs: 3, observation: '@e1 button', truncated: true, cursor: 'c1' });
  registry.recordObservation('s2', { url: 'https://b.test/', title: 'B', refs: 1, observation: '@e2 link' });
  const list = registry.list();
  assert.ok(list.some((resource) => resource.uri === 'bridge://observation/s1'));
  assert.ok(list.some((resource) => resource.uri === 'bridge://observation/s2'));
  const latest = JSON.parse(registry.read('bridge://observation/latest').contents[0].text);
  assert.equal(latest.key, 's2');
  assert.equal(latest.payload.url, 'https://b.test/');
  const first = JSON.parse(registry.read('bridge://observation/s1').contents[0].text);
  assert.equal(first.payload.refs, 3);
  assert.equal(first.payload.truncated, true);
  assert.equal(first.payload.cursor, 'c1');
  assert.ok(typeof first.capturedAt === 'string');
  assert.throws(() => registry.read('bridge://observation/nope'), (error) => error.code === 'E_NOT_FOUND');
  // browser_brief 的嵌套结构也能被规范化
  registry.recordObservation('s3', { session: 's3', page: { url: 'https://c.test/', title: 'C' }, observation: { text: '@e9 ok', refs: 9, truncated: false }, next: [] });
  const brief = JSON.parse(registry.read('bridge://observation/s3').contents[0].text);
  assert.equal(brief.payload.url, 'https://c.test/');
  assert.equal(brief.payload.observation, '@e9 ok');
  assert.equal(brief.payload.refs, 9);
});

test('调试证据：工具成功后写入并按会话读取', () => {
  const registry = createResourceRegistry({ home: tempHome() });
  assert.throws(() => registry.read('bridge://debug/evidence/latest'), (error) => error.code === 'E_NOT_FOUND');
  registry.recordEvidence('s1', { ok: true, path: '/tmp/evidence.json', requests: 12 });
  const payload = JSON.parse(registry.read('bridge://debug/evidence/latest').contents[0].text);
  assert.equal(payload.payload.requests, 12);
  assert.equal(payload.payload.ok, true);
  assert.ok(registry.list().some((resource) => resource.uri === 'bridge://debug/evidence/s1'));
  assert.throws(() => registry.read('bridge://debug/evidence/nope'), (error) => error.code === 'E_NOT_FOUND');
});

test('更新状态资源读取 HOME 下的 update-state.json', () => {
  const home = tempHome();
  const registry = createResourceRegistry({ home });
  const empty = JSON.parse(registry.read('bridge://update/state').contents[0].text);
  assert.equal(empty.present, false);
  fs.writeFileSync(path.join(home, 'update-state.json'), JSON.stringify({ stage: 'applied', version: '0.3.0' }), 'utf8');
  const present = JSON.parse(registry.read('bridge://update/state').contents[0].text);
  assert.equal(present.present, true);
  assert.equal(present.state.stage, 'applied');
});

test('超大内容截断到上限并保留可读标记', () => {
  const registry = createResourceRegistry({ home: tempHome() });
  const huge = 'x'.repeat(MAX_RESOURCE_BYTES + 1024);
  registry.recordObservation('big', { url: 'https://big.test/', observation: huge });
  const text = registry.read('bridge://observation/big').contents[0].text;
  assert.ok(text.length <= MAX_RESOURCE_BYTES + 200, String(text.length));
  assert.ok(text.endsWith('请用 CLI 读取完整内容。'));
});

test('URI 解析：技能/观察/证据/journal 与分页查询参数', () => {
  const skill = parseResourceUri('bridge://skill/SKILL.md');
  assert.equal(skill.kind, RESOURCE_KINDS.SKILL_MAIN);
  assert.equal(skill.key, 'SKILL.md');
  assert.equal(skill.paging.paged, false);
  const reference = parseResourceUri('bridge://skill/references/environment.md');
  assert.equal(reference.kind, RESOURCE_KINDS.SKILL_REFERENCE);
  assert.equal(reference.key, 'environment.md');
  const observation = parseResourceUri('bridge://observation/s1');
  assert.equal(observation.kind, RESOURCE_KINDS.OBSERVATION);
  assert.equal(observation.key, 's1');
  const paged = parseResourceUri('bridge://observation/s1?limit=100&cursor=5');
  assert.equal(paged.paging.paged, true);
  assert.equal(paged.paging.offset, 5);
  assert.equal(paged.paging.limit, 100);
  const offset = parseResourceUri('bridge://debug/evidence/s2?offset=3');
  assert.equal(offset.kind, RESOURCE_KINDS.EVIDENCE);
  assert.equal(offset.key, 's2');
  assert.equal(offset.paging.offset, 3);
  assert.equal(offset.paging.limit, 32 * 1024);
  const journal = parseResourceUri('bridge://debug/journal/latest');
  assert.equal(journal.kind, RESOURCE_KINDS.JOURNAL);
  assert.equal(journal.key, 'latest');
  assert.equal(parseResourceUri('bridge://protocol/summary').kind, RESOURCE_KINDS.PROTOCOL_SUMMARY);
  assert.equal(parseResourceUri('bridge://update/state').kind, RESOURCE_KINDS.UPDATE_STATE);
  assert.deepEqual(parsePagingQuery(''), { paged: false, offset: 0, limit: 32 * 1024, limitSpecified: false });
  assert.deepEqual(parsePagingQuery('limit=5'), { paged: true, offset: 0, limit: 5, limitSpecified: true });
  assert.deepEqual(parsePagingQuery('cursor=9'), { paged: true, offset: 9, limit: 32 * 1024, limitSpecified: false });
});

test('URI 解析：非法路径/参数/越界都被拒绝', () => {
  const bad = [
    ['http://example.com/x', 'E_BAD_ARG'],
    ['bridge://unknown/thing', 'E_NOT_FOUND'],
    ['bridge://debug/journal', 'E_NOT_FOUND'],
    ['bridge://debug/nope/s1', 'E_NOT_FOUND'],
    ['bridge://observation/', 'E_NOT_FOUND'],
    ['bridge://observation/s1?limit=0', 'E_BAD_ARG'],
    ['bridge://observation/s1?limit=' + (MAX_PAGE_CHARS + 1), 'E_BAD_ARG'],
    ['bridge://observation/s1?limit=abc', 'E_BAD_ARG'],
    ['bridge://observation/s1?cursor=-1', 'E_BAD_ARG'],
    ['bridge://observation/s1?offset=1&cursor=2', 'E_BAD_ARG'],
    ['bridge://observation/s1?nope=1', 'E_BAD_ARG'],
    ['bridge://observation/s1?limit=1&limit=2', 'E_BAD_ARG'],
    ['bridge://skill/references/..%2F..%2Fpackage.json', 'E_BAD_ARG'],
    ['bridge://skill/references/..%5Cpackage.json', 'E_BAD_ARG'],
    ['bridge://skill/other.md', 'E_NOT_FOUND'],
  ];
  for (const [uri, code] of bad) {
    assert.throws(() => parseResourceUri(uri), (error) => {
      assert.ok(error instanceof ResourceError, uri);
      assert.equal(error.code, code, uri + ' → ' + error.code);
      return true;
    }, uri);
  }
});

test('资源读取 _meta：kind/subscribe/paged 标记齐全', () => {
  const registry = createResourceRegistry({ home: tempHome() });
  registry.recordObservation('m1', { url: 'https://meta.test/', observation: '@e1 ok' });
  const result = registry.read('bridge://observation/m1');
  const meta = result._meta['browser-bridge/resource'];
  assert.equal(meta.kind, 'observation');
  assert.equal(meta.key, 'm1');
  assert.equal(meta.paged, false);
  assert.equal(meta.capabilities.subscribe, true);
  assert.equal(meta.capabilities.subscription.notification, 'notifications/resources/updated');
  assert.equal(typeof meta.totalChars, 'number');
  assert.equal(result.contents[0]._meta['browser-bridge/resource'].kind, 'observation');
  const summary = registry.read('bridge://protocol/summary');
  assert.equal(summary._meta['browser-bridge/resource'].kind, 'protocol-summary');
});

test('journal 快照：事件归一化、序号范围、阶段与截断标记', () => {
  const registry = createResourceRegistry({ home: tempHome() });
  const events = [];
  for (let index = 1; index <= JOURNAL_MAX_EVENTS + 100; index += 1) {
    events.push({ seq: index, stage: index % 2 === 0 ? 'network' : 'console', type: 'event', text: 'e' + index });
  }
  const written = registry.recordJournal('j1', { session: 'j1', gaps: [{ from: 5, to: 7 }], events });
  assert.equal(written.key, 'j1');
  assert.equal(written.meta.kind, 'journal');
  const payload = JSON.parse(registry.read('bridge://debug/journal/j1').contents[0].text).payload;
  assert.equal(payload.count, JOURNAL_MAX_EVENTS + 100);
  assert.equal(payload.kept, JOURNAL_MAX_EVENTS);
  assert.equal(payload.dropped, 100);
  assert.equal(payload.firstSeq, 101);
  assert.equal(payload.lastSeq, JOURNAL_MAX_EVENTS + 100);
  assert.deepEqual(payload.stages, ['console', 'network']);
  assert.deepEqual(payload.gaps, [{ from: 5, to: 7 }]);
  assert.equal(payload.truncated, true);
  assert.equal(payload.events.at(-1).seq, JOURNAL_MAX_EVENTS + 100);
  // 非事件结构：保留原样并计数 0（不伪造时间线）
  registry.recordJournal('raw', { summary: { ok: true } });
  const raw = JSON.parse(registry.read('bridge://debug/journal/raw').contents[0].text).payload;
  assert.equal(raw.count, 0);
  assert.equal(raw.truncated, false);
  assert.equal(raw.raw.summary.ok, true);
  assert.throws(() => registry.read('bridge://debug/journal/nope'), (error) => error.code === 'E_NOT_FOUND');
});

test('journal 列表：latest 与按会话 URI 都可读，淘汰保持有界', () => {
  const registry = createResourceRegistry({ home: tempHome() });
  for (let index = 0; index < 20; index += 1) registry.recordJournal('s' + index, { events: [{ seq: index }] });
  assert.equal(registry.journals.size(), 16);
  const uris = registry.list().map((resource) => resource.uri);
  assert.ok(uris.includes('bridge://debug/journal/latest'));
  assert.ok(uris.includes('bridge://debug/journal/s19'));
  assert.ok(!uris.includes('bridge://debug/journal/s0'), '最旧的 journal 应被淘汰');
  const latest = JSON.parse(registry.read('bridge://debug/journal/latest').contents[0].text);
  assert.equal(latest.key, 's19');
});

test('recordToolResult：工具成功后回填 observation/evidence/journal 快照', () => {
  const registry = createResourceRegistry({ home: tempHome() });
  const observed = registry.recordToolResult('browser_observe', { session: 's1' }, {
    session: 's1', url: 'https://a.test/', title: 'A', refs: 4, observation: '@e1 A', truncated: false,
  });
  assert.equal(observed.kind, 'observation');
  assert.equal(observed.key, 's1');
  assert.equal(observed.uri, 'bridge://observation/s1');
  assert.equal(JSON.parse(registry.read(observed.uri).contents[0].text).payload.refs, 4);

  const brief = registry.recordToolResult('browser_brief', {}, { page: { url: 'https://b.test/', title: 'B' }, observation: { text: '@e9 B', refs: 9 } });
  assert.equal(brief.kind, 'observation');
  const briefPayload = JSON.parse(registry.read(brief.uri).contents[0].text).payload;
  assert.equal(briefPayload.url, 'https://b.test/');
  assert.equal(briefPayload.observation, '@e9 B');
  assert.equal(briefPayload.tool, 'browser_brief');

  const evidence = registry.recordToolResult('browser_debug_evidence', { session: 's2' }, { ok: true, path: '/tmp/e.json', requests: 12 });
  assert.equal(evidence.kind, 'evidence');
  assert.equal(evidence.uri, 'bridge://debug/evidence/s2');
  assert.equal(JSON.parse(registry.read(evidence.uri).contents[0].text).payload.requests, 12);

  const journal = registry.recordToolResult('browser_debug_journal', { session: 's3' }, { events: [{ seq: 1, stage: 'network' }], truncated: false });
  assert.equal(journal.kind, 'journal');
  assert.equal(journal.uri, 'bridge://debug/journal/s3');
  assert.equal(JSON.parse(registry.read(journal.uri).contents[0].text).payload.count, 1);

  const archive = registry.recordToolResult('browser_debug_query', { file: 'D:\\evidence\\run-7.json' }, { events: [{ seq: 2 }] });
  assert.equal(archive.kind, 'journal');
  assert.equal(archive.key, 'archive:run-7.json');
  assert.equal(registry.read(archive.uri).contents[0].text.includes('run-7.json'), true);

  assert.equal(registry.recordToolResult('browser_status', {}, { ok: true }), null);
  assert.equal(registry.recordToolResult('browser_evaluate', { expression: '1' }, { value: 1 }), null);
});

// ---------------------------------------------------------------------------
// W7-C：快照更新事件（订阅推送的唯一事件源）
// ---------------------------------------------------------------------------
test('快照更新事件：记录/淘汰/剪枝都产生带 URI 的 update 事件', () => {
  const events = [];
  const registry = createResourceRegistry({ home: tempHome(), onUpdate: (event) => events.push(event) });
  const written = registry.recordObservation('s1', { url: 'https://a.test/', observation: '@e1 A' });
  assert.equal(written.key, 's1');
  assert.equal(events.length, 1);
  const record = events[0];
  assert.equal(record.action, 'record');
  assert.equal(record.kind, 'observation');
  assert.equal(record.key, 's1');
  assert.deepEqual(record.uris, ['bridge://observation/s1', 'bridge://observation/latest']);
  assert.equal(record.tool, null);
  assert.ok(Object.isFrozen(record), '事件必须冻结，避免订阅者改写');
  assert.ok(Object.isFrozen(record.uris));

  // 工具回填带 tool 字段，且仍然同时通知会话 URI 与 latest。
  registry.recordToolResult('browser_observe', { session: 's2' }, { session: 's2', observation: '@e2 B' });
  assert.equal(events[1].tool, 'browser_observe');
  assert.deepEqual(events[1].uris, ['bridge://observation/s2', 'bridge://observation/latest']);

  // 不产生快照的工具不产生更新事件。
  const before = events.length;
  registry.recordToolResult('browser_status', {}, { ok: true });
  assert.equal(events.length, before);
  assert.equal(registry.updateStats().emitted, 2);
  assert.equal(registry.updateStats().lastUpdate.key, 's2');
});

test('快照淘汰：LRU 挤出旧 key 时事件带上被淘汰 URI', () => {
  const events = [];
  const store = new SnapshotStore({ limit: 1, label: 'observation' });
  const registry = createResourceRegistry({
    home: tempHome(),
    observations: store,
    onUpdate: (event) => events.push(event),
  });
  registry.recordObservation('s1', { observation: '@e1' });
  assert.deepEqual(events[0].evicted, []);
  registry.recordObservation('s2', { observation: '@e2' });
  assert.deepEqual(events[1].evicted, ['s1']);
  assert.ok(events[1].uris.includes('bridge://observation/s1'), '被淘汰 URI 也要通知（客户端重读会 E_NOT_FOUND）');
  assert.ok(events[1].uris.includes('bridge://observation/s2'));
  assert.ok(events[1].uris.includes('bridge://observation/latest'));
  assert.equal(registry.read('bridge://observation/latest').contents[0].text.includes('@e2'), true);
  assert.throws(() => registry.read('bridge://observation/s1'), (error) => error.code === 'E_NOT_FOUND');
});

test('快照过期剪枝：prune-expired 事件覆盖被删 URI 与 latest', () => {
  const events = [];
  const clock = { value: 1_700_000_000_000 };
  const limits = resolveSnapshotLimits({ BB_MCP_SNAPSHOT_TTL_MS: '1000' });
  const registry = createResourceRegistry({
    home: tempHome(),
    limits,
    now: () => clock.value,
    onUpdate: (event) => events.push(event),
  });
  registry.recordObservation('s1', { observation: '@e1' });
  registry.recordEvidence('e1', { ok: true });
  events.length = 0;
  clock.value += 5_000;
  const pruned = registry.pruneSnapshots();
  assert.deepEqual(pruned.observation, ['s1']);
  assert.deepEqual(pruned.evidence, ['e1']);
  const actions = events.map((event) => event.action);
  assert.deepEqual(actions, ['prune-expired', 'prune-expired']);
  assert.ok(events[0].uris.includes('bridge://observation/s1'));
  assert.ok(events[0].uris.includes('bridge://observation/latest'));
  assert.ok(events[1].uris.includes('bridge://debug/evidence/e1'));
  assert.deepEqual(events[0].removed, ['s1']);
});

test('更新 sink：可增删、异常隔离、计数可诊断', () => {
  const received = [];
  let remove = null;
  const registry = createResourceRegistry({
    home: tempHome(),
    onUpdate: () => { throw new Error('第一个 sink 坏了'); },
  });
  remove = registry.addUpdateSink((event) => received.push(event));
  registry.recordObservation('s1', { observation: '@e1' });
  assert.equal(received.length, 1, '坏 sink 不影响后续 sink');
  const stats = registry.updateStats();
  assert.equal(stats.sinks, 2);
  assert.equal(stats.sinkErrors, 1);
  assert.equal(stats.emitted, 1);
  assert.equal(remove(), true);
  assert.equal(remove(), false, '重复移除返回 false');
  registry.recordObservation('s2', { observation: '@e2' });
  assert.equal(received.length, 1, '移除后的 sink 不再收到事件');
  assert.equal(registry.updateStats().sinks, 1);
  assert.throws(() => registry.addUpdateSink('nope'), /需要函数/);
});
