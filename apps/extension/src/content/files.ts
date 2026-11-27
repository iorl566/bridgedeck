// src/content/files.ts —— upload 的页面侧实现（DataTransfer + File，无 chrome.debugger）。
//
// 为什么可行：daemon 的 upload 路由会把文件字节以内联 base64（≤8MB）或 transfer staging
// 形式送到扩展；扩展把字节分块转发给内容脚本，页面里用 `new File([bytes], name)` 构造真实
// File 对象，再通过 DataTransfer 写进 `input.files`（或 drop 事件）。
//
// 明确的边界：
// - 9MB 以上只走 daemon staging 的文件没有内联字节，且本运行时没有 chrome.debugger
//   （DOM.setFileInputFiles 需要它），无法读取本机路径 —— 这种情况返回 E_NOT_IMPLEMENTED
//   并带 data.reason='no-file-bytes'，不伪造成功；
// - `via` 如实标注：input（直接写 input.files）/ hidden-input（目标不是 input 时回退到
//   页面上隐藏的 file input，并派发 change）/ drop（DataTransfer drop 事件）；
// - 所有事件都是合成事件：trusted:false / synthetic:true。

import type { ElementLike, DomEnvironment } from './dom.ts';
import { normalizeText, tagOf } from './dom.ts';

export interface UploadFileSpec {
  name: string;
  mime: string;
  size: number;
}

export interface StagedUpload {
  id: string;
  files: Array<UploadFileSpec & { chunks: string[]; received: number }>;
  mode: 'input' | 'drop';
  targetSelector: string | null;
  targetRef: string | null;
}

/** 校验文件规格（非法文件名/大小回结构化错误，不静默跳过）。 */
export function validateUploadFiles(raw: unknown): UploadFileSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw Object.assign(new Error('upload 需要至少一个 files 条目'), { code: 'E_BAD_ARG' });
  }
  return raw.slice(0, 8).map((item) => {
    const bag = (item ?? {}) as Record<string, unknown>;
    const name = typeof bag.name === 'string' ? bag.name.trim() : '';
    if (!name) throw Object.assign(new Error('upload files[].name 不能为空'), { code: 'E_BAD_ARG' });
    const size = Number(bag.size);
    if (!Number.isInteger(size) || size < 0) {
      throw Object.assign(new Error('upload files[].size 必须是 ≥0 的整数'), { code: 'E_BAD_ARG', data: { name, size: bag.size } });
    }
    return { name, mime: typeof bag.mime === 'string' ? bag.mime : 'application/octet-stream', size };
  });
}

/** base64 → Uint8Array（不依赖 atob 之外的库；畸形 base64 回 E_BAD_ARG）。 */
export function base64ToBytes(base64: unknown): Uint8Array {
  const text = String(base64 ?? '');
  if (!text) return new Uint8Array(0);
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    throw Object.assign(new Error('base64 不是合法编码'), { code: 'E_BAD_ARG' });
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export interface BuiltUploadFile {
  name: string;
  mime: string;
  size: number;
  bytes: Uint8Array;
}

/** 把分块 base64 拼成 File 字节（顺序由 index 决定；缺块回 E_TRANSFER_INCOMPLETE）。 */
export function assembleFileBatches(staged: StagedUpload): BuiltUploadFile[] {
  const out: BuiltUploadFile[] = [];
  for (const file of staged.files) {
    if (file.received !== file.size) {
      throw Object.assign(new Error('文件字节不完整（' + file.received + '/' + file.size + '）：' + file.name), {
        code: 'E_TRANSFER_INCOMPLETE',
        data: { name: file.name, received: file.received, expected: file.size },
      });
    }
    const pieces = file.chunks.map((chunk) => base64ToBytes(chunk));
    const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const piece of pieces) {
      bytes.set(piece, offset);
      offset += piece.length;
    }
    out.push({ name: file.name, mime: file.mime, size: bytes.length, bytes });
  }
  return out;
}

function fileOf(doc: Document, file: BuiltUploadFile): File {
  const buffer = file.bytes.slice().buffer;
  return new File([buffer], file.name, { type: file.mime || 'application/octet-stream' });
}

function dispatch(doc: Document, el: ElementLike, event: Event): void {
  try {
    (el as unknown as Element).dispatchEvent(event);
  } catch {
    // 页面事件处理器抛错不影响写入结果
  }
  void doc;
}

/** 找隐藏 file input（目标不是 input 时的回退；只选页面上确实存在的）。 */
export function findFileInputs(doc: Document): HTMLInputElement[] {
  try {
    return Array.from(doc.querySelectorAll('input[type="file"]')) as HTMLInputElement[];
  } catch {
    return [];
  }
}

export function isHiddenInput(el: ElementLike): boolean {
  if (el.hasAttribute('hidden')) return true;
  const view = (() => {
    try {
      return (el as unknown as Element).ownerDocument?.defaultView ?? null;
    } catch {
      return null;
    }
  })();
  const style = (() => {
    try {
      return (view?.getComputedStyle(el as unknown as Element) ?? null) as CSSStyleDeclaration | null;
    } catch {
      return null;
    }
  })();
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return true;
  const rect = (() => {
    try {
      return el.getBoundingClientRect();
    } catch {
      return { width: 0, height: 0 };
    }
  })();
  return Math.abs(rect.width) < 1 || Math.abs(rect.height) < 1;
}

function setInputFiles(doc: Document, input: HTMLInputElement, files: File[]): void {
  const DataTransferCtor = (doc.defaultView as unknown as { DataTransfer?: typeof DataTransfer } | null)?.DataTransfer;
  if (!DataTransferCtor) throw Object.assign(new Error('页面环境没有 DataTransfer'), { code: 'E_EVAL_UNAVAILABLE' });
  const dt = new DataTransferCtor();
  for (const file of files) dt.items.add(file);
  input.files = dt.files;
  dispatch(doc, input as unknown as ElementLike, new Event('input', { bubbles: true }));
  dispatch(doc, input as unknown as ElementLike, new Event('change', { bubbles: true }));
}

function dropFiles(doc: Document, target: ElementLike, files: File[]): void {
  const view = doc.defaultView as unknown as {
    DataTransfer?: typeof DataTransfer;
    DragEvent?: typeof DragEvent;
  } | null;
  const DataTransferCtor = view?.DataTransfer;
  if (!DataTransferCtor) throw Object.assign(new Error('页面环境没有 DataTransfer'), { code: 'E_EVAL_UNAVAILABLE' });
  const dt = new DataTransferCtor();
  for (const file of files) dt.items.add(file);
  const make = (type: string): Event => {
    const DragEventCtor = view?.DragEvent;
    if (DragEventCtor) {
      try {
        return new DragEventCtor(type, { bubbles: true, cancelable: true, dataTransfer: dt });
      } catch {
        // 退化到普通 Event + dataTransfer 属性
      }
    }
    const event = new Event(type, { bubbles: true, cancelable: true });
    try {
      Object.defineProperty(event, 'dataTransfer', { value: dt, configurable: true });
    } catch {
      // 忽略
    }
    return event;
  };
  for (const type of ['dragenter', 'dragover', 'drop']) dispatch(doc, target, make(type));
}

export interface ApplyUploadOptions {
  env: DomEnvironment;
  target: ElementLike | null;
  files: BuiltUploadFile[];
  mode: 'input' | 'drop';
  selector: string | null;
  ref: string | null;
}

/**
 * 把文件写进页面并返回证据。
 *
 * - mode='drop'：在目标元素上派发 dragenter/dragover/drop；
 * - 目标是 input[type=file]：直接写 files + input/change；
 * - 其它目标（按钮等）：回退到页面上隐藏的 file input（找不到就明确 E_NOT_IMPLEMENTED）。
 */
export function applyUpload(options: ApplyUploadOptions): {
  via: 'input' | 'hidden-input' | 'drop';
  names: string[];
  files: Array<{ name: string; size: number; mime: string }>;
  tag: string | null;
  selector: string | null;
  note: string;
} {
  const doc = options.env.document as unknown as Document;
  const wanted = options.files.map((file) => fileOf(doc, file));
  const names = options.files.map((file) => file.name);
  const detail = options.files.map((file) => ({ name: file.name, size: file.size, mime: file.mime }));
  const target = options.target;
  const tag = target ? tagOf(target).toLowerCase() : null;
  if (options.mode === 'drop') {
    if (!target) throw Object.assign(new Error('upload --mode drop 需要 dropzone 目标'), { code: 'E_BAD_ARG' });
    dropFiles(doc, target, wanted);
    return {
      via: 'drop',
      names,
      files: detail,
      tag,
      selector: options.selector,
      note: 'DataTransfer drop 事件（合成事件；无 chrome.debugger）',
    };
  }
  if (target && tagOf(target) === 'INPUT' && String(target.getAttribute('type') ?? '').toLowerCase() === 'file') {
    try {
      setInputFiles(doc, target as unknown as HTMLInputElement, wanted);
    } catch (error) {
      throw Object.assign(new Error('写入 input.files 失败：' + (error instanceof Error ? error.message : String(error))), { code: 'E_NOT_IMPLEMENTED' });
    }
    return {
      via: 'input',
      names,
      files: detail,
      tag,
      selector: options.selector,
      note: 'DataTransfer 写 input.files + input/change（合成事件；字节来自 daemon 传输/staging）',
    };
  }
  const hidden = findFileInputs(doc);
  if (!hidden.length) {
    throw Object.assign(new Error('目标不是 file input，且页面上没有隐藏的 file input 可回退'), {
      code: 'E_NOT_IMPLEMENTED',
      data: { selector: options.selector, ref: options.ref, tag },
    });
  }
  const input = hidden.find((candidate) => isHiddenInput(candidate as unknown as ElementLike)) ?? hidden[hidden.length - 1];
  try {
    setInputFiles(doc, input as HTMLInputElement, wanted);
  } catch (error) {
    throw Object.assign(new Error('写入隐藏 input.files 失败：' + (error instanceof Error ? error.message : String(error))), { code: 'E_NOT_IMPLEMENTED' });
  }
  return {
    via: 'hidden-input',
    names,
    files: detail,
    tag,
    selector: options.selector,
    note: '目标不是 file input：回退写入页面上的隐藏 file input 并派发 change（合成事件）',
  };
}

/** 目标类型推断（prepare 阶段就决定 input/drop；避免 commit 时才报参数错）。 */
export function classifyUploadTarget(target: ElementLike | null, mode: 'input' | 'drop'): 'input' | 'hidden-input' | 'drop' | 'unknown' {
  if (mode === 'drop') return 'drop';
  if (!target) return 'unknown';
  if (tagOf(target) === 'INPUT' && String(target.getAttribute('type') ?? '').toLowerCase() === 'file') return 'input';
  return 'hidden-input';
}

export { normalizeText };
