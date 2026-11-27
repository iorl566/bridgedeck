// src/capture/pdf.ts —— CDP Page.printToPDF：把当前文档导出为 PDF（20v2 / MCP pdf）。
//
// 边界：
// - 通道复用 `CdpChannel`（attach/超时/重挂由 src/cdp/** 负责），本模块只做参数归一与落盘契约；
// - 返回 base64（CLI 侧解码写文件，见 cli/commands/page.mjs 的 pdf 分支）；
// - `pages` 支持 "1"/"1-3"/"2,4-6"；`margins` 同时接受 {top,right,bottom,left} 与数组/逗号串；
// - 后台标签页也可导出（printToPDF 不要求前台），不抢焦点。

import type { CdpChannel } from '../debug/cdp-channel.ts';
import { finiteNumber } from '../debug/cdp-channel.ts';

export interface PdfServiceOptions {
  client: CdpChannel;
  now?: () => number;
  timeoutMs?: number;
}

export interface PdfOptions {
  tabId: number;
  /** 页码/范围（Chrome pageRanges 语义："1", "1-3", "2,4-6"）。 */
  pages?: string;
  scale?: number;
  margins?: Record<string, unknown> | string | Array<unknown>;
  printBackground?: boolean;
  landscape?: boolean;
  preferCSSPageSize?: boolean;
  paperWidth?: number;
  paperHeight?: number;
  /** 打印头部/底部模板（CDP 原字段；默认不注入）。 */
  headerTemplate?: string;
  footerTemplate?: string;
  /** 横/纵向外的边距单位（英寸，默认 0.4）。 */
  marginUnit?: 'in' | 'cm';
}

const MARGIN_KEYS = ['top', 'right', 'bottom', 'left'] as const;

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return String(error);
}

/** 归一页边距：对象 {top,right,bottom,left} / "0.5,0.5,0.5,0.5" / [0.5,0.5,0.5,0.5]。 */
export function normalizeMargins(margins: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (margins === undefined || margins === null) return out;
  let values: unknown[] = [];
  if (Array.isArray(margins)) {
    values = margins;
  } else if (typeof margins === 'string') {
    values = margins.split(',').map((item) => item.trim());
  } else if (typeof margins === 'object') {
    for (const key of MARGIN_KEYS) {
      const value = (margins as Record<string, unknown>)[key];
      const number = Number(value);
      if (Number.isFinite(number) && number >= 0) out[key] = number;
    }
    return out;
  }
  for (let index = 0; index < MARGIN_KEYS.length; index += 1) {
    const raw = values[index];
    if (raw === undefined) continue;
    const number = Number(raw);
    if (Number.isFinite(number) && number >= 0) out[MARGIN_KEYS[index] as string] = number;
  }
  return out;
}

/** 归一页码表达式（去掉空格；非法返回空串 = 全部页）。 */
export function normalizePageRanges(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, '');
  if (!text) return '';
  return /^[0-9]+([-,][0-9]+)*$/.test(text) ? text : '';
}

/** 组装 Page.printToPDF 的 CDP 参数（纯函数，单测覆盖）。 */
export function buildPrintToPdfParams(options: PdfOptions): Record<string, unknown> {
  const params: Record<string, unknown> = {
    printBackground: options.printBackground !== false,
    landscape: options.landscape === true,
    preferCSSPageSize: options.preferCSSPageSize === true,
  };
  const pages = normalizePageRanges(options.pages);
  if (pages) params['pageRanges'] = pages;
  const scale = Number(options.scale);
  if (Number.isFinite(scale) && scale > 0.1 && scale <= 2) params['scale'] = scale;
  const margins = normalizeMargins(options.margins);
  for (const key of MARGIN_KEYS) {
    const value = margins[key];
    if (value === undefined) continue;
    params['margin' + key.charAt(0).toUpperCase() + key.slice(1)] = value;
  }
  const paperWidth = Number(options.paperWidth);
  const paperHeight = Number(options.paperHeight);
  if (Number.isFinite(paperWidth) && paperWidth > 0) params['paperWidth'] = paperWidth;
  if (Number.isFinite(paperHeight) && paperHeight > 0) params['paperHeight'] = paperHeight;
  if (typeof options.headerTemplate === 'string' && options.headerTemplate) {
    params['displayHeaderFooter'] = true;
    params['headerTemplate'] = options.headerTemplate;
  }
  if (typeof options.footerTemplate === 'string' && options.footerTemplate) {
    params['displayHeaderFooter'] = true;
    params['footerTemplate'] = options.footerTemplate;
  }
  return params;
}

/** PDF 服务。 */
export class PdfService {
  private readonly client: CdpChannel;
  private readonly now: () => number;
  private readonly timeoutMs: number | undefined;

  constructor(options: PdfServiceOptions) {
    if (!options || !options.client) throw new TypeError('PdfService 需要 CdpChannel');
    this.client = options.client;
    this.now = options.now ?? Date.now;
    this.timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
      ? Math.floor(Number(options.timeoutMs))
      : undefined;
  }

  /** 单条命令超时（未配置时交给 CdpClient 默认值）。 */
  private sendOptions(): { timeoutMs?: number } | undefined {
    return this.timeoutMs === undefined ? undefined : { timeoutMs: this.timeoutMs };
  }

  /** 导出 PDF：返回 { ok, base64, bytes, pageRanges, params }。 */
  async printPdf(rawParams: unknown): Promise<Record<string, unknown>> {
    const params = rawParams && typeof rawParams === 'object' ? rawParams as Record<string, unknown> : {};
    const tabId = Number(params['tabId']);
    if (!Number.isInteger(tabId) || tabId <= 0) {
      throw Object.assign(new Error('pdf 需要正整数 tabId（由 daemon 按会话注入）'), { code: 'E_BAD_ARG' });
    }
    const options: PdfOptions = {
      tabId,
      ...(typeof params['pages'] === 'string' ? { pages: String(params['pages']) } : {}),
      ...(params['scale'] !== undefined ? { scale: Number(params['scale']) } : {}),
      ...(params['margins'] !== undefined ? { margins: params['margins'] as PdfOptions['margins'] } : {}),
      ...(params['printBackground'] !== undefined ? { printBackground: params['printBackground'] === true } : {}),
      ...(params['landscape'] !== undefined ? { landscape: params['landscape'] === true } : {}),
      ...(params['preferCSSPageSize'] !== undefined ? { preferCSSPageSize: params['preferCSSPageSize'] === true } : {}),
      ...(params['paperWidth'] !== undefined ? { paperWidth: Number(params['paperWidth']) } : {}),
      ...(params['paperHeight'] !== undefined ? { paperHeight: Number(params['paperHeight']) } : {}),
      ...(typeof params['headerTemplate'] === 'string' ? { headerTemplate: String(params['headerTemplate']) } : {}),
      ...(typeof params['footerTemplate'] === 'string' ? { footerTemplate: String(params['footerTemplate']) } : {}),
    };
    const cdpParams = buildPrintToPdfParams(options);
    const startedAt = this.now();
    await this.client.acquire(tabId, 'pdf');
    try {
      const result = await this.client.send<Record<string, unknown>>(tabId, 'Page.printToPDF', cdpParams, this.sendOptions());
      const data = String(result['data'] ?? '');
      if (!data) {
        throw Object.assign(new Error('printToPDF 没有返回数据'), { code: 'E_INTERNAL' });
      }
      return {
        ok: true,
        base64: data,
        // base64 的 3 字节 → 4 字符；CLI 真解码后的长度以实际字节为准，这里给保守估计。
        bytes: Math.floor((data.length * 3) / 4),
        pageRanges: cdpParams['pageRanges'] ?? null,
        durationMs: Math.max(0, this.now() - startedAt),
        via: 'cdp-page-printToPDF',
      };
    } catch (error) {
      throw Object.assign(new Error('PDF 导出失败：' + errorText(error)), {
        code: (error as { code?: string }).code ?? 'E_CDP_COMMAND',
        data: { tabId, params: cdpParams },
      });
    } finally {
      this.client.release(tabId, 'pdf');
    }
  }
}

/** 便捷函数：直接导出（无状态场景）。 */
export async function printPdf(params: Record<string, unknown>, options: PdfServiceOptions): Promise<Record<string, unknown>> {
  return new PdfService(options).printPdf(params);
}

/** PDF 服务用到的数值工具再导出（测试/其它 capture 模块复用）。 */
export { finiteNumber };
