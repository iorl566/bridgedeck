// src/pdf.js —— 用 CDP Page.printToPDF 导出当前文档为 PDF（后台标签页也可）。
import { acquire, release, send } from './debugger.js';
import { bridgeError } from './errors.js';

function requireTabId(params) {
  const tabId = Number(params && params.tabId);
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', '需要 tabId');
  return tabId;
}

export async function printPdf(params = {}) {
  const tabId = requireTabId(params);
  await acquire(tabId, 'pdf');
  try {
    const options = {
      printBackground: params.printBackground !== false,
      landscape: params.landscape === true,
      preferCSSPageSize: params.preferCssPageSize === true,
    };
    if (typeof params.pages === 'string' && params.pages) options.pageRanges = params.pages;
    const scale = Number(params.scale);
    if (Number.isFinite(scale) && scale > 0.1 && scale <= 2) options.scale = scale;
    if (params.margins && typeof params.margins === 'object') {
      for (const [key, value] of Object.entries(params.margins)) {
        const margin = Number(value);
        if (Number.isFinite(margin) && margin >= 0) options['margin' + key.charAt(0).toUpperCase() + key.slice(1)] = margin;
      }
    }
    const paperWidth = Number(params.paperWidth);
    const paperHeight = Number(params.paperHeight);
    if (Number.isFinite(paperWidth) && paperWidth > 0) options.paperWidth = paperWidth;
    if (Number.isFinite(paperHeight) && paperHeight > 0) options.paperHeight = paperHeight;
    const result = await send(tabId, 'Page.printToPDF', options);
    if (!result || typeof result.data !== 'string' || !result.data) {
      throw bridgeError('E_INTERNAL', 'printToPDF 没有返回数据');
    }
    return { ok: true, base64: result.data, bytes: Math.floor(result.data.length * 0.75) };
  } finally {
    await release(tabId, 'pdf').catch(() => {});
  }
}
