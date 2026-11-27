// tools/quality/lib/writes.mjs —— 写路径的幂等 token 与重复执行语义（门禁原语）。
//
// 真实写路径（意图账本 WAL、recipe 文件 DAO、run report）各有自己的实现；
// 门禁需要一个"最小可判定模型"把语义钉住：
//   * token 只由规范化后的语义输入派生（method + 目标 + 参数），与进程/时间无关；
//   * 同 token 第二次执行必须命中已提交结论（duplicate），且不产生第二次写；
//   * 执行失败不得提交（避免"失败被当成已做"）。
// 该模型同时是跨进程一致性的比较对象（同 seed/同操作 → 同 token）。

import { fingerprint, semanticFingerprint } from './canonical.mjs';
import { createFixedClock } from './prng.mjs';

export const WRITE_TOKEN_VERSION = 1;

/** 规范化写操作：只保留决定副作用的语义字段（去掉描述性/易变字段）。 */
export function normalizeOperation(operation = {}) {
  const source = operation && typeof operation === 'object' ? operation : {};
  const params = source.params && typeof source.params === 'object' ? source.params : {};
  const keys = Object.keys(params).sort();
  const normalizedParams = {};
  for (const key of keys) normalizedParams[key] = params[key];
  return {
    version: WRITE_TOKEN_VERSION,
    method: String(source.method || ''),
    target: source.target == null ? null : String(source.target),
    params: normalizedParams,
  };
}

/** 幂等 token：同语义输入 → 同 token（跨进程稳定，不含时间/随机）。 */
export function operationToken(operation) {
  return 'wt_' + fingerprint(normalizeOperation(operation));
}

/**
 * 幂等写存储：内存实现，可注入 clock 与 storage（Map 兼容接口）。
 * apply(operation, executor) 返回：
 *   {token, executed, duplicate, result, writes, executions}
 * 失败：不提交 token，记录 attempts 后原样抛错（由调用方决定是否重试）。
 */
export function createIdempotentStore({ clock = createFixedClock().now, storage = new Map() } = {}) {
  const state = {
    writes: 0,
    executions: 0,
    duplicates: 0,
    failures: 0,
    storage,
    clock,
  };
  const api = {
    get writes() {
      return state.writes;
    },
    get executions() {
      return state.executions;
    },
    get duplicates() {
      return state.duplicates;
    },
    get failures() {
      return state.failures;
    },
    /** 只读查询：已经提交过就返回记录，否则 null。 */
    peek(operation) {
      const token = operationToken(operation);
      return storage.has(token) ? storage.get(token) : null;
    },
    async apply(operation, executor) {
      if (typeof executor !== 'function') throw new TypeError('createIdempotentStore.apply 需要 executor');
      const token = operationToken(operation);
      const existing = storage.get(token);
      if (existing && existing.status === 'committed') {
        state.duplicates += 1;
        state.executions += 1;
        return {
          token,
          executed: false,
          duplicate: true,
          result: existing.result,
          writes: state.writes,
          executions: state.executions,
        };
      }
      state.executions += 1;
      try {
        const result = await executor(normalizeOperation(operation));
        storage.set(token, {
          token,
          status: 'committed',
          at: state.clock(),
          result,
        });
        state.writes += 1;
        return { token, executed: true, duplicate: false, result, writes: state.writes, executions: state.executions };
      } catch (error) {
        state.failures += 1;
        const previous = storage.get(token);
        storage.set(token, {
          token,
          status: 'failed',
          at: state.clock(),
          attempts: ((previous && previous.attempts) || 0) + 1,
          error: { code: (error && error.code) || 'E_INTERNAL', message: String((error && error.message) || error) },
        });
        throw error;
      }
    },
    snapshot() {
      return {
        writes: state.writes,
        executions: state.executions,
        duplicates: state.duplicates,
        failures: state.failures,
        committed: [...storage.values()].filter((entry) => entry.status === 'committed').length,
        failed: [...storage.values()].filter((entry) => entry.status === 'failed').length,
      };
    },
  };
  return api;
}

/** 写记录语义摘要：忽略提交时间等易变字段，用于"重复写同一份内容"的比对。 */
export function writeSemanticDigest(value) {
  return semanticFingerprint(value);
}

/** 固定写操作夹具：测试可据此断言 token 的稳定派生。 */
export function createFingerprintFixture() {
  const operation = { method: 'click', target: '@e1', params: { selector: '#submit', label: 'submit' } };
  return {
    operation,
    operationToken: operationToken(operation),
    digest: fingerprint(normalizeOperation(operation)),
  };
}

/** 跨进程 token 检查的子进程入口：node lib/writes.mjs --token-fixture <seed> */
export function tokenFixture(seed = 'quality') {
  const operationSets = [
    [
      { method: 'click', target: '@e1', params: { selector: '#submit', label: 'submit' } },
      { method: 'fill', target: '@e2', params: { value: 'secret', password: 'p@ss' } },
    ],
    [
      { method: 'navigate', target: 'tab:11', params: { url: 'https://fixture.invalid/next' } },
      { method: 'click', target: '@e1', params: { selector: '#submit', label: 'submit' } },
    ],
  ];
  const tokens = operationSets.map((operations) => operations.map((operation) => operationToken(operation)));
  return {
    schema: 'bb.quality-write-token/1',
    seed: String(seed),
    tokens,
    digest: fingerprint({ seed: String(seed), tokens }),
    store: createIdempotentStore().snapshot(),
  };
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return new URL('file://' + entry.replace(/\\/g, '/')).href === import.meta.url
      || new URL(import.meta.url).pathname.endsWith(entry.replace(/\\/g, '/'));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--token-fixture');
  if (index >= 0) {
    const seed = args[index + 1] || 'quality';
    process.stdout.write(JSON.stringify(tokenFixture(seed)) + '\n');
  } else {
    process.stderr.write('用法：node tools/quality/lib/writes.mjs --token-fixture <seed>\n');
    process.exitCode = 2;
  }
}
