/**
 * tools/eval/corpus/intent-ledger.mjs -- invariants for the write-ahead intent
 * ledger (lib/intent-ledger.mjs).
 *
 * The ledger is the safety boundary that prevents replaying a non-idempotent
 * browser action whose outcome is unknown. The properties here cover:
 *
 *   - begin/finish state machine and WAL frame integrity (v2, seq, checksum);
 *   - UNKNOWN blocking + explicit resolve (idempotent duplicate, conflict);
 *   - crash recovery (active -> unknown/stale, replayBlocked for non-idempotent);
 *   - reconcile / status / stale promotion under an injected clock;
 *   - sanitization (argument VALUES never reach the snapshot or WAL);
 *   - durability degradation (WAL append failure keeps memory state + evidence);
 *   - snapshot trimming and checkpoint truncation.
 *
 * All clocks are injected and all storage is in-memory, so every counterexample
 * is reproducible in-process. Random entry ids are never used as assertions.
 */

import { defineProperty } from '../lib/property.mjs';
import {
  LEDGER_STATES,
  WAL_FRAME_VERSION,
  WAL_KINDS,
  IntentLedger,
  NON_IDEMPOTENT_METHODS,
  createMemoryLedgerStorage,
  hasNoEffect,
  isExplicitResolveOutcome,
  isMutating,
  isNonIdempotentAction,
  normalizeResolveOutcome,
  parseWalRecords,
} from '../../../lib/intent-ledger.mjs';
import { array, boolean, constant, integer, oneOf, record, string, suchThat } from '../lib/gen.mjs';
import { assert, assertDeepEqual, assertEqual, assertJsonSafe, assertMatch, fail } from '../lib/assert.mjs';
import { createLedgerHarness, createManualClock } from '../lib/harness.mjs';

const BEGIN = { file: 'lib/intent-ledger.mjs', symbol: 'begin' };
const FINISH = { file: 'lib/intent-ledger.mjs', symbol: 'finish' };
const RECOVER = { file: 'lib/intent-ledger.mjs', symbol: 'recover' };
const RESOLVE = { file: 'lib/intent-ledger.mjs', symbol: 'resolve' };
const CHECK_REPLAY = { file: 'lib/intent-ledger.mjs', symbol: 'checkReplay' };
const RECONCILE = { file: 'lib/intent-ledger.mjs', symbol: 'reconcile' };
const STATUS = { file: 'lib/intent-ledger.mjs', symbol: 'status' };
const PARSE_WAL = { file: 'lib/intent-ledger.mjs', symbol: 'parseWalRecords' };
const STORAGE = { file: 'lib/intent-ledger.mjs', symbol: 'createMemoryLedgerStorage' };
const HAS_NO_EFFECT = { file: 'lib/intent-ledger.mjs', symbol: 'hasNoEffect' };
const NON_IDEMPOTENT = { file: 'lib/intent-ledger.mjs', symbol: 'isNonIdempotentAction' };

const METHODS = ['click', 'fill', 'navigate', 'observe', 'status', 'tab.list', 'session.start', 'scroll', 'press', 'screenshot', 'video.start'];
const methodGen = oneOf(METHODS.map((method) => constant(method)));
const outcomeGen = oneOf(['done', 'failed', 'unknown', 'weird'].map((outcome) => constant(outcome)));
const resolveOutcomeGen = oneOf(['confirmed', 'not-applied', 'abandoned', 'applied', 'none', 'reconciled', 'bogus'].map((outcome) => constant(outcome)));
const tabIdGen = integer({ min: 0, max: 20 });
const sessionIdGen = oneOf([constant(null), string({ minLength: 1, maxLength: 4, alphabet: 'ab12' })]);

const NO_EFFECT_CODES = [
  'E_BAD_ARG', 'E_INVALID_PARAMS', 'E_NOT_FOUND', 'E_TARGET_NOT_FILLABLE', 'E_NOT_ACTIONABLE',
  'E_OPTION_NOT_FOUND', 'E_OPTION_AMBIGUOUS', 'E_NOT_SELECT', 'E_FORBIDDEN', 'E_CURSOR_STALE',
  'E_TARGET_MISMATCH', 'E_CONTROL_NOT_HELD', 'E_CONTROL_BUSY', 'E_CONTROL_STALE',
];
const UNKNOWN_CODES = ['E_TIMEOUT', 'E_DAEMON_TIMEOUT', 'E_EXTENSION_GONE', 'E_DISCONNECTED', 'E_CANCELLED'];

function beginMutating(harness, method, tabId, sessionId = null, params = {}) {
  return harness.begin(method, params, { tabId, sessionId });
}

function finishAndFlush(harness, entry, outcome = 'done') {
  const record = harness.finish(entry, outcome);
  // Settle the debounced snapshot write deterministically (no real timers).
  harness.flush();
  return record;
}

function assertFrames(frames, expectedKinds) {
  assertEqual(frames.length, expectedKinds.length, 'WAL 帧数不符', { actual: frames.map((item) => item.frame && item.frame.kind) });
  for (let index = 0; index < frames.length; index += 1) {
    assertEqual(frames[index].error, null, 'WAL 行无法解析');
    const frame = frames[index].frame;
    assert(frame && typeof frame === 'object', 'WAL 帧不是对象');
    assertEqual(frame.v, WAL_FRAME_VERSION, 'WAL 帧版本不符');
    assertEqual(frame.kind, expectedKinds[index], 'WAL 帧 kind 不符');
    // The ledger starts seq at 2 by construction; the invariant we care about is
    // strict contiguity (+1 per frame) and a positive start, not the absolute base.
    assertEqual(frame.seq, frames[0].frame.seq + index, 'WAL seq 不连续');
    assert(frame.seq >= 1, 'WAL seq 不是正数', { actual: frame.seq });
    assertMatch(frame.sum, /^[0-9a-f]{16}$/, 'WAL checksum 不是 16 位十六进制');
  }
}

export const area = {
  area: 'intent-ledger',
  title: '预写意图账本：状态机、WAL、恢复、阻塞、脱敏',
  properties: [
    defineProperty({
      id: 'intent-ledger/begin-mutating-active',
      title: 'mutating begin 生成 active 条目 + begin 帧；只读方法不记账',
      area: 'intent-ledger',
      gen: record({ method: methodGen, tabId: tabIdGen, sessionId: sessionIdGen }),
      consumes: [BEGIN, STORAGE],
      check: ({ method, tabId, sessionId }) => {
        const harness = createLedgerHarness();
        const entry = harness.begin(method, { ref: '@e1', value: 'v', token: 't' }, { tabId, sessionId });
        const frames = harness.walFrames();
        if (!isMutating(method)) {
          assertEqual(entry, null, '只读方法产生了账本条目');
          assertEqual(frames.length, 0, '只读方法写入了 WAL');
          return true;
        }
        assert(entry && typeof entry === 'object', 'mutating 方法没有返回条目');
        assertEqual(entry.state, 'active', '条目初始状态不是 active');
        assertEqual(entry.method, method, '条目方法名不符');
        assertEqual(entry.tabId, tabId, '条目 tabId 不符');
        assertEqual(entry.sessionId, sessionId === null ? null : String(sessionId), '条目 sessionId 不符');
        assertEqual(entry.nonIdempotent, NON_IDEMPOTENT_METHODS.has(method), 'nonIdempotent 分类不符');
        assertEqual(Array.isArray(entry.keys), true, 'keys 摘要不是数组');
        assertFrames(frames, ['begin']);
        assertEqual(frames[0].frame.id, entry.id, 'begin 帧 id 与条目 id 不符');
        assertEqual(frames[0].frame.entry.state, 'active', 'begin 帧里的状态不是 active');
        harness.flush();
        return true;
      },
    }),
    defineProperty({
      id: 'intent-ledger/finish-state-machine',
      title: 'finish 只结算 active，状态映射与二次 finish 幂等',
      area: 'intent-ledger',
      gen: record({ outcome: outcomeGen, tabId: tabIdGen, again: boolean() }),
      consumes: [BEGIN, FINISH],
      check: ({ outcome, tabId, again }) => {
        const harness = createLedgerHarness();
        const entry = beginMutating(harness, 'click', tabId);
        assert(entry, 'begin 没有返回条目');
        const finished = harness.finish(entry, outcome);
        const expected = ['done', 'failed', 'unknown'].includes(outcome) ? outcome : 'done';
        assertEqual(finished.state, expected, 'finish 状态映射不符');
        assertEqual(typeof finished.finishedAt, 'string', 'finish 没有记录 finishedAt');
        const expectedKind = expected === 'unknown' ? 'unknown' : expected === 'failed' ? 'failed' : 'commit';
        const frames = harness.walFrames();
        assertFrames(frames, ['begin', expectedKind]);
        const beforeFrames = frames.length;
        if (again) {
          const second = harness.finish(finished, 'failed');
          assertEqual(second.state, expected, '二次 finish 改变了状态');
          assertEqual(harness.walFrames().length, beforeFrames, '二次 finish 重复写 WAL');
        }
        harness.flush();
        return true;
      },
    }),
    defineProperty({
      id: 'intent-ledger/unknown-marks-replay-blocked',
      title: 'finish(unknown) 标记 replayBlocked；done/failed 不标记',
      area: 'intent-ledger',
      gen: record({ outcome: oneOf([constant('done'), constant('failed'), constant('unknown')]), tabId: tabIdGen }),
      consumes: [FINISH, BEGIN],
      check: ({ outcome, tabId }) => {
        const harness = createLedgerHarness();
        const entry = beginMutating(harness, 'click', tabId);
        const finished = harness.finish(entry, outcome);
        if (outcome === 'unknown') assertEqual(finished.replayBlocked, true, 'unknown 没有标记 replayBlocked');
        else assertEqual(finished.replayBlocked === true, false, '非 unknown 被标记 replayBlocked');
        harness.flush();
        return true;
      },
    }),
    defineProperty({
      id: 'intent-ledger/pending-blocks-tab',
      title: 'UNKNOWN 阻塞同 tab 的 mutating 动作，只读/其它 tab 不受影响',
      area: 'intent-ledger',
      gen: record({ tabId: tabIdGen, sessionId: sessionIdGen, blockerMethod: oneOf([constant('click'), constant('fill'), constant('navigate')]) }),
      consumes: [CHECK_REPLAY, BEGIN],
      check: ({ tabId, sessionId, blockerMethod }) => {
        const harness = createLedgerHarness();
        const entry = beginMutating(harness, blockerMethod, tabId, sessionId);
        harness.finish(entry, 'unknown');
        harness.flush();
        const decision = harness.ledger.checkReplay('fill', { tabId, sessionId });
        assertEqual(decision.ok, false, 'UNKNOWN 待结算没有阻塞后续 mutating 动作');
        assertEqual(decision.replayable, false, '阻塞判定 replayable 不是 false');
        assertEqual(decision.code, 'E_LEDGER_PENDING', '阻塞错误码不是 E_LEDGER_PENDING');
        assert(decision.blocker && decision.blocker.state === 'unknown', '阻塞证据缺少 unknown 状态');
        assertEqual(harness.ledger.checkReplay('observe', { tabId }).ok, true, '只读方法被阻塞');
        assertEqual(harness.ledger.checkReplay('fill', { tabId: tabId + 1 }).ok, true, '其它 tab 被误阻塞');
        let thrown = null;
        try {
          harness.begin('click', {}, { tabId });
        } catch (error) {
          thrown = error;
        }
        assert(thrown, '待结算期间 begin 没有抛错');
        assertEqual(thrown.code, 'E_LEDGER_PENDING', '待结算 begin 的错误码不是 E_LEDGER_PENDING');
        return true;
      },
    }),
    defineProperty({
      id: 'intent-ledger/resolve-idempotent-duplicate',
      title: '重复 resolve 同结论返回 duplicate 且不重复写 WAL',
      area: 'intent-ledger',
      gen: record({ tabId: tabIdGen, outcome: oneOf([constant('confirmed'), constant('not-applied'), constant('applied'), constant('none')]) }),
      consumes: [RESOLVE, BEGIN],
      check: ({ tabId, outcome }) => {
        const harness = createLedgerHarness();
        const entry = beginMutating(harness, 'click', tabId);
        harness.finish(entry, 'unknown');
        const resolved = harness.ledger.resolve(entry.id, outcome);
        assertEqual(resolved.state, 'resolved', '首次 resolve 后状态不是 resolved');
        const normalized = normalizeResolveOutcome(outcome);
        assertEqual(resolved.outcome, normalized.outcome, 'resolve outcome 未归一化');
        assertEqual(resolved.replayBlocked, false, 'resolve 后 replayBlocked 未清除');
        assertEqual(resolved.resolution.explicit, true, 'resolution.explicit 不为 true');
        const frames = harness.walFrames();
        assertFrames(frames, ['begin', 'unknown', 'resolve']);
        const duplicate = harness.ledger.resolve(entry.id, outcome);
        assertEqual(duplicate.duplicate, true, '重复 resolve 没有返回 duplicate');
        assertEqual(duplicate.state, 'resolved', '重复 resolve 改变了状态');
        assertEqual(harness.walFrames().length, frames.length, '重复 resolve 重复写 WAL');
        harness.flush();
        return true;
      },
    }),
    defineProperty({
      id: 'intent-ledger/resolve-conflict',
      title: '冲突 resolve 抛 E_LEDGER_CONFLICT，先前的结论保留',
      area: 'intent-ledger',
      gen: suchThat(record({ tabId: tabIdGen, first: resolveOutcomeGen, second: resolveOutcomeGen }), (value) => value.first !== value.second && normalizeResolveOutcome(value.first) !== null && normalizeResolveOutcome(value.second) !== null),
      consumes: [RESOLVE],
      check: ({ tabId, first, second }) => {
        const normalizedFirst = normalizeResolveOutcome(first);
        const normalizedSecond = normalizeResolveOutcome(second);
        if (normalizedFirst.effect === normalizedSecond.effect) return true; // same effective outcome is a documented duplicate, not a conflict
        const harness = createLedgerHarness();
        const entry = beginMutating(harness, 'click', tabId);
        harness.finish(entry, 'unknown');
        const resolved = harness.ledger.resolve(entry.id, first);
        let thrown = null;
        try {
          harness.ledger.resolve(entry.id, second);
        } catch (error) {
          thrown = error;
        }
        assert(thrown, '冲突 resolve 没有抛错');
        assertEqual(thrown.code, 'E_LEDGER_CONFLICT', '冲突错误码不是 E_LEDGER_CONFLICT');
        assert(thrown.data, '冲突错误缺少 data 证据');
        assertEqual(resolved.state, 'resolved', '冲突改变了已结算状态');
        assertEqual(harness.ledger.entries.find((item) => item.id === entry.id).outcome, normalizedFirst.outcome, '冲突改变了首次结论');
        harness.flush();
        return true;
      },
    }),
    defineProperty({
      id: 'intent-ledger/recover-active-only',
      title: '恢复只处理 active：升级为 unknown/stale，已完成条目不变',
      area: 'intent-ledger',
      gen: record({ activeCount: integer({ min: 1, max: 3 }), doneCount: integer({ min: 0, max: 2 }), legacy: boolean() }),
      consumes: [RECOVER, BEGIN, FINISH],
      check: ({ activeCount, doneCount, legacy }) => {
        const harness = createLedgerHarness();
        const done = [];
        for (let index = 0; index < doneCount; index += 1) {
          const entry = beginMutating(harness, 'click', index);
          harness.finish(entry, 'done');
          done.push(entry.id);
        }
        const activeIds = [];
        for (let index = 0; index < activeCount; index += 1) {
          const entry = beginMutating(harness, 'fill', 10 + index);
          activeIds.push(entry.id);
          void entry;
        }
        const summary = harness.ledger.recover({ legacyState: legacy ? 'stale' : 'unknown', reason: 'unit-recover' });
        assertEqual(summary.recovered, activeCount, '恢复条目数不等于 active 数');
        assertEqual(summary.unknown, legacy ? 0 : activeCount, 'unknown 计数不符');
        assertEqual(summary.stale, legacy ? activeCount : 0, 'stale 计数不符');
        const expectedReplayBlocked = legacy ? 0 : activeIds.filter((id) => harness.ledger.entries.find((item) => item.id === id).nonIdempotent === true).length;
        assertEqual(summary.replayBlocked, expectedReplayBlocked, 'replayBlocked 计数不符');
        for (const id of activeIds) {
          const entry = harness.ledger.entries.find((item) => item.id === id);
          assertEqual(entry.state, legacy ? 'stale' : 'unknown', 'active 条目恢复状态不符');
          assertEqual(entry.previousState, 'active', '恢复没有记录 previousState');
          assertEqual(entry.recovered, true, '恢复没有标记 recovered');
          assertEqual(entry.recoveryReason, 'unit-recover', '恢复原因不符');
          assertEqual(entry.replayBlocked, legacy ? false : entry.nonIdempotent === true, '恢复后 replayBlocked 结论不符');
          assertEqual(typeof entry.recoveredAt, 'string', '恢复没有记录 recoveredAt');
        }
        for (const id of done) {
          const entry = harness.ledger.entries.find((item) => item.id === id);
          assertEqual(entry.state, 'done', '已完成条目被恢复改写');
          assertEqual(entry.recovered === true, false, '已完成条目被标记 recovered');
        }
        const second = harness.ledger.recover();
        assertEqual(second.recovered, 0, '二次恢复又处理了条目');
        return true;
      },
    }),
    defineProperty({
      id: 'intent-ledger/recover-legacy-stale',
      title: 'legacy 恢复把 active 记 stale 且不阻塞重放',
      area: 'intent-ledger',
      gen: record({ tabId: tabIdGen }),
      consumes: [RECOVER],
      check: ({ tabId }) => {
        const harness = createLedgerHarness();
        const entry = beginMutating(harness, 'click', tabId);
        const summary = harness.ledger.load();
        assertEqual(summary.length, 1, 'load() 返回条目数不符');
        const loaded = summary[0];
        assertEqual(loaded.state, 'stale', 'legacy 恢复没有记为 stale');
        assertEqual(loaded.replayBlocked === true, false, 'legacy stale 被标记 replayBlocked');
        assertEqual(typeof loaded.staleAt, 'string', 'stale 没有 staleAt');
        assertEqual(harness.ledger.checkReplay('click', { tabId }).ok, false, 'stale 待结算没有阻塞后续动作');
        assertEqual(harness.ledger.checkReplay('observe', { tabId }).ok, true, '只读方法被 stale 阻塞');
        return true;
      },
    }),
    defineProperty({
      id: 'intent-ledger/recovered-resolve-requires-explicit',
      title: '崩溃恢复的非幂等 UNKNOWN 必须显式 confirmed/not-applied 才能解锁',
      area: 'intent-ledger',
      gen: record({ outcome: oneOf([constant('abandoned'), constant('reconciled'), constant('bogus')]), explicit: oneOf([constant('confirmed'), constant('not-applied')]) }),
      consumes: [RESOLVE, RECOVER],
      check: ({ outcome, explicit }) => {
        const harness = createLedgerHarness();
        const entry = beginMutating(harness, 'navigate', 3);
        harness.ledger.recover();
        let thrown = null;
        try {
          harness.ledger.resolve(entry.id, outcome);
        } catch (error) {
          thrown = error;
        }
        assert(thrown, '恢复后非幂等 UNKNOWN 使用了非显式结论却没有抛错');
        assertEqual(thrown.code, 'E_LEDGER_RESOLVE_REQUIRED', '解锁错误码不是 E_LEDGER_RESOLVE_REQUIRED');
        assert(thrown.data && Array.isArray(thrown.data.allowedOutcomes), '解锁错误缺少 allowedOutcomes');
        assertDeepEqual(thrown.data.allowedOutcomes, ['confirmed', 'not-applied'], 'allowedOutcomes 不符');
        const resolved = harness.ledger.resolve(entry.id, explicit);
        assertEqual(resolved.state, 'resolved', '显式结论没有结算');
        assertEqual(resolved.replayBlocked, false, '显式结论没有解除 replayBlocked');
        assertEqual(harness.ledger.checkReplay('navigate', { tabId: 3 }).ok, true, '显式结论后仍被阻塞');
        harness.flush();
        return true;
      },
    }),
    defineProperty({
      id: 'intent-ledger/reconcile-rules',
      title: 'reconcile 只处理同 tab 的 stale/unknown，恢复的非幂等需显式结论',
      area: 'intent-ledger',
      gen: record({ tabId: tabIdGen, recovered: boolean(), outcome: oneOf([constant('reconciled'), constant('confirmed'), constant('not-applied')]) }),
      consumes: [RECONCILE, RECOVER],
      check: ({ tabId, recovered, outcome }) => {
        const harness = createLedgerHarness();
        const entry = beginMutating(harness, 'click', tabId);
        if (recovered) harness.ledger.recover();
        else {
          harness.clock.advance(harness.ledger.staleMs + 1);
          harness.ledger.status();
        }
        const other = beginMutating(harness, 'fill', tabId + 1);
        harness.finish(other, 'done');
        const count = harness.ledger.reconcile(tabId, outcome);
        const current = harness.ledger.entries.find((item) => item.id === entry.id);
        if (recovered && outcome === 'reconciled') {
          assertEqual(count, 0, '恢复的非幂等条目被自动和解');
          assertEqual(current.state, 'unknown', '被跳过的条目状态被改写');
          assertEqual(current.replayBlocked, true, '被跳过的条目没有保持 replayBlocked');
          assertEqual(harness.ledger.lastReconcileSkipped, 1, 'lastReconcileSkipped 计数不符');
          return true;
        }
        assertEqual(count, 1, '应被和解的条目没有被和解');
        assertEqual(current.state, 'resolved', '和解后状态不是 resolved');
        assertEqual(isExplicitResolveOutcome(current.outcome), outcome !== 'reconciled', '和解结论的显式性不符');
        harness.flush();
        return true;
      },
    }),
    defineProperty({
      id: 'intent-ledger/status-pending-consistency',
      title: 'status.pending 只含 active/stale/unknown，recent 截断且倒序',
      area: 'intent-ledger',
      gen: record({ tabId: tabIdGen, count: integer({ min: 1, max: 3 }), mode: oneOf([constant('active'), constant('done'), constant('unknown')]) }),
      consumes: [STATUS, BEGIN, FINISH],
      check: ({ tabId, count, mode }) => {
        const harness = createLedgerHarness();
        for (let index = 0; index < count; index += 1) {
          const entry = beginMutating(harness, 'click', tabId + index);
          if (mode !== 'active') harness.finish(entry, mode);
        }
        const status = harness.ledger.status({ limit: 2 });
        const expectedPending = mode === 'done' ? 0 : count;
        assertEqual(status.pending.length, expectedPending, 'pending 数量不符');
        for (const entry of status.pending) {
          assert(LEDGER_STATES.includes(entry.state), 'pending 含非法状态', { actual: entry.state });
          assert(entry.state === 'active' || entry.state === 'stale' || entry.state === 'unknown', 'pending 含已结算条目', { actual: entry.state });
        }
        assert(status.recent.length <= 2, 'recent 没有按 limit 截断');
        assertDeepEqual(status.recent, harness.ledger.entries.slice(-2).reverse(), 'recent 不是倒序末尾条目');
        assertEqual(status.staleMs, 15_000, 'staleMs 不符');
        const serialized = JSON.stringify(status);
        assert(!serialized.includes('undefined'), 'status 含 undefined');
        harness.flush();
        return true;
      },
    }),
    defineProperty({
      id: 'intent-ledger/stale-promotion',
      title: '超过 staleMs 的 active 条目在 status/checkReplay 时升级为 stale',
      area: 'intent-ledger',
      gen: record({ tabId: tabIdGen, advance: integer({ min: 0, max: 30000 }) }),
      consumes: [STATUS, CHECK_REPLAY],
      check: ({ tabId, advance }) => {
        const harness = createLedgerHarness({ staleMs: 10_000 });
        const entry = beginMutating(harness, 'click', tabId);
        harness.clock.advance(advance);
        const status = harness.ledger.status();
        const current = status.pending.find((item) => item.id === entry.id) || harness.ledger.entries.find((item) => item.id === entry.id);
        if (advance > 10_000) {
          assertEqual(current.state, 'stale', '超时条目没有升级为 stale');
          assertEqual(typeof current.staleAt, 'string', 'stale 条目没有 staleAt');
        } else {
          assertEqual(current.state, 'active', '未超时条目被提前升级');
        }
        const decision = harness.ledger.checkReplay('click', { tabId });
        if (advance > 10_000) {
          assertEqual(decision.ok, false, 'stale 条目没有阻塞重放');
          assertEqual(decision.blocker.state, 'stale', '阻塞证据状态不是 stale');
        } else {
          assertEqual(decision.ok, true, '未超时条目误阻塞重放');
        }
        return true;
      },
    }),
    defineProperty({
      id: 'intent-ledger/sanitize-values',
      title: '脱敏：参数值/密钥绝不进入条目、快照或 WAL',
      area: 'intent-ledger',
      gen: record({ secret: suchThat(string({ minLength: 3, maxLength: 10, alphabet: 'SECRETxyz123' }), (value) => value.trim().length >= 3), selector: string({ minLength: 1, maxLength: 6, alphabet: 'abc#.' }) }),
      consumes: [BEGIN, STORAGE],
      check: ({ secret, selector }) => {
        const harness = createLedgerHarness();
        const params = {
          ref: '@e1',
          selector,
          value: secret,
          token: 'tok-' + secret,
          password: secret,
          text: secret,
          clipboard: secret,
        };
        const entry = harness.begin('fill', params, { tabId: 1, sessionId: 's1' });
        const frames = harness.walFrames();
        assertFrames(frames, ['begin']);
        const walText = harness.walText();
        const entryJson = JSON.stringify(entry);
        assert(!entryJson.includes(secret), '条目明文包含参数值', { actual: secret });
        assert(!walText.includes(secret), 'WAL 明文包含参数值', { actual: secret });
        for (const key of ['value', 'token', 'password', 'text', 'clipboard']) {
          assert(!entry.keys.includes(key), 'keys 摘要包含敏感键：' + key);
        }
        assert(entry.keys.includes('ref'), 'keys 摘要丢失 ref');
        assert(entry.keys.includes('selector'), 'keys 摘要丢失 selector');
        assertDeepEqual(entry.keys, entry.keys.slice().sort(), 'keys 摘要没有排序');
        assert(entry.target && entry.target.ref === '@e1', 'target 摘要丢失 ref');
        assert(entry.target && entry.target.selector === selector, 'target 摘要丢失 selector');
        const snapshot = harness.flushStats();
        assert(snapshot.entries.active === 1, 'snapshot 统计不含 active 条目');
        harness.flush();
        assert(!JSON.stringify(harness.snapshotEntries()).includes(secret), '快照明文包含参数值');
        return true;
      },
    }),
    defineProperty({
      id: 'intent-ledger/wal-frame-integrity',
      title: 'WAL 帧结构合法、seq 递增、checksum 可解析且无损坏',
      area: 'intent-ledger',
      gen: record({ tabs: array(tabIdGen, { minLength: 1, maxLength: 3 }), finishMode: oneOf([constant('done'), constant('unknown'), constant('failed')]) }),
      consumes: [PARSE_WAL, BEGIN, FINISH],
      check: ({ tabs, finishMode }) => {
        const harness = createLedgerHarness();
        const entries = [];
        // The ledger intentionally blocks a second mutating begin on a tab that
        // still has an UNKNOWN entry, so dedupe generated tab ids (the queue
        // semantics for one entry per tab are covered by pending-blocks-tab).
        for (const tabId of [...new Set(tabs)]) {
          const entry = beginMutating(harness, 'click', tabId);
          entries.push(entry);
          harness.finish(entry, finishMode);
        }
        const frames = harness.walFrames();
        assertEqual(frames.length, entries.length * 2, 'WAL 帧数不是 begin+settle 的 2 倍');
        assertFrames(frames, entries.flatMap(() => ['begin', finishMode === 'unknown' ? 'unknown' : finishMode === 'failed' ? 'failed' : 'commit']));
        for (let index = 0; index < entries.length; index += 1) {
          assertEqual(frames[index * 2].frame.id, entries[index].id, 'begin 帧 id 不符');
          assertEqual(frames[index * 2 + 1].frame.id, entries[index].id, 'settle 帧 id 不符');
        }
        const parsed = parseWalRecords(harness.walText(), { now: harness.clock.now });
        assertEqual(parsed.stats.lines, frames.length, 'parseWalRecords lines 不符');
        assertEqual(parsed.stats.parsed, frames.length, 'parseWalRecords parsed 不符');
        assertEqual(parsed.stats.corrupted, 0, 'WAL 出现损坏帧');
        assertEqual(parsed.stats.tornTail, false, '完整 WAL 被判定为 torn tail');
        assertEqual(parsed.stats.duplicates, 0, 'WAL 出现重复帧');
        assertEqual(parsed.stats.outOfOrder, 0, 'WAL 出现乱序帧');
        assertEqual(parsed.stats.lastSeq, frames[frames.length - 1].frame.seq, 'lastSeq 不是最大 seq');
        assertEqual(parsed.records.length, frames.length, 'records 数量不符');
        for (const record of parsed.records) assert(WAL_KINDS.includes(record.kind), '解析结果含未知 kind');
        harness.flush();
        return true;
      },
    }),
    defineProperty({
      id: 'intent-ledger/wal-tamper-and-torn-tail',
      title: '篡改 checksum / 半行尾部 / legacy 行都有结构化审计证据',
      area: 'intent-ledger',
      gen: record({ tabId: tabIdGen, tamper: boolean() }),
      consumes: [PARSE_WAL],
      check: ({ tabId, tamper }) => {
        const harness = createLedgerHarness();
        const entry = beginMutating(harness, 'click', tabId);
        harness.finish(entry, 'done');
        const raw = harness.walText();
        const lines = raw.split('\n').filter(Boolean);
        assertEqual(lines.length, 2, 'WAL 行数不符');
        if (tamper) {
          const frame = JSON.parse(lines[0]);
          frame.entry.method = 'navigate';
          const tampered = [JSON.stringify(frame), lines[1]].join('\n') + '\n';
          const parsed = parseWalRecords(tampered, { now: harness.clock.now });
          assert(parsed.stats.corrupted >= 1, '篡改 checksum 没有被识别');
          assertEqual(parsed.stats.parsed, 1, '篡改行的剩余帧解析数不符');
        }
        const torn = parseWalRecords(raw.slice(0, Math.max(1, raw.length - 8)), { now: harness.clock.now });
        assertEqual(torn.stats.tornTail, true, '半行尾部没有标记 tornTail');
        const legacy = parseWalRecords(JSON.stringify({ id: 'lt_legacy', method: 'click', state: 'active' }) + '\n', { now: harness.clock.now });
        assertEqual(legacy.stats.legacy, 1, 'legacy 行没有被识别');
        assertEqual(legacy.stats.parsed, 1, 'legacy 行没有计入 parsed');
        const garbage = parseWalRecords('{"broken":\nnot-json-at-all\n\n', { now: harness.clock.now });
        assert(garbage.stats.corrupted >= 1, '纯垃圾行没有被计为损坏');
        assert(Number.isInteger(garbage.stats.lines), '审计计数不是整数');
        return true;
      },
    }),
    defineProperty({
      id: 'intent-ledger/durability-degraded',
      title: 'WAL 追加失败时保留内存状态并留下 degraded 证据',
      area: 'intent-ledger',
      gen: record({ tabId: tabIdGen, method: oneOf([constant('click'), constant('fill')]) }),
      consumes: [BEGIN, STORAGE],
      check: ({ tabId, method }) => {
        const clock = createManualClock();
        const storage = createMemoryLedgerStorage({ failAppendAfter: 0 });
        const ledger = new IntentLedger({ storage, now: clock.now, fsync: false });
        const entry = ledger.begin(method, { ref: '@e1' }, { tabId });
        assert(entry && entry.state === 'active', '追加失败后内存状态丢失');
        assertEqual(ledger.durability.degraded, true, '追加失败没有标记 degraded');
        assert(ledger.durability.lastError, '追加失败没有 lastError 证据');
        assertEqual(ledger.durability.lastError.code, 'E_LEDGER_WAL_IO', 'degraded 错误码不符');
        const stats = ledger.stats();
        assertEqual(stats.entries.total, 1, 'stats 条目数不符');
        assertEqual(stats.entries.active, 1, 'stats active 数不符');
        ledger.flush();
        return true;
      },
    }),
    defineProperty({
      id: 'intent-ledger/snapshot-max-entries',
      title: '快照只保留最后 maxEntries 条，顺序稳定',
      area: 'intent-ledger',
      gen: record({ maxEntries: integer({ min: 2, max: 4 }), extra: integer({ min: 1, max: 3 }) }),
      consumes: [BEGIN, FINISH],
      check: ({ maxEntries, extra }) => {
        const harness = createLedgerHarness({ maxEntries });
        const ids = [];
        for (let index = 0; index < maxEntries + extra; index += 1) {
          const entry = beginMutating(harness, 'click', index);
          ids.push(entry.id);
          harness.finish(entry, 'done');
        }
        harness.flush();
        const snapshot = harness.snapshotEntries();
        assertEqual(snapshot.length, maxEntries, '快照条目数不等于 maxEntries');
        assertDeepEqual(snapshot.map((entry) => entry.id), ids.slice(-maxEntries), '快照保留的不是最后 maxEntries 条');
        assertEqual(harness.walText(), '', '写快照后 WAL 没有截断');
        return true;
      },
    }),
    defineProperty({
      id: 'intent-ledger/checkpoint',
      title: 'checkpoint 落快照、清空 WAL 并返回统计',
      area: 'intent-ledger',
      gen: record({ count: integer({ min: 1, max: 3 }) }),
      consumes: [BEGIN, FINISH],
      check: ({ count }) => {
        const harness = createLedgerHarness();
        const ids = [];
        for (let index = 0; index < count; index += 1) {
          const entry = beginMutating(harness, 'click', index);
          ids.push(entry.id);
          harness.finish(entry, 'done');
        }
        assert(harness.walText().length > 0, 'checkpoint 前 WAL 为空');
        const stats = harness.ledger.checkpoint();
        assertEqual(stats.entries.total, count, 'checkpoint 统计条目数不符');
        assertEqual(harness.storage.readWalRaw(), '', 'checkpoint 没有清空 WAL');
        assert(harness.storage.truncates >= 1, 'checkpoint 没有截断 WAL');
        assertDeepEqual(harness.snapshotEntries().map((entry) => entry.id), ids, 'checkpoint 快照条目不符');
        return true;
      },
    }),
    defineProperty({
      id: 'intent-ledger/has-no-effect-classification',
      title: 'hasNoEffect 只承认派发前/明确未生效的证据',
      area: 'intent-ledger',
      gen: record({ code: oneOf([...NO_EFFECT_CODES, ...UNKNOWN_CODES].map((code) => constant(code))), flag: oneOf([constant(null), constant('none'), constant('dispatched')]) }),
      consumes: [HAS_NO_EFFECT],
      check: ({ code, flag }) => {
        const error = { code };
        if (flag === 'none') error.effectState = 'none';
        if (flag === 'dispatched') error.dispatched = false;
        const expected = NO_EFFECT_CODES.includes(code) || flag !== null;
        assertEqual(hasNoEffect(error), expected, 'hasNoEffect 判定不符', { actual: { code, flag } });
        assertEqual(hasNoEffect(null), false, 'null 被判定为未生效');
        assertEqual(hasNoEffect({}), false, '空错误被判定为未生效');
        assertEqual(hasNoEffect({ code: 'E_TIMEOUT' }), false, '超时被判定为未生效');
        assertEqual(hasNoEffect({ code: 'E_TIMEOUT', data: { dispatched: false } }), true, 'data.dispatched=false 没有被识别');
        return true;
      },
    }),
    defineProperty({
      id: 'intent-ledger/non-idempotent-classification',
      title: 'isNonIdempotentAction 与 NON_IDEMPOTENT_METHODS 完全一致',
      area: 'intent-ledger',
      gen: record({ method: methodGen, unknown: string({ minLength: 1, maxLength: 4, alphabet: 'abc' }) }),
      consumes: [NON_IDEMPOTENT],
      check: ({ method, unknown }) => {
        assertEqual(isNonIdempotentAction(method), NON_IDEMPOTENT_METHODS.has(method), '标准方法分类不一致');
        assertEqual(isNonIdempotentAction(unknown), NON_IDEMPOTENT_METHODS.has(unknown), '未知方法分类不一致');
        assertEqual(isNonIdempotentAction(null), false, 'null 被判定为非幂等');
        if (isMutating(method)) {
          const harness = createLedgerHarness();
          const entry = beginMutating(harness, method, 1);
          assertEqual(entry.nonIdempotent, isNonIdempotentAction(method), '账本条目的 nonIdempotent 与分类不一致');
          harness.flush();
        }
        return true;
      },
    }),
    defineProperty({
      id: 'intent-ledger/stats-consistency',
      title: 'stats 的状态计数/nextSeq/replayBlocked 与内部条目一致',
      area: 'intent-ledger',
      gen: record({ tabId: tabIdGen, count: integer({ min: 1, max: 3 }), mode: oneOf([constant('active'), constant('done'), constant('unknown')]) }),
      consumes: [STATUS, PARSE_WAL],
      check: ({ tabId, count, mode }) => {
        const harness = createLedgerHarness();
        for (let index = 0; index < count; index += 1) {
          const entry = beginMutating(harness, 'click', tabId + index);
          if (mode !== 'active') harness.finish(entry, mode);
        }
        const stats = harness.ledger.stats();
        assertEqual(stats.entries.total, count, 'total 不符');
        if (mode === 'active') assertEqual(stats.entries.active, count, 'active 计数不符');
        if (mode === 'unknown') {
          assertEqual(stats.entries.unknown, count, 'unknown 计数不符');
          assertEqual(stats.entries.unresolved, count, 'unresolved 计数不符');
        }
        if (mode === 'done') {
          assertEqual(stats.entries.active, 0, 'done 模式下仍有 active 条目');
          assertEqual(stats.entries.unknown, 0, 'done 模式下仍有 unknown 条目');
          assertEqual(stats.entries.unresolved, 0, 'done 模式下仍有待结算条目');
        }
        const sum = ['active', 'stale', 'unknown'].reduce((total, state) => total + (stats.entries[state] || 0), 0);
        assert(sum <= stats.entries.total, '状态计数总和超过 total');
        const replayBlocked = harness.ledger.entries.filter((entry) => entry.replayBlocked === true).length;
        assertEqual(stats.entries.replayBlocked, replayBlocked, 'replayBlocked 计数不符');
        const frames = harness.walFrames();
        const lastSeq = frames.reduce((max, item) => Math.max(max, item.frame ? item.frame.seq : 0), 0);
        assertEqual(stats.nextSeq, lastSeq + 1, 'nextSeq 不是最大 seq + 1');
        assert(Number.isInteger(stats.wal.parsed), 'wal.parsed 不是整数');
        assert(Number.isInteger(stats.wal.lines), 'wal.lines 不是整数');
        assertJsonSafe(stats, 'stats 不是 JSON 安全值');
        harness.flush();
        return true;
      },
    }),
    defineProperty({
      id: 'intent-ledger/read-only-never-blocked',
      title: '只读方法从不被待结算/未知状态阻塞',
      area: 'intent-ledger',
      gen: record({ tabId: tabIdGen, state: oneOf([constant('unknown'), constant('stale')]) }),
      consumes: [CHECK_REPLAY, BEGIN],
      check: ({ tabId, state }) => {
        const harness = createLedgerHarness();
        const entry = beginMutating(harness, 'click', tabId);
        if (state === 'unknown') harness.finish(entry, 'unknown');
        else {
          harness.clock.advance(harness.ledger.staleMs + 1);
          harness.ledger.status();
        }
        for (const method of ['observe', 'status', 'tab.list', 'screenshot']) {
          const decision = harness.ledger.checkReplay(method, { tabId });
          assertEqual(decision.ok, true, '只读方法被阻塞：' + method);
          assertEqual(decision.reason, 'read-only', '只读方法 reason 不是 read-only');
          assertEqual(harness.ledger.begin(method, {}, { tabId }), null, '只读方法产生了账本条目：' + method);
        }
        // A mutating method stays blocked while the unknown/stale entry is unresolved.
        let thrown = null;
        try {
          harness.ledger.begin('fill', {}, { tabId });
        } catch (error) {
          thrown = error;
        }
        assert(thrown && thrown.code === 'E_LEDGER_PENDING', '待结算期间 mutating 没有被拦截');
        return true;
      },
    }),
  ],
};

export default area;
