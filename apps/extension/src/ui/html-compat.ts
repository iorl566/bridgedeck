// src/ui/html-compat.ts —— 扩展 HTML 产物的构建期兼容处理（wxt.config.ts 使用，纯函数便于单测）。
//
// 为什么需要（29/29d 的真实根因）：
// - `entrypoints/*.html` 源码文件带 UTF-8 BOM；WXT/Vite 输出时把 BOM 留在
//   `<!DOCTYPE html>` 之后（`3C 21 44 4F ... 20 EF BB BF 0A <html>`）。HTML 解析器把
//   U+FEFF 当普通字符 → 提前建出空 head/body，于是 `<meta>/<title>/<script>/<link>`
//   全部落进 **body**；页面脚本里 `document.body.textContent=''` 会把它们连同 title 一起
//   清掉，`document.title` 变成空串（E2E 里 tab.title 退化成 URL，29d 阿拉伯语标题失败）。
// - WXT 只把 `entrypoints/popup/index.html` 输出为根 `popup.html`，而 0.3.0 JS 产物/
//   CLI 断言使用 `ui/popup.html`（JS manifest 的 action.default_popup 就是它）。
//
// 本模块只做两件事：去 BOM、给 popup 生成相对根路径都成立的别名页；不改变页面内容。

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

/** HTML 中出现即非法的“游离 BOM”字符（U+FEFF）。页面正文不需要它。 */
const BOM = '\uFEFF';

/** 去掉 HTML 文本里的全部 U+FEFF（含被 Vite 留在 DOCTYPE 后的那一个）。 */
export function stripHtmlBom(html: string): string {
  if (typeof html !== 'string') return '';
  if (!html.includes(BOM)) return html;
  return html.split(BOM).join('');
}

/**
 * Vite MPA 构建里的 HTML chunk 文件名 → WXT 最终输出名（与 WXT getEntrypointName 一致）：
 * - `entrypoints/options.html` → `options.html`
 * - `entrypoints/popup/index.html` → `popup.html`（目录入口取目录名）
 */
export function htmlOutputName(inputFileName: string): string {
  const normalized = String(inputFileName ?? '').replace(/\\/g, '/').replace(/^\.?\//, '');
  const withoutEntrypoints = normalized.startsWith('entrypoints/')
    ? normalized.slice('entrypoints/'.length)
    : normalized;
  const parts = withoutEntrypoints.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  const base = parts[parts.length - 1] ?? '';
  if (base.toLowerCase() === 'index.html' && parts.length > 1) {
    return parts.slice(0, -1).join('/') + '.html';
  }
  return withoutEntrypoints;
}

/** popup 别名页在产物内的路径（JS 0.3.0 布局；也是 catalog popup.path）。 */
export const UI_POPUP_ALIAS_FILE = 'ui/popup.html';

/** 该 HTML chunk 是否需要在 `ui/` 下再产出一份别名页（目前只有 popup）。 */
export function needsPopupAlias(inputFileName: string): boolean {
  return htmlOutputName(inputFileName) === 'popup.html';
}

/** Rollup/Vite 产物里的 asset 最小形状（generateBundle 的 bundle 项）。 */
export interface HtmlAssetLike {
  type: string;
  source: string | Uint8Array;
}

/**
 * 对一次 Vite 构建的产物执行兼容处理（纯逻辑 + 显式 outDir，便于在 wxt.config 与单测
 * 之间共用同一份实现）：
 * - 所有 `.html` asset 去游离 BOM（原地改 source，Rollup 写盘时生效）；
 * - popup 入口额外把同一份 HTML 写到 `<outDir>/ui/popup.html`（不复制 chunk，路径引用不变）。
 *
 * @returns 额外写出的相对路径（目前只有 ui/popup.html 或空数组）。
 */
export function applyHtmlCompat(bundle: Record<string, HtmlAssetLike>, outDir: string | null | undefined): string[] {
  const written: string[] = [];
  for (const [fileName, item] of Object.entries(bundle)) {
    if (!item || item.type !== 'asset' || !fileName.endsWith('.html')) continue;
    const raw = typeof item.source === 'string'
      ? item.source
      : new TextDecoder().decode(item.source);
    const cleaned = stripHtmlBom(raw);
    item.source = cleaned;
    if (!outDir || !needsPopupAlias(fileName)) continue;
    const target = join(outDir, UI_POPUP_ALIAS_FILE);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, cleaned, 'utf8');
    written.push(UI_POPUP_ALIAS_FILE);
  }
  return written;
}

/**
 * Vite 插件：在一次构建的 generateBundle 里执行 {@link applyHtmlCompat}。
 *
 * 为什么要拆成工厂函数：wxt.config 只能声明插件，而单测需要直接驱动插件钩子
 * （用假 bundle 验证“HTML 去 BOM + popup 别名页落盘”这条真实构建期行为）。
 */
export function createUiHtmlCompatPlugin(): Plugin {
  return {
    name: 'bridgedeck:ui-html-compat',
    enforce: 'post',
    generateBundle(options, bundle) {
      const assets: Record<string, HtmlAssetLike> = {};
      for (const [fileName, item] of Object.entries(bundle)) {
        if (item.type !== 'asset') continue;
        assets[fileName] = { type: 'asset', source: item.source };
      }
      const written = applyHtmlCompat(assets, options.dir ?? null);
      // 就地回写清理后的 HTML（Rollup 写盘时才真正落盘）。
      for (const [fileName, item] of Object.entries(bundle)) {
        if (item.type !== 'asset') continue;
        const cleaned = assets[fileName]?.source;
        if (cleaned !== undefined) item.source = cleaned;
      }
      if (written.length > 0) {
        this.info('bridgeDeck ui-html-compat：额外产出 ' + written.join(','));
      }
    },
  };
}
