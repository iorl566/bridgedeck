// ui/rtl-audit.js —— RTL 逻辑属性审计（可被单测/CI 复用的纯函数门禁）。
//
// 背景：方向相关的物理属性（left/right/margin-left...）在 ar/he 下会镜像错位。
// 规则：扩展 UI 必须使用逻辑属性（inset-inline-*、margin-inline-*、text-align:start）；
// 少数“本来就该用物理坐标”的位置（页面坐标标记、居中定位、拖拽读取）进豁免表，
// 且豁免必须带理由并真实命中——过期豁免会让门禁失败，防止豁免表变成垃圾桶。
//
// 本模块不读写文件：调用方（测试/脚本）传入 { file, text, kind }。

/** 物理属性 → 审计类别。 */
export const PHYSICAL_PROPERTIES = [
  'left',
  'right',
  'margin-left',
  'margin-right',
  'padding-left',
  'padding-right',
  'border-left',
  'border-left-width',
  'border-left-style',
  'border-left-color',
  'border-right',
  'border-right-width',
  'border-right-style',
  'border-right-color',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-left-radius',
  'border-bottom-right-radius',
  'text-align',
  'float',
  'clear',
];

const PHYSICAL_SET = new Set(PHYSICAL_PROPERTIES);

/** 声明提取：CSS/HTML 内联样式/JS 样式字符串通用。 */
const DECLARATION = /([a-zA-Z-]+)\s*:\s*([^;{}"'\n]+)/g;

/** JS 属性访问（element.style.left = ... / .offsetLeft 不算）。 */
const JS_STYLE_WRITE = /\.style\.(left|right|marginLeft|marginRight|paddingLeft|paddingRight)\b(?:\s*=\s*([^;\n]+))?/g;

/** 方向性 transform：translateX(非 0) 必须成对出现 RTL 反向覆盖。 */
const TRANSLATE_X = /translateX\(\s*(-?\d+(?:\.\d+)?)(px|%|rem|em)?\s*\)/g;

/**
 * @typedef {{file:string,line:number,prop:string,value:string,category:string,raw:string,selector?:string}} RtlFinding
 */

/**
 * 从文本中提取 CSS 声明及其选择器（只做浅层花括号跟踪，足够覆盖本项目 CSS）。
 * @param {string} text
 * @returns {{selector:string, declarations: Array<{prop:string,value:string,line:number,raw:string}>}}
 */
export function parseCssStatements(text) {
  const statements = [];
  const rules = [];
  // 逐字符扫描，维护选择器栈；@media 不展开也不影响，因为内部选择器仍是最近的选择器。
  let index = 0;
  let selectorStart = 0;
  const stack = [];
  const lines = String(text).split('\n');
  // 行号预处理：offset → line。
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineOf = (offset) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  while (index < text.length) {
    const char = text[index];
    if (char === '{') {
      const selector = text.slice(selectorStart, index).trim();
      stack.push(selector);
      selectorStart = index + 1;
      index += 1;
      continue;
    }
    if (char === '}') {
      stack.pop();
      selectorStart = index + 1;
      index += 1;
      continue;
    }
    if (char === ';') {
      const chunk = text.slice(selectorStart, index);
      const colon = chunk.indexOf(':');
      if (colon > 0) {
        const prop = chunk.slice(0, colon).trim().toLowerCase();
        const value = chunk.slice(colon + 1).trim();
        if (/^[-a-z]+$/.test(prop)) {
          rules.push({
            selector: stack.filter(Boolean).join(' / '),
            prop,
            value,
            line: lineOf(selectorStart + colon),
            raw: chunk.trim().slice(0, 160),
          });
        }
      }
      selectorStart = index + 1;
      index += 1;
      continue;
    }
    index += 1;
  }
  statements.push(...rules);
  void lines;
  return rules;
}

/**
 * 扫描一段源码，返回物理方向属性/方向性 transform 命中。
 * @param {{file:string, text:string, kind?:'css'|'html'|'js'}} source
 * @returns {RtlFinding[]}
 */
export function scanSource(source) {
  const { file, text } = source;
  const kind = source.kind || (/\.css$/i.test(file) ? 'css' : /\.html$/i.test(file) ? 'html' : 'js');
  const findings = [];
  const add = (finding) => findings.push({ file, ...finding });
  if (kind === 'css' || kind === 'html') {
    for (const decl of parseCssStatements(text)) {
      const prop = decl.prop;
      if (prop === 'text-align') {
        if (/^(left|right)\b/i.test(decl.value)) {
          add({ line: decl.line, prop, value: decl.value, category: 'physical-text-align', selector: decl.selector, raw: decl.raw });
        }
        continue;
      }
      if (!PHYSICAL_SET.has(prop)) continue;
      add({ line: decl.line, prop, value: decl.value, category: 'physical-property', selector: decl.selector, raw: decl.raw });
    }
  }
  if (kind === 'js') {
    const lineStarts = [0];
    for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lineStarts.push(i + 1);
    const lineOf = (offset) => lineStarts.filter((start) => start <= offset).length;
    for (const match of text.matchAll(JS_STYLE_WRITE)) {
      const prop = match[1].replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
      add({ line: lineOf(match.index || 0), prop, value: String(match[2] || '').trim(), category: 'js-style-write', raw: match[0].slice(0, 160) });
    }
    // JS 里的 CSS 字符串（shadow DOM innerHTML/style.cssText）也走声明扫描。
    for (const decl of parseCssStatements(text)) {
      if (decl.prop === 'text-align') {
        if (/^(left|right)\b/i.test(decl.value)) {
          add({ line: decl.line, prop: decl.prop, value: decl.value, category: 'physical-text-align', selector: decl.selector, raw: decl.raw });
        }
      } else if (PHYSICAL_SET.has(decl.prop)) {
        add({ line: decl.line, prop: decl.prop, value: decl.value, category: 'physical-property', selector: decl.selector, raw: decl.raw });
      }
    }
  }
  // 方向性 transform：有负向 RTL 覆盖的文件视为成对镜像（例如 .sw::after 与 [dir=rtl] .sw::after）。
  const mirrored = /\[dir="rtl"\][\s\S]{0,240}?translateX\(-/.test(text);
  for (const match of text.matchAll(TRANSLATE_X)) {
    const value = Number(match[1]);
    if (!value) continue;
    add({
      line: text.slice(0, match.index || 0).split('\n').length,
      prop: 'transform',
      value: 'translateX(' + match[1] + (match[2] || '') + ')',
      category: mirrored ? 'mirrored-transform' : 'directional-transform',
      raw: match[0],
    });
  }
  return findings;
}

/**
 * 豁免表：只有“物理坐标本来就是页面坐标系”或“已显式成对镜像”的命中才可豁免。
 * 每条豁免必须至少命中一次，否则视为过期豁免（门禁失败）。
 */
export const DEFAULT_EXEMPTIONS = Object.freeze([
  {
    id: 'target-marker-page-coords',
    file: 'extension/src/target-marker.js',
    prop: 'left',
    reason: '目标标记按页面视口坐标绝对定位（getBoundingClientRect），与文字方向无关',
  },
  {
    id: 'overlay-page-coords-left',
    file: 'extension/src/overlay-ui.js',
    prop: 'left',
    reason: '浮层高亮/拖拽/滚动提示按页面坐标绝对定位（left:50% 居中、ev.clientX 拖拽、rect.left 高亮），不参与文字方向布局',
  },
  {
    id: 'overlay-page-coords-right',
    file: 'extension/src/overlay-ui.js',
    prop: 'right',
    reason: '浮层定位时会显式写 right:auto 抵消宽度约束，属于页面坐标定位而非文字方向',
  },
  {
    id: 'overlay-help-center-transform',
    file: 'extension/src/overlay-ui.js',
    prop: 'transform',
    value: /translateX\(-50%\)/,
    reason: 'Help 高亮居中：left:50% + translateX(-50%)，双向对称',
  },
  {
    id: 'record-overlay-page-coords',
    file: 'extension/src/record-overlay.js',
    prop: 'left',
    reason: '录制胶囊按页面坐标吸附到目标位置（rect.left / clientX），与文字方向无关',
  },
  {
    id: 'switch-knob-mirror',
    file: /extension\/ui\/(popup|ui)\.css$/,
    prop: 'transform',
    category: /mirrored-transform|directional-transform/,
    value: /translateX/,
    reason: '开关滑块位移已在 [dir="rtl"] 中成对反向（translateX(-16px)）',
  },
]);

/** 判断一条命中是否被豁免。 */
export function findExemption(finding, exemptions = DEFAULT_EXEMPTIONS) {
  return exemptions.find((rule) => {
    if (rule.prop && rule.prop !== finding.prop) return false;
    if (rule.category && !rule.category.test(finding.category)) return false;
    if (rule.file) {
      if (rule.file instanceof RegExp) {
        if (!rule.file.test(finding.file)) return false;
      } else if (!String(finding.file).endsWith(String(rule.file))) return false;
    }
    if (rule.value && !rule.value.test(finding.value)) return false;
    if (rule.selector && !rule.selector.test(finding.selector || '')) return false;
    return true;
  }) || null;
}

/**
 * 审计多份源码。
 * @param {Array<{file:string,text:string,kind?:string}>} sources
 * @param {{exemptions?: typeof DEFAULT_EXEMPTIONS}} [options]
 */
export function auditRtlSources(sources, options = {}) {
  const exemptions = options.exemptions || DEFAULT_EXEMPTIONS;
  const used = new Set();
  const findings = [];
  const exempted = [];
  let declarations = 0;
  for (const source of sources) {
    const fileFindings = scanSource(source);
    declarations += parseCssStatements(source.text).length;
    for (const finding of fileFindings) {
      const rule = findExemption(finding, exemptions);
      if (rule) {
        used.add(rule.id);
        exempted.push({ ...finding, exemption: rule.id, reason: rule.reason });
      } else {
        findings.push(finding);
      }
    }
  }
  const staleExemptions = exemptions.filter((rule) => !used.has(rule.id)).map((rule) => rule.id);
  return {
    ok: findings.length === 0 && staleExemptions.length === 0,
    findings,
    exempted,
    staleExemptions,
    scannedFiles: sources.length,
    declarations,
  };
}

/** 把命中格式化成可读的一行（失败信息里必须包含文件/行/属性）。 */
export function formatFinding(finding) {
  return finding.file + ':' + finding.line + ' ' + finding.prop + (finding.value ? ': ' + finding.value : '') + ' [' + finding.category + ']';
}

/** 生成失败报告（测试失败信息）。 */
export function formatReport(result) {
  const lines = [];
  for (const finding of result.findings) lines.push('物理方向属性: ' + formatFinding(finding));
  for (const id of result.staleExemptions) lines.push('过期豁免（未命中任何命中项）: ' + id);
  return lines.join('\n');
}
