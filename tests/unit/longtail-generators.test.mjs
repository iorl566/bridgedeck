// tests/unit/longtail-generators.test.mjs —— 四类大夹具生成器的确定性 + 规模契约。

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SEED, sha256Hex, sha256HexSync } from '../../tools/longtail/lib/prng.mjs';
import { resolveScale } from '../../tools/longtail/lib/budget.mjs';
import { createWorkspace } from '../../tools/longtail/lib/tmpdir.mjs';
import {
  PAGE_FIXTURE_VERSION,
  buildPageFixture,
  computeFixtureStats,
  flattenPageNodes,
  summarizePageFixture,
} from '../../tools/longtail/gen/page.mjs';
import {
  HAR_FIXTURE_VERSION,
  buildFrameRegistry,
  buildHarFailureProbes,
  buildHarFixture,
  readHarFixture,
  writeHarFixture,
} from '../../tools/longtail/gen/har.mjs';
import {
  RECORD_BASE_AT,
  RECORD_FIXTURE_VERSION,
  buildRecordFailureProbes,
  buildRecordFixture,
  buildRecordVariant,
} from '../../tools/longtail/gen/record.mjs';
import {
  SEGMENT_DURATION_MS,
  VIDEO_FIXTURE_VERSION,
  buildVideoFixture,
  partRefOf,
  segmentContent,
} from '../../tools/longtail/gen/video.mjs';
import { validateHarDeep } from '../../lib/har-merge.mjs';
import { buildRecordProgram } from '../../extension/src/record-program.js';

// ---------------------------------------------------------------------------
// 大页面
// ---------------------------------------------------------------------------

test('大页面夹具：default 规模 ≥1000 refs / 深嵌套 / 多 iframe', () => {
  const scale = resolveScale('default');
  const fixture = buildPageFixture({ ...scale.page, seed: DEFAULT_SEED, profile: 'default' });
  assert.equal(PAGE_FIXTURE_VERSION, 1);
  assert.equal(fixture.version, PAGE_FIXTURE_VERSION);
  assert.equal(fixture.kind, 'page');
  assert.ok(fixture.stats.refs >= 1000, 'refs=' + fixture.stats.refs);
  assert.ok(fixture.stats.refs >= scale.page.refs, 'refs 不低于规模目标');
  assert.ok(fixture.stats.nodes >= 1000);
  assert.ok(fixture.stats.maxDepth >= 12, '嵌套深度=' + fixture.stats.maxDepth);
  assert.equal(fixture.stats.frames, scale.page.frames);
  assert.equal(fixture.stats.iframeNodes, scale.page.frames);
  assert.ok(fixture.stats.edges >= fixture.stats.refs, '边数应不少于节点数');
  assert.equal(fixture.entries.length, scale.page.frames + 1);
  assert.equal(fixture.frames[fixture.frames.length - 1].hidden, true, '多 iframe 布局应包含一个 hidden 帧');
  assert.ok(fixture.main.nodes.length >= 1000);
  assert.match(fixture.fingerprint, /^[0-9a-f]{16}$/);
  assert.match(fixture.document.documentId, /^doc-[0-9a-f]{8}$/);
});

test('大页面夹具：节点/边/iframe 形状满足 VOM 输入契约', () => {
  const fixture = buildPageFixture({ refs: 120, depth: 8, frames: 3, subgraphNodes: 12, seed: 5 });
  for (const entry of fixture.entries) {
    for (const node of entry.graph.nodes) {
      assert.equal(typeof node.key, 'string');
      assert.equal(typeof node.ref, 'string');
      assert.ok(node.ref.startsWith('@'));
      assert.equal(typeof node.tag, 'string');
      assert.equal(typeof node.role, 'string');
      assert.ok(node.parentKey === null || typeof node.parentKey === 'string');
      assert.ok(node.rect && ['x', 'y', 'w', 'h'].every((key) => Number.isFinite(node.rect[key])));
      if (node.tag === 'iframe') {
        assert.equal(typeof node.frameIndex, 'number');
        assert.ok(node.srcUrl.startsWith('https://'));
      }
    }
    for (const edge of entry.graph.edges) {
      assert.equal(typeof edge.type, 'string');
      assert.equal(typeof edge.from, 'string');
      assert.equal(typeof edge.to, 'string');
      assert.notEqual(edge.from, edge.to);
    }
  }
  const main = fixture.entries[0];
  assert.ok(main.iframeOwners.length >= 1);
  const nested = fixture.entries.filter((entry) => entry.parentFrameId !== 0);
  assert.ok(nested.length >= 1, 'default iframe 布局应包含嵌套帧');
});

test('大页面夹具：同 seed 完全确定，不同 seed 不同', () => {
  const options = { refs: 200, depth: 10, frames: 4, subgraphNodes: 10 };
  const left = buildPageFixture({ ...options, seed: 'alpha' });
  const right = buildPageFixture({ ...options, seed: 'alpha' });
  const other = buildPageFixture({ ...options, seed: 'beta' });
  assert.equal(left.fingerprint, right.fingerprint);
  assert.deepEqual(left.stats, right.stats);
  assert.notEqual(left.fingerprint, other.fingerprint);
  const roundTrip = JSON.parse(JSON.stringify(left));
  assert.equal(roundTrip.fingerprint, left.fingerprint);
  assert.deepEqual(summarizePageFixture(roundTrip), summarizePageFixture(left));
});

test('大页面夹具：统计/摊平辅助函数一致', () => {
  const fixture = buildPageFixture({ refs: 80, depth: 6, frames: 2, subgraphNodes: 8, seed: 3 });
  const stats = computeFixtureStats(fixture.entries);
  assert.deepEqual(stats, fixture.stats);
  const flat = flattenPageNodes(fixture);
  assert.equal(flat.length, stats.nodes);
  const deep = flat.filter((item) => item.frameId === 0).sort((a, b) => b.node.depth - a.node.depth)[0];
  assert.ok(deep.ancestors.length >= 6, '深链节点的祖先链应达到 depth：' + deep.ancestors.length);
  assert.ok(deep.ancestors.every((ancestor) => typeof ancestor.ref === 'string'));
  assert.equal(summarizePageFixture(fixture).refs, stats.refs);
});

// ---------------------------------------------------------------------------
// 大 HAR
// ---------------------------------------------------------------------------

function buildDefaultHar() {
  const scale = resolveScale('default');
  return { scale, fixture: buildHarFixture({ ...scale.har, seed: 12345, profile: 'default' }) };
}

test('大 HAR：default 规模 ≥5MB / 多来源', () => {
  const { scale, fixture } = buildDefaultHar();
  assert.equal(HAR_FIXTURE_VERSION, 1);
  assert.equal(fixture.kind, 'har');
  assert.equal(fixture.sources.length, scale.har.sources);
  assert.ok(fixture.stats.totalBytes >= 5_000_000, 'totalBytes=' + fixture.stats.totalBytes);
  assert.ok(fixture.stats.meetsMinBytes);
  assert.equal(fixture.stats.totalEntries, scale.har.sources * scale.har.entriesPerSource);
  assert.ok(fixture.stats.sharedWithVariant > 0);
  assert.equal(fixture.frames.length, 8);
  for (const source of fixture.sources) {
    assert.equal(source.har.log.version, '1.2');
    assert.equal(source.har.log.entries.length, scale.har.entriesPerSource);
    assert.equal(source.har.log.pages.length, 1);
    assert.ok(source.bytes > 0);
  }
});

test('大 HAR：每个来源结构校验 error=0，时间字段自洽', () => {
  const fixture = buildHarFixture({ sources: 2, entriesPerSource: 24, bodyBytes: 800, minBytes: 100_000, seed: 9 });
  for (const source of fixture.sources) {
    const validation = validateHarDeep(source.har, { maxIssues: 200 });
    assert.equal(validation.counts.errors, 0, source.label + ' errors=' + validation.counts.errors);
    for (const entry of source.har.log.entries) {
      assert.ok(Number.isFinite(Date.parse(entry.startedDateTime)));
      assert.equal(entry._startedAt, Date.parse(entry.startedDateTime));
      assert.equal(entry._finishedAt, entry._startedAt + entry.time);
      const sum = entry.timings.blocked + entry.timings.dns + entry.timings.connect + entry.timings.send + entry.timings.wait + entry.timings.receive;
      assert.equal(sum, entry.time);
      assert.equal(entry.timings._breakdownSumMs, entry.time);
      assert.ok(entry.request.url.startsWith('https://'));
      assert.ok(entry.response.content.text.length > 0);
    }
  }
});

test('大 HAR：确定性 + 不同 seed/体积参数改变指纹', () => {
  const options = { sources: 2, entriesPerSource: 16, bodyBytes: 600, minBytes: 100_000, seed: 'har-seed' };
  const left = buildHarFixture(options);
  const right = buildHarFixture(options);
  const otherSeed = buildHarFixture({ ...options, seed: 'other' });
  const otherSize = buildHarFixture({ ...options, minBytes: 200_000 });
  assert.equal(left.fingerprint, right.fingerprint);
  assert.equal(left.stats.totalBytes, right.stats.totalBytes);
  assert.notEqual(left.fingerprint, otherSeed.fingerprint);
  assert.notEqual(left.fingerprint, otherSize.fingerprint);
  assert.ok(otherSize.stats.totalBytes > left.stats.totalBytes);
});

test('大 HAR：写 tmp / 按索引读回（parseHarSource 可用）', () => {
  const fixture = buildHarFixture({ sources: 2, entriesPerSource: 12, bodyBytes: 400, minBytes: 40_000, seed: 4 });
  const workspace = createWorkspace({ label: 'unit-har', seed: 4 });
  try {
    const written = writeHarFixture(workspace, fixture);
    assert.equal(written.files.length, 2);
    assert.ok(written.bytes >= fixture.stats.totalBytes);
    assert.ok(workspace.listFiles('har').length >= 3);
    const read = readHarFixture(workspace, fixture);
    assert.equal(read.sources.length, 2);
    for (const raw of read.sources) assert.ok(JSON.parse(raw).log.entries.length > 0);
  } finally {
    workspace.cleanup();
  }
});

test('大 HAR：坏 HAR 探针给出具名 issue code', () => {
  for (const probe of buildHarFailureProbes()) {
    const validation = validateHarDeep(probe.har, { maxIssues: 100 });
    const codes = [...new Set(validation.issues.map((issue) => issue.code))];
    for (const expected of probe.expectedCodes) {
      assert.ok(codes.includes(expected), probe.name + ' 期望 ' + expected + '，实际 ' + codes.join(','));
    }
    if (probe.severity) {
      assert.ok(validation.issues.some((issue) => issue.severity === probe.severity), probe.name + ' 应有 ' + probe.severity);
    } else {
      assert.ok(validation.issues.some((issue) => issue.severity === 'error'), probe.name + ' 应为 error');
    }
  }
  assert.equal(buildHarFailureProbes().length, 5);
  const registry = buildFrameRegistry();
  assert.equal(registry[0].parentFrameId, null);
  assert.equal(registry.length, 8);
});

// ---------------------------------------------------------------------------
// 长 record
// ---------------------------------------------------------------------------

test('长 record 夹具：default 规模 ≥200 步 / 分支 / 循环 / human-gate', () => {
  const scale = resolveScale('default');
  const fixture = buildRecordFixture({ ...scale.record, seed: 7, profile: 'default' });
  assert.equal(RECORD_FIXTURE_VERSION, 1);
  assert.equal(fixture.kind, 'record');
  assert.equal(fixture.steps.length, scale.record.steps);
  assert.ok(fixture.steps.length >= 200);
  assert.equal(fixture.stats.boundaries, scale.record.boundaries);
  assert.ok(fixture.stats.loops >= scale.record.loops);
  assert.ok(fixture.stats.humanGates >= scale.record.humanGates);
  assert.ok(fixture.stats.nonIdempotent > 0);
  const refs = fixture.steps.map((step) => step.ref);
  assert.equal(new Set(refs).size, refs.length, 'step ref 必须唯一');
  for (let index = 1; index < fixture.steps.length; index += 1) {
    assert.ok(fixture.steps[index].seq > fixture.steps[index - 1].seq, 'seq 必须递增');
  }
  for (const step of fixture.steps) {
    if (step.kind === 'branch') {
      assert.equal(step.method, 'navigate');
      assert.ok(step.branch && step.branch.url);
      assert.ok(step.params.url);
    }
    if (step.humanGate) {
      assert.ok(step.humanGate.reason.length > 0);
      assert.ok(step.humanGate.valueKind.length > 0);
      assert.ok(typeof step.params.value === 'string' && step.params.value.length > 0);
    }
  }
  assert.equal(fixture.stats.documents, scale.record.boundaries + 1);
});

test('长 record 夹具可被真实 buildRecordProgram 接受（校验 error=0）', () => {
  const fixture = buildRecordFixture({ steps: 240, boundaries: 6, loops: 5, humanGates: 4, seed: 11 });
  const program = buildRecordProgram(fixture.steps);
  assert.equal(program.validation.errors, 0);
  assert.equal(program.stats.total, 240);
  assert.equal(program.stats.boundaries, 6);
  assert.equal(program.stats.segments, 7);
  assert.ok(program.loops.length >= 5);
  assert.equal(program.stats.humanGates, 4);
  assert.ok(program.stats.idempotent + program.stats.nonIdempotent === 240);
  assert.match(program.fingerprint, /^p[0-9a-z]+-/);
});

test('长 record 夹具：确定性 + 变体可 diff', () => {
  const options = { steps: 80, boundaries: 2, loops: 2, humanGates: 1, seed: 'rec' };
  const left = buildRecordFixture(options);
  const right = buildRecordFixture(options);
  const other = buildRecordFixture({ ...options, seed: 'rec2' });
  assert.equal(left.fingerprint, right.fingerprint);
  assert.notEqual(left.fingerprint, other.fingerprint);
  const variant = buildRecordVariant(left, { seed: 1 });
  assert.equal(variant.steps.length >= left.steps.length - 3, true);
  assert.ok(variant.changed.length >= 1);
  assert.ok(variant.added.length >= 1);
  assert.ok(RECORD_BASE_AT > 0);
});

test('长 record 失败探针：非法程序给出具名 code', () => {
  const probes = buildRecordFailureProbes();
  assert.equal(probes.length, 5);
  for (const probe of probes) {
    const program = buildRecordProgram(probe.steps);
    const codes = [...new Set(program.validation.issues.map((issue) => issue.code))];
    for (const expected of probe.expectedCodes) {
      assert.ok(codes.includes(expected), probe.name + ' 期望 ' + expected + '，实际 ' + codes.join(','));
    }
  }
});

// ---------------------------------------------------------------------------
// 大视频 manifest
// ---------------------------------------------------------------------------

test('大视频夹具：default ≥100 分片，时间/字节/校验和自洽', () => {
  const scale = resolveScale('default');
  const fixture = buildVideoFixture({ ...scale.video, seed: 21, profile: 'default' });
  assert.equal(VIDEO_FIXTURE_VERSION, 1);
  assert.ok(fixture.segments.length >= 100);
  assert.equal(fixture.segments.length, scale.video.segments);
  assert.equal(fixture.stats.segments, fixture.segments.length);
  assert.ok(fixture.stats.bytes >= fixture.segments.length * scale.video.segmentBytes * 0.85);
  for (let index = 0; index < fixture.segments.length; index += 1) {
    const segment = fixture.segments[index];
    assert.equal(segment.index, index);
    assert.ok(segment.bytes > 0);
    assert.equal(segment.codec, 'avc');
    assert.match(segment.checksum, /^[0-9a-f]{64}$/);
    assert.ok(segment.lastFrameAt >= segment.atMs);
    if (index > 0) {
      assert.ok(segment.atMs > fixture.segments[index - 1].atMs, 'atMs 必须严格递增');
      assert.ok(segment.atMs > fixture.segments[index - 1].lastFrameAt, '下一片必须在前一片最后一帧之后开始');
    }
  }
  const last = fixture.segments[fixture.segments.length - 1];
  assert.equal(fixture.stats.durationMs, last.lastFrameAt - fixture.segments[0].atMs);
  assert.equal(SEGMENT_DURATION_MS, 500);
  assert.ok(fixture.budget.maxTotalBytes >= fixture.stats.bytes);
});

test('大视频夹具：分片内容确定、sha256 与记录一致', async () => {
  const fixture = buildVideoFixture({ segments: 8, segmentBytes: 2048, seed: 2 });
  for (const segment of fixture.segments) {
    const left = segmentContent(segment);
    const right = segmentContent(segment);
    assert.equal(left.length, segment.bytes);
    assert.equal(left.length, segment.bytes);
    assert.deepEqual([...left], [...right]);
    assert.equal(sha256HexSync(left), segment.checksum);
    assert.equal(await sha256Hex(left), segment.checksum);
  }
  assert.equal(partRefOf(fixture.segments[0]).index, 0);
  assert.equal(partRefOf(fixture.segments[0]).bytes, fixture.segments[0].bytes);
  assert.equal(partRefOf(fixture.segments[0]).checksum, fixture.segments[0].checksum);
});

test('大视频夹具：恢复 case 契约与确定性', () => {
  const fixture = buildVideoFixture({ segments: 30, segmentBytes: 4096, seed: 'video' });
  const names = fixture.recoveryCases.map((recoveryCase) => recoveryCase.name);
  assert.deepEqual(names, ['complete', 'missing-middle', 'truncated', 'checksum-mismatch', 'unlisted-part', 'no-parts']);
  const complete = fixture.recoveryCases[0];
  assert.deepEqual(complete.expect, { recovered: true, completeness: 'complete', state: 'recovered', keptSegments: 30, codes: [] });
  const noParts = fixture.recoveryCases[5];
  assert.equal(noParts.dropAll, true);
  assert.equal(noParts.expect.recovered, false);
  const again = buildVideoFixture({ segments: 30, segmentBytes: 4096, seed: 'video' });
  assert.equal(again.fingerprint, fixture.fingerprint);
  const other = buildVideoFixture({ segments: 30, segmentBytes: 4096, seed: 'video-2' });
  assert.notEqual(other.fingerprint, fixture.fingerprint);
  assert.equal(fixture.kind, 'video');
  assert.match(fixture.recordingId, /^rec-[0-9a-f]{12}$/);
});
