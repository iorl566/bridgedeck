// ui/a11y-audit.js —— 静态可访问性审计（纯函数门禁，测试/CI 复用）。
//
// 只做“没有 DOM 也能确定”的硬性检查，避免误报：
// - html[lang] 必须存在；
// - <img> 必须有 alt（装饰图用 alt=""）；
// - <svg> 必须有 aria-hidden="true" 或 role="img"+aria-label；
// - <button>/<a href> 必须有可访问名称（aria-label/title/可见文本/SVG title）；
// - role="switch" 必须有 aria-checked；
// - 不允许 tabindex="正数"（打乱键盘顺序）；
// - 输入控件必须有 aria-label 或关联 <label for>/包裹 label；
// - CSS 不允许只 outline:none 而不提供 :focus-visible 替代；
// - 每个 UI 页面至少有一条 :focus-visible/焦点样式（由 CSS 文件审计）。
//
// 规则以“失败信息带文件/元素/原因”的形式返回，测试直接断言 findings 为空。

export const POSITIVE_TABINDEX = /\btabindex\s*=\s*["']?([1-9]\d*)/i;

function stripTags(text) {
  return String(text || '').replace(/<svg[\s\S]*?<\/svg>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

function attrs(attributeText) {
  const map = {};
  for (const match of String(attributeText || '').matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    map[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return map;
}

function lineOf(text, index) {
  return String(text).slice(0, index).split('\n').length;
}

/**
 * 审计一段 HTML。
 * @param {{file:string, text:string}} source
 * @returns {Array<{file:string,line:number,rule:string,element:string,message:string}>}
 */
export function auditHtml(source) {
  const { file, text } = source;
  const findings = [];
  const add = (index, rule, element, message) => findings.push({ file, line: lineOf(text, index), rule, element, message: file + ':' + lineOf(text, index) + ' [' + rule + '] ' + message });

  const htmlTag = /<html\b([^>]*)>/i.exec(text);
  if (!htmlTag) add(0, 'html-lang', '<html>', '缺少 <html> 标签');
  else if (!attrs(htmlTag[1]).lang) add(htmlTag.index, 'html-lang', '<html>', 'html 缺 lang 属性');

  for (const match of text.matchAll(/<img\b([^>]*)>/gi)) {
    if (!Object.prototype.hasOwnProperty.call(attrs(match[1]), 'alt')) add(match.index, 'img-alt', '<img>', '图片缺 alt 属性');
  }

  for (const match of text.matchAll(/<svg\b([^>]*)>/gi)) {
    const map = attrs(match[1]);
    if (map['aria-hidden'] === 'true') continue;
    if (map.role === 'img' && map['aria-label']) continue;
    if (map['aria-label']) continue;
    add(match.index, 'svg-name', '<svg>', '内联 SVG 既没有 aria-hidden="true" 也没有可访问名称');
  }

  for (const match of text.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    const map = attrs(match[1]);
    const name = map['aria-label'] || map.title || stripTags(match[2]);
    if (!String(name || '').trim()) add(match.index, 'button-name', '<button>', '按钮没有可访问名称');
  }

  for (const match of text.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const map = attrs(match[1]);
    if (!map.href) continue;
    if (!String(map['aria-label'] || map.title || stripTags(match[2]) || '').trim()) {
      add(match.index, 'link-name', '<a href>', '链接没有可访问名称');
    }
  }

  for (const match of text.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*\brole\s*=\s*["']switch["'][^>]*)>/gi)) {
    const map = attrs(match[2]);
    if (!['true', 'false'].includes(map['aria-checked'])) add(match.index, 'switch-checked', '<' + match[1] + ' role=switch>', 'role=switch 缺 aria-checked');
  }

  for (const match of text.matchAll(/tabindex\s*=\s*["']?([1-9]\d*)/gi)) {
    add(match.index, 'tabindex-positive', 'tabindex=' + match[1], '不允许正数 tabindex（会打乱键盘顺序）');
  }

  // 输入控件：有 id 的必须有 aria-label/aria-labelledby 或 <label for> 或包裹 label；
  // 没有 id 的必须有 aria-label。
  const labelled = new Set();
  const labelRanges = [];
  for (const match of text.matchAll(/<label\b([^>]*)>/gi)) {
    const map = attrs(match[1]);
    if (map.for) labelled.add(map.for);
  }
  for (const match of text.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)) {
    labelRanges.push([match.index, match.index + match[0].length]);
    for (const control of match[1].matchAll(/<(?:input|select|textarea)\b[^>]*\bid\s*=\s*["']([^"']+)["']/gi)) {
      labelled.add(control[1]);
    }
  }
  const inLabel = (index) => labelRanges.some(([start, end]) => index >= start && index < end);
  for (const match of text.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
    const map = attrs(match[2]);
    if (map.type === 'hidden') continue;
    const hasName = map['aria-label'] || map['aria-labelledby'] || (map.id && labelled.has(map.id)) || inLabel(match.index);
    if (!hasName) {
      add(match.index, 'control-name', '<' + match[1] + '>', '输入控件缺 aria-label 或关联 label' + (map.id ? '（id=' + map.id + '）' : ''));
    }
  }
  return findings;
}

/** 审计 CSS 的焦点可见性。 */
export function auditFocusCss(source) {
  const { file, text } = source;
  const findings = [];
  const add = (index, rule, message) => findings.push({ file, line: lineOf(text, index), rule, message: file + ':' + lineOf(text, index) + ' [' + rule + '] ' + message });
  for (const match of text.matchAll(/outline\s*:\s*(?:none|0)\b/gi)) {
    add(match.index, 'outline-none', '存在 outline:none/0；必须提供可见焦点替代（用 :focus-visible）');
  }
  if (!/:focus-visible|:focus\b/.test(text)) add(0, 'focus-style', '没有 :focus-visible 焦点样式');
  for (const match of text.matchAll(/outline\s*:\s*([^;{}]+)/gi)) {
    if (/none|0\b/.test(match[1])) continue;
    if (/var\(--|#[0-9a-f]{3,8}|rgba?\(/i.test(match[1]) === false) add(match.index, 'outline-color', '焦点 outline 没有可解析颜色：' + match[1].trim());
  }
  return findings;
}

/** 提取 HTML 里的内联 <style> 块（静态页面的焦点样式也要审计）。 */
export function extractStyleBlocks(htmlText) {
  return [...String(htmlText || '').matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1]);
}

/** 汇总静态审计结果。 */
export function auditStatic(sources) {
  const findings = [];
  let checked = 0;
  for (const source of sources) {
    if (source.kind === 'css') findings.push(...auditFocusCss(source));
    else findings.push(...auditHtml(source));
    checked += 1;
  }
  return { ok: findings.length === 0, checked, findings };
}

/** 失败报告。 */
export function formatStaticReport(result) {
  return result.findings.map((finding) => finding.message).join('\n') || '静态 a11y: 0 findings';
}
