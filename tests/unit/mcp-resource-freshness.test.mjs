// tests/unit/mcp-resource-freshness.test.mjs —— 资源新鲜度分级测试。
//
// 覆盖：窗口解析（默认/环境变量缩放）、capturedAt 解析、classifyFreshness 的
// fresh/recent/stale/expired/static/unknown 六态与 action、边界时刻、buildFreshnessEntries
// 从真实注册表派生（uri/etag/persisted）、summarizeFreshness 汇总、revalidationAdvice
// 的工具建议、freshnessSnapshot 声明。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FRESHNESS_ACTIONS,
  FRESHNESS_ENV,
  FRESHNESS_STATES,
  FRESHNESS_WINDOWS,
  buildFreshnessEntries,
  classifyFreshness,
  freshnessHint,
  freshnessSnapshot,
  parseCapturedAt,
  revalidationAdvice,
  resolveFreshnessWindows,
  summarizeFreshness,
} from '../../mcp/resource-freshness.mjs';
import { INDEX_KINDS } from '../../mcp/resource-index.mjs';
import { SNAPSHOT_FRESH_MS, createResourceRegistry } from '../../mcp/resources.mjs';

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-mcp-freshness-'));
}

const NOW = Date.parse('2026-11-26T00:00:00.000Z');
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

test('resolveFreshnessWindows：默认窗口与 env 缩放', () => {
  const defaults = resolveFreshnessWindows({});
  assert.equal(defaults.source, 'default');
  assert.equal(defaults.freshMs, FRESHNESS_WINDOWS.freshMs);
  assert.equal(defaults.freshMs, SNAPSHOT_FRESH_MS);
  assert.equal(defaults.recentMs, defaults.freshMs * 6);
  assert.equal(defaults.expiredMs, defaults.freshMs * 24);

  const scaled = resolveFreshnessWindows({ [FRESHNESS_ENV]: '1000' });
  assert.equal(scaled.source, FRESHNESS_ENV);
  assert.equal(scaled.freshMs, 1000);
  assert.equal(scaled.recentMs, 6000);
  assert.equal(scaled.expiredMs, 24000);

  const ignored = resolveFreshnessWindows({ [FRESHNESS_ENV]: 'abc' });
  assert.equal(ignored.source, 'default');
});

test('parseCapturedAt：ISO/毫秒数/非法', () => {
  assert.equal(parseCapturedAt('2026-11-26T00:00:00.000Z'), NOW);
  assert.equal(parseCapturedAt(NOW), NOW);
  assert.equal(parseCapturedAt('not-a-date'), null);
  assert.equal(parseCapturedAt(null), null);
  assert.equal(parseCapturedAt(''), null);
});

test('classifyFreshness：fresh / recent / stale / expired 的边界', () => {
  const windows = { freshMs: 1000, recentMs: 5000, expiredMs: 10000 };
  const fresh = classifyFreshness(iso(-500), { now: NOW, windows, kind: INDEX_KINDS.OBSERVATION });
  assert.equal(fresh.state, FRESHNESS_STATES.FRESH);
  assert.equal(fresh.action, 'use');
  assert.equal(fresh.fresh, true);
  assert.equal(fresh.stale, false);
  assert.equal(fresh.ageMs, 500);
  assert.equal(fresh.ageSeconds, 1);

  const boundary = classifyFreshness(iso(-1000), { now: NOW, windows, kind: INDEX_KINDS.OBSERVATION });
  assert.equal(boundary.state, FRESHNESS_STATES.FRESH, '恰好等于窗口仍算 fresh');

  const recent = classifyFreshness(iso(-2000), { now: NOW, windows, kind: INDEX_KINDS.OBSERVATION });
  assert.equal(recent.state, FRESHNESS_STATES.RECENT);
  assert.equal(recent.action, 'revalidate');
  assert.equal(recent.stale, false);

  const stale = classifyFreshness(iso(-6000), { now: NOW, windows, kind: INDEX_KINDS.EVIDENCE });
  assert.equal(stale.state, FRESHNESS_STATES.STALE);
  assert.equal(stale.action, 'refresh');
  assert.equal(stale.stale, true);
  assert.equal(stale.expired, false);

  const expired = classifyFreshness(iso(-20000), { now: NOW, windows, kind: INDEX_KINDS.JOURNAL });
  assert.equal(expired.state, FRESHNESS_STATES.EXPIRED);
  assert.equal(expired.action, 'recollect');
  assert.equal(expired.expired, true);
  assert.equal(expired.stale, true);
});

test('classifyFreshness：静态资源与未知时间戳', () => {
  const staticSkill = classifyFreshness(iso(-9999999), { now: NOW, kind: INDEX_KINDS.SKILL_MAIN });
  assert.equal(staticSkill.state, FRESHNESS_STATES.STATIC);
  assert.equal(staticSkill.action, 'use');
  assert.equal(staticSkill.fresh, true);
  assert.equal(staticSkill.expired, false);

  const unknown = classifyFreshness(null, { now: NOW, kind: INDEX_KINDS.OBSERVATION });
  assert.equal(unknown.state, FRESHNESS_STATES.UNKNOWN);
  assert.equal(unknown.action, 'recollect');
  assert.equal(unknown.ageMs, null);
  assert.equal(unknown.stale, true);
  assert.equal(unknown.expired, true);

  // 未来时间戳（时钟漂移）按 0 年龄处理，不出现负 age。
  const future = classifyFreshness(iso(5000), { now: NOW, kind: INDEX_KINDS.OBSERVATION });
  assert.equal(future.ageMs, 0);
  assert.equal(future.state, FRESHNESS_STATES.FRESH);
});

test('freshnessHint / FRESHNESS_ACTIONS 覆盖每个状态', () => {
  for (const state of Object.values(FRESHNESS_STATES)) {
    assert.equal(typeof FRESHNESS_ACTIONS[state], 'string', state);
    assert.equal(typeof freshnessHint(state), 'string', state);
  }
  assert.match(freshnessHint(FRESHNESS_STATES.STALE), /browser_observe/);
  assert.match(freshnessHint(FRESHNESS_STATES.EXPIRED), /重新采集/);
  assert.match(freshnessHint('nope'), /无数据/);
});

test('buildFreshnessEntries：从真实注册表派生日志/观察/证据条目', () => {
  const registry = createResourceRegistry({ home: tempHome(), persist: false });
  registry.recordObservation('s1', { observation: '@e1', url: 'https://x.test/' });
  registry.recordEvidence('s1', { ok: true });
  registry.recordJournal('s1', { events: [{ at: 1, kind: 'request' }] });
  const entries = buildFreshnessEntries(registry, { now: Date.now() });
  assert.ok(entries.length >= 3);
  const kinds = new Set(entries.map((entry) => entry.kind));
  assert.equal(kinds.has(INDEX_KINDS.OBSERVATION), true);
  assert.equal(kinds.has(INDEX_KINDS.EVIDENCE), true);
  assert.equal(kinds.has(INDEX_KINDS.JOURNAL), true);
  for (const entry of entries) {
    assert.equal(typeof entry.uri, 'string');
    assert.match(entry.uri, /^bridge:\/\//);
    assert.equal(typeof entry.capturedAt, 'string');
    assert.ok(entry.ageMs >= 0);
    assert.ok(entry.state === FRESHNESS_STATES.FRESH || entry.state === FRESHNESS_STATES.RECENT);
    assert.match(String(entry.etag), /^W\/"/);
    assert.equal(Object.isFrozen(entry), true);
  }
  assert.throws(() => buildFreshnessEntries(null), /资源注册表/);
});

test('summarizeFreshness：按状态计数、列出 stale/expired、最老年龄', () => {
  const windows = { freshMs: 1000, recentMs: 5000, expiredMs: 10000 };
  const summary = summarizeFreshness([
    { uri: 'bridge://observation/latest', capturedAt: iso(-100), kind: INDEX_KINDS.OBSERVATION },
    { uri: 'bridge://debug/evidence/s1', capturedAt: iso(-8000), kind: INDEX_KINDS.EVIDENCE },
    { uri: 'bridge://debug/journal/s1', capturedAt: iso(-50000), kind: INDEX_KINDS.JOURNAL },
    { uri: 'bridge://skill/SKILL.md', capturedAt: null, kind: INDEX_KINDS.SKILL_MAIN },
  ], { now: NOW, windows });
  assert.equal(summary.total, 4);
  assert.equal(summary.byState[FRESHNESS_STATES.FRESH], 1);
  assert.equal(summary.byState[FRESHNESS_STATES.STALE], 1);
  assert.equal(summary.byState[FRESHNESS_STATES.EXPIRED], 1);
  assert.equal(summary.byState[FRESHNESS_STATES.STATIC], 1);
  assert.deepEqual([...summary.stale], ['bridge://debug/evidence/s1']);
  assert.deepEqual([...summary.expired], ['bridge://debug/journal/s1']);
  assert.equal(summary.oldestAgeMs, 50000);
  assert.equal(summary.dynamicResources, 3);
  assert.equal(summary.newestCapturedAt, iso(-100));
  assert.equal(summary.windows.freshMs, 1000);
});

test('revalidationAdvice：状态 + 建议工具', () => {
  const windows = { freshMs: 1000, recentMs: 5000, expiredMs: 10000 };
  const observation = revalidationAdvice('bridge://observation/latest', iso(-2000), { now: NOW, windows });
  assert.equal(observation.state, FRESHNESS_STATES.RECENT);
  assert.equal(observation.action, 'revalidate');
  assert.equal(observation.tool, 'browser_observe');

  const evidence = revalidationAdvice('bridge://debug/evidence/s1', iso(-8000), { now: NOW, windows });
  assert.equal(evidence.tool, 'browser_debug_evidence');
  const journal = revalidationAdvice('bridge://debug/journal/s1', null, { now: NOW, windows });
  assert.equal(journal.tool, 'browser_debug_journal');
  const skill = revalidationAdvice('bridge://skill/SKILL.md', iso(-9e6), { now: NOW, windows });
  assert.equal(skill.state, FRESHNESS_STATES.STATIC);
  assert.equal(skill.tool, null);
});

test('freshnessSnapshot：声明六态/动作/窗口/env', () => {
  const snapshot = freshnessSnapshot();
  assert.equal(snapshot.env, FRESHNESS_ENV);
  assert.equal(snapshot.readMetaKey, 'browser-bridge/freshness');
  assert.deepEqual([...snapshot.states].sort(), Object.values(FRESHNESS_STATES).sort());
  assert.equal(snapshot.windows.source, 'default');
  assert.ok(snapshot.staticKinds.includes(INDEX_KINDS.SKILL_MAIN));
  assert.ok(snapshot.dynamicKinds.includes(INDEX_KINDS.OBSERVATION));
});
