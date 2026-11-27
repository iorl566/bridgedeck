// src/native/service.ts —— upload / download 的文件事务层（M-C 第四批）。
//
// 与 JS 扩展（extension/src/files.js）的差别只在于**输入通道**：
// - download 完全一致：chrome.downloads 观测 onCreated → search 直到 complete；不接 debugger；
// - upload 不用 CDP DOM.setFileInputFiles：daemon 的 upload 路由已经把文件字节以内联 base64
//   （≤8MB）送到扩展，这里分块转给内容脚本，用 DataTransfer 构造 File 写入 input.files 或
//   drop 事件。9MB 以上只有 transfer staging 路径的文件没有内联字节 —— 明确 E_NOT_IMPLEMENTED，
//   不伪造“已上传”。
//
// download 的 `filename` 是浏览器保存路径，daemon 的 transfer.stageDownload 会把它导入 staging，
// CLI 再复制到 --out；这里不碰本机文件系统。

import { RpcMethodError } from '../rpc/registry.ts';
import type { ContentReply, ContentRequest } from '../content/protocol.ts';

export interface NativeContentTransport {
  request(
    tabId: number,
    request: ContentRequest,
    options?: { timeoutMs?: number; signal?: AbortSignal; frameId?: number },
  ): Promise<ContentReply>;
}

export interface DownloadItemLike {
  id: number;
  filename?: string;
  url?: string;
  mime?: string;
  state?: string;
  error?: string;
  fileSize?: number;
  totalBytes?: number;
  tabId?: number;
}

export interface DownloadsApi {
  search(query: { id?: number; limit?: number }): Promise<DownloadItemLike[]>;
  /** 直接发起下载（可达 anchor href；不需要用户手势，也不打开保存对话框）。 */
  download?(options: { url: string; filename?: string; saveAs?: boolean }): Promise<number>;
  onCreated: {
    addListener(listener: (item: DownloadItemLike) => void): void;
    removeListener(listener: (item: DownloadItemLike) => void): void;
  };
}

export interface TabsApiLike {
  update(tabId: number, props: Record<string, unknown>): Promise<unknown>;
}

export interface NativeServiceOptions {
  content: NativeContentTransport;
  downloads?: DownloadsApi | null;
  tabs?: TabsApiLike | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  captureIntervalMs?: number;
}

export interface UploadFileInput {
  name: string;
  mime?: string;
  base64?: string;
  transferId?: string;
}

const CHUNK_BYTES = 1024 * 1024;
const DOWNLOAD_POLL_MS = 200;
const DOWNLOAD_DEFAULT_TIMEOUT_MS = 30_000;
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveInt(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function decodeBase64Length(base64: string): number {
  const text = String(base64 ?? '');
  if (!text) return 0;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return Math.floor((text.length * 3) / 4) - padding;
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return String((error as { message?: unknown }).message);
  }
  return String(error);
}

/** 大文件（无内联字节、只给本机路径）的 CDP 兜底：由 background 注入（DOM.setFileInputFiles）。 */
export interface UploadFileFallback {
  upload(request: {
    tabId: number;
    selector: string | null;
    ref: string | null;
    paths: string[];
    files: Array<{ name: string; mime: string; size: number; base64: string | null; transferId: string | null }>;
    mode: 'input' | 'drop';
  }): Promise<Record<string, unknown>>;
}

/** 文件上传事务（DataTransfer；分块传输给内容脚本）。 */
export class UploadService {
  private readonly content: NativeContentTransport;
  private readonly now: () => number;
  private readonly files: UploadFileFallback | null;

  constructor(options: { content: NativeContentTransport; now?: () => number; files?: UploadFileFallback | null }) {
    if (!options || typeof options.content?.request !== 'function') {
      throw new TypeError('UploadService 需要 content transport');
    }
    this.content = options.content;
    this.now = options.now ?? Date.now;
    this.files = options.files && typeof options.files.upload === 'function' ? options.files : null;
  }

  private async requestContent(
    tabId: number,
    op: ContentRequest['op'],
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const request: ContentRequest = {
      type: 'bb.content',
      requestId: 'upload-' + op + '-' + String(tabId) + '-' + String(this.now()),
      op,
      params,
    };
    const reply = await this.content.request(tabId, request, { timeoutMs });
    if (!reply || reply.ok !== true) {
      const failure = reply as { code?: string; message?: string; data?: unknown } | null;
      throw new RpcMethodError(failure?.code ?? 'E_CONTENT_ERROR', failure?.message ?? '内容脚本没有回包', failure?.data);
    }
    return isRecord(reply.result) ? reply.result : {};
  }

  /**
   * upload 命令入口。
   *
   * 入参（daemon 注入）：{ tabId, ref|selector|text|stableRef, files: [{name,mime,base64?,transferId?}],
   * paths?, mode?: 'drop' }。
   */
  async upload(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = isRecord(rawParams) ? rawParams : {};
    const tabId = positiveInt(params.tabId);
    if (tabId === null) throw new RpcMethodError('E_BAD_ARG', 'upload 需要正整数 tabId', { tabId: params.tabId ?? null });
    const files = Array.isArray(params.files) ? params.files as UploadFileInput[] : [];
    if (!files.length) throw new RpcMethodError('E_BAD_ARG', 'upload 需要至少一个 files 条目');
    if (files.length > 8) throw new RpcMethodError('E_BAD_ARG', 'upload 单次最多 8 个文件');
    const mode: 'input' | 'drop' = params.mode === 'drop' ? 'drop' : 'input';
    const target: Record<string, unknown> = {};
    for (const key of ['ref', 'selector', 'text', 'stableRef']) {
      if (params[key] !== undefined && params[key] !== null) target[key] = params[key];
    }
    const prepared: Array<{ name: string; mime: string; size: number; base64: string | null; transferId: string | null }> = [];
    let total = 0;
    for (const file of files) {
      const name = typeof file?.name === 'string' ? file.name : '';
      if (!name) throw new RpcMethodError('E_BAD_ARG', 'upload files[].name 不能为空');
      const base64 = typeof file.base64 === 'string' && file.base64 ? file.base64 : null;
      const size = base64 ? decodeBase64Length(base64) : 0;
      total += size;
      if (total > MAX_UPLOAD_BYTES) throw new RpcMethodError('E_BAD_ARG', 'upload 总大小超过 64MB');
      prepared.push({
        name,
        mime: typeof file.mime === 'string' && file.mime ? file.mime : 'application/octet-stream',
        size,
        base64,
        transferId: typeof file.transferId === 'string' ? file.transferId : null,
      });
    }
    // 没有内联字节的文件：有 CDP 兜底（DOM.setFileInputFiles）时走本机路径直写，否则如实拒绝。
    const missing = prepared.filter((file) => !file.base64);
    if (missing.length) {
      if (this.files) {
        return this.files.upload({
          tabId,
          selector: typeof target.selector === 'string' ? target.selector : null,
          ref: typeof target.ref === 'string' ? target.ref : null,
          paths: Array.isArray(params.paths) ? (params.paths as unknown[]).map((item) => String(item)) : [],
          files: prepared,
          mode,
        });
      }
      throw new RpcMethodError(
        'E_NOT_IMPLEMENTED',
        'TS 运行时没有 chrome.debugger/DOM.setFileInputFiles，无法读取本机路径；请用 ≤8MB 的文件（daemon 会内联 base64）',
        {
          method: 'upload',
          reason: 'no-file-bytes',
          files: missing.map((file) => ({ name: file.name, transferId: file.transferId })),
          limitation: 'staged-only files require CDP DOM.setFileInputFiles (not wired in this runtime)',
        },
      );
    }
    const preparedMeta = await this.requestContent(tabId, 'upload-prepare', {
      ...target,
      mode,
      files: prepared.map((file) => ({ name: file.name, mime: file.mime, size: file.size })),
    }, 15_000);
    const uploadId = String(preparedMeta.uploadId ?? '');
    if (!uploadId) throw new RpcMethodError('E_INTERNAL', 'upload-prepare 没有返回 uploadId');
    for (let index = 0; index < prepared.length; index += 1) {
      const file = prepared[index];
      if (!file || !file.base64) continue;
      // base64 分块必须按 4 字符对齐（否则 atob 会丢掉尾部 padding，字节数变少）。
      const chunkChars = Math.floor(CHUNK_BYTES / 3) * 4;
      let offset = 0;
      while (offset < file.base64.length) {
        const slice = file.base64.slice(offset, offset + chunkChars);
        const chunk = await this.requestContent(tabId, 'upload-chunk', {
          uploadId,
          index,
          offset,
          base64: slice,
        }, 20_000);
        offset += slice.length;
        if (chunk.eof === true) break;
      }
    }
    const committed = await this.requestContent(tabId, 'upload-commit', { uploadId }, 30_000);
    const names = Array.isArray(committed.names) ? committed.names : prepared.map((file) => file.name);
    return {
      ok: true,
      tabId,
      via: committed.via ?? 'input',
      names,
      files: Array.isArray(committed.files) ? committed.files : prepared.map((file) => ({ name: file.name, size: file.size, mime: file.mime })),
      tag: committed.tag ?? null,
      selector: typeof target.selector === 'string' ? target.selector : null,
      ref: typeof target.ref === 'string' ? target.ref : null,
      effectState: 'committed',
      cleanupState: 'ok',
      trusted: false,
      synthetic: true,
      dataSource: 'daemon-transfer-inline-base64',
      note: String(committed.note ?? 'DataTransfer 写入页面（合成事件；无 chrome.debugger）'),
    };
  }
}

/** 下载事务（chrome.downloads；与 JS 扩展同一条观测路径，不接 debugger）。 */
export class DownloadService {
  private readonly content: NativeContentTransport;
  private readonly downloads: DownloadsApi | null;
  private readonly tabs: TabsApiLike | null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: NativeServiceOptions) {
    if (!options || typeof options.content?.request !== 'function') {
      throw new TypeError('DownloadService 需要 content transport');
    }
    this.content = options.content;
    this.downloads = options.downloads ?? null;
    this.tabs = options.tabs ?? null;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  private requireDownloads(): DownloadsApi {
    if (!this.downloads || typeof this.downloads.search !== 'function' || !this.downloads.onCreated) {
      throw new RpcMethodError('E_NOT_IMPLEMENTED', '当前运行时没有 chrome.downloads，无法观测下载', { method: 'download' });
    }
    return this.downloads;
  }

  private async clickTarget(tabId: number, params: Record<string, unknown>): Promise<void> {
    const target: Record<string, unknown> = {};
    for (const key of ['ref', 'selector', 'text', 'stableRef']) {
      if (params[key] !== undefined && params[key] !== null) target[key] = params[key];
    }
    const request: ContentRequest = {
      type: 'bb.content',
      requestId: 'download-click-' + String(tabId) + '-' + String(this.now()),
      op: 'click',
      params: target,
    };
    const reply = await this.content.request(tabId, request, { timeoutMs: 20_000 });
    if (!reply || reply.ok !== true) {
      const failure = reply as { code?: string; message?: string; data?: unknown } | null;
      throw new RpcMethodError(failure?.code ?? 'E_CONTENT_ERROR', '下载目标点击失败：' + (failure?.message ?? '内容脚本没有回包'), failure?.data);
    }
  }

  /**
   * download 命令入口：点击/导航触发下载，等 chrome.downloads 观测到 complete。
   *
   * 目标解析策略（从“证据最强”到“最兼容”）：
   * 1) 目标是 <a href>：用 chrome.downloads.download(url) 直接发起（浏览器原生下载管线，
   *    不依赖合成 click 的用户手势，也不会弹保存对话框）——`via='downloads-api'`；
   * 2) 其它目标（按钮/JS 触发）：合成 click 后等 onCreated ——`via='content-script-click+downloads'`；
   * 3) --url：直接 downloads.download(url)。
   */
  async download(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = isRecord(rawParams) ? rawParams : {};
    const tabId = positiveInt(params.tabId);
    if (tabId === null) throw new RpcMethodError('E_BAD_ARG', 'download 需要正整数 tabId', { tabId: params.tabId ?? null });
    const hasTarget = Boolean(params.ref || params.selector || params.text || params.stableRef);
    const url = typeof params.url === 'string' && params.url.trim() ? params.url.trim() : '';
    if (!hasTarget && !url) throw new RpcMethodError('E_BAD_ARG', 'download 需要 ref/selector 或 url');
    if (hasTarget && url) throw new RpcMethodError('E_BAD_ARG', 'download 的 ref/selector 与 url 只能给一个');
    const timeoutMsRaw = Number(params.timeoutMs);
    const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0
      ? Math.min(Math.max(Math.round(timeoutMsRaw), 1000), 120_000)
      : DOWNLOAD_DEFAULT_TIMEOUT_MS;
    const downloads = this.requireDownloads();
    let directId: number | null = null;
    let via = '';
    if (url) {
      if (typeof downloads.download !== 'function') {
        throw new RpcMethodError('E_NOT_IMPLEMENTED', '当前运行时 chrome.downloads 没有 download()，无法按 url 下载');
      }
      directId = await downloads.download({ url });
      via = 'downloads-api-url';
    } else {
      const linkHref = await this.linkHref(tabId, params);
      if (linkHref && typeof downloads.download === 'function') {
        try {
          directId = await downloads.download({ url: linkHref });
          via = 'downloads-api';
        } catch (error) {
          directId = null;
          via = '';
          void error;
        }
      }
    }
    let baseline = new Set<number>();
    try {
      const existing = await downloads.search({ limit: 50 });
      baseline = new Set((existing || []).map((item) => item.id));
    } catch {
      baseline = new Set();
    }
    const started: number[] = directId !== null ? [directId] : [];
    const onCreated = (item: DownloadItemLike): void => {
      if (!item || baseline.has(item.id)) return;
      started.push(item.id);
    };
    downloads.onCreated.addListener(onCreated);
    try {
      if (directId === null) {
        await this.clickTarget(tabId, params);
        via = 'content-script-click+downloads';
      }
      const deadline = this.now() + timeoutMs;
      while (this.now() < deadline) {
        await this.sleep(DOWNLOAD_POLL_MS);
        if (!started.length) continue;
        const id = started[started.length - 1];
        if (id === undefined) continue;
        let items: DownloadItemLike[] = [];
        try {
          items = await downloads.search({ id });
        } catch (error) {
          throw new RpcMethodError('E_BROWSER', '查询下载状态失败：' + errorMessageOf(error));
        }
        const item = items && items[0];
        if (!item) continue;
        if (item.state === 'complete') {
          const bytes = Number(item.fileSize) > 0 ? Number(item.fileSize) : (Number(item.totalBytes) || 0);
          return {
            ok: true,
            tabId,
            downloadId: item.id,
            filename: item.filename || '',
            url: item.url || '',
            mime: item.mime || '',
            bytes,
            state: 'complete',
            effectState: 'committed',
            cleanupState: 'ok',
            via,
            trusted: false,
            synthetic: true,
            note: via === 'downloads-api'
              ? 'chrome.downloads.download 直接发起（浏览器原生下载管线；无 chrome.debugger）'
              : 'chrome.downloads 观测下载完成；文件路径由浏览器决定，daemon 会导入 transfer staging',
          };
        }
        if (item.state === 'interrupted') {
          throw new RpcMethodError('E_DOWNLOAD_FAILED', '下载中断：' + (item.error || 'interrupted'), {
            downloadId: item.id,
            effect_state: 'unknown',
            dispatched: true,
          });
        }
      }
      throw new RpcMethodError('E_NO_DOWNLOAD', '等待 ' + String(timeoutMs) + 'ms 没有观测到完成下载', {
        effect_state: hasTarget ? 'unknown' : 'none',
        dispatched: hasTarget,
        timeoutMs,
      });
    } finally {
      try {
        downloads.onCreated.removeListener(onCreated);
      } catch {
        // 监听器可能已被移除
      }
    }
  }

  /** 解析目标元素的绝对 href（仅 <a>；其它目标返回 null）。 */
  private async linkHref(tabId: number, params: Record<string, unknown>): Promise<string | null> {
    const target: Record<string, unknown> = {};
    for (const key of ['ref', 'selector', 'text', 'stableRef']) {
      if (params[key] !== undefined && params[key] !== null) target[key] = params[key];
    }
    const request: ContentRequest = {
      type: 'bb.content',
      requestId: 'download-href-' + String(tabId) + '-' + String(this.now()),
      op: 'element-state',
      params: target,
    };
    const reply = await this.content.request(tabId, request, { timeoutMs: 15_000 });
    if (!reply || reply.ok !== true) return null;
    const state = reply.result as { href?: unknown } | null;
    return typeof state?.href === 'string' && state.href ? state.href : null;
  }
}
