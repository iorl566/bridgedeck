// lib/har-replay.mjs —— HAR → 可重放请求：抽出 method/url/headers/body，并给出重放计划注解。
//
// 顺序/并发/幂等三件事由 lib/har-plan.mjs 计算：
//   * 默认：保持 HAR 顺序，逐条可重放（CLI `network replay-har` 单条/--all 都走这里）；
//   * options.idempotent=true：只保留幂等请求（GET/HEAD/OPTIONS/TRACE）并按 method+url+body
//     去重，非幂等请求作为 skip 证据返回（`options.honorPlan` 时从结果里剔除）；
//   * options.order='time' 时按 HAR 时间戳排序，concurrency 只写进计划元数据（执行由调用方决定）。
//
// 消费点：cli/commands/network.mjs `network replay-har`、mcp browser_network_replay_har。
import { normalizeHar, toHeadersArray } from './har-normalize.mjs';
import {
  buildHarReplayPlan,
  executeHarReplayPlan,
  normalizeReplayEntry,
  replayIdOf,
  isIdempotentRequest,
} from './har-plan.mjs';

/**
 * 解析可为空的 replay 条目。
 * 返回数组元素：{index, order, replayId, idempotent, method, url, headers, body, startedAt,
 *               resourceType, skip?}
 */
export function parseHarReplayEntries(har, options = {}) {
  const normalized = normalizeHar(har);
  const candidates = [];
  for (const entry of normalized.log.entries) {
    const request = entry.request || {};
    const url = String(request.url || '');
    if (!url) continue;
    candidates.push({
      index: candidates.length,
      harIndex: candidates.length,
      method: String(request.method || 'GET').toUpperCase(),
      url,
      headers: Object.fromEntries(toHeadersArray(request.headers).map((header) => [header.name, header.value])),
      ...(request.postData && typeof request.postData.text === 'string' ? { body: request.postData.text } : {}),
      resourceType: String(entry._resourceType || ''),
      startedAt: entry._startedAt ?? null,
      requestId: entry._requestId || null,
    });
  }
  const plan = buildHarReplayPlan(candidates, {
    order: options.order || 'har',
    concurrency: options.concurrency || 1,
    idempotent: options.idempotent === true,
    allowNonIdempotent: options.allowNonIdempotent === true,
    maxEntries: options.maxEntries || 0,
  });
  const skipByIndex = new Map(plan.skipped.map((item) => [item.index, item.reason]));
  const entries = candidates.map((candidate) => {
    const normalizedEntry = normalizeReplayEntry(candidate, candidate.index);
    const reason = skipByIndex.has(candidate.index) ? skipByIndex.get(candidate.index) : null;
    return {
      index: candidate.index,
      order: (plan.entries.find((item) => item.index === candidate.index) || {}).order ?? null,
      replayId: normalizedEntry.replayId,
      idempotent: isIdempotentRequest(candidate.method),
      method: candidate.method,
      url: candidate.url,
      headers: candidate.headers,
      ...(candidate.body != null ? { body: candidate.body } : {}),
      startedAt: candidate.startedAt,
      resourceType: candidate.resourceType,
      ...(reason ? { skip: reason } : {}),
    };
  });
  if (options.honorPlan === true) {
    return entries.filter((entry) => !entry.skip);
  }
  return entries;
}

/**
 * 按索引/URL 子串选一条可重放请求。
 * index 命中优先；urlContains 命中第一条 URL 匹配；都没有则取第一条。
 */
export function findHarReplayEntry(entries, { index = null, urlContains = '' } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  if (index != null && Number.isInteger(Number(index))) {
    const found = list.find((entry) => entry.index === Number(index));
    if (found) return found;
  }
  if (urlContains) {
    const needle = String(urlContains);
    const found = list.find((entry) => entry.url.includes(needle));
    if (found) return found;
  }
  return list[0] || null;
}

/** 直接对 HAR 构建重放计划（CLI/daemon 若要做受控并发重放可直接复用）。 */
export function planHarReplay(har, options = {}) {
  const entries = parseHarReplayEntries(har, options);
  return buildHarReplayPlan(entries, options);
}

/** 便捷重放：对 HAR 构建计划并执行（send 由调用方注入，便于离线测试/受控并发）。 */
export async function replayHarPlan(har, send, options = {}) {
  const plan = planHarReplay(har, options);
  return executeHarReplayPlan(plan, send, options);
}

export { buildHarReplayPlan, executeHarReplayPlan, replayIdOf, isIdempotentRequest };
