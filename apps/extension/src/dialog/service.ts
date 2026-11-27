// src/dialog/service.ts —— 原生对话框的“页面事件近似处理”（M-C 第四批）。
//
// 背景：JS 扩展用 chrome.debugger 的 Page.javascriptDialogOpening 真正拦截 confirm/alert/prompt，
// 然后以 dialog.pending + operation 的语义让调用方 accept/dismiss。TS 运行时明确不接 debugger，
// 本文件用**页面主世界钩子**做近似，并把证据标明：
// - click 派发前用 chrome.scripting.executeScript(MAIN) 给 window.confirm/alert/prompt 装一个
//   “只在 Agent 派发窗口内生效”的拦截器：记下 type/message，先返回安全默认值（false/null）；
// - click 派发后读回记录：有对话框 → 该动作以 E_DIALOG_PENDING 返回（带 dialog/operationId），
//   并把原始目标暂存为 pending operation；
// - dialog.accept/dismiss 时给钩子下发“结算计划”（confirm=false / prompt='文本'），**重放一次
//   原目标点击**，让页面处理器拿到期望的返回值（页面最终落在用户可见的结果上），随后
//   operation 标记 completed；
// - 挂起期间的新动作一律 E_DIALOG_PENDING + dispatched:false（不派发）。
//
// 证据字段：method='main-world-hook'、trusted=false、synthetic=true、limitations 写明这不是
// 真正的 CDP 对话框拦截（对话框在页面主世界被替换，而不是浏览器层挂起）。

import { RpcMethodError } from '../rpc/registry.ts';
import type { ContentReply, ContentRequest } from '../content/protocol.ts';
import type { ScriptingApi } from '../scripting/evaluate.ts';

export interface DialogContentTransport {
  request(
    tabId: number,
    request: ContentRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal; frameId?: number },
  ): Promise<ContentReply>;
}

export interface PendingDialog {
  id: number;
  type: 'confirm' | 'alert' | 'prompt' | 'beforeunload';
  message: string;
  tabId: number;
  operationId: string;
  action: 'pending' | 'accepted' | 'dismissed';
  createdAt: number;
  /** 原始点击参数（结算后重放用）。 */
  clickParams: Record<string, unknown>;
}

export interface DialogOperation {
  id: string;
  tabId: number;
  dialogId: number;
  state: 'pending' | 'completed' | 'failed';
  startedAt: number;
  completedAt: number | null;
  dispatched: boolean;
  result: unknown;
}

export const DIALOG_LIMITATIONS: readonly string[] = Object.freeze([
  'no-debugger: 不是 CDP Page.javascriptDialogOpening 拦截；对话框在页面主世界被临时替换',
  'approximation: click 先以安全默认值返回（confirm=false / prompt=null），结算时重放原点击让页面拿到 accept 的值',
  'scope: 只覆盖被 Agent 派发的点击窗口；页面自己弹出的对话框（非 Agent 动作触发）不被拦截',
]);

/** 主世界钩子安装器（必须是自包含函数：chrome.scripting 会序列化注入）。 */
function mainWorldInstallDialogHooks(): { ok: boolean; installed: boolean } {
  const win = window as unknown as Record<string, unknown>;
  if (win.__bbDialogHooksInstalled === true) return { ok: true, installed: false };
  const original = {
    confirm: win.confirm as ((message?: string) => boolean) | undefined,
    alert: win.alert as ((message?: string) => void) | undefined,
    prompt: win.prompt as ((message?: string, defaultValue?: string) => string | null) | undefined,
  };
  win.__bbDialogLog = [];
  win.__bbDialogSeq = 0;
  win.__bbDialogArmed = false;
  win.__bbDialogPlan = null;
  const record = (type: string, message: unknown): void => {
    const seq = Number(win.__bbDialogSeq ?? 0) + 1;
    win.__bbDialogSeq = seq;
    const log = (win.__bbDialogLog as unknown[]) ?? [];
    log.push({ id: seq, type, message: String(message ?? ''), at: Date.now() });
    win.__bbDialogLog = log;
  };
  const plan = (): { settle?: boolean; confirm?: boolean; promptText?: string } | null => {
    const raw = win.__bbDialogPlan;
    return raw && typeof raw === 'object' ? raw as { settle?: boolean; confirm?: boolean; promptText?: string } : null;
  };
  const active = (): boolean => win.__bbDialogArmed === true || plan()?.settle === true;
  win.confirm = function confirm(message?: string): boolean {
    if (!active()) {
      return typeof original.confirm === 'function' ? original.confirm.call(window, message) : false;
    }
    const current = plan();
    if (current?.settle === true) return current.confirm === true;
    record('confirm', message);
    return false;
  };
  win.alert = function alert(message?: string): void {
    if (!active()) {
      if (typeof original.alert === 'function') original.alert.call(window, message);
      return;
    }
    const current = plan();
    if (current?.settle === true) return;
    record('alert', message);
  };
  win.prompt = function prompt(message?: string, defaultValue?: string): string | null {
    if (!active()) {
      return typeof original.prompt === 'function' ? original.prompt.call(window, message, defaultValue) : null;
    }
    const current = plan();
    if (current?.settle === true) return current.promptText == null ? null : String(current.promptText);
    record('prompt', message);
    return null;
  };
  win.__bbDialogHooksInstalled = true;
  return { ok: true, installed: true };
}

function mainWorldArmDialog(armed: boolean): { ok: boolean; armed: boolean } {
  const win = window as unknown as Record<string, unknown>;
  win.__bbDialogArmed = armed === true;
  return { ok: true, armed: win.__bbDialogArmed === true };
}

function mainWorldReadDialogs(): { ok: boolean; dialogs: Array<{ id: number; type: string; message: string; at: number }> } {
  const win = window as unknown as Record<string, unknown>;
  const log = Array.isArray(win.__bbDialogLog) ? win.__bbDialogLog as Array<{ id: number; type: string; message: string; at: number }> : [];
  win.__bbDialogLog = [];
  return { ok: true, dialogs: log };
}

function mainWorldResolveDialog(plan: { settle: boolean; confirm?: boolean; promptText?: string }): { ok: boolean } {
  const win = window as unknown as Record<string, unknown>;
  win.__bbDialogPlan = plan && plan.settle === true ? plan : null;
  win.__bbDialogArmed = false;
  return { ok: true };
}

/** 动作派发器（由 background 注入：通常是 ActionRegistry.dispatch('click', ...)）。 */
export type ClickDispatcher = (tabId: number, params: Record<string, unknown>) => Promise<unknown>;

export interface DialogServiceOptions {
  content: DialogContentTransport;
  scripting?: ScriptingApi | null;
  now?: () => number;
  setTimer?: (handler: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class DialogService {
  private readonly content: DialogContentTransport;
  private readonly scripting: ScriptingApi | null;
  private readonly now: () => number;
  private readonly setTimer: (handler: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly pending = new Map<number, PendingDialog>();
  private readonly dialogsById = new Map<number, PendingDialog>();
  private readonly operations = new Map<string, DialogOperation>();
  private dialogSeq = 0;
  private operationSeq = 0;

  constructor(options: DialogServiceOptions) {
    if (!options || typeof options.content?.request !== 'function') {
      throw new TypeError('DialogService 需要 content transport');
    }
    this.content = options.content;
    this.scripting = options.scripting ?? null;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /** 当前 tab 是否有挂起对话框（诊断/闸门）。 */
  pendingOf(tabId: number): PendingDialog | null {
    return this.pending.get(Number(tabId)) ?? null;
  }

  /** 诊断：全部对话框记录（含已结算）。 */
  list(): PendingDialog[] {
    return [...this.dialogsById.values()];
  }

  operation(id: string): DialogOperation | null {
    return this.operations.get(String(id)) ?? null;
  }

  private async runMainWorld<T>(tabId: number, func: (...args: never[]) => unknown, args: unknown[] = []): Promise<T> {
    if (!this.scripting || typeof this.scripting.scripting.executeScript !== 'function') {
      throw new RpcMethodError('E_EVAL_UNAVAILABLE', '当前运行时没有 chrome.scripting，无法安装对话框页面钩子', { tabId });
    }
    try {
      const results = await this.scripting.scripting.executeScript<T>({
        target: { tabId, frameIds: [0] },
        world: 'MAIN',
        func: func as unknown as (...args: never[]) => unknown,
        args,
      });
      const first = Array.isArray(results) ? results[0] : null;
      if (!first) throw new RpcMethodError('E_DIALOG_HOOK_FAILED', '对话框钩子执行没有返回结果', { tabId });
      if (first.error && first.error.message) {
        throw new RpcMethodError('E_DIALOG_HOOK_FAILED', '对话框钩子执行失败：' + first.error.message, { tabId });
      }
      return first.result as T;
    } catch (error) {
      if (error instanceof RpcMethodError) throw error;
      throw new RpcMethodError('E_DIALOG_HOOK_FAILED', '对话框钩子执行失败：' + (error instanceof Error ? error.message : String(error)), { tabId });
    }
  }

  private ensureInstalled(tabId: number): Promise<void> {
    return this.runMainWorld<{ ok: boolean }>(tabId, mainWorldInstallDialogHooks).then(() => undefined);
  }

  private arm(tabId: number): Promise<void> {
    return this.runMainWorld<{ ok: boolean }>(tabId, mainWorldArmDialog, [true]).then(() => undefined);
  }

  private disarm(tabId: number): Promise<void> {
    return this.runMainWorld<{ ok: boolean }>(tabId, mainWorldArmDialog, [false]).then(() => undefined).catch(() => undefined);
  }

  private async read(tabId: number): Promise<Array<{ id: number; type: string; message: string }>> {
    const outcome = await this.runMainWorld<{ dialogs?: Array<{ id: number; type: string; message: string }> }>(tabId, mainWorldReadDialogs);
    return Array.isArray(outcome?.dialogs) ? outcome.dialogs : [];
  }

  private pendingError(tabId: number, dispatched: boolean): RpcMethodError {
    const dialog = this.pendingOf(tabId);
    const operation = dialog ? this.operations.get(dialog.operationId) : null;
    return new RpcMethodError(
      'E_DIALOG_PENDING',
      '有原生对话框挂起：先 bridge dialog dismiss|accept <id>',
      {
        dispatched,
        dialog: dialog
          ? { id: dialog.id, type: dialog.type, message: dialog.message, action: dialog.action }
          : null,
        operationId: dialog?.operationId ?? operation?.id ?? null,
        limitations: [...DIALOG_LIMITATIONS],
      },
    );
  }

  /**
   * 包装 click：派发前装钩子/查挂起，派发后读对话框记录。
   * 有对话框时抛出 E_DIALOG_PENDING（动作已经派发，所以 dispatched:true）。
   */
  async dispatchClick(tabId: number, params: Record<string, unknown>, dispatch: ClickDispatcher): Promise<unknown> {
    if (this.pendingOf(tabId)) throw this.pendingError(tabId, false);
    let result: unknown;
    let hooksReady = false;
    try {
      await this.ensureInstalled(tabId);
      await this.arm(tabId);
      hooksReady = true;
    } catch {
      // 受限页面（扩展页/内部页）无法注入主世界钩子：降级为普通点击，不让对话框≈能力把动作本身弄挂。
      hooksReady = false;
    }
    try {
      result = await dispatch(tabId, params);
    } finally {
      if (hooksReady) await this.disarm(tabId);
    }
    if (!hooksReady) return result;
    const captured = await this.read(tabId).catch(() => []);
    const first = captured[0];
    if (!first) return result;
    const dialogId = this.dialogSeq + 1;
    this.dialogSeq = dialogId;
    this.operationSeq += 1;
    const operationId = 'op_dlg_' + String(this.operationSeq) + '_' + Math.floor(this.now()).toString(36);
    const dialog: PendingDialog = {
      id: dialogId,
      type: String(first.type) === 'prompt' ? 'prompt' : String(first.type) === 'alert' ? 'alert' : 'confirm',
      message: String(first.message ?? ''),
      tabId,
      operationId,
      action: 'pending',
      createdAt: this.now(),
      clickParams: { ...params },
    };
    this.pending.set(tabId, dialog);
    this.dialogsById.set(dialogId, dialog);
    this.operations.set(operationId, {
      id: operationId,
      tabId,
      dialogId,
      state: 'pending',
      startedAt: this.now(),
      completedAt: null,
      dispatched: true,
      result: null,
    });
    const error = this.pendingError(tabId, true);
    throw error;
  }

  status(): Record<string, unknown> {
    const dialogs = [...this.dialogsById.values()].map((dialog) => ({
      id: dialog.id,
      type: dialog.type,
      message: dialog.message,
      action: dialog.action,
      tabId: dialog.tabId,
      operationId: dialog.operationId,
      at: dialog.createdAt,
    }));
    return {
      ok: true,
      dialogs,
      pending: dialogs.filter((dialog) => dialog.action === 'pending').length,
      method: 'main-world-hook',
      limitations: [...DIALOG_LIMITATIONS],
    };
  }

  private dialogById(rawId: unknown): PendingDialog {
    const id = Number(rawId);
    const dialog = this.dialogsById.get(id);
    if (!dialog) throw new RpcMethodError('E_NOT_FOUND', '对话框不存在：' + String(rawId), { id: rawId ?? null });
    return dialog;
  }

  private async settle(tabId: number, dialog: PendingDialog, action: 'accepted' | 'dismissed', promptText: string, dispatch: ClickDispatcher): Promise<Record<string, unknown>> {
    const plan = dialog.type === 'confirm'
      ? { settle: true, confirm: action === 'accepted' }
      : dialog.type === 'prompt'
        ? { settle: true, promptText: action === 'accepted' ? promptText : undefined }
        : { settle: true };
    await this.runMainWorld<{ ok: boolean }>(tabId, mainWorldResolveDialog, [plan]);
    // 重放原点击：页面处理器这一次会拿到 accept 的返回值，页面到达最终状态。
    let replay: unknown = null;
    let replayError: string | null = null;
    try {
      replay = await dispatch(tabId, dialog.clickParams);
    } catch (error) {
      replayError = error instanceof Error ? error.message : String(error);
      if (error instanceof RpcMethodError && error.code === 'E_DIALOG_PENDING') replayError = 'nested-dialog-pending';
    } finally {
      await this.runMainWorld<{ ok: boolean }>(tabId, mainWorldResolveDialog, [{ settle: false }]).catch(() => undefined);
      await this.disarm(tabId);
    }
    dialog.action = action;
    this.pending.delete(tabId);
    const operation = this.operations.get(dialog.operationId);
    if (operation) {
      operation.state = 'completed';
      operation.completedAt = this.now();
      operation.result = replay;
    }
    return {
      ok: true,
      id: dialog.id,
      action,
      operationId: dialog.operationId,
      via: 'main-world-hook+replay',
      trusted: false,
      synthetic: true,
      replay: replayError === null ? { ok: true } : { ok: false, reason: replayError },
      limitations: [...DIALOG_LIMITATIONS],
    };
  }

  async dismiss(rawParams: unknown, dispatch: ClickDispatcher): Promise<Record<string, unknown>> {
    const params = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>;
    const dialog = this.dialogById(params.id);
    return this.settle(dialog.tabId, dialog, 'dismissed', '', dispatch);
  }

  async accept(rawParams: unknown, dispatch: ClickDispatcher): Promise<Record<string, unknown>> {
    const params = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>;
    const dialog = this.dialogById(params.id);
    const text = typeof params.text === 'string' ? params.text : '';
    return this.settle(dialog.tabId, dialog, 'accepted', text, dispatch);
  }

  /** operation.await：对话框结算是同步完成的，这里返回 completed（未完成则按 timeout 轮询）。 */
  async awaitOperation(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>;
    const id = String(params.id ?? '');
    if (!id) throw new RpcMethodError('E_BAD_ARG', 'operation await 需要 <id>');
    const timeoutRaw = Number(params.timeoutMs);
    const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.min(Math.floor(timeoutRaw), 120_000) : 10_000;
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const operation = this.operations.get(id);
      if (!operation) throw new RpcMethodError('E_NOT_FOUND', 'operation 不存在：' + id, { id });
      if (operation.state === 'completed' || operation.state === 'failed') {
        return {
          ok: true,
          id,
          state: operation.state,
          dispatched: operation.dispatched,
          startedAt: operation.startedAt,
          completedAt: operation.completedAt,
          durationMs: operation.completedAt === null ? null : operation.completedAt - operation.startedAt,
          result: operation.result,
        };
      }
      if (this.now() >= deadline) {
        throw new RpcMethodError('E_TIMEOUT', 'operation await 超时：' + id, { id, timeoutMs, state: operation.state });
      }
      await new Promise<void>((resolve) => this.setTimer(() => resolve(), 50));
    }
  }

  /** operation.cancel：把挂起的对话框操作标记失败并清掉挂起状态。 */
  cancelOperation(rawParams: unknown): Record<string, unknown> {
    const params = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>;
    const id = String(params.id ?? '');
    const operation = this.operations.get(id);
    if (!operation) return { ok: true, cancelled: false, id };
    operation.state = 'failed';
    operation.completedAt = this.now();
    const dialog = this.dialogsById.get(operation.dialogId);
    if (dialog) dialog.action = 'dismissed';
    this.pending.delete(operation.tabId);
    return { ok: true, cancelled: true, id, state: operation.state };
  }

  clearTab(tabId: number): void {
    const dialog = this.pending.get(Number(tabId));
    if (dialog) {
      dialog.action = 'dismissed';
      const operation = this.operations.get(dialog.operationId);
      if (operation && operation.state === 'pending') {
        operation.state = 'failed';
        operation.completedAt = this.now();
      }
      this.pending.delete(Number(tabId));
    }
  }
}

export { mainWorldInstallDialogHooks, mainWorldReadDialogs, mainWorldResolveDialog };
/** 单测用的钩子源码形状断言（确认注入体是自包含函数）。 */
export const DIALOG_HOOK_SOURCE = mainWorldInstallDialogHooks.toString();
export function __internalClearTimer(handle: unknown): void {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}
