// extension/src/lib/pipeline-compare.js —— 观察管线双跑对照的纯汇总。
//
// 目的：在切换到 DOMSnapshot/AX 采集器之前，持续量化 page-lib 与 AX 两条管线的
// 覆盖差异（交互元素覆盖率）与耗时，不改变默认 observe 输出。

function charCount(text) {
  return typeof text === 'string' ? text.length : 0;
}

function lineCount(text) {
  if (typeof text !== 'string' || !text) return 0;
  return text.split('\n').length;
}

/**
 * @param {{
 *   pageLib?: {ms?: number, refs?: number, text?: string},
 *   ax?: {ms?: number, nodes?: number, text?: string},
 *   interactiveTotal?: number,
 *   matched?: number,
 * }} input
 */
export function summarizePipeline(input = {}) {
  const pageLib = input.pageLib || {};
  const ax = input.ax || {};
  const interactiveTotal = Math.max(0, Number(input.interactiveTotal) || 0);
  const matched = Math.min(interactiveTotal, Math.max(0, Number(input.matched) || 0));
  return {
    pageLib: {
      ms: Math.max(0, Math.round(Number(pageLib.ms) || 0)),
      refs: Math.max(0, Number(pageLib.refs) || 0),
      chars: charCount(pageLib.text),
      lines: lineCount(pageLib.text),
    },
    ax: {
      ms: Math.max(0, Math.round(Number(ax.ms) || 0)),
      nodes: Math.max(0, Number(ax.nodes) || 0),
      chars: charCount(ax.text),
      lines: lineCount(ax.text),
    },
    interactiveTotal,
    matched,
    unmappedInteractive: interactiveTotal - matched,
    axCoverage: interactiveTotal > 0 ? Math.round((matched / interactiveTotal) * 1000) / 1000 : null,
  };
}

/** 判断节点矩形是否与视口相交；缺任一侧时按“无法判断”处理（返回 true）。 */
export function intersectsViewport(bounds, viewport) {
  if (!bounds || !viewport) return true;
  const x1 = Math.max(bounds.x, viewport.x);
  const y1 = Math.max(bounds.y, viewport.y);
  const x2 = Math.min(bounds.x + bounds.width, viewport.x + viewport.width);
  const y2 = Math.min(bounds.y + bounds.height, viewport.y + viewport.height);
  return x2 - x1 > 0 && y2 - y1 > 0;
}
