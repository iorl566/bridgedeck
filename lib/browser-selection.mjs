// lib/browser-selection.mjs —— 解析 --browser 选择器（instanceId / 唯一名称 / edge|chrome 前缀）。
//
// 规则与 bsk 对齐：显式选择器不能"猜"。同名 label 有多个已连接实例时返回
// E_BROWSER_AMBIGUOUS，要求调用方改用 instanceId，而不是随便选第一个。

export const BROWSER_SELECTION_ERRORS = Object.freeze({
  NO_BROWSER: 'E_NO_BROWSER',
  AMBIGUOUS: 'E_BROWSER_AMBIGUOUS',
  NOT_FOUND: 'E_NO_BROWSER',
});

/**
 * @param {Array<{instanceId: string, label?: string, browser?: string}>} list
 * @param {unknown} browserSpec
 * @returns {{ instance: object } | { error: string, message: string }}
 */
export function selectBrowserInstance(list, browserSpec) {
  const items = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!items.length) {
    return {
      error: BROWSER_SELECTION_ERRORS.NO_BROWSER,
      message: '没有已连接的浏览器；请在 Edge/Chrome 里加载并启用 BridgeDeck 扩展',
    };
  }
  if (browserSpec === undefined || browserSpec === null || String(browserSpec).trim() === '') {
    // 与 bsk 一致：未显式选择时，只有一个在线实例才自动选；多个实例必须指定。
    if (items.length === 1) return { instance: items[0] };
    return {
      error: BROWSER_SELECTION_ERRORS.AMBIGUOUS,
      message: '存在多个已连接的浏览器；请用 --browser <instanceId|唯一名称> 指定',
    };
  }

  const spec = String(browserSpec).trim().toLowerCase();
  const exact = items.find((item) => String(item.instanceId || '').toLowerCase() === spec);
  if (exact) return { instance: exact };

  const byLabel = items.filter((item) => String(item.label || '').toLowerCase() === spec);
  if (byLabel.length > 1) {
    return {
      error: BROWSER_SELECTION_ERRORS.AMBIGUOUS,
      message: '多个浏览器使用同一名称 "' + String(browserSpec) + '"；请改用 instanceId 区分',
    };
  }
  if (byLabel.length === 1) return { instance: byLabel[0] };

  const matched = items.filter((item) => {
    const name = String(item.browser || '').toLowerCase();
    return name && (name.startsWith(spec) || spec.startsWith(name));
  });
  if (matched.length === 1) return { instance: matched[0] };
  if (matched.length > 1) {
    return {
      error: BROWSER_SELECTION_ERRORS.AMBIGUOUS,
      message: '有多个 ' + String(browserSpec) + ' 实例；请用 --browser <instanceId|唯一名称> 区分',
    };
  }
  return {
    error: BROWSER_SELECTION_ERRORS.NOT_FOUND,
    message: '没有找到浏览器选择器 "' + String(browserSpec) + '"；先运行 bridge browsers 查看 instanceId/名称',
  };
}
