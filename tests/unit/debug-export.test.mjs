// tests/unit/debug-export.test.mjs —— journal 导出 envelope（schema 版本 + checksum）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECKSUM_ALGORITHM,
  DEBUG_EXPORT_SCHEMA,
  assertExportRedacted,
  buildJournalExport,
  canonicalJson,
  checksumOf,
  fnv1a64Hex,
  parseJournalExport,
  serializeJournalExport,
  summarizeJournalExport,
  utf8Bytes,
  verifyJournalExport,
} from '../../extension/src/lib/debug-export.js';
import { scanForPlaintextSecrets } from '../../extension/src/lib/debug-redact.js';
import { buildDebugCoverage } from '../../extension/src/lib/debug-coverage.js';
import { buildDebugCorrelation } from '../../extension/src/lib/debug-correlation.js';

function sampleInput() {
  const journal = {
    seq: 4,
    bytes: 400,
    timeRange: { from: 1_000, to: 1_200 },
    byType: { start: 1, pin: 1, replay: 1, stop: 1 },
    events: [
      { seq: 1, sessionId: 'tab-1', at: 1_000, type: 'start', name: 'demo' },
      { seq: 2, sessionId: 'tab-1', at: 1_050, type: 'pin', id: 'req-1' },
      { seq: 3, sessionId: 'tab-1', at: 1_100, type: 'replay', id: 1, token: 'JOURNAL_SECRET', ok: true },
      { seq: 4, sessionId: 'tab-1', at: 1_200, type: 'stop', requests: 1, console: 0 },
    ],
    evictions: { total: 1, counts: { 'session-ring-limit': 1 }, sessions: { 'tab-1': 1 }, recent: [] },
  };
  const requests = [{
    id: 1,
    method: 'GET',
    url: 'https://x.test/api/a?token=REQUEST_SECRET&page=2',
    status: 200,
    startedAt: 1_050,
    durationMs: 12,
    headers: { Authorization: 'Bearer HEADER_SECRET' },
  }];
  const coverage = buildDebugCoverage({
    session: { id: 'tab-1', tabId: 1, active: true, bodies: false, startedAt: 1_000 },
    requests,
    requestsTotal: 3,
    console: [],
    frames: [{ frameId: 0 }],
    websockets: { sockets: [], total: 0 },
    trace: null,
    screenshots: [],
    journal,
    consoleError: 'hook not ready',
    now: 2_000,
  });
  const correlation = buildDebugCorrelation({ requests, journal: journal.events });
  return { journal, requests, coverage, correlation };
}

test('canonicalJson：键排序、undefined/循环/Date/BigInt 都有确定表示', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ a: undefined, b: null, c: 1 }), '{"b":null,"c":1}');
  assert.equal(canonicalJson({ a: undefined }), '{}');
  assert.equal(canonicalJson([1, undefined, null]), '[1,null,null]');
  const circular = { name: 'root' };
  circular.self = circular;
  assert.equal(canonicalJson(circular), '{"name":"root","self":"[circular]"}');
  assert.equal(canonicalJson(new Date('2026-01-01T00:00:00.000Z')), '"2026-01-01T00:00:00.000Z"');
  assert.equal(canonicalJson({ big: 123n }), '{"big":"123"}');
  assert.equal(canonicalJson(Number.NaN), 'null');
  assert.equal(canonicalJson(undefined), 'null');
  assert.equal(canonicalJson({ nested: { z: 1, a: [{ d: 4, c: 3 }] } }), '{"nested":{"a":[{"c":3,"d":4}],"z":1}}');
});

test('fnv1a64Hex 已知向量与 UTF-8 字节数', () => {
  assert.equal(CHECKSUM_ALGORITHM, 'fnv1a64');
  assert.equal(fnv1a64Hex(''), 'cbf29ce484222325');
  assert.equal(fnv1a64Hex('a'), 'af63dc4c8601ec8c');
  assert.equal(fnv1a64Hex('foobar'), '85944171f73967e8');
  // 中文按 UTF-8 字节计算，不是 UTF-16 码元
  assert.equal(utf8Bytes('调试'), 6);
  assert.equal(utf8Bytes('a调'), 4);
  assert.notEqual(fnv1a64Hex('调试'), fnv1a64Hex('调'));
});

test('checksumOf 与键顺序无关、数据变化会改变摘要', () => {
  const left = checksumOf({ b: [1, 2], a: 'x' });
  const right = checksumOf({ a: 'x', b: [1, 2] });
  assert.equal(left.algorithm, CHECKSUM_ALGORITHM);
  assert.equal(left.digest, right.digest);
  assert.equal(left.bytes, right.bytes);
  assert.equal(left.digest.length, 16);
  assert.notEqual(checksumOf({ a: 'x' }).digest, checksumOf({ a: 'y' }).digest);
});

test('buildJournalExport：schema/版本/统计/checksum 完整', () => {
  const { journal, requests, coverage, correlation } = sampleInput();
  const envelope = buildJournalExport({
    session: { id: 'tab-1', tabId: 1, name: 'demo', url: 'https://x.test/', startedAt: 1_000, endedAt: 1_500, bodies: false },
    journal,
    requests,
    coverage,
    correlation,
    generatedAt: 3_000,
  });
  assert.deepEqual(envelope.schema, DEBUG_EXPORT_SCHEMA);
  assert.equal(envelope.schema.name, 'bridgedeck.debug.journal');
  assert.equal(envelope.schema.version, 1);
  assert.equal(envelope.generatedAt, new Date(3_000).toISOString());
  assert.deepEqual(envelope.session, {
    id: 'tab-1',
    tabId: 1,
    name: 'demo',
    url: 'https://x.test/',
    startedAt: 1_000,
    endedAt: 1_500,
    bodies: false,
  });
  assert.equal(envelope.counts.events, 4);
  assert.equal(envelope.counts.requests, 1);
  assert.equal(envelope.counts.gaps, coverage.gaps.length);
  assert.deepEqual(envelope.counts.byType, { start: 1, pin: 1, replay: 1, stop: 1 });
  assert.equal(envelope.journal.events.length, 4);
  assert.equal(envelope.journal.evictions.total, 1);
  assert.equal(envelope.requests[0].requestId, 'req-1');
  assert.equal(envelope.coverage.complete, false);
  assert.ok(envelope.coverage.summary.gaps > 0);
  assert.equal(envelope.correlation.requests, 1);
  assert.equal(envelope.integrity.algorithm, CHECKSUM_ALGORITHM);
  assert.match(envelope.integrity.digest, /^[0-9a-f]{16}$/);
  assert.ok(envelope.integrity.bytes > 0);

  const verified = verifyJournalExport(envelope);
  assert.equal(verified.ok, true);
  assert.equal(verified.reason, 'verified');
  assert.equal(verified.digest, envelope.integrity.digest);
  assert.equal(verified.events, 4);
  assert.equal(verified.requests, 1);
  assert.equal(verified.generatedAt, new Date(3_000).toISOString());
});

test('导出物脱敏：journal/URL 中的 secret 不出现，可读字段保留', () => {
  const { journal, requests, coverage, correlation } = sampleInput();
  const envelope = buildJournalExport({ session: { id: 'tab-1' }, journal, requests, coverage, correlation });
  const text = serializeJournalExport(envelope);
  const scan = scanForPlaintextSecrets(text, ['JOURNAL_SECRET', 'REQUEST_SECRET', 'HEADER_SECRET']);
  assert.deepEqual(scan.leaked, []);
  assert.equal(scan.clean, true);
  assert.match(text, /page=2/);
  assert.equal(envelope.requests[0].url.includes('token=%5Bredacted%5D') || envelope.requests[0].url.includes('token=[redacted]'), true);
  const replay = envelope.journal.events.find((event) => event.type === 'replay');
  assert.equal(replay.token, '[redacted]');
  const redactionCheck = assertExportRedacted(text, ['JOURNAL_SECRET']);
  assert.deepEqual(redactionCheck, { clean: true, leakedCount: 0, leaked: [] });
  const leakCheck = assertExportRedacted('{"password":"LEAKED"}', ['LEAKED']);
  assert.equal(leakCheck.clean, false);
  assert.deepEqual(leakCheck.leaked, ['LEAKED']);
});

test('verifyJournalExport：篡改 payload 报 checksum-mismatch，bytes 也有独立校验', () => {
  const { journal, requests, coverage, correlation } = sampleInput();
  const envelope = buildJournalExport({ session: { id: 'tab-1' }, journal, requests, coverage, correlation });

  const tampered = JSON.parse(JSON.stringify(envelope));
  tampered.counts.events = 99;
  const mismatch = verifyJournalExport(tampered);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'checksum-mismatch');
  assert.match(mismatch.expected, /^[0-9a-f]{16}$/);
  assert.equal(mismatch.actual, envelope.integrity.digest);

  const bytesBroken = JSON.parse(JSON.stringify(envelope));
  bytesBroken.integrity.bytes = envelope.integrity.bytes + 1;
  const bytesResult = verifyJournalExport(bytesBroken);
  assert.equal(bytesResult.ok, false);
  assert.equal(bytesResult.reason, 'bytes-mismatch');
  assert.equal(bytesResult.actual, bytesBroken.integrity.bytes);

  const noIntegrity = JSON.parse(JSON.stringify(envelope));
  delete noIntegrity.integrity;
  assert.equal(verifyJournalExport(noIntegrity).reason, 'missing-integrity');

  const wrongSchema = JSON.parse(JSON.stringify(envelope));
  wrongSchema.schema.name = 'other.tool';
  assert.equal(verifyJournalExport(wrongSchema).reason, 'unsupported-schema');
  const wrongVersion = JSON.parse(JSON.stringify(envelope));
  wrongVersion.schema.version = 2;
  const versionResult = verifyJournalExport(wrongVersion);
  assert.equal(versionResult.reason, 'unsupported-schema');
  assert.equal(versionResult.expectedVersion, 1);

  const unknownAlgorithm = JSON.parse(JSON.stringify(envelope));
  unknownAlgorithm.integrity.algorithm = 'md5';
  assert.equal(verifyJournalExport(unknownAlgorithm).reason, 'unsupported-checksum');

  // 接受 JSON 文本：篡改后的文本同样被抓住
  const textTampered = serializeJournalExport(envelope).replace('"events":4', '"events":5');
  assert.equal(verifyJournalExport(textTampered).reason, 'checksum-mismatch');
  assert.equal(verifyJournalExport('not json').reason, 'invalid-json');
  assert.equal(verifyJournalExport('[]').reason, 'invalid-envelope');
  assert.equal(verifyJournalExport(null).reason, 'invalid-envelope');
});

test('serialize/parse/summarize 往返一致', () => {
  const { journal, requests, coverage, correlation } = sampleInput();
  const envelope = buildJournalExport({ session: { id: 'tab-1' }, journal, requests, coverage, correlation });
  const compact = serializeJournalExport(envelope);
  const pretty = serializeJournalExport(envelope, { pretty: true });
  assert.equal(compact.includes('\n'), false);
  assert.ok(pretty.split('\n').length > 10);

  const parsed = parseJournalExport(compact);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.envelope.integrity, envelope.integrity);
  assert.equal(verifyJournalExport(parsed.envelope).ok, true);
  assert.equal(parseJournalExport('{bad').ok, false);
  assert.equal(parseJournalExport('{bad').reason, 'invalid-json');
  assert.equal(parseJournalExport('[]').reason, 'not-an-object');

  const summary = summarizeJournalExport(envelope);
  assert.equal(summary.schema.name, DEBUG_EXPORT_SCHEMA.name);
  assert.equal(summary.events, 4);
  assert.equal(summary.requests, 1);
  assert.equal(summary.gaps, coverage.gaps.length);
  assert.equal(summary.digest, envelope.integrity.digest);
  assert.equal(summary.bytes, envelope.integrity.bytes);
  assert.equal(summary.verified, true);
  assert.equal(summary.verifyReason, 'verified');
  assert.equal(summary.session.id, 'tab-1');

  const tampered = JSON.parse(JSON.stringify(envelope));
  tampered.counts.events = 1;
  assert.equal(summarizeJournalExport(tampered).verified, false);
  assert.equal(summarizeJournalExport(tampered).verifyReason, 'checksum-mismatch');
});

test('buildJournalExport 对入参做归一：无效请求被丢掉、数组 journal 也可用', () => {
  const envelope = buildJournalExport({
    session: null,
    journal: [{ type: 'start', at: 1 }, { type: 'stop', at: 2 }],
    requests: [{ url: '' }, { method: 'GET', url: 'https://x.test/ok', status: 200 }],
    generatedAt: 5_000,
  });
  assert.equal(envelope.journal.events.length, 2);
  assert.equal(envelope.counts.byType.start, 1);
  assert.equal(envelope.counts.byType.stop, 1);
  assert.equal(envelope.requests.length, 1);
  assert.equal(envelope.requests[0].method, 'GET');
  assert.equal(envelope.session, null);
  assert.equal(envelope.coverage, null);
  assert.equal(envelope.correlation, null);
  assert.deepEqual(envelope.gaps, []);
  assert.equal(verifyJournalExport(envelope).ok, true);

  const empty = buildJournalExport({});
  assert.equal(empty.counts.events, 0);
  assert.equal(empty.counts.requests, 0);
  assert.equal(empty.journal.events.length, 0);
  assert.equal(verifyJournalExport(empty).ok, true);
});
