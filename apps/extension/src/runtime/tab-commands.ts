// src/runtime/tab-commands.ts —— tab 控制面（alias / policy / cleanup）的扩展实现。
//
// 为什么这些在扩展而不是 daemon：协议目录里 tab.alias 是 instance owner、tab.policy 是
// session owner，CLI 直接把 RPC 发给扩展。daemon 只负责路由与审计，不知道某个 tab 的
// 只读/白名单策略，也不知道 alias 映射；这两份状态必须和“动作派发点”在同一个进程里，
// 才能在派发前拦下动作（E_READ_ONLY）与导航（E_FORBIDDEN）。
//
// 持久化：chrome.storage.local（SW 回收后仍在）。tab cleanup 只清理**本运行时创建过**的
// tab（TabActivityRegistry），避免误关用户的标签页。

import { RpcMethodError } from '../rpc/registry.ts';
import type { BrowserApiLike } from './commands.ts';
import type { CommandHandler, RegisteredCommand } from './router.ts';
import { TabActivityRegistry, TabAliasStore, TabPolicyStore } from './tab-state.ts';

export interface TabCommandsDeps {
  api: BrowserApiLike;
  policies: TabPolicyStore;
  aliases: TabAliasStore;
  activity?: TabActivityRegistry;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveInt(params: Record<string, unknown>, key: string): number {
  const value = Number(params[key]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new RpcMethodError('E_BAD_ARG', key + ' 必须是正整数', { [key]: params[key] ?? null });
  }
  return value;
}

/**
 * 创建 tab.alias / tab.policy / tab.cleanup 三个命令。
 *
 * 这些命令都是 serialized:false：它们不操作页面 DOM，排进 tab 队列反而会拖慢动作面。
 */
export function createTabCommands(deps: TabCommandsDeps): RegisteredCommand[] {
  const api = deps.api;
  const now = deps.now ?? Date.now;
  const activity = deps.activity ?? new TabActivityRegistry(now);
  const commands: RegisteredCommand[] = [];

  function add(method: string, handler: CommandHandler, description: string, timeoutMs?: number): void {
    commands.push({
      method,
      handler,
      serialized: false,
      timeoutMs: Number(timeoutMs) > 0 ? Math.floor(Number(timeoutMs)) : null,
      description,
    });
  }

  add('tab.alias', async (context) => {
    const params = context.params;
    const action = typeof params.action === 'string' ? params.action : 'list';
    if (action === 'list') {
      return { ok: true, aliases: await deps.aliases.list() };
    }
    if (action === 'resolve') {
      const tabId = await deps.aliases.resolve(params.alias);
      // 校验 tab 还在（alias 可能残留旧 id）：不在时回 E_NO_TAB，而不是让后面动作莫名失败。
      try {
        await api.tabs.get(tabId);
      } catch {
        throw new RpcMethodError('E_NO_TAB', 'alias ' + String(params.alias) + ' 指向的 tab ' + String(tabId) + ' 已关闭', {
          alias: String(params.alias),
          tabId,
        });
      }
      return { ok: true, alias: String(params.alias), tabId };
    }
    if (action === 'clear') {
      const result = await deps.aliases.clear(params.alias);
      return { ok: true, ...result };
    }
    if (action === 'set') {
      const tabId = positiveInt(params, 'tabId');
      try {
        await api.tabs.get(tabId);
      } catch {
        throw new RpcMethodError('E_NO_TAB', 'tabId ' + String(tabId) + ' 不存在或已关闭', { tabId });
      }
      const result = await deps.aliases.set(tabId, params.alias);
      return { ok: true, ...result };
    }
    throw new RpcMethodError('E_BAD_ARG', 'tab.alias 的 action 只支持 set|clear|list|resolve', { action });
  }, '设置/清除/列出/解析 tab 别名（instance 级，持久化到 storage.local）');

  add('tab.policy', async (context) => {
    const params = context.params;
    const tabId = positiveInt(params, 'tabId');
    try {
      await api.tabs.get(tabId);
    } catch {
      throw new RpcMethodError('E_NO_TAB', 'tabId ' + String(tabId) + ' 不存在或已关闭', { tabId });
    }
    const clear = params.clear === true;
    if (!clear && params.readOnly === undefined && params.keepOpen === undefined && params.allowedOrigins === undefined) {
      const current = await deps.policies.get(tabId);
      return {
        ok: true,
        tabId,
        policy: current ?? { readOnly: false, keepOpen: false, allowedOrigins: [], updatedAt: now() },
        applied: [],
      };
    }
    const policy = await deps.policies.patch(tabId, {
      readOnly: params.readOnly,
      keepOpen: params.keepOpen,
      allowedOrigins: params.allowedOrigins,
      clear,
    });
    return { ok: true, tabId, policy, applied: clear ? ['clear'] : ['readOnly', 'keepOpen', 'allowedOrigins'].filter((key) => params[key] !== undefined) };
  }, '设置 per-tab 策略（readOnly / keepOpen / allowedOrigins）；策略在动作派发前强制');

  add('tab.cleanup', async (context) => {
    const params = context.params;
    const idleMsRaw = Number(params.idleMs);
    const idleMs = Number.isFinite(idleMsRaw) && idleMsRaw >= 0 ? Math.floor(idleMsRaw) : 600_000;
    const dryRun = params.dryRun !== false;
    const candidates = activity.list();
    const close: Array<{ tabId: number; reason: string }> = [];
    const keep: Array<{ tabId: number; reason: string }> = [];
    const scanned = candidates.length;
    for (const item of candidates) {
      const policy = await deps.policies.get(item.tabId);
      let tabActive = false;
      try {
        const tab = await api.tabs.get(item.tabId);
        tabActive = tab.active === true;
      } catch {
        // tab 已经关闭：直接从候选集移除
        activity.drop(item.tabId);
        continue;
      }
      if (policy?.keepOpen === true) {
        keep.push({ tabId: item.tabId, reason: 'keep-open' });
        continue;
      }
      if (tabActive) {
        keep.push({ tabId: item.tabId, reason: 'active-tab' });
        continue;
      }
      if (idleMs > 0 && now() - item.lastSeen < idleMs) {
        keep.push({ tabId: item.tabId, reason: 'recently-used' });
        continue;
      }
      close.push({ tabId: item.tabId, reason: idleMs <= 0 ? 'idle' : 'idle-timeout' });
    }
    const closed: number[] = [];
    if (!dryRun) {
      for (const item of close) {
        try {
          await api.tabs.remove(item.tabId);
          activity.drop(item.tabId);
          closed.push(item.tabId);
        } catch {
          // tab 可能在清理期间被用户关掉
        }
      }
    }
    return {
      ok: true,
      dryRun,
      idleMs,
      scanned,
      close: close.map((item) => item.tabId),
      keep,
      closed,
    };
  }, '清理本运行时创建的空闲 tab（默认 dry-run；keepOpen 与 active tab 不关）', 15_000);

  return commands;
}
