/**
 * tools/eval/corpus/session-queue.mjs -- invariants for the per-session serial
 * command queue.
 *
 * Runtime under test: lib/session-queue.mjs (`createSessionQueue`).
 * The queue is the concurrency boundary that keeps one browser session's
 * mutating commands from interleaving (ref store, debugger, input state).
 *
 * Concurrency here is deterministic: tasks block on manually-resolved promises
 * and the property advances only microtasks, never timers. Every property
 * releases its tasks before returning, so the runner never leaks pending work.
 */

import { defineProperty } from '../lib/property.mjs';
import {
  DEFAULT_QUEUE_CAPACITY,
  SessionQueueError,
  createSessionQueue,
} from '../../../lib/session-queue.mjs';
import { array, boolean, constant, integer, oneOf, record, string } from '../lib/gen.mjs';
import { assert, assertDeepEqual, assertEqual, assertMatch } from '../lib/assert.mjs';
import { createQueueHarness, flushMicrotasks } from '../lib/harness.mjs';

const CREATE = { file: 'lib/session-queue.mjs', symbol: 'createSessionQueue' };
const ERROR = { file: 'lib/session-queue.mjs', symbol: 'SessionQueueError' };

const sessionName = string({ minLength: 1, maxLength: 4, alphabet: 'abc12' });
const taskCount = integer({ min: 1, max: 5 });
const capacityGen = oneOf([constant(1), constant(2), constant(3), constant(4)]);

async function releaseAndAwait(harness, tokens) {
  for (const token of tokens) if (!token.released && !token.settled) token.deferred.resolve(token.value);
  await flushMicrotasks(32);
  return Promise.all(tokens.map((token) => token.promise));
}

export const area = {
  area: 'session-queue',
  title: '每 session 串行队列：FIFO、容量、关闭、故障隔离',
  properties: [
    defineProperty({
      id: 'session-queue/fifo-per-session',
      title: '同一 session 的任务严格按提交顺序执行',
      area: 'session-queue',
      gen: record({ count: taskCount }),
      consumes: [CREATE],
      check: async ({ count }) => {
        const harness = createQueueHarness(createSessionQueue, { capacity: 8 });
        const tokens = [];
        for (let index = 0; index < count; index += 1) tokens.push(harness.submit('s1', { tag: index }));
        await flushMicrotasks(4);
        const outcomes = await releaseAndAwait(harness, tokens);
        assertDeepEqual(harness.order, Array.from({ length: count }, (_, index) => index), '执行顺序不是提交顺序', { actual: harness.order });
        for (const outcome of outcomes) assertEqual(outcome.ok, true, '任务意外失败');
        assert(harness.snapshot().every((entry) => entry.pending === 0), '结算后仍有在途任务');
        return true;
      },
    }),
    defineProperty({
      id: 'session-queue/capacity-bound',
      title: '容量上限：超出的提交以 E_QUEUE_FULL 拒绝，成功数不超过容量',
      area: 'session-queue',
      gen: record({ capacity: capacityGen, extra: integer({ min: 1, max: 3 }) }),
      consumes: [CREATE, ERROR],
      check: async ({ capacity, extra }) => {
        const harness = createQueueHarness(createSessionQueue, { capacity });
        const tokens = [];
        for (let index = 0; index < capacity + extra; index += 1) tokens.push(harness.submit('s', { tag: index }));
        await flushMicrotasks(4);
        const snapshot = harness.snapshot();
        assertEqual(snapshot.length, 1, '快照 session 数不符');
        assertEqual(snapshot[0].pending, capacity, '在途任务数不等于容量');
        const rejected = await Promise.all(tokens.slice(capacity).map((token) => token.promise));
        for (const outcome of rejected) {
          assertEqual(outcome.ok, false, '超出容量的任务没有被拒绝');
          assertEqual(outcome.error, 'E_QUEUE_FULL', '拒绝错误码不是 E_QUEUE_FULL');
        }
        const accepted = await releaseAndAwait(harness, tokens.slice(0, capacity));
        for (const outcome of accepted) assertEqual(outcome.ok, true, '容量内的任务失败');
        assert(harness.snapshot().every((entry) => entry.pending === 0), '结算后仍有在途任务');
        // Capacity is released after settlement: a new burst of `capacity` fits.
        const later = [];
        for (let index = 0; index < capacity; index += 1) later.push(harness.submit('s', { tag: 'later-' + index }));
        const laterOutcomes = await releaseAndAwait(harness, later);
        for (const outcome of laterOutcomes) assertEqual(outcome.ok, true, '结算后容量没有释放');
        return true;
      },
    }),
    defineProperty({
      id: 'session-queue/serial-per-session',
      title: '同一 session 同时最多只有一个任务在跑',
      area: 'session-queue',
      gen: record({ count: integer({ min: 2, max: 5 }) }),
      consumes: [CREATE],
      check: async ({ count }) => {
        const harness = createQueueHarness(createSessionQueue, { capacity: 8 });
        const tokens = [];
        for (let index = 0; index < count; index += 1) tokens.push(harness.submit('s', { tag: index }));
        await flushMicrotasks(4);
        assertEqual(tokens.filter((token) => token.started).length, 1, '多个任务同时启动');
        for (let index = 0; index < count; index += 1) {
          await harness.release(tokens[index]);
          await flushMicrotasks(4);
          const expectedStarted = Math.min(index + 2, count);
          assertEqual(tokens.filter((token) => token.started).length, expectedStarted, '串行推进没有逐任务进行');
        }
        assertDeepEqual(harness.order, Array.from({ length: count }, (_, index) => index), '串行执行顺序不符');
        return true;
      },
    }),
    defineProperty({
      id: 'session-queue/across-sessions-concurrent',
      title: '不同 session 之间可以并行（各自仍串行）',
      area: 'session-queue',
      gen: record({ a: integer({ min: 1, max: 3 }), b: integer({ min: 1, max: 3 }) }),
      consumes: [CREATE],
      check: async ({ a, b }) => {
        const harness = createQueueHarness(createSessionQueue, { capacity: 8 });
        const tokensA = [];
        const tokensB = [];
        for (let index = 0; index < a; index += 1) tokensA.push(harness.submit('a', { tag: 'a' + index }));
        for (let index = 0; index < b; index += 1) tokensB.push(harness.submit('b', { tag: 'b' + index }));
        await flushMicrotasks(6);
        assertEqual(tokensA[0].started, true, 'session a 首个任务没有启动');
        assertEqual(tokensB[0].started, true, 'session b 首个任务没有启动');
        assertEqual(tokensA.filter((token) => token.started).length, 1, 'session a 并发超过 1');
        assertEqual(tokensB.filter((token) => token.started).length, 1, 'session b 并发超过 1');
        const snapshot = harness.snapshot();
        assertDeepEqual(snapshot.map((item) => item.sessionId), ['a', 'b'], '快照顺序不是首次入队顺序');
        await releaseAndAwait(harness, [...tokensA, ...tokensB]);
        assert(harness.snapshot().every((entry) => entry.pending === 0), '结算后仍有在途任务');
        return true;
      },
    }),
    defineProperty({
      id: 'session-queue/error-isolation',
      title: '单任务失败不会打断后续任务，错误只回传给调用方',
      area: 'session-queue',
      gen: record({ count: integer({ min: 3, max: 5 }), failIndex: integer({ min: 0, max: 4 }) }),
      consumes: [CREATE],
      check: async ({ count, failIndex }) => {
        const index = Math.min(failIndex, count - 1);
        const harness = createQueueHarness(createSessionQueue, { capacity: 8 });
        const tokens = [];
        for (let cursor = 0; cursor < count; cursor += 1) tokens.push(harness.submit('s', { tag: cursor, succeed: cursor !== index }));
        const outcomes = await releaseAndAwait(harness, tokens);
        assertDeepEqual(harness.order, Array.from({ length: count }, (_, cursor) => cursor), '故障后执行顺序被打乱');
        for (let cursor = 0; cursor < count; cursor += 1) {
          if (cursor === index) {
            assertEqual(outcomes[cursor].ok, false, '失败任务没有回传失败');
            assertMatch(outcomes[cursor].message, /task-failed:/, '失败信息丢失');
          } else {
            assertEqual(outcomes[cursor].ok, true, '失败任务影响了后续任务');
          }
        }
        assert(harness.snapshot().every((entry) => entry.pending === 0), '结算后仍有在途任务');
        return true;
      },
    }),
    defineProperty({
      id: 'session-queue/immediate-failure-continues-chain',
      title: '立即失败的任务不会阻塞链上后续任务',
      area: 'session-queue',
      gen: record({ first: boolean(), value: integer({ min: -5, max: 5 }) }),
      consumes: [CREATE],
      check: async ({ first, value }) => {
        const harness = createQueueHarness(createSessionQueue, { capacity: 4 });
        const failing = harness.submit('s', { tag: 'fail', hold: false, succeed: false });
        const outcome = await failing.promise;
        assertEqual(outcome.ok, false, '失败任务没有回传失败');
        assertEqual(outcome.error, 'E_TASK', '失败错误码不是 E_TASK');
        const next = harness.submit('s', { tag: 'next', hold: false, succeed: true, value: first ? value : null });
        const nextOutcome = await next.promise;
        assertEqual(nextOutcome.ok, true, '链上后续任务没有执行');
        if (!first) assertEqual(nextOutcome.result, next.index, '任务返回值不是提交序号');
        assertDeepEqual(harness.order, ['fail', 'next'], '任务顺序不符');
        assert(harness.snapshot().every((entry) => entry.pending === 0), '结算后仍有在途任务');
        return true;
      },
    }),
    defineProperty({
      id: 'session-queue/rejected-does-not-leak-capacity',
      title: '被容量拒绝的提交不占用后续容量',
      area: 'session-queue',
      gen: record({ capacity: capacityGen }),
      consumes: [CREATE, ERROR],
      check: async ({ capacity }) => {
        const harness = createQueueHarness(createSessionQueue, { capacity });
        const tokens = [];
        for (let index = 0; index < capacity; index += 1) tokens.push(harness.submit('s', { tag: index }));
        await flushMicrotasks(2);
        const overflow = harness.submit('s', { tag: 'overflow' });
        const overflowOutcome = await overflow.promise;
        assertEqual(overflowOutcome.ok, false, '溢出任务没有被拒绝');
        await releaseAndAwait(harness, tokens);
        const retry = harness.submit('s', { tag: 'retry', hold: false });
        const retryOutcome = await retry.promise;
        assertEqual(retryOutcome.ok, true, '拒绝后容量没有恢复');
        assert(harness.snapshot().every((entry) => entry.pending === 0), '结算后仍有在途任务');
        return true;
      },
    }),
    defineProperty({
      id: 'session-queue/drop-rejects-and-excludes',
      title: 'drop 后拒绝新提交、快照排除该 session，在途任务仍可结算',
      area: 'session-queue',
      gen: record({ session: sessionName }),
      consumes: [CREATE, ERROR],
      check: async ({ session }) => {
        const harness = createQueueHarness(createSessionQueue, { capacity: 4 });
        const pending = harness.submit(session, { tag: 'pending' });
        await flushMicrotasks(2);
        harness.drop(session);
        await flushMicrotasks(2);
        const rejected = harness.submit(session, { tag: 'after-drop' });
        const rejectedOutcome = await rejected.promise;
        assertEqual(rejectedOutcome.ok, false, 'drop 后新提交没有被拒绝');
        assertEqual(rejectedOutcome.error, 'E_SESSION_STOPPED', '错误码不是 E_SESSION_STOPPED');
        assert(!harness.snapshot().some((item) => item.sessionId === session), 'drop 后 session 仍在快照里');
        const released = await releaseAndAwait(harness, [pending]);
        assertEqual(released[0].ok, true, 'drop 把在途任务也弄失败了');
        return true;
      },
    }),
    defineProperty({
      id: 'session-queue/drop-idle-session',
      title: '对从未入队的 session 调 drop 后，首次提交也被拒绝',
      area: 'session-queue',
      gen: record({ session: sessionName, payload: integer({ min: 0, max: 100 }) }),
      consumes: [CREATE, ERROR],
      check: async ({ session, payload }) => {
        const harness = createQueueHarness(createSessionQueue, { capacity: 2 });
        harness.drop(session);
        const token = harness.submit(session, { tag: payload, hold: false });
        const outcome = await token.promise;
        assertEqual(outcome.ok, false, 'drop 空闲 session 后首次提交没有被拒绝');
        assertEqual(outcome.error, 'E_SESSION_STOPPED', '错误码不是 E_SESSION_STOPPED');
        assertDeepEqual(harness.snapshot(), [], 'drop 后快照应为空');
        return true;
      },
    }),
    defineProperty({
      id: 'session-queue/string-session-identity',
      title: '数字与字符串 session id 共用同一条队列',
      area: 'session-queue',
      gen: record({ numericId: integer({ min: 0, max: 99 }) }),
      consumes: [CREATE],
      check: async ({ numericId }) => {
        const harness = createQueueHarness(createSessionQueue, { capacity: 1 });
        const first = harness.submit(numericId, { tag: 'first' });
        await flushMicrotasks(2);
        const second = harness.submit(String(numericId), { tag: 'second' });
        const outcome = await second.promise;
        assertEqual(outcome.ok, false, '字符串 id 没有复用同一队列容量');
        assertEqual(outcome.error, 'E_QUEUE_FULL', '复用队列后错误码不是 E_QUEUE_FULL');
        await releaseAndAwait(harness, [first]);
        assert(harness.snapshot().every((entry) => entry.pending === 0), '结算后仍有在途任务');
        return true;
      },
    }),
    defineProperty({
      id: 'session-queue/snapshot-shape',
      title: 'snapshot 结构：sessionId/pending/closed，pending 非负且按首入队顺序',
      area: 'session-queue',
      gen: record({ sessions: array(sessionName, { minLength: 1, maxLength: 4 }), capacity: capacityGen }),
      consumes: [CREATE],
      check: async ({ sessions, capacity }) => {
        const harness = createQueueHarness(createSessionQueue, { capacity: capacity + 4 });
        const unique = [...new Set(sessions)];
        const tokens = unique.map((session) => harness.submit(session, { tag: session }));
        await flushMicrotasks(4);
        const snapshot = harness.snapshot();
        assertDeepEqual(snapshot.map((item) => item.sessionId), unique, '快照顺序不是首次入队顺序');
        for (const entry of snapshot) {
          assertEqual(typeof entry.sessionId, 'string', 'sessionId 不是字符串');
          assert(Number.isInteger(entry.pending) && entry.pending >= 0, 'pending 不是非负整数', { actual: entry.pending });
          assertEqual(entry.closed, false, '未关闭的队列标记为 closed');
        }
        await releaseAndAwait(harness, tokens);
        assert(harness.snapshot().every((entry) => entry.pending === 0), '结算后仍有在途任务');
        return true;
      },
    }),
    defineProperty({
      id: 'session-queue/enqueue-return-values',
      title: 'enqueue 原样返回任务结果（含 falsy / 对象）',
      area: 'session-queue',
      gen: array(oneOf([
        integer({ min: -100, max: 100 }),
        string({ minLength: 0, maxLength: 4, alphabet: 'ab' }),
        boolean(),
        constant(null),
        record({ n: integer({ min: 0, max: 9 }), ok: boolean() }),
      ]), { minLength: 1, maxLength: 4 }),
      consumes: [CREATE],
      check: async (values) => {
        const queue = createSessionQueue({ capacity: values.length + 1 });
        const results = [];
        for (const value of values) results.push(await queue.enqueue('s', async () => value));
        assertDeepEqual(results, values, 'enqueue 没有原样返回任务结果');
        assert(queue.snapshot().every((entry) => entry.pending === 0), '结算后仍有在途任务');
        return true;
      },
    }),
    defineProperty({
      id: 'session-queue/sync-task-order',
      title: '同步任务也按提交顺序执行并返回',
      area: 'session-queue',
      gen: array(integer({ min: 0, max: 99 }), { minLength: 1, maxLength: 5 }),
      consumes: [CREATE],
      check: async (values) => {
        const queue = createSessionQueue({ capacity: 8 });
        const order = [];
        const results = await Promise.all(values.map((value) => queue.enqueue('s', () => {
          order.push(value);
          return value * 2;
        })));
        assertDeepEqual(order, values, '同步任务执行顺序不是提交顺序');
        assertDeepEqual(results, values.map((value) => value * 2), '同步任务返回值不符');
        return true;
      },
    }),
    defineProperty({
      id: 'session-queue/capacity-normalization',
      title: '非法/非正容量归一化为默认容量',
      area: 'session-queue',
      gen: oneOf([constant(0), constant(-5), constant('x'), constant(null), constant(1), constant(2), constant(7)]),
      consumes: [CREATE],
      check: (capacity) => {
        const queue = createSessionQueue({ capacity });
        const numeric = Number(capacity);
        if (Number.isFinite(numeric) && numeric > 0) assertEqual(queue.capacity, numeric, '合法容量没有生效');
        else assertEqual(queue.capacity, DEFAULT_QUEUE_CAPACITY, '非法容量没有回退到默认值');
        return true;
      },
    }),
    defineProperty({
      id: 'session-queue/error-class',
      title: 'SessionQueueError 携带稳定 code 与消息',
      area: 'session-queue',
      gen: record({ code: oneOf([constant('E_QUEUE_FULL'), constant('E_SESSION_STOPPED')]), message: string({ minLength: 1, maxLength: 6, alphabet: 'abc' }) }),
      consumes: [ERROR],
      check: ({ code, message }) => {
        const error = new SessionQueueError(code, message);
        assert(error instanceof Error, 'SessionQueueError 不是 Error');
        assertEqual(error.code, code, 'code 没有保存');
        assertEqual(error.message, message, 'message 没有保存');
        return true;
      },
    }),
  ],
};

export default area;
