// src/scripting/input.ts —— CDP Input 域：可信鼠标/键盘/文本输入原语（20z、7、7b 的底座）。
//
// 为什么需要：`content-script` 合成的 click 是 isTrusted=false，反爬靶场（antibot.html）
// 会明确拒绝；可信输入必须走 CDP `Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText`。
//
// 本模块只提供「坐标/按键 → 事件序列」的原语，不解析 selector/ref：
// 目标解析与动作语义在 actions 层（Integration 由 lead/defects-ui 接线，见报告 §E）。
//
// 关键细节：
// - 鼠标事件带 `timestamp`（TimeSinceEpoch 秒），单调递增，避免浏览器按旧时间戳丢事件；
// - click = mouseMoved（到点）→ mousePressed → mouseReleased；hover 只发 mouseMoved 序列；
// - 后台派发时开 `Emulation.setFocusEmulationEnabled(true)`，完成后按 tab 的 armed 状态决定是否关闭；
// - `clickBackendNode` 用 `DOM.resolveNode + scrollIntoView + getBoundingClientRect` 拿坐标，
//   返回 `via:'cdp-backend'`（7/7b 的断言）。

import type { CdpChannel } from '../debug/cdp-channel.ts';

export interface TrustedPoint {
  x: number;
  y: number;
}

export interface InputServiceOptions {
  client: CdpChannel;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface TabInputState {
  focusEmulation: boolean;
}

/** 修饰键位（与 CDP Input.dispatchKeyEvent.modifiers 一致）。 */
export const MODIFIERS = Object.freeze({ alt: 1, ctrl: 2, meta: 4, shift: 8 });

interface KeyInfo {
  key: string;
  code: string;
  vk: number;
  text?: string;
  shift?: boolean;
}

const NAMED_KEYS: Readonly<Record<string, KeyInfo>> = Object.freeze({
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Esc: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
});

const PUNCTUATION: Readonly<Record<string, [string, number, boolean?]>> = Object.freeze({
  '`': ['Backquote', 192], '~': ['Backquote', 192, true],
  '-': ['Minus', 189], '_': ['Minus', 189, true],
  '=': ['Equal', 187], '+': ['Equal', 187, true],
  '[': ['BracketLeft', 219], '{': ['BracketLeft', 219, true],
  ']': ['BracketRight', 221], '}': ['BracketRight', 221, true],
  '\\': ['Backslash', 220], '|': ['Backslash', 220, true],
  ';': ['Semicolon', 186], ':': ['Semicolon', 186, true],
  "'": ['Quote', 222], '"': ['Quote', 222, true],
  ',': ['Comma', 188], '<': ['Comma', 188, true],
  '.': ['Period', 190], '>': ['Period', 190, true],
  '/': ['Slash', 191], '?': ['Slash', 191, true],
});

/**
 * 解析按键表达（"Enter" / "ctrl+a" / "/" / "a"）。
 * 返回 CDP 需要的 key/code/vk/text 与 modifier 位。
 */
export function parseKeySpec(spec: unknown): KeyInfo & { modifiers: number } {
  const parts = String(spec ?? '').split('+').map((item) => item.trim()).filter(Boolean);
  if (!parts.length) throw Object.assign(new Error('press 需要 key'), { code: 'E_BAD_ARG' });
  const keyName = parts.pop() ?? '';
  let modifiers = 0;
  for (const part of parts) {
    const token = part.toLowerCase();
    if (token === 'ctrl' || token === 'control') modifiers |= MODIFIERS.ctrl;
    else if (token === 'alt' || token === 'option') modifiers |= MODIFIERS.alt;
    else if (token === 'shift') modifiers |= MODIFIERS.shift;
    else if (token === 'meta' || token === 'cmd' || token === 'win') modifiers |= MODIFIERS.meta;
  }
  const named = NAMED_KEYS[keyName]
    ?? NAMED_KEYS[keyName.charAt(0).toUpperCase() + keyName.slice(1)];
  if (named) return { ...named, modifiers };
  if (keyName.length === 1) {
    const char = keyName;
    const upper = char.toUpperCase();
    const isDigit = /[0-9]/.test(char);
    const punctuation = PUNCTUATION[char];
    if (punctuation) {
      const [code, vk, shift] = punctuation;
      return {
        key: char,
        code,
        vk,
        ...(shift ? { shift: true } : { text: char }),
        modifiers: shift ? modifiers | MODIFIERS.shift : modifiers,
      };
    }
    return {
      key: char,
      code: isDigit ? 'Digit' + char : (/[a-zA-Z]/.test(char) ? 'Key' + upper : ''),
      vk: isDigit ? char.charCodeAt(0) : (upper.charCodeAt(0) || 0),
      text: char,
      modifiers,
    };
  }
  throw Object.assign(new Error('不支持的按键：' + String(spec)), { code: 'E_BAD_ARG' });
}

/** 计算从 start 到 end 的 N 段轨迹（含终点），用于可信 mousemove。 */
export function movePath(start: TrustedPoint | null, end: TrustedPoint, steps: number): TrustedPoint[] {
  const count = Math.max(1, Math.min(64, Math.floor(Number(steps) || 1)));
  const from = start ?? { x: end.x - 40, y: end.y - 24 };
  const path: TrustedPoint[] = [];
  for (let index = 1; index <= count; index += 1) {
    const ratio = index / count;
    path.push({
      x: Math.round((from.x + (end.x - from.x) * ratio) * 100) / 100,
      y: Math.round((from.y + (end.y - from.y) * ratio) * 100) / 100,
    });
  }
  return path;
}

/**
 * 可信输入服务。
 *
 * ```ts
 * const input = new InputService({ client });
 * const result = await input.clickPoint(tabId, { x: 100, y: 200 }, { human: true });
 * await input.pressKey(tabId, 'Enter');
 * await input.insertText(tabId, 'hello');
 * ```
 */
export class InputService {
  private readonly client: CdpChannel;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly tabs = new Map<number, TabInputState>();
  private readonly lastPoints = new Map<number, TrustedPoint>();
  private lastTimestamp = 0;

  constructor(options: InputServiceOptions) {
    if (!options || !options.client) throw new TypeError('InputService 需要 CdpChannel');
    this.client = options.client;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, ms));
      (timer as unknown as { unref?: () => void }).unref?.();
    }));
  }

  /** 单调递增的 CDP 事件时间戳（秒）。 */
  private stamp(): number {
    const now = this.now() / 1000;
    this.lastTimestamp = Math.max(now, this.lastTimestamp + 0.001);
    return this.lastTimestamp;
  }

  private async ensureFocusEmulation(tabId: number): Promise<void> {
    const id = Number(tabId);
    let state = this.tabs.get(id);
    if (!state) {
      state = { focusEmulation: false };
      this.tabs.set(id, state);
    }
    if (state.focusEmulation) return;
    await this.client.send(id, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
    state.focusEmulation = true;
  }

  /** 显式关闭焦点仿真（armed/需要真实焦点语义时不要调用）。 */
  async releaseFocusEmulation(tabId: number): Promise<void> {
    const id = Number(tabId);
    const state = this.tabs.get(id);
    if (!state || !state.focusEmulation) return;
    state.focusEmulation = false;
    await this.client.send(id, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => undefined);
  }

  /** 可信悬停：若干 mouseMoved（默认 5 段，至少 3 次 mousemove 才能过 antibot 挑战）。 */
  async hoverPoint(
    tabId: number,
    point: TrustedPoint,
    options: { steps?: number; human?: boolean; durationMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    const id = Number(tabId);
    await this.client.acquire(id, 'input-trusted');
    try {
      await this.ensureFocusEmulation(id);
      const steps = Math.max(options.human === true ? 5 : 1, Math.min(24, Math.floor(options.steps ?? (options.human === true ? 5 : 1))));
      const path = movePath(this.lastPoints.get(id) ?? null, point, steps);
      const delay = options.durationMs !== undefined && options.durationMs > 0 ? Math.min(60, Math.floor(options.durationMs / steps)) : 0;
      for (const step of path) {
        await this.client.send(id, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: step.x,
          y: step.y,
          button: 'none',
          buttons: 0,
          clickCount: 0,
          timestamp: this.stamp(),
        });
        if (delay > 0) await this.sleep(delay);
      }
      this.lastPoints.set(id, { x: point.x, y: point.y });
      return { ok: true, trusted: true, x: point.x, y: point.y, moves: path.length, via: 'cdp-input' };
    } finally {
      this.client.release(id, 'input-trusted');
    }
  }

  /** 可信点击：move（可多段）→ pressed → released；失败时补发 released，避免卡住鼠标状态。 */
  async clickPoint(
    tabId: number,
    point: TrustedPoint,
    options: { human?: boolean; steps?: number; modifiers?: number } = {},
  ): Promise<Record<string, unknown>> {
    const id = Number(tabId);
    await this.client.acquire(id, 'input-trusted');
    try {
      await this.ensureFocusEmulation(id);
      const steps = Math.max(options.human === true ? 5 : 1, Math.min(24, Math.floor(options.steps ?? (options.human === true ? 5 : 1))));
      const path = movePath(this.lastPoints.get(id) ?? null, point, steps);
      for (const step of path) {
        await this.client.send(id, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: step.x,
          y: step.y,
          button: 'none',
          buttons: 0,
          clickCount: 0,
          modifiers: options.modifiers ?? 0,
          timestamp: this.stamp(),
        });
      }
      const downStamp = this.stamp();
      let pressed = false;
      try {
        await this.client.send(id, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: point.x,
          y: point.y,
          button: 'left',
          buttons: 1,
          clickCount: 1,
          modifiers: options.modifiers ?? 0,
          timestamp: downStamp,
        });
        pressed = true;
        await this.client.send(id, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: point.x,
          y: point.y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
          modifiers: options.modifiers ?? 0,
          timestamp: this.stamp(),
        });
        pressed = false;
      } finally {
        if (pressed) {
          await this.client.send(id, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: point.x,
            y: point.y,
            button: 'left',
            buttons: 0,
            clickCount: 1,
            timestamp: this.stamp(),
          }).catch(() => undefined);
        }
      }
      this.lastPoints.set(id, { x: point.x, y: point.y });
      return { ok: true, trusted: true, x: point.x, y: point.y, moves: path.length, via: 'cdp-input' };
    } finally {
      this.client.release(id, 'input-trusted');
    }
  }

  /** 可信拖拽：mouseMoved → pressed → 多段 moved → released。 */
  async dragPath(
    tabId: number,
    from: TrustedPoint,
    to: TrustedPoint,
    options: { steps?: number; modifiers?: number } = {},
  ): Promise<Record<string, unknown>> {
    const id = Number(tabId);
    await this.client.acquire(id, 'input-trusted');
    try {
      await this.ensureFocusEmulation(id);
      const modifiers = options.modifiers ?? 0;
      const steps = Math.max(2, Math.min(32, Math.floor(options.steps ?? 8)));
      await this.client.send(id, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0, clickCount: 0, modifiers, timestamp: this.stamp(),
      });
      await this.client.send(id, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1, modifiers, timestamp: this.stamp(),
      });
      let released = false;
      try {
        for (const step of movePath(from, to, steps)) {
          await this.client.send(id, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: step.x, y: step.y, button: 'left', buttons: 1, modifiers, timestamp: this.stamp(),
          });
        }
        await this.client.send(id, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, modifiers, timestamp: this.stamp(),
        });
        released = true;
      } finally {
        if (!released) {
          await this.client.send(id, 'Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1, modifiers, timestamp: this.stamp(),
          }).catch(() => undefined);
        }
      }
      this.lastPoints.set(id, { x: to.x, y: to.y });
      return { ok: true, trusted: true, from, to, steps, via: 'cdp-input' };
    } finally {
      this.client.release(id, 'input-trusted');
    }
  }

  /** 可信按键（keyDown + keyUp；带 text 的按键会真正插入字符）。 */
  async pressKey(tabId: number, spec: unknown): Promise<Record<string, unknown>> {
    const id = Number(tabId);
    const info = parseKeySpec(spec);
    await this.client.acquire(id, 'input-trusted');
    try {
      await this.ensureFocusEmulation(id);
      const base = {
        modifiers: info.modifiers,
        key: info.key,
        code: info.code,
        windowsVirtualKeyCode: info.vk,
        nativeVirtualKeyCode: info.vk,
      };
      const withText = info.text !== undefined && (info.modifiers & (MODIFIERS.ctrl | MODIFIERS.meta)) === 0;
      await this.client.send(id, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        ...base,
        ...(withText ? { text: info.text } : {}),
        timestamp: this.stamp(),
      });
      await this.client.send(id, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        ...base,
        timestamp: this.stamp(),
      });
      return { ok: true, trusted: true, key: info.key, code: info.code, via: 'cdp-input' };
    } finally {
      this.client.release(id, 'input-trusted');
    }
  }

  /** 可信文本输入（Input.insertText：产生 isTrusted 的 input 事件）。 */
  async insertText(tabId: number, text: string): Promise<Record<string, unknown>> {
    const id = Number(tabId);
    await this.client.acquire(id, 'input-trusted');
    try {
      await this.ensureFocusEmulation(id);
      await this.client.send(id, 'Input.insertText', { text: String(text ?? '') });
      return { ok: true, trusted: true, length: String(text ?? '').length, via: 'cdp-input' };
    } finally {
      this.client.release(id, 'input-trusted');
    }
  }

  /** 全选（Ctrl+A）：替换输入框内容前的标准动作。 */
  async selectAll(tabId: number): Promise<void> {
    const id = Number(tabId);
    await this.client.acquire(id, 'input-trusted');
    try {
      await this.ensureFocusEmulation(id);
      await this.client.send(id, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        modifiers: MODIFIERS.ctrl,
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
        timestamp: this.stamp(),
      });
      await this.client.send(id, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        modifiers: MODIFIERS.ctrl,
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
        timestamp: this.stamp(),
      });
    } finally {
      this.client.release(id, 'input-trusted');
    }
  }

  /** 按 backendNodeId 可信点击（7/7b：via='cdp-backend'）。 */
  async clickBackendNode(
    tabId: number,
    backendNodeId: number,
    options: { human?: boolean; modifiers?: number } = {},
  ): Promise<Record<string, unknown>> {
    const id = Number(tabId);
    const backendId = Number(backendNodeId);
    if (!Number.isInteger(backendId) || backendId <= 0) {
      throw Object.assign(new Error('clickBackendNode 需要正整数 backendNodeId'), { code: 'E_BAD_ARG' });
    }
    await this.client.acquire(id, 'input-trusted');
    try {
      const resolved = await this.client.send<Record<string, unknown>>(id, 'DOM.resolveNode', { backendNodeId: backendId });
      const objectId = String((resolved['object'] as Record<string, unknown> | undefined)?.['objectId'] ?? '');
      if (!objectId) throw Object.assign(new Error('backendNodeId 无法解析为对象'), { code: 'E_STALE_REF' });
      try {
        const boxed = await this.client.send<Record<string, unknown>>(id, 'Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function(){ this.scrollIntoView({ block: "center", inline: "center" }); const r = this.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: String(this.tagName || "").toLowerCase() }; }',
          returnByValue: true,
        });
        const value = ((boxed['result'] as Record<string, unknown> | undefined)?.['value'] ?? {}) as Record<string, unknown>;
        const x = Number(value['x']);
        const y = Number(value['y']);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw Object.assign(new Error('元素没有可点击坐标'), { code: 'E_NOT_ACTIONABLE' });
        await this.ensureFocusEmulation(id);
        const steps = options.human === true ? 5 : 1;
        for (const step of movePath(this.lastPoints.get(id) ?? null, { x, y }, steps)) {
          await this.client.send(id, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved', x: step.x, y: step.y, button: 'none', buttons: 0, clickCount: 0, modifiers: options.modifiers ?? 0, timestamp: this.stamp(),
          });
        }
        await this.client.send(id, 'Input.dispatchMouseEvent', {
          type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, modifiers: options.modifiers ?? 0, timestamp: this.stamp(),
        });
        await this.client.send(id, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, modifiers: options.modifiers ?? 0, timestamp: this.stamp(),
        });
        this.lastPoints.set(id, { x, y });
        return { ok: true, trusted: true, via: 'cdp-backend', backendNodeId: backendId, x, y, tag: String(value['tag'] ?? '') };
      } finally {
        await this.client.send(id, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
      }
    } finally {
      this.client.release(id, 'input-trusted');
    }
  }

  /** tab 关闭/会话回收：关闭焦点仿真并清理轨迹缓存。 */
  async forgetTab(tabId: number): Promise<void> {
    const id = Number(tabId);
    this.lastPoints.delete(id);
    await this.releaseFocusEmulation(id);
    this.tabs.delete(id);
  }
}

/** 便捷工厂。 */
export function createInputService(options: InputServiceOptions): InputService {
  return new InputService(options);
}
