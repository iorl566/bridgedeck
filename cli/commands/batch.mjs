// cli/commands/batch.mjs —— `bridge daemon batch plan|start|status|list|cancel|quota|schema`
// 真实调用 daemon 的批处理 RPC（batch.plan / batch.start / batch.status / batch.list /
// batch.cancel / batch.quota），并负责：
//   - 批量规格（spec）读取：--file（可重复）/ --items（内联 JSON）/ --url（单条）；
//   - 人类输出（table-views 的表格/摘要）与 --json 单行信封；
//   - 退出码（exit-codes：0 成功 / 1 失败 / 2 参数 / 3 部分成功 / 4 配额拒绝 / 5 取消或回滚）；
//   - --strict：输出前按 cli/lib/json-schema.mjs 的 schema 自检，daemon 字段漂移直接失败。
//
// 用法示例：
//   bridge daemon batch plan --file batch.json
//   bridge daemon batch start --file batch.json --on-error abort --concurrency 2
//   bridge daemon batch start --items '[{"url":"https://a.example/"},{"url":"https://b.example/"}]'
//   bridge daemon batch status b1-abc --json
//   bridge daemon batch list --state completed --limit 5
//   bridge daemon batch cancel b1-abc
//   bridge daemon batch quota --json
//   bridge daemon batch schema            # 列出登记 schema
//   bridge daemon batch schema bb.session-batch/1 --json
//
// 注意：本命令**不做**任何本地会话副作用；所有启动/停止都在 daemon 侧完成，
// 参数错误在本地以 ArgError（退出码 2）拒绝，不触达 daemon。

import fs from 'node:fs';
import path from 'node:path';
import { formatExitCode, exitCodeForBatch, EXIT_USAGE, EXIT_OK, EXIT_ERROR } from '../lib/exit-codes.mjs';
import { assertSchema, describeSchema, listSchemas, schemaTable } from '../lib/json-schema.mjs';
import { renderBatchList, renderBatchPlan, renderBatchReport, renderQuota } from '../lib/table-views.mjs';

const USAGE = '用法：bridge daemon batch plan|start [--file <spec.json>]... [--items <json>] [--url <url>] '
  + '[--on-error continue|abort|rollback] [--concurrency N] [--retries N] [--max N] [--dry-run] [--json] [--strict]'
  + ' | status [<batchId>] [--json] [--strict]'
  + ' | list [--state <state>] [--limit N] [--json]'
  + ' | cancel <batchId> [--json]'
  + ' | quota [--json] [--limit N]'
  + ' | schema [<schemaId>] [--json]';

const BATCH_STATES = ['planning', 'running', 'completed', 'aborted', 'cancelled', 'rolled-back', 'failed'];
const ON_ERROR = ['continue', 'abort', 'rollback'];

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 把 --items 的 JSON 解析成 batch 规格；允许数组（条目/tab 简写）或对象。 */
export function parseItemsFlag(raw, ArgError) {
  const text = String(raw === undefined || raw === null ? '' : raw).trim();
  if (!text) throw new ArgError('--items 需要 JSON（数组或 {"items":[...]}）');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ArgError('--items 不是合法 JSON：' + ((error && error.message) || error));
  }
  if (Array.isArray(parsed)) return parsed;
  if (isObject(parsed) && Array.isArray(parsed.items)) return parsed.items;
  throw new ArgError('--items 需要数组或 {"items":[...]}');
}

/**
 * 汇总一个或多个 spec 文件：允许多种形状，全部归一化成 batch 请求参数。
 * 支持：
 *   { items: [...], onError, concurrency, ... }         —— 完整 batch 参数
 *   [ {url}, {url} ]                                    —— 条目数组
 *   ["https://a/", "https://b/"]                        —— URL 字符串数组
 *   { urls: ["https://a/"] }                            —— URL 列表简写
 */
export function mergeSpecDocuments(documents, { ArgError } = {}) {
  const error = ArgError || Error;
  const merged = { items: [], params: {} };
  for (const document of Array.isArray(documents) ? documents : []) {
    if (document === null || document === undefined) continue;
    if (Array.isArray(document)) {
      merged.items.push(...normalizeDocumentItems(document, error));
      continue;
    }
    if (!isObject(document)) throw new error('batch spec 需要对象或数组');
    if (Array.isArray(document.urls)) {
      for (const url of document.urls) merged.items.push(typeof url === 'string' ? { url } : url);
    }
    if (Array.isArray(document.items)) merged.items.push(...normalizeDocumentItems(document.items, error));
    for (const key of ['onError', 'concurrency', 'retries', 'timeoutMs', 'max', 'priority', 'batchId', 'group', 'quota']) {
      if (document[key] !== undefined) merged.params[key] = document[key];
    }
  }
  return { items: merged.items, ...merged.params };
}

function normalizeDocumentItems(items, ArgError) {
  const out = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (typeof item === 'string') out.push({ url: item });
    else if (isObject(item)) out.push(item);
    else throw new ArgError('batch spec 的条目需要对象或 url 字符串');
  }
  return out;
}

/** 从 flags 读一个正整数（缺省 undefined；非法抛 ArgError）。 */
function positiveInt(flags, name, ArgError, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (flags[name] === undefined) return undefined;
  const text = String(flags[name]).trim();
  if (!/^\d+$/.test(text)) throw new ArgError('--' + name + ' 需要整数，收到 "' + text + '"');
  const value = Number(text);
  if (value < min || value > max) throw new ArgError('--' + name + ' 需要在 ' + min + '..' + max + ' 之间');
  return value;
}

/**
 * 读取并合并 batch 规格。返回 null 表示"没有提供任何 spec 来源"（由调用方报用法错误）。
 * @param {{file?: string|string[], items?: string, url?: string, onError?: string, concurrency?: string,
 *          retries?: string, max?: string, batchId?: string, group?: string, dryRun?: boolean}} flags
 */
export function loadBatchParams(flags = {}, { ArgError, cwd = process.cwd() } = {}) {
  const sources = [];
  const files = flags.file === undefined ? [] : (Array.isArray(flags.file) ? flags.file : [flags.file]);
  for (const file of files) {
    const target = path.resolve(cwd, String(file));
    let text;
    try {
      text = fs.readFileSync(target, 'utf8');
    } catch (error) {
      throw new ArgError('读取 batch spec 失败：' + target + '（' + ((error && error.message) || error) + '）');
    }
    try {
      sources.push(JSON.parse(text));
    } catch (error) {
      throw new ArgError('batch spec 不是合法 JSON：' + target + '（' + ((error && error.message) || error) + '）');
    }
  }
  if (flags.items !== undefined) sources.push(parseItemsFlag(flags.items, ArgError));
  if (flags.url !== undefined && flags.url !== '') sources.push([{ url: String(flags.url) }]);
  if (!sources.length) return null;
  const params = mergeSpecDocuments(sources, { ArgError });
  if (!params.items.length) throw new ArgError(USAGE + '（spec 里没有条目）');
  if (flags['on-error'] !== undefined) {
    const value = String(flags['on-error']).trim().toLowerCase();
    if (!ON_ERROR.includes(value)) throw new ArgError('--on-error 需要 ' + ON_ERROR.join('|'));
    params.onError = value;
  }
  const concurrency = positiveInt(flags, 'concurrency', ArgError, { min: 1, max: 32 });
  if (concurrency !== undefined) params.concurrency = concurrency;
  const retries = positiveInt(flags, 'retries', ArgError, { min: 0, max: 3 });
  if (retries !== undefined) params.retries = retries;
  const max = positiveInt(flags, 'max', ArgError, { min: 1, max: 100 });
  if (max !== undefined) params.max = max;
  if (flags['batch-id'] !== undefined) params.batchId = String(flags['batch-id']);
  if (flags.group !== undefined) params.group = String(flags.group);
  if (flags['dry-run'] === true) params.dryRun = true;
  return params;
}

/**
 * 构造 `bridge daemon batch` 命令。
 * @param {{callRpc: Function, timeoutOf: Function, outputFailure: Function, outputJsonBody: Function,
 *          emitJson: Function, isJson: () => boolean, print: Function, ArgError: Function}} ctx
 */
export function createBatchCommand(ctx) {
  const { callRpc, timeoutOf, outputFailure, outputJsonBody, emitJson, isJson, print, ArgError } = ctx;
  const errorType = ArgError || Error;

  function batchTimeout(flags) {
    // 批处理可能包含多次 session.start + navigate；给足默认预算（用户可用 --timeout 覆盖更大值）。
    return Math.max(timeoutOf(flags), 60_000);
  }

  /** --strict：按 schema 自检；不通过时输出单行 JSON 失败信封并返回 1。 */
  function strictCheck(schemaId, value) {
    try {
      assertSchema(schemaId, value, { ErrorType: errorType });
      return null;
    } catch (error) {
      const problems = error.problems || [error.message];
      if (isJson()) {
        emitJson({ ok: false, error: { code: error.code || 'E_INTERNAL', message: 'daemon 返回的 JSON 不符合 ' + schemaId, problems } });
      } else {
        process.stderr.write('schema 校验失败（' + schemaId + '）：\n');
        for (const problem of problems) process.stderr.write('  - ' + problem + '\n');
      }
      return 1;
    }
  }

  async function cmdPlan(flags) {
    const params = loadBatchParams(flags, { ArgError: errorType });
    if (!params) throw new errorType(USAGE);
    const body = await callRpc('batch.plan', params, batchTimeout(flags));
    if (!body.ok) return outputFailure(body);
    if (flags.strict === true) {
      const failed = strictCheck('bb.session-batch-plan/1', body.result);
      if (failed !== null) return failed;
    }
    if (isJson()) return outputJsonBody(body);
    print(renderBatchPlan(body.result || {}));
    if (params.onError === 'rollback' || params.onError === 'abort') {
      print('（dry-run 不修改 daemon；实际启动请去掉 --dry-run 或使用 batch start）');
    }
    return EXIT_OK;
  }

  async function cmdStart(flags, pos) {
    const params = loadBatchParams(flags, { ArgError: errorType });
    if (!params) throw new errorType(USAGE);
    // `batch start` 默认真启动；--dry-run 等价 plan（daemon 侧 dryRun 分支）。
    const body = await callRpc('batch.start', params, batchTimeout(flags));
    if (!body.ok) return outputFailure(body);
    const result = body.result || {};
    if (flags.strict === true) {
      const schemaId = result.dryRun === true || result.kind === 'bridge/session-batch-plan'
        ? 'bb.session-batch-plan/1'
        : 'bb.session-batch/1';
      const failed = strictCheck(schemaId, result);
      if (failed !== null) return failed;
    }
    if (isJson()) {
      outputJsonBody(body);
    } else {
      print(result.dryRun === true || result.kind === 'bridge/session-batch-plan'
        ? renderBatchPlan(result)
        : renderBatchReport(result));
    }
    if (result.dryRun === true) return EXIT_OK;
    const code = exitCodeForBatch(result);
    if (!isJson() && code !== EXIT_OK) process.stderr.write('（' + formatExitCode(code) + '；明细见 result.items）\n');
    return code;
  }

  async function cmdStatus(flags, pos) {
    const batchId = pos[3] || flags['batch-id'] || '';
    if (!batchId) return cmdList(flags);
    const body = await callRpc('batch.status', { batchId: String(batchId) }, batchTimeout(flags));
    if (!body.ok) return outputFailure(body);
    if (flags.strict === true) {
      const failed = strictCheck('bb.session-batch/1', body.result);
      if (failed !== null) return failed;
    }
    if (isJson()) return outputJsonBody(body);
    print(renderBatchReport(body.result || {}));
    return EXIT_OK;
  }

  async function cmdList(flags) {
    const state = flags.state === undefined ? null : String(flags.state).trim().toLowerCase();
    if (state !== null && !BATCH_STATES.includes(state)) {
      throw new errorType('--state 需要 ' + BATCH_STATES.join('|'));
    }
    const limit = positiveInt(flags, 'limit', errorType, { min: 1, max: 200 }) ?? 20;
    const body = await callRpc('batch.list', { state, limit }, batchTimeout(flags));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    print(renderBatchList(body.result || {}, { limit }));
    return EXIT_OK;
  }

  async function cmdCancel(flags, pos) {
    const batchId = pos[3] || flags['batch-id'] || '';
    if (!batchId) throw new errorType(USAGE + '（cancel 需要 batchId）');
    const body = await callRpc('batch.cancel', { batchId: String(batchId) }, batchTimeout(flags));
    if (!body.ok) return outputFailure(body);
    const result = body.result || {};
    if (isJson()) return outputJsonBody(body);
    if (result.cancelled === true) {
      print('已取消批次 ' + result.batchId + '（取消条目 ' + (result.cancelledItems ?? 0) + '）');
      return EXIT_OK;
    }
    print('批次 ' + (result.batchId || batchId) + ' 已结束（state=' + (result.state || '?') + '），无需取消');
    return EXIT_OK;
  }

  async function cmdQuota(flags) {
    const limit = positiveInt(flags, 'limit', errorType, { min: 1, max: 500 }) ?? 50;
    const body = await callRpc('batch.quota', { limit }, batchTimeout(flags));
    if (!body.ok) return outputFailure(body);
    if (flags.strict === true) {
      const failed = strictCheck('bb.session-quota/1', body.result);
      if (failed !== null) return failed;
    }
    if (isJson()) return outputJsonBody(body);
    print(renderQuota(body.result || {}));
    return EXIT_OK;
  }

  async function cmdSchema(flags, pos) {
    const schemaId = pos[3];
    if (schemaId) {
      const described = describeSchema(String(schemaId));
      if (!described) throw new errorType('未知 schema id：' + schemaId + '（可用：' + listSchemas().map((item) => item.id).join(', ') + '）');
      if (isJson()) return outputJsonBody({ ok: true, result: described });
      print(JSON.stringify(described, null, 2));
      return EXIT_OK;
    }
    const result = { schemas: listSchemas(), table: schemaTable() };
    if (isJson()) return outputJsonBody({ ok: true, result });
    print('登记的 JSON schema（cli/lib/json-schema.mjs）：');
    for (const row of result.table) {
      print('  ' + row.id.padEnd(26) + '  ' + row.title);
      if (row.required) print('    required: ' + row.required);
    }
    return EXIT_OK;
  }

  return async function cmdBatch(flags, pos) {
    const action = pos[2] || 'list';
    switch (action) {
    case 'plan': return cmdPlan(flags);
    case 'start': return cmdStart(flags, pos);
    case 'status': return cmdStatus(flags, pos);
    case 'list': return cmdList(flags);
    case 'cancel': return cmdCancel(flags, pos);
    case 'quota': return cmdQuota(flags);
    case 'schema': return cmdSchema(flags, pos);
    default: throw new errorType('未知 batch 子命令：' + action + '\n' + USAGE);
    }
  };
}

/** 供 selftest/单测直接使用的用法文本与常量。 */
export const BATCH_USAGE = USAGE;
export const BATCH_ACTIONS = Object.freeze(['plan', 'start', 'status', 'list', 'cancel', 'quota', 'schema']);
export const BATCH_EXIT_DOC = Object.freeze({ ok: 0, failed: 1, usage: 2, partial: 3, quota: 4, cancelled: 5 });
export { EXIT_ERROR, EXIT_USAGE };
