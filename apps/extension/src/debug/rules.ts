// src/debug/rules.ts —— debug 规则面：block 走 DNR，fulfill/modify 走 CDP Fetch。
//
// 能力边界（M-C 第六批 wave 2 更新）：
// - `block`/`abort` 优先用 chrome.declarativeNetRequest 的 session rules 生效（E2E 20o 已验证）；
// - `fulfill`/`modify` 通过注入的 `FetchController`（CDP Fetch 域）真正拦截：fulfill 伪造响应，
//   modify 改写 URL/方法/头/正文；没有 Fetch 通道时如实登记 `applied:false`，不假装拦截成功；
// - 规则列表/导出/导入/启用/停用/删除都是真实状态迁移；任何规则变更都同步 Fetch 域的启停；
// - 规则是扩展级（跨 tab）登记，Fetch 按 tab 启用：RPC 调用会带 tabId，`add(rule, tabId)` 负责同步。

import { RpcMethodError } from '../rpc/registry.ts';
import type { FetchController, FetchRuleSpec } from '../network/fetch.ts';

export interface DnrRuleApi {
  getSessionRules?(): Promise<Array<Record<string, unknown>>>;
  updateSessionRules(options: { removeRuleIds?: number[]; addRules?: Array<Record<string, unknown>> }): Promise<void>;
}

export interface RuleRecord {
  id: number;
  action: string;
  urlPattern: string;
  enabled: boolean;
  hits: number;
  body: string | null;
  status: number;
  headers: Record<string, string> | null;
  url: string | null;
  method: string | null;
  applied: boolean;
  dnrRuleId: number | null;
  createdAt: number;
  note?: string;
}

export interface RuleServiceOptions {
  rules?: DnrRuleApi | null;
  /** CDP Fetch 通道（fulfill/modify 的真正拦截面）；缺省时只登记。 */
  fetch?: FetchController | null;
  now?: () => number;
}

const SUPPORTED_ACTIONS: readonly string[] = Object.freeze(['block', 'fulfill', 'modify', 'redirect', 'abort']);

let dnrSeq = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveIntOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeHeaders(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const headers: Record<string, string> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!name) continue;
    headers[name] = String(raw);
  }
  return Object.keys(headers).length ? headers : null;
}

export class RuleService {
  private readonly rules: DnrRuleApi | null;
  private fetchValue: FetchController | null;
  private readonly now: () => number;
  private readonly records = new Map<number, RuleRecord>();
  private seq = 0;

  constructor(options: RuleServiceOptions = {}) {
    this.rules = options.rules ?? null;
    this.fetchValue = options.fetch ?? null;
    this.now = options.now ?? Date.now;
  }

  /** 晚绑定 Fetch 通道（集成时先建 RuleService，再建 FetchController 并挂上）。 */
  attachFetch(fetch: FetchController | null): void {
    this.fetchValue = fetch;
    this.refreshApplied();
  }

  private get fetch(): FetchController | null {
    return this.fetchValue;
  }

  private requireDnr(): DnrRuleApi {
    if (!this.rules || typeof this.rules.updateSessionRules !== 'function') {
      throw new RpcMethodError('E_NOT_IMPLEMENTED', '当前运行时没有 chrome.declarativeNetRequest.updateSessionRules，无法下发 block 规则', {
        method: 'debug.rule_add',
        limitation: 'needs declarativeNetRequest permission/API',
      });
    }
    return this.rules;
  }

  private dnrShape(record: RuleRecord): Record<string, unknown> {
    return {
      id: record.dnrRuleId ?? ++dnrSeq,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter: record.urlPattern },
    };
  }

  private publicRecord(record: RuleRecord): Record<string, unknown> {
    return {
      id: record.id,
      action: record.action,
      urlPattern: record.urlPattern,
      status: record.enabled ? 'active' : 'disabled',
      enabled: record.enabled,
      hits: record.hits,
      applied: record.applied,
      ...(record.body !== null ? { body: record.body } : {}),
      ...(record.headers !== null ? { headers: record.headers } : {}),
      ...(record.url !== null ? { url: record.url } : {}),
      ...(record.method !== null ? { method: record.method } : {}),
      ...(record.note ? { note: record.note } : {}),
      createdAt: record.createdAt,
    };
  }

  private recordsArray(): RuleRecord[] {
    return [...this.records.values()].sort((a, b) => a.id - b.id);
  }

  /** Fetch 域消费的规则快照（只含 enabled 的 fulfill/modify/block/abort）。 */
  rulesForFetch(): FetchRuleSpec[] {
    return this.recordsArray()
      .filter((record) => record.enabled)
      .map((record) => ({
        id: record.id,
        action: record.action,
        urlPattern: record.urlPattern,
        enabled: record.enabled,
        status: record.status,
        ...(record.headers ? { headers: record.headers } : {}),
        ...(record.body !== null ? { body: record.body } : {}),
        ...(record.url !== null ? { url: record.url } : {}),
        ...(record.method !== null ? { method: record.method } : {}),
      }));
  }

  /** 命中计数回写（FetchController.onHit）。 */
  recordHit(ruleId: number | string): void {
    const record = this.records.get(Number(ruleId));
    if (record) record.hits += 1;
  }

  /** 是否需要 Fetch 介入（fulfill/modify）。 */
  private needsFetch(): boolean {
    return this.recordsArray().some((record) => record.enabled && (record.action === 'fulfill' || record.action === 'modify'));
  }

  /** 同步 Fetch 域的启停（按 tab）。没有 tabId 时返回 false（无法挂通道）。 */
  private async syncFetch(tabId: unknown): Promise<boolean> {
    if (!this.fetch) return false;
    const id = positiveIntOrNull(tabId);
    if (id === null) return false;
    try {
      const enabled = await this.fetch.sync(id, { feature: 'debug-rules' });
      return enabled;
    } catch {
      return false;
    }
  }

  /** 规则状态迁移后刷新 applied 说明（block 看 DNR 下发；fulfill/modify 由 syncFetch 结果决定 applied）。 */
  private refreshApplied(): void {
    for (const record of this.records.values()) {
      if (record.action === 'block' || record.action === 'abort') {
        record.applied = record.dnrRuleId !== null;
      } else if (record.action === 'fulfill' || record.action === 'modify') {
        if (this.fetch) {
          delete record.note;
        } else {
          record.applied = false;
          record.note = '当前运行时没有 chrome.debugger/Fetch 域；fulfill/modify 只登记，不改变网络响应';
        }
      }
    }
  }

  async list(): Promise<Record<string, unknown>> {
    this.refreshApplied();
    const local = this.recordsArray().map((record) => this.publicRecord(record));
    // DNR session rules 里可能有外部写入的规则：一并列出（只读投影，不静默丢）。
    let external: Array<Record<string, unknown>> = [];
    if (this.rules && typeof this.rules.getSessionRules === 'function') {
      const known = new Set(this.recordsArray().map((record) => record.dnrRuleId));
      try {
        const session = await this.rules.getSessionRules();
        external = (Array.isArray(session) ? session : [])
          .filter((rule) => !known.has(Number(rule.id)))
          .map((rule) => ({
            id: 'dnr:' + String(rule.id ?? ''),
            action: isRecord(rule.action) ? String(rule.action.type ?? 'unknown') : 'unknown',
            urlPattern: isRecord(rule.condition) ? String(rule.condition.urlFilter ?? '') : '',
            status: 'active',
            enabled: true,
            hits: 0,
            applied: true,
            source: 'session',
          }));
      } catch {
        external = [];
      }
    }
    return {
      ok: true,
      rules: [...local, ...external],
      readonly: false,
      blockVia: 'declarativeNetRequest',
      fulfillVia: this.fetch ? 'cdp-fetch' : null,
      fulfillSupported: Boolean(this.fetch),
      note: this.fetch
        ? 'block 规则通过 DNR session rules 生效；fulfill/modify 通过 CDP Fetch 真正拦截'
        : 'block 规则通过 DNR session rules 生效；fulfill/modify 需要 CDP Fetch（当前通道不可用，只登记 applied:false）',
    };
  }

  async add(rawRule: unknown, rawTabId?: unknown): Promise<Record<string, unknown>> {
    if (!isRecord(rawRule)) throw new RpcMethodError('E_BAD_ARG', 'debug rule_add 需要 --rule <json object>');
    const action = typeof rawRule['action'] === 'string' ? String(rawRule['action']) : 'block';
    const urlPattern = typeof rawRule['urlPattern'] === 'string'
      ? String(rawRule['urlPattern'])
      : (typeof rawRule['url'] === 'string' ? String(rawRule['url']) : '');
    if (!urlPattern) throw new RpcMethodError('E_BAD_ARG', '规则需要 urlPattern', { rule: rawRule });
    if (!SUPPORTED_ACTIONS.includes(action)) {
      throw new RpcMethodError('E_BAD_ARG', '不支持的规则 action：' + action, { action });
    }
    const statusRaw = Number(rawRule['status']);
    const status = Number.isFinite(statusRaw) && statusRaw > 0 ? Math.floor(statusRaw) : 200;
    const url = typeof rawRule['url'] === 'string' && rawRule['url'] ? String(rawRule['url']) : null;
    const method = typeof rawRule['method'] === 'string' && rawRule['method'] ? String(rawRule['method']).toUpperCase() : null;
    const headers = normalizeHeaders(rawRule['headers']);
    this.seq += 1;
    const record: RuleRecord = {
      id: this.seq,
      action,
      urlPattern,
      enabled: true,
      hits: 0,
      body: typeof rawRule['body'] === 'string' ? String(rawRule['body']) : null,
      status,
      headers,
      url,
      method,
      applied: false,
      dnrRuleId: null,
      createdAt: this.now(),
    };
    if (action === 'block' || action === 'abort') {
      const dnr = this.requireDnr();
      record.dnrRuleId = ++dnrSeq;
      await dnr.updateSessionRules({ addRules: [this.dnrShape(record)] });
      record.applied = true;
    } else {
      record.note = this.fetch
        ? undefined
        : 'fulfill/modify 需要 CDP Fetch 域；当前通道不可用，只登记规则，不改变网络响应';
    }
    this.records.set(record.id, record);
    this.refreshApplied();
    const fetchSynced = await this.syncFetch(rawTabId);
    if ((action === 'fulfill' || action === 'modify') && this.fetch) record.applied = fetchSynced;
    const listed = await this.list();
    return { ...listed, added: this.publicRecord(record) };
  }

  private requireRecord(rawId: unknown): RuleRecord {
    const id = Number(rawId);
    const record = this.records.get(id);
    if (!record) throw new RpcMethodError('E_NOT_FOUND', '规则不存在：' + String(rawId), { id: rawId ?? null });
    return record;
  }

  async setEnabled(rawId: unknown, enabled: boolean, rawTabId?: unknown): Promise<Record<string, unknown>> {
    const record = this.requireRecord(rawId);
    if (record.dnrRuleId !== null) {
      const dnr = this.requireDnr();
      if (enabled) {
        await dnr.updateSessionRules({ addRules: [this.dnrShape(record)] });
      } else {
        await dnr.updateSessionRules({ removeRuleIds: [record.dnrRuleId] });
      }
    }
    record.enabled = enabled;
    this.refreshApplied();
    const fetchSynced = await this.syncFetch(rawTabId);
    if ((record.action === 'fulfill' || record.action === 'modify') && this.fetch) {
      record.applied = enabled ? fetchSynced : false;
    }
    const listed = await this.list();
    return { ...listed, id: record.id, enabled: record.enabled };
  }

  async remove(rawId: unknown, rawTabId?: unknown): Promise<Record<string, unknown>> {
    const record = this.requireRecord(rawId);
    if (record.dnrRuleId !== null) {
      const dnr = this.requireDnr();
      await dnr.updateSessionRules({ removeRuleIds: [record.dnrRuleId] });
    }
    this.records.delete(record.id);
    await this.syncFetch(rawTabId);
    const listed = await this.list();
    return { ...listed, removed: record.id };
  }

  async clear(rawTabId?: unknown): Promise<Record<string, unknown>> {
    const ids = this.recordsArray()
      .map((record) => record.dnrRuleId)
      .filter((id): id is number => typeof id === 'number');
    if (ids.length && this.rules && typeof this.rules.updateSessionRules === 'function') {
      await this.rules.updateSessionRules({ removeRuleIds: ids });
    }
    const cleared = this.records.size;
    this.records.clear();
    // 清空后 Fetch 必须立刻关闭：否则页面请求会一直等 continue。
    if (this.fetch) {
      const id = positiveIntOrNull(rawTabId);
      if (id !== null) {
        await this.fetch.disable(id).catch(() => false);
      } else {
        // 没有 tabId（旧调用方）：把所有启用中的 tab 一并关掉，避免残留拦截。
        await Promise.all(this.fetch.enabledTabs().map((tabId) => this.fetch?.disable(tabId).catch(() => false)));
      }
    }
    const listed = await this.list();
    return { ...listed, cleared };
  }

  async exportRules(): Promise<Record<string, unknown>> {
    return {
      ok: true,
      version: 1,
      rules: this.recordsArray().map((record) => ({
        id: record.id,
        action: record.action,
        urlPattern: record.urlPattern,
        enabled: record.enabled,
        hits: record.hits,
        ...(record.body !== null ? { body: record.body } : {}),
        ...(record.status !== 200 ? { status: record.status } : {}),
        ...(record.headers !== null ? { headers: record.headers } : {}),
        ...(record.url !== null ? { url: record.url } : {}),
        ...(record.method !== null ? { method: record.method } : {}),
        applied: record.applied,
      })),
      exportedAt: this.now(),
      note: 'block 规则由 DNR 生效；fulfill/modify 由 CDP Fetch 生效（无通道时 applied:false）',
    };
  }

  async importRules(rawRules: unknown, rawTabId?: unknown): Promise<Record<string, unknown>> {
    const list = Array.isArray(rawRules) ? rawRules : (isRecord(rawRules) && Array.isArray(rawRules['rules']) ? rawRules['rules'] : null);
    if (!list) throw new RpcMethodError('E_BAD_ARG', 'rule_import 需要 rules 数组');
    let imported = 0;
    const errors: Array<{ rule: unknown; error: string }> = [];
    for (const rule of list.slice(0, 200)) {
      try {
        await this.add(rule, rawTabId);
        imported += 1;
      } catch (error) {
        errors.push({ rule, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const listed = await this.list();
    return {
      ok: true,
      imported,
      errors,
      rules: listed.rules,
      note: '导入后 block 规则立即由 DNR 生效；fulfill/modify 由 CDP Fetch 生效',
    };
  }

  /** 诊断：Fetch requestPaused 派发统计（20w `debug.fetch_probe`）。 */
  async probe(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = isRecord(rawParams) ? rawParams : {};
    const tabId = positiveIntOrNull(params['tabId']);
    if (tabId === null) throw new RpcMethodError('E_BAD_ARG', 'debug fetch_probe 需要正整数 tabId', { tabId: params['tabId'] ?? null });
    if (!this.fetch) {
      throw new RpcMethodError('E_NOT_IMPLEMENTED', '当前运行时没有 chrome.debugger（无法启用 CDP Fetch 诊断）', {
        method: 'debug.fetch_probe',
        limitation: 'needs chrome.debugger permission',
      });
    }
    return this.fetch.probe(tabId, { ms: Number(params['ms']) || 1500 });
  }

  /** tab 关闭/会话回收。 */
  async forgetTab(rawTabId: unknown): Promise<void> {
    const tabId = positiveIntOrNull(rawTabId);
    if (tabId !== null && this.fetch) await this.fetch.forgetTab(tabId).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    await this.fetch?.dispose().catch(() => undefined);
  }
}

/** 便捷工厂。 */
export function createRuleService(options: RuleServiceOptions = {}): RuleService {
  return new RuleService(options);
}
