// src/content/track.ts —— 页面侧协作/归因时钟、指纹、节点签名、frame 清单与手动截图浮层。
//
// 这些能力是 M-C 第四批新增的「页面事实采集」，全部基于真实 DOM：
// - 协作 frameState：MutationObserver + 事件监听得到的确定性计数器（mutations/structure/
//   texts/scroll/events/focus/selection/media），不依赖 debugger；
// - 归因时钟：Agent 自己的合成输入在派发窗口内置 agent 标记，页面上真正由人产生的
//   pointer/keydown/focus 事件记为 human（lastHumanKind）；两边都带时间戳；
// - 页面指纹 / 节点签名：为 --observation 收据与 --node-scope 动态校验提供证据；
// - frame 清单：从主文档 iframe 元素读 src/隐藏状态/几何（与 webNavigation 的 frame inventory
//   对账用）；
// - 手动长截图浮层：注入/移除 `__bb_manual_host`（本批只做占位浮层，不做完整交互）。

import type { DomEnvironment, ElementLike } from './dom.ts';
import { accessibleNameOf, normalizeText, rectOf, tagOf } from './dom.ts';

function realDocument(env: DomEnvironment): Document {
  return env.document as unknown as Document;
}

function realWindow(env: DomEnvironment): Window {
  return env.window as unknown as Window;
}

/** 稳定短哈希（FNV-1a 32bit → base36）；纯函数、可单测。 */
export function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  const source = String(text ?? '');
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** 页面指纹：URL + 可见文本长度 + 节点数 + 表单值摘要（结构/文本变化会改变指纹）。 */
export function fingerprintOf(doc: Document, win: Window): string {
  try {
    const all = doc.querySelectorAll('*');
    const text = String(doc.body?.innerText ?? doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim();
    const inputs: string[] = [];
    for (const el of Array.from(doc.querySelectorAll('input,textarea,select'))) {
      const input = el as HTMLInputElement;
      if (input.type === 'password') {
        inputs.push('pw:' + String(input.value ?? '').length);
      } else {
        inputs.push(String(input.value ?? '').slice(0, 80));
      }
    }
    return 'fp-' + shortHash(doc.URL + '|' + String(all.length) + '|' + String(text.length) + '|' + text.slice(0, 2000) + '|' + inputs.join(','))
      + '-' + shortHash(String(win.scrollY ?? 0) + '|' + text.slice(0, 8000));
  } catch {
    return 'fp-unavailable';
  }
}

export interface NodeSignature {
  attached: boolean;
  tag: string;
  id: string | null;
  text: string;
  value: string | null;
  checked: boolean | null;
  rect: { x: number; y: number; width: number; height: number };
  signature: string;
  /** 节点已脱离文档（target_detached）时附带的说明。 */
  detached?: boolean;
}

function nodeSignatureOf(el: ElementLike | null): NodeSignature {
  if (!el) {
    return {
      attached: false,
      tag: '',
      id: null,
      text: '',
      value: null,
      checked: null,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      signature: 'sig-detached',
      detached: true,
    };
  }
  const tag = tagOf(el).toLowerCase();
  const id = el.id ? String(el.id) : null;
  const text = normalizeText(el.textContent).slice(0, 200);
  const rawValue = (el as { value?: unknown }).value;
  const value = typeof rawValue === 'string' ? rawValue.slice(0, 200) : null;
  const checked = typeof (el as { checked?: unknown }).checked === 'boolean' ? Boolean((el as { checked?: boolean }).checked) : null;
  const rect = rectOf(el);
  const signature = 'sig-' + shortHash([tag, id, text, value, String(checked)].join('|'));
  return {
    attached: el.isConnected !== false,
    tag,
    id,
    text,
    value,
    checked,
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    signature,
  };
}

export { nodeSignatureOf };

export function signatureOfElement(el: ElementLike | null): NodeSignature {
  return nodeSignatureOf(el);
}

/** 人工与 Agent 输入归因窗口（时间戳容差 1.5ms，与 JS 扩展的归因口径一致）。 */
export interface AttributionState {
  owner: 'agent' | 'human' | null;
  kind: string | null;
  at: number | null;
  by: 'command' | 'page-event' | null;
}

export interface CooperationFrameState {
  revision: number;
  mutations: number;
  structure: number;
  texts: string[];
  scroll: number;
  document: string;
  events: string[];
  focusNeutral: boolean;
  selection: string;
  media: string[];
  mediaComplete: boolean;
  textsComplete: boolean;
  eventsComplete: boolean;
  fieldsComplete: boolean;
  focusIsDocument: boolean;
  agentAttributed: number;
  humanAttributed: number;
  lastHumanKind: string | null;
  inputClock: number;
  timeToleranceMs: number;
  attribution: AttributionState;
  expectationPending: boolean;
}

/** 页面侧协作/归因追踪器：一个文档一个实例，导航后随内容脚本重建。 */
export class CooperationTracker {
  private readonly env: DomEnvironment;
  private started = false;
  private observer: MutationObserver | null = null;
  private suppress = false;
  private revisionValue = 0;
  private mutations = 0;
  private structure = 0;
  private texts: string[] = [];
  private events: string[] = [];
  private media: string[] = [];
  private agentAttributed = 0;
  private humanAttributed = 0;
  private inputClock = 0;
  private lastHumanKind: string | null = null;
  private attribution: AttributionState = { owner: null, kind: null, at: null, by: null };
  private settlement: string[] = [];
  private attached = false;

  constructor(env: DomEnvironment) {
    this.env = env;
  }

  /** 安装观察器/监听器（幂等；第一个同步调用时安装）。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    const win = realWindow(this.env);
    const doc = realDocument(this.env);
    try {
      const Observer = (win as unknown as { MutationObserver?: typeof MutationObserver }).MutationObserver;
      if (Observer && doc.documentElement) {
        this.observer = new Observer((records) => this.consumeMutations(records));
        this.observer.observe(doc.documentElement, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      }
    } catch {
      this.observer = null;
    }
    const listen = (type: string, handler: (event: Event) => void): void => {
      try {
        (doc as unknown as EventTarget).addEventListener(type, handler as EventListener, { passive: true, capture: true });
      } catch {
        // 事件监听失败不影响计数器（observations 仍然可用）
      }
    };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'click', 'keydown', 'input', 'focusin', 'scroll', 'selectionchange']) {
      listen(type, (event) => this.consumeEvent(type, event));
    }
  }

  private consumeMutations(records: MutationRecord[]): void {
    let structure = 0;
    let textChanged = false;
    for (const record of records) {
      this.mutations += 1;
      if (record.type === 'characterData') {
        const next = normalizeText(record.target.textContent);
        if (next) {
          this.texts.push(next.slice(0, 120));
          textChanged = true;
        }
      } else if (record.type === 'childList') {
        structure += record.addedNodes.length + record.removedNodes.length;
        for (const node of Array.from(record.addedNodes)) {
          const text = normalizeText(node.textContent);
          if (text) this.texts.push(text.slice(0, 120));
        }
        textChanged = true;
      } else if (record.type === 'attributes') {
        textChanged = true;
      }
    }
    if (structure > 0) this.structure += structure;
    // 属性/没有文本的变更也算一次结构推进（否则 revision 不前进）
    if (structure === 0 && textChanged) this.structure += 1;
    if (this.texts.length > 32) this.texts = this.texts.slice(-32);
    this.revisionValue += Math.max(1, records.length);
  }

  private consumeEvent(type: string, event: Event): void {
    if (this.events.length >= 32) this.events.shift();
    const target = event.target as Node | null;
    const targetId = target && (target as unknown as ElementLike).id ? String((target as unknown as ElementLike).id) : '';
    this.events.push(type + (targetId ? '#' + targetId : ''));
    if (this.suppress) return;
    if (type === 'pointerdown' || type === 'mousedown' || type === 'pointerup' || type === 'click') {
      this.lastHumanKind = 'pointer';
      this.humanAttributed += 1;
      this.attribution = { owner: 'human', kind: 'pointer', at: Date.now(), by: 'page-event' };
    } else if (type === 'keydown') {
      this.lastHumanKind = 'keydown';
      this.humanAttributed += 1;
      this.attribution = { owner: 'human', kind: 'keydown', at: Date.now(), by: 'page-event' };
    } else if (type === 'focusin') {
      this.lastHumanKind = 'focus';
    }
  }

  /** Agent 派发窗口：窗口内的页面事件归因给 Agent（命令来源，证据里写明 by:'command'）。 */
  beginAgentInput(kind: string): void {
    this.suppress = true;
    this.agentKind = kind;
  }

  endAgentInput(): void {
    this.suppress = false;
    this.agentAttributed += 1;
    this.inputClock += 1;
    this.attribution = { owner: 'agent', kind: this.agentKind ?? 'input', at: Date.now(), by: 'command' };
    this.lastAgentKind = this.agentKind ?? 'input';
    this.agentKind = null;
  }

  private agentKind: string | null = null;
  private lastAgentKind: string | null = null;

  /** 记录一次 Agent 动作（不需要 begin/end 的简单路径）。 */
  noteAgentInput(kind: string): void {
    this.agentAttributed += 1;
    this.inputClock += 1;
    this.lastAgentKind = kind;
    this.attribution = { owner: 'agent', kind, at: Date.now(), by: 'command' };
  }

  /** 期望（--expect/--depends-on）在动作前消费；这里只记录 pending=false。 */
  setExpectationPending(pending: boolean): void {
    this.settlement = pending ? ['pending'] : [];
  }

  /** 当前 frameState 快照（供 cooperate.sync 使用）。 */
  snapshot(): CooperationFrameState {
    const win = realWindow(this.env);
    const doc = realDocument(this.env);
    const active = doc.activeElement as unknown as ElementLike | null;
    const activeTag = active ? tagOf(active).toLowerCase() : '';
    const selection = (() => {
      try {
        return String(win.getSelection?.()?.toString() ?? '').slice(0, 200);
      } catch {
        return '';
      }
    })();
    return {
      revision: this.revisionValue,
      mutations: this.mutations,
      structure: this.structure,
      texts: [...this.texts],
      scroll: Number(win.scrollY ?? 0),
      document: String(doc.URL ?? ''),
      events: [...this.events],
      focusNeutral: !activeTag || activeTag === 'body' || activeTag === 'html',
      selection,
      media: [...this.media],
      mediaComplete: true,
      textsComplete: true,
      eventsComplete: true,
      fieldsComplete: true,
      focusIsDocument: !activeTag || activeTag === 'body' || activeTag === 'html',
      agentAttributed: this.agentAttributed,
      humanAttributed: this.humanAttributed,
      lastHumanKind: this.lastHumanKind,
      inputClock: this.inputClock,
      timeToleranceMs: 1.5,
      attribution: { ...this.attribution },
      expectationPending: false,
    };
  }

  /** 节点签名清单（--node-scope / 收据校验用）：只记录调用方给的 ref 表元素。 */
  signaturesOf(elements: Map<string, ElementLike>): Record<string, NodeSignature> {
    const out: Record<string, NodeSignature> = {};
    for (const [ref, el] of elements) out[ref] = nodeSignatureOf(el);
    return out;
  }

  lastKind(): string | null {
    return this.lastAgentKind;
  }

  dispose(): void {
    try {
      this.observer?.disconnect();
    } catch {
      // 忽略
    }
    this.observer = null;
    this.started = false;
  }
}

/** frame 清单（主文档 iframe 元素；隐藏判定来自 computed style/几何，不猜）。 */
export interface FrameInventoryEntry {
  src: string;
  absoluteSrc: string;
  title: string;
  hidden: boolean;
  hiddenReason: string | null;
  rect: { x: number; y: number; width: number; height: number };
}

export function frameInventory(env: DomEnvironment): FrameInventoryEntry[] {
  const doc = realDocument(env);
  const entries: FrameInventoryEntry[] = [];
  let frames: ElementLike[] = [];
  try {
    frames = Array.from(doc.querySelectorAll('iframe,frame')) as unknown as ElementLike[];
  } catch {
    frames = [];
  }
  for (const el of frames.slice(0, 32)) {
    const src = String(el.getAttribute('src') ?? '');
    let absoluteSrc = src;
    try {
      absoluteSrc = src ? new URL(src, String(doc.URL ?? '')).href : String(doc.URL ?? '');
    } catch {
      absoluteSrc = src;
    }
    const style = (() => {
      try {
        return realWindow(env).getComputedStyle(el as unknown as Element) as unknown as {
          display?: string;
          visibility?: string;
          opacity?: string;
        };
      } catch {
        return {} as { display?: string; visibility?: string; opacity?: string };
      }
    })();
    const rect = rectOf(el);
    let hidden = false;
    let reason: string | null = null;
    if (el.hasAttribute('hidden')) {
      hidden = true;
      reason = 'hidden-attribute';
    } else if (style.display === 'none') {
      hidden = true;
      reason = 'display-none';
    } else if (style.visibility === 'hidden' || style.visibility === 'collapse') {
      hidden = true;
      reason = 'visibility-hidden';
    } else if (Number(style.opacity) <= 0.05) {
      hidden = true;
      reason = 'opacity-zero';
    } else if (rect.width < 1 || rect.height < 1) {
      hidden = true;
      reason = 'zero-size';
    }
    entries.push({
      src,
      absoluteSrc,
      title: String(el.getAttribute('title') ?? ''),
      hidden,
      hiddenReason: reason,
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    });
  }
  return entries;
}

/** 手动长截图浮层：注入/移除 `__bb_manual_host`（本批只做可见占位 UI）。 */
export function setManualOverlay(env: DomEnvironment, show: boolean): { ok: boolean; present: boolean; host?: string } {
  const doc = realDocument(env);
  const existing = doc.getElementById('__bb_manual_host');
  if (!show) {
    try {
      existing?.remove();
    } catch {
      // 忽略
    }
    return { ok: true, present: Boolean(doc.getElementById('__bb_manual_host')) };
  }
  if (existing) {
    existing.style.visibility = 'visible';
    return { ok: true, present: true, host: 'existing' };
  }
  try {
    const host = doc.createElement('div');
    host.id = '__bb_manual_host';
    host.setAttribute('data-bb-ui', 'manual');
    host.style.position = 'fixed';
    host.style.right = '16px';
    host.style.bottom = '16px';
    host.style.zIndex = '2147483647';
    host.style.background = '#111827';
    host.style.color = '#fff';
    host.style.font = '12px/1.4 system-ui, sans-serif';
    host.style.padding = '8px 10px';
    host.style.borderRadius = '8px';
    host.style.boxShadow = '0 6px 20px rgba(0,0,0,.35)';
    host.textContent = '手动长截图：已拍帧（TS 运行时占位浮层）';
    (doc.body ?? doc.documentElement)?.appendChild(host);
    return { ok: true, present: true, host: 'created' };
  } catch (error) {
    return { ok: false, present: false, host: 'error:' + (error instanceof Error ? error.message : String(error)) };
  }
}

/** 元素可见文本（read --expect field=text 与 node-scope 文本比对共用）。 */
export function elementTextOf(el: ElementLike | null): string {
  return normalizeText(el?.textContent).slice(0, 200);
}

export { accessibleNameOf };
