// tests/unit/ui-workspace.test.mjs —— 第十一批 F 页面上线门禁。
//
// 这个测试是“UI 第二轮”的收口证据：
// 1. 新页面 workspace.js 在 DOM/chrome 桩下能完成首屏（空数据路径），不炸；
// 2. 新页面/新样式/新模块过静态 a11y、焦点、RTL 逻辑属性门禁；
// 3. 旧页面（debug/audit/ops/record/longshot）的 `SELFTEST:ok:*` 契约逐字不变，
//    既有入口脚本/selftest 触发参数/29–35 系列依赖全部保留；
// 4. 旧页面真实消费 page-tools（导出/导入校验），新页面真实消费新 lib/views；
// 5. 新文案全部走 labels 目录（不存在“页面里拼中文”的新债）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { auditFocusCss, auditHtml, auditStatic } from './a11y-audit-lib.mjs';
import { DEFAULT_EXEMPTIONS, auditRtlSources, scanSource, formatFinding } from './rtl-audit-lib.mjs';
import { hasLabel } from '../../extension/ui/lib/labels.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const UI = 'extension/ui/';
const PAGES = {
  debug: UI + 'debug.js',
  audit: UI + 'audit.js',
  ops: UI + 'ops.js',
  record: UI + 'record.js',
  longshot: UI + 'longshot.js',
};

/* ---------------- DOM / chrome 桩（空数据首屏） ---------------- */

function makeElement(tag = 'div') {
  const element = function () {};
  element.nodeType = 1;
  element.tagName = String(tag).toUpperCase();
  element.children = [];
  element.childNodes = [];
  element.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  element.dataset = {};
  element.style = { setProperty() {}, removeProperty() {} };
  element.hidden = false;
  element.value = '';
  element.textContent = '';
  element.disabled = false;
  element.tabIndex = -1;
  element.options = [];
  element.files = [];
  element.attributes = {};
  element.className = '';
  element.querySelectorAll = () => [];
  element.querySelector = () => null;
  element.closest = () => null;
  element.addEventListener = () => {};
  element.removeEventListener = () => {};
  element.appendChild = (child) => { element.children.push(child); return child; };
  element.append = (...items) => { element.children.push(...items); };
  element.insertBefore = (child) => { element.children.push(child); return child; };
  element.prepend = () => {};
  element.remove = () => {};
  element.setAttribute = (name, value) => { element.attributes[name] = String(value); };
  element.removeAttribute = (name) => { delete element.attributes[name]; };
  element.getAttribute = (name) => (Object.prototype.hasOwnProperty.call(element.attributes, name) ? element.attributes[name] : null);
  element.focus = () => {};
  element.click = () => {};
  element.scrollIntoView = () => {};
  element.getBoundingClientRect = () => ({ width: 100, height: 30, top: 0, left: 0 });
  element.contains = () => false;
  element.cloneNode = () => makeElement(tag);
  element.clientWidth = 480;
  element.clientHeight = 320;
  element.ownerDocument = null;
  return element;
}

function makeDocument() {
  const ids = new Map();
  const doc = {
    body: makeElement('body'),
    documentElement: makeElement('html'),
    head: makeElement('head'),
    readyState: 'complete',
    title: '',
    createElement: (tag) => makeElement(tag),
    createTextNode: (text) => { const node = makeElement('#text'); node.textContent = String(text); return node; },
    createDocumentFragment: () => makeElement('#fragment'),
    getElementById: (id) => ids.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    activeElement: null,
  };
  doc.body.childNodes = [];
  doc.__ids = ids;
  return doc;
}

function installStubs() {
  const sent = [];
  const doc = makeDocument();
  // 页面用到的容器 id（工作台首屏会 mount 到这些节点）。
  for (const id of [
    'wsTitle', 'wsSubtitle', 'wsStatus', 'wsTabs', 'wsDataPanel', 'wsComparePanel',
    'wsIoBar', 'wsImportPanel', 'wsImportReportHost', 'wsTableBar', 'wsFilterHost',
    'wsColumnsHost', 'wsTableHint', 'wsTable', 'wsEmpty', 'wsCompareRuns',
    'wsCompareHint', 'wsCompareBody', 'wsDiffHost', 'wsDiffRows', 'wsFootnote', 'wsAnnounce',
  ]) doc.__ids.set(id, makeElement('div'));
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'location', {
    value: { search: '', href: 'chrome-extension://stub/ui/workspace.html', pathname: '/ui/workspace.html', reload() {} },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'history', { value: { replaceState() {}, back() {}, length: 1 }, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'URL', {
    value: Object.assign(URL, { createObjectURL: () => 'blob:stub', revokeObjectURL() {} }),
    configurable: true,
    writable: true,
  });
  const payload = {
    ok: true,
    entries: [],
    history: [],
    recordings: [],
    total: 0,
    result: { entries: [], history: [], recordings: [], total: 0 },
  };
  Object.defineProperty(globalThis, 'chrome', {
    value: {
      runtime: {
        getURL: (suffix) => 'chrome-extension://stub/' + (suffix || ''),
        sendMessage: async (message) => { sent.push(message && message.type); return payload; },
        onMessage: { addListener() {} },
        lastError: null,
      },
      storage: {
        session: { get: async () => ({}), set: async () => {} },
        local: { get: async () => ({}), set: async () => {} },
      },
    },
    configurable: true,
    writable: true,
  });
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  globalThis.MutationObserver = class { observe() {} };
  return { doc, sent };
}

/* ---------------- 1. 新页面首屏 ---------------- */

test('workspace.js 在空数据 + DOM/chrome 桩下完成首屏并暴露只读快照', async () => {
  installStubs();
  const module = await import(pathToFileURL(path.join(ROOT, UI + 'workspace.js')).href);
  // 等首屏异步（storage.get）完成。
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(typeof module.workspaceSnapshot, 'function');
  const snapshot = module.workspaceSnapshot();
  assert.equal(snapshot.rows, 0);
  assert.equal(snapshot.tab, 'data');
  assert.equal(snapshot.page, 1);
  assert.deepEqual(snapshot.compare, []);
  assert.deepEqual(snapshot.filter, { matched: 0, total: 0 });
  assert.equal(snapshot.columns.length >= 5, true);
  assert.equal(snapshot.columnsSummary, '5 / 5 列可见');
  assert.ok(snapshot.status.includes('导入'), '空态应提示导入/载入：' + snapshot.status);
  // 首屏不能抛到全局（页面用 note 提示错误，这里 status 不应是异常文本）。
  assert.doesNotMatch(snapshot.status, /is not a function|undefined is not/);
});

/* ---------------- 2. 新页面/样式静态门禁 ---------------- */

test('新页面静态 a11y / 焦点 / RTL 逻辑属性：0 findings', () => {
  const html = read(UI + 'workspace.html');
  assert.match(html, /<html lang="zh-CN">/);
  assert.match(html, /<title>[^<]+<\/title>/);
  assert.match(html, /<script src="direction\.js"><\/script>/);
  assert.match(html, /<script type="module" src="i18n\.js"><\/script>/);
  assert.match(html, /<script type="module" src="workspace\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="workspace\.css"/);
  // 静态 a11y（按钮/输入/标签/tabindex 等规则）零 findings。
  assert.deepEqual(auditHtml({ file: UI + 'workspace.html', text: html }), []);
  // 焦点样式：有 :focus-visible 且 outline 用 token。
  assert.deepEqual(auditFocusCss({ file: UI + 'workspace.css', text: read(UI + 'workspace.css') }), []);
  assert.match(read(UI + 'workspace.css'), /:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--accent\)/);
  // 样式表与页面里不能有物理方向属性（RTL 门禁用同一份规则）。
  const sources = [
    { file: UI + 'workspace.css', text: read(UI + 'workspace.css'), kind: 'css' },
    { file: UI + 'workspace.html', text: html, kind: 'html' },
    { file: UI + 'workspace.js', text: read(UI + 'workspace.js'), kind: 'js' },
  ];
  const rtl = auditRtlSources(sources, { exemptions: DEFAULT_EXEMPTIONS });
  assert.deepEqual(rtl.findings.map(formatFinding), []);
  // 逻辑属性确实被使用（不是“碰巧没写”）。
  assert.match(read(UI + 'workspace.css'), /inset-inline|margin-block|padding-inline/);
  // HTML 静态中文会进 12 语言词条门禁：新页面用 JS 本地化，不写死中文。
  assert.doesNotMatch(html, /[\u4e00-\u9fa5]/);
});

test('新页面与 ui.css 新增块不引入正数 tabindex / 阻塞对话框 / 物理 inline style', () => {
  const js = read(UI + 'workspace.js');
  assert.doesNotMatch(js, /tabindex\s*=\s*["']?[1-9]/);
  assert.doesNotMatch(js, /window\.confirm\(|(?<![\w.])alert\(/);
  const html = read(UI + 'workspace.html');
  assert.doesNotMatch(html, /style="/, '页面不应有内联样式（RTL/a11y 双重门禁）');
  const uiCss = read(UI + 'ui.css');
  assert.match(uiCss, /\.io-inline-tools/);
  assert.match(uiCss, /\.filter-chip/);
  assert.doesNotMatch(uiCss, /margin-left\s*:|padding-left\s*:/);
  assert.match(uiCss, /:focus-visible/);
});

/* ---------------- 3. SELFTEST 契约逐字冻结 ---------------- */

test('SELFTEST 标题契约逐字不变（29–35 系列 E2E 依赖）', () => {
  const contracts = {
    debug: [
      "new URLSearchParams(location.search).get('selftest') === '1'",
      "new URLSearchParams(location.search).get('selftest') === 'replay'",
      "new URLSearchParams(location.search).get('selftest') === 'perf'",
      "new URLSearchParams(location.search).get('selftest') === 'rules'",
      "'SELFTEST:ok:debug:' + stopped.requests + ':' + stopped.console",
      "'SELFTEST:ok:replay:' + (replayed.status != null ? replayed.status : '?')",
      "'SELFTEST:ok:perf:' + Object.keys(metrics).length",
      "'SELFTEST:ok:rules:' + rules.length",
      "'SELFTEST:fail:' + ((error && error.message) || error)",
    ],
    audit: [
      "new URLSearchParams(location.search).get('selftest') === '1'",
      "'SELFTEST:ok:audit:' + ((result.entries || []).length)",
      "'SELFTEST:fail:' + ((error && error.message) || error)",
    ],
    ops: [
      "new URLSearchParams(location.search).get('selftest') === '1'",
      "'SELFTEST:ok:ops:' + recordings.length + ':' + events",
    ],
    record: [
      "const selftest = new URLSearchParams(location.search).get('selftest')",
      "if (selftest === '1')",
      "} else if (selftest === 'seed')",
      "'SELFTEST:ok:video:' + records.length + ':' + (String(latest.mime).includes('mp4') ? 'mp4' : 'webm') + ':' + latest.bytes",
      "'SELFTEST:fail:no-video-file'",
      "'SELFTEST:ok:seed:' + id + ':' + blob.size + ':' + (mime.includes('mp4') ? 'mp4' : 'webm')",
    ],
    longshot: [
      "const selftest = new URLSearchParams(location.search).get('selftest')",
      "if (selftest === 'restore')",
      "} else if (selftest === '1')",
      "'SELFTEST:ok:restore:' + list[0].tiles + ':' + stitched.width + 'x' + stitched.height",
      "'SELFTEST:ok:longshot:' + result.width + 'x' + result.height",
    ],
  };
  for (const [page, needles] of Object.entries(contracts)) {
    const source = read(PAGES[page]);
    for (const needle of needles) {
      assert.ok(source.includes(needle), page + ' 的 SELFTEST 契约被改动：缺 ' + needle);
    }
  }
  // 页面入口脚本 / HTML 本地化依赖保持不变。
  for (const page of Object.keys(PAGES)) {
    const html = read(UI + page + '.html');
    assert.match(html, new RegExp('<script type="module" src="' + page + '\\.js"></script>'), page + '.html 入口脚本被改动');
    assert.match(html, /<script src="direction\.js"><\/script>/);
    assert.match(html, /<script type="module" src="i18n\.js"><\/script>/);
  }
});

test('既有页面行为未被削弱：第十批 E 的 helper 消费点仍在', () => {
  const consumptions = [
    ['debug', 'buildTimelineView({'],
    ['debug', 'buildCaptureCompareView({'],
    ['debug', 'rpc.daemon('],
    ['audit', 'buildPagingModel({'],
    ['audit', 'rpc.send('],
    ['ops', 'buildSequenceCompareView({'],
    ['ops', 'buildSequenceView({'],
    ['record', 'buildHistoryView({'],
    ['record', 'buildTimelineView({'],
    ['longshot', 'buildHistoryView({'],
    ['longshot', 'buildTimelineView({'],
  ];
  for (const [page, needle] of consumptions) {
    assert.ok(read(PAGES[page]).includes(needle), page + ' 丢失既有消费点：' + needle);
  }
  // 页面仍把 operations.list 经真实 RPC 转发（不是残留 bb.call）。
  assert.ok(read(PAGES.debug).includes("rpc.daemon('operations.list'"));
  assert.doesNotMatch(read(PAGES.debug), /type:\s*'bb\.call'/);
});

/* ---------------- 4. 页面接线证据 ---------------- */

test('五个旧页面真实安装 page-tools（surface/toolsId/rows 可定位）', () => {
  const wiring = {
    debug: { toolsId: 'liveTools', rows: '(lastLive && Array.isArray(lastLive.requests) ? lastLive.requests : [])' },
    audit: { toolsId: 'auditTools', rows: 'auditViewEntries' },
    ops: { toolsId: 'opsTools', rows: 'opsRecordings()' },
    record: { toolsId: 'recordTools', rows: 'videoRecords' },
    longshot: { toolsId: 'longshotTools', rows: 'longshotCache' },
  };
  for (const [page, expected] of Object.entries(wiring)) {
    const source = read(PAGES[page]);
    assert.ok(source.includes("import { installPageTools } from './lib/page-tools.js'"), page + ' 没有 import page-tools');
    assert.ok(source.includes("installPageTools({"), page + ' 没有调用 installPageTools');
    assert.ok(source.includes("surface: '" + page + "'"), page + ' 安装参数 surface 不对');
    assert.ok(source.includes("toolsId: '" + expected.toolsId + "'"), page + ' 安装容器不对');
    assert.ok(source.includes('rows: () => ' + expected.rows), page + ' 行 provider 不对');
    // 安装必须在 SELFTEST 代码之后（不改契约顺序）。
    const selftestIndex = source.indexOf('SELFTEST');
    const installIndex = source.indexOf('installPageTools({');
    assert.ok(installIndex > selftestIndex, page + ' 安装位置应在 SELFTEST 之后');
  }
});

test('新页面真实消费全部新 lib/views（不是写了没人用）', () => {
  const source = read(UI + 'workspace.js');
  const expected = [
    './lib/io-export.js',
    './lib/io-import.js',
    './lib/filter-model.js',
    './lib/columns-model.js',
    './lib/diff-nav.js',
    './lib/aria-live.js',
    './lib/keyboard-grid.js',
    './views/io-toolbar.js',
    './views/filter-bar.js',
    './views/columns-panel.js',
    './views/import-report.js',
    './views/export-preview.js',
    './views/compare-matrix.js',
    './views/diff-toolbar.js',
    './views/empty-state-view.js',
  ];
  for (const spec of expected) {
    assert.ok(source.includes("from '" + spec + "'"), 'workspace.js 没有消费 ' + spec);
  }
  // 空态模型经视图模块消费（单点接线，避免页面同时依赖两份文案表）。
  assert.ok(read(UI + 'views/empty-state-view.js').includes("from '../lib/empty-state.js'"), 'empty-state-view 应包装 lib/empty-state');
  const calls = [
    'buildIoToolbar({',
    'buildFilterBar({',
    'buildColumnsPanel({',
    'buildImportReport({',
    'buildExportPreview({',
    'buildFieldCompareMatrix({',
    'buildDiffPanel({',
    'buildEmptyStateView({',
    'buildRunPicker({',
    'buildMergeChooser(',
    'parseImport(',
    'validateImport(',
    'mergeImported(',
    'buildExportPayload(',
    'filterRows(',
    'createDiffNavigator(',
    'createGridSelection(',
    'createAnnouncer(',
  ];
  for (const call of calls) assert.ok(source.includes(call), 'workspace.js 没有真正调用 ' + call);
});

test('新增 lib/views 全部可被 Node 直接 import（无顶层 DOM/chrome 依赖）', async () => {
  const files = [
    'lib/io-export.js', 'lib/io-import.js', 'lib/filter-model.js', 'lib/columns-model.js',
    'lib/diff-nav.js', 'lib/empty-state.js', 'lib/aria-live.js', 'lib/keyboard-grid.js', 'lib/page-tools.js',
    'views/io-toolbar.js', 'views/filter-bar.js', 'views/columns-panel.js', 'views/import-report.js',
    'views/export-preview.js', 'views/compare-matrix.js', 'views/diff-toolbar.js', 'views/empty-state-view.js',
  ];
  for (const file of files) {
    const module = await import(pathToFileURL(path.join(ROOT, UI + file)).href);
    assert.ok(Object.keys(module).length >= 2, file + ' 导出的 API 太少');
  }
});

/* ---------------- 5. 新文案目录 ---------------- */

test('新页面/新视图用到的文案 key 全部收录在 labels 目录', () => {
  const sources = [
    UI + 'workspace.js',
    UI + 'lib/io-export.js',
    UI + 'lib/io-import.js',
    UI + 'lib/filter-model.js',
    UI + 'lib/columns-model.js',
    UI + 'lib/diff-nav.js',
    UI + 'lib/empty-state.js',
    UI + 'lib/aria-live.js',
    UI + 'lib/keyboard-grid.js',
    UI + 'lib/page-tools.js',
    UI + 'views/io-toolbar.js',
    UI + 'views/filter-bar.js',
    UI + 'views/columns-panel.js',
    UI + 'views/import-report.js',
    UI + 'views/export-preview.js',
    UI + 'views/compare-matrix.js',
    UI + 'views/diff-toolbar.js',
    UI + 'views/empty-state-view.js',
  ];
  const keys = new Set();
  for (const file of sources) {
    const source = read(file);
    for (const match of source.matchAll(/(?:formatLabel|t)\(\s*'([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)'/g)) keys.add(match[1]);
    for (const match of source.matchAll(/labelKey:\s*'([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)'/g)) keys.add(match[1]);
  }
  assert.ok(keys.size >= 80, '扫描到的文案 key 太少：' + keys.size);
  const missing = [...keys].filter((key) => !hasLabel(key));
  assert.deepEqual(missing, [], '缺文案 key：' + missing.join(', '));
});

/* ---------------- 6. 对照基线：本轮只新增，不动契约 ---------------- */

test('本轮改动不碰契约文件：i18n.js / locales.js / direction.js / popup* 结构稳定', () => {
  // 这些文件属于 12 语言/弹窗/主题门禁的“冻结输入”，本轮不许改（只校验非空与关键结构）。
  const frozen = {
    'i18n.js': /export function getLang/,
    'locales.js': /export const LOCALE_TEXT|export const SUPPORTED_LANGS/,
    'direction.js': /RTL_LANGS|data-bb-dir/,
    'popup.js': /SELFTEST:ok:popup/,
    'popup.css': /:focus-visible/,
    'error-hints.js': /export const ERROR_HINTS/,
    'a11y-dialog.js': /export function announce/,
  };
  for (const [file, pattern] of Object.entries(frozen)) {
    const source = read(UI + file);
    assert.ok(source.length > 100, file + ' 被清空');
    assert.match(source, pattern, file + ' 关键结构丢失');
  }
  assert.match(read(UI + 'popup.html'), /<html lang="zh-CN">/);
  // 新增文件必须都在 extension/ui/** 下（本轮写域）。
  for (const file of ['workspace.js', 'workspace.html', 'workspace.css', 'lib/io-export.js', 'views/io-toolbar.js']) {
    assert.ok(fs.existsSync(path.join(ROOT, UI + file)), file + ' 不存在');
  }
});
