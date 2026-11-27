// src/runtime/tab-state.ts —— per-tab 策略与 tab alias 的持久化（M-C 第三批）。
//
// 为什么放在扩展侧：daemon 的 routePolicy 只处理会话级 scope（session.readOnly /
// allowedOrigins 写在会话记录里），而 `tab.policy <tabId> --read-only` 是**按标签页**的
// 覆盖，语义上属于扩展的 tab 控制面（协议目录 owner=extension）。本文件把两份状态
// （alias / policy）落在 chrome.storage.local，SW 被回收后仍然有效。
//
// 授权点是“动作派发前”而不是“失败后回滚”：只读 tab 上不会真的派发点击；
// 导航还会额外检查 allowedOrigins（只允许列出的源，空列表 = 不限制）。

import { RpcMethodError } from '../rpc/registry.ts';

export interface TabPolicyStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface TabPolicy {
  readOnly: boolean;
  keepOpen: boolean;
  allowedOrigins: string[];
  updatedAt: number;
}

export const TAB_POLICY_KEY = 'bb.tabPolicies';
export const TAB_ALIAS_KEY = 'bb.tabAliases';

/** 只读策略下仍然允许的动作（观察/读取/截图/提取等只读面）。 */
const READ_ONLY_ALLOWED: ReadonlySet<string> = new Set([
  'observe', 'read', 'get-html', 'snapshot', 'extract', 'extract.discover', 'extract.table',
  'extract.list', 'screenshot', 'screenshot.read', 'screenshot.release', 'network.list',
  'network.start', 'network.stop', 'network.detail', 'wait-for-element', 'wait-for-navigation',
  'wait-ms', 'operation.await', 'operation.cancel', 'cancel', 'actionable', 'scroll-to',
  'cooperate.sync', 'cooperate.wait', 'cooperate.handback', 'console',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePolicy(raw: unknown, now: number): TabPolicy | null {
  if (!isRecord(raw)) return null;
  const origins = Array.isArray(raw.allowedOrigins)
    ? raw.allowedOrigins.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  return {
    readOnly: raw.readOnly === true,
    keepOpen: raw.keepOpen === true,
    allowedOrigins: origins,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now,
  };
}

/**
 * tab 策略仓库。
 *
 * ```ts
 * const store = new TabPolicyStore(storage.local);
 * await store.patch(7, { readOnly: true });
 * store.authorize(7, 'click'); // {ok:false, code:'E_READ_ONLY', ...}
 * ```
 */
export class TabPolicyStore {
  private readonly storage: TabPolicyStorage | null;
  private readonly now: () => number;
  private loaded = false;
  private policies = new Map<number, TabPolicy>();

  constructor(storage: TabPolicyStorage | null | undefined, now: () => number = Date.now) {
    this.storage = storage ?? null;
    this.now = now;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.storage) return;
    try {
      const stored = await this.storage.get(TAB_POLICY_KEY);
      const bag = stored?.[TAB_POLICY_KEY];
      if (isRecord(bag)) {
        for (const [key, value] of Object.entries(bag)) {
          const tabId = Number(key);
          const policy = normalizePolicy(value, this.now());
          if (Number.isInteger(tabId) && tabId > 0 && policy) this.policies.set(tabId, policy);
        }
      }
    } catch {
      // 存储不可用时退化为进程内记忆
    }
  }

  private persist(): void {
    if (!this.storage) return;
    const bag: Record<string, TabPolicy> = {};
    for (const [tabId, policy] of this.policies) bag[String(tabId)] = policy;
    try {
      void this.storage.set({ [TAB_POLICY_KEY]: bag }).catch(() => undefined);
    } catch {
      // 忽略持久化失败
    }
  }

  async get(tabId: number): Promise<TabPolicy | null> {
    await this.load();
    return this.policies.get(Number(tabId)) ?? null;
  }

  async list(): Promise<Record<string, TabPolicy>> {
    await this.load();
    const out: Record<string, TabPolicy> = {};
    for (const [tabId, policy] of this.policies) out[String(tabId)] = policy;
    return out;
  }

  /** 局部更新；clear=true 时删除该 tab 的策略。 */
  async patch(tabId: number, patch: { readOnly?: unknown; keepOpen?: unknown; allowedOrigins?: unknown; clear?: unknown }): Promise<TabPolicy> {
    await this.load();
    const id = Number(tabId);
    if (!Number.isInteger(id) || id <= 0) throw new RpcMethodError('E_BAD_ARG', 'tab 策略需要正整数 tabId', { tabId });
    if (patch.clear === true) {
      this.policies.delete(id);
      this.persist();
      return { readOnly: false, keepOpen: false, allowedOrigins: [], updatedAt: this.now() };
    }
    const current = this.policies.get(id) ?? { readOnly: false, keepOpen: false, allowedOrigins: [], updatedAt: this.now() };
    const next: TabPolicy = {
      readOnly: patch.readOnly === undefined ? current.readOnly : patch.readOnly === true,
      keepOpen: patch.keepOpen === undefined ? current.keepOpen : patch.keepOpen === true,
      allowedOrigins: patch.allowedOrigins === undefined
        ? current.allowedOrigins
        : String(patch.allowedOrigins ?? '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) => {
            try {
              return new URL(item.includes('://') ? item : 'https://' + item).origin;
            } catch {
              return item;
            }
          }),
      updatedAt: this.now(),
    };
    this.policies.set(id, next);
    this.persist();
    return next;
  }

  /** per-tab 授权：只读 tab 上的变更动作在这里被拒绝（页面收不到命令）。 */
  authorize(tabId: number, method: string): { ok: true } | { ok: false; code: string; message: string; data?: unknown } {
    const policy = this.policies.get(Number(tabId));
    if (!policy || policy.readOnly !== true) return { ok: true };
    if (READ_ONLY_ALLOWED.has(String(method))) return { ok: true };
    return {
      ok: false,
      code: 'E_READ_ONLY',
      message: 'tab ' + String(tabId) + ' 已设置为只读（tab.policy --read-only）：' + String(method) + ' 被拒绝',
      data: { tabId: Number(tabId), method: String(method), reason: 'read-only' },
    };
  }

  /** 导航白名单：策略里列了 allowedOrigins 时，目标源必须在列表内。 */
  async checkNavigation(tabId: number, url: string): Promise<void> {
    await this.load();
    const policy = this.policies.get(Number(tabId));
    if (!policy || policy.allowedOrigins.length === 0) return;
    let origin = '';
    try {
      origin = new URL(String(url)).origin;
    } catch {
      throw new RpcMethodError('E_BAD_ARG', 'navigate 目标 URL 不合法：' + String(url));
    }
    if (!policy.allowedOrigins.includes(origin)) {
      throw new RpcMethodError('E_FORBIDDEN', '目标源不在该 tab 的 allowedOrigins 内：' + origin, {
        tabId: Number(tabId),
        origin,
        allowedOrigins: policy.allowedOrigins,
      });
    }
  }
}

/** 运行时创建过的 tab 与最近活动时间（tab cleanup 的候选集；只清自己建的 tab）。 */
export class TabActivityRegistry {
  private readonly createdAt = new Map<number, number>();
  private readonly lastSeen = new Map<number, number>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  record(tabId: number): void {
    const id = Number(tabId);
    if (!Number.isInteger(id) || id <= 0) return;
    const at = this.now();
    this.createdAt.set(id, at);
    this.lastSeen.set(id, at);
  }

  touch(tabId: number): void {
    const id = Number(tabId);
    if (this.lastSeen.has(id)) this.lastSeen.set(id, this.now());
  }

  drop(tabId: number): void {
    const id = Number(tabId);
    this.createdAt.delete(id);
    this.lastSeen.delete(id);
  }

  list(): Array<{ tabId: number; createdAt: number; lastSeen: number }> {
    const out: Array<{ tabId: number; createdAt: number; lastSeen: number }> = [];
    for (const [tabId, createdAt] of this.createdAt) {
      out.push({ tabId, createdAt, lastSeen: this.lastSeen.get(tabId) ?? createdAt });
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }
}

/** tab alias 仓库（instance 级）：alias → tabId，CLI `--tab-id <alias>` 用它解析。 */
export class TabAliasStore {
  private readonly storage: TabPolicyStorage | null;
  private loaded = false;
  private aliases = new Map<string, number>();

  constructor(storage: TabPolicyStorage | null | undefined) {
    this.storage = storage ?? null;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.storage) return;
    try {
      const stored = await this.storage.get(TAB_ALIAS_KEY);
      const bag = stored?.[TAB_ALIAS_KEY];
      if (isRecord(bag)) {
        for (const [alias, value] of Object.entries(bag)) {
          const tabId = Number(value);
          if (alias && Number.isInteger(tabId) && tabId > 0) this.aliases.set(alias, tabId);
        }
      }
    } catch {
      // 忽略
    }
  }

  private persist(): void {
    if (!this.storage) return;
    const bag: Record<string, number> = {};
    for (const [alias, tabId] of this.aliases) bag[alias] = tabId;
    try {
      void this.storage.set({ [TAB_ALIAS_KEY]: bag }).catch(() => undefined);
    } catch {
      // 忽略
    }
  }

  static isValidAlias(alias: unknown): boolean {
    return typeof alias === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(alias);
  }

  async set(tabId: number, alias: unknown): Promise<{ alias: string; tabId: number }> {
    if (!TabAliasStore.isValidAlias(alias)) {
      throw new RpcMethodError('E_BAD_ARG', 'alias 需要 1–64 位字母/数字/_.-（不能以符号开头）', { alias });
    }
    const id = Number(tabId);
    if (!Number.isInteger(id) || id <= 0) throw new RpcMethodError('E_BAD_ARG', 'tab.alias 需要正整数 tabId', { tabId });
    await this.load();
    // 一个 tab 只保留一个 alias：设置新 alias 时清掉旧映射。
    for (const [existing, value] of this.aliases) {
      if (value === id) this.aliases.delete(existing);
    }
    this.aliases.set(String(alias), id);
    this.persist();
    return { alias: String(alias), tabId: id };
  }

  async clear(alias: unknown): Promise<{ alias: string; removed: boolean }> {
    await this.load();
    const removed = this.aliases.delete(String(alias ?? ''));
    this.persist();
    return { alias: String(alias ?? ''), removed };
  }

  async list(): Promise<Record<string, number>> {
    await this.load();
    const out: Record<string, number> = {};
    for (const [alias, tabId] of this.aliases) out[alias] = tabId;
    return out;
  }

  async resolve(alias: unknown): Promise<number> {
    await this.load();
    const tabId = this.aliases.get(String(alias ?? ''));
    if (!tabId) throw new RpcMethodError('E_NOT_FOUND', '没有这个 tab alias：' + String(alias ?? ''), { alias: String(alias ?? ''), reason: 'alias-not-found' });
    return tabId;
  }
}
