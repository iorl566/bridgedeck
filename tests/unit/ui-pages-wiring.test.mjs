// tests/unit/ui-pages-wiring.test.mjs —— 页面深度交互接线 + SELFTEST 契约不变门禁。
//
// 这一批（第十批 E）只允许「增强」UI 页面：29–35 系列 E2E 依赖的
// `SELFTEST:ok:*` 标题契约、页面入口脚本、selftest 触发参数必须保持原样。
// 本测试同时确认新 helper 真的被页面消费（不是写了没人用）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const lineOf = (text, needle) => text.split('\n').findIndex((line) => line.includes(needle)) + 1;

const PAGES = {
  debug: 'extension/ui/debug.js',
  audit: 'extension/ui/audit.js',
  ops: 'extension/ui/ops.js',
  record: 'extension/ui/record.js',
  longshot: 'extension/ui/longshot.js',
};

test('SELFTEST 标题契约逐字保持不变（E2E 29–35 系列依赖）', () => {
  const contracts = {
    debug: [
      "'SELFTEST:ok:debug:'",
      "'SELFTEST:ok:replay:'",
      "'SELFTEST:ok:perf:'",
      "'SELFTEST:ok:rules:'",
      "get('selftest') === '1'",
      "get('selftest') === 'replay'",
      "get('selftest') === 'perf'",
      "get('selftest') === 'rules'",
    ],
    audit: ["'SELFTEST:ok:audit:'", "get('selftest') === '1'"],
    ops: ["'SELFTEST:ok:ops:'", "get('selftest') === '1'"],
    record: ["'SELFTEST:ok:video:'", "'SELFTEST:ok:seed:'", "selftest === '1'", "selftest === 'seed'"],
    longshot: ["'SELFTEST:ok:longshot:'", "'SELFTEST:ok:restore:'", "selftest === '1'", "selftest === 'restore'"],
  };
  for (const [page, needles] of Object.entries(contracts)) {
    const source = read(PAGES[page]);
    for (const needle of needles) {
      assert.ok(source.includes(needle), page + ' 的 SELFTEST 契约被改动：缺 ' + needle);
    }
  }
  // 页面 HTML 仍加载各自的模块入口（E2E 通过 URL 打开这些页面）。
  for (const page of Object.keys(PAGES)) {
    const html = read('extension/ui/' + page + '.html');
    assert.match(html, new RegExp('<script type="module" src="' + page + '\\.js"></script>'), page + '.html 入口脚本被改动');
    assert.match(html, /<html lang="zh-CN">/);
    assert.match(html, /<script src="direction\.js"><\/script>/);
    assert.match(html, /<script type="module" src="i18n\.js"><\/script>/);
  }
});

test('页面真实消费新 helper（file:line 可定位）', () => {
  const consumptions = [
    ['extension/ui/debug.js', 'extension/ui/lib/rpc.js'],
    ['extension/ui/debug.js', 'extension/ui/views/timeline-view.js'],
    ['extension/ui/debug.js', 'extension/ui/views/compare-view.js'],
    ['extension/ui/debug.js', 'extension/ui/lib/table.js'],
    ['extension/ui/debug.js', 'extension/ui/lib/states.js'],
    ['extension/ui/debug.js', 'extension/ui/lib/focus.js'],
    ['extension/ui/debug.js', 'extension/ui/lib/keyboard.js'],
    ['extension/ui/debug.js', 'extension/ui/lib/view-state.js'],
    ['extension/ui/audit.js', 'extension/ui/lib/rpc.js'],
    ['extension/ui/audit.js', 'extension/ui/lib/table.js'],
    ['extension/ui/audit.js', 'extension/ui/lib/paging.js'],
    ['extension/ui/audit.js', 'extension/ui/views/timeline-view.js'],
    ['extension/ui/audit.js', 'extension/ui/lib/keyboard.js'],
    ['extension/ui/audit.js', 'extension/ui/lib/states.js'],
    ['extension/ui/ops.js', 'extension/ui/views/history-view.js'],
    ['extension/ui/ops.js', 'extension/ui/views/compare-view.js'],
    ['extension/ui/ops.js', 'extension/ui/views/timeline-view.js'],
    ['extension/ui/ops.js', 'extension/ui/lib/rpc.js'],
    ['extension/ui/record.js', 'extension/ui/views/history-view.js'],
    ['extension/ui/record.js', 'extension/ui/views/timeline-view.js'],
    ['extension/ui/record.js', 'extension/ui/lib/labels.js'],
    ['extension/ui/longshot.js', 'extension/ui/views/history-view.js'],
    ['extension/ui/longshot.js', 'extension/ui/views/timeline-view.js'],
    ['extension/ui/longshot.js', 'extension/ui/lib/focus.js'],
  ];
  for (const [page, helper] of consumptions) {
    const source = read(page);
    const importSpec = './' + path.relative(path.dirname(page), helper).replace(/\\/g, '/');
    assert.ok(source.includes("from '" + importSpec + "'"), page + ' 没有 import ' + helper + '（期望 ' + importSpec + '）');
    const line = lineOf(source, importSpec);
    assert.ok(line > 0, page + ' 的 import 行号异常');
  }
  // 关键调用点（不只是 import）：确认 helper 函数真的被调用。
  const calls = [
    ['extension/ui/debug.js', 'buildTimelineView({'],
    ['extension/ui/debug.js', 'buildCaptureCompareView({'],
    ['extension/ui/debug.js', 'rpc.daemon('],
    ['extension/ui/audit.js', 'buildTimelineView({'],
    ['extension/ui/audit.js', 'buildPagingModel({'],
    ['extension/ui/audit.js', 'rpc.send('],
    ['extension/ui/ops.js', 'buildSequenceCompareView({'],
    ['extension/ui/ops.js', 'buildSequenceView({'],
    ['extension/ui/record.js', 'buildHistoryView({'],
    ['extension/ui/record.js', 'buildTimelineView({'],
    ['extension/ui/longshot.js', 'buildHistoryView({'],
    ['extension/ui/longshot.js', 'buildTimelineView({'],
  ];
  for (const [page, call] of calls) {
    const source = read(page);
    assert.ok(source.includes(call), page + ' 没有真正调用 ' + call);
  }
});

test('debug 页把 operations.list 改成真实 RPC（原 bb.call 在后台没有处理分支）', () => {
  const source = read('extension/ui/debug.js');
  assert.ok(source.includes("rpc.daemon('operations.list'"), 'operations.list 必须经 bb.daemon.call 转发');
  assert.doesNotMatch(source, /type:\s*'bb\.call'/, '残留的 bb.call 在后台没有 handler');
});

test('页面加载/错误/空态与 aria：新容器存在且无内联中文（避免绕过 i18n 门禁）', () => {
  const containers = {
    'extension/ui/debug.html': ['liveTools', 'requestsTimeline', 'comparePanel', 'compareBody'],
    'extension/ui/audit.html': ['auditTools', 'auditSummary', 'auditTimeline', 'auditPager', 'auditDetail'],
    'extension/ui/ops.html': ['opsTools', 'opsPager', 'opsTimeline', 'opsComparePanel'],
    'extension/ui/record.html': ['recordTools', 'recordPager', 'recordTimeline', 'recordDetail'],
    'extension/ui/longshot.html': ['longshotTools', 'longshotList', 'longshotPager', 'longshotTimeline'],
  };
  for (const [file, ids] of Object.entries(containers)) {
    const source = read(file);
    for (const id of ids) {
      assert.ok(source.includes('id="' + id + '"'), file + ' 缺容器 #' + id);
    }
    // 新容器里的 aria-label 用英文占位（运行时会本地化），不引入未登记中文。
    for (const match of source.matchAll(/id="(?:liveTools|requestsTimeline|comparePanel|auditTools|auditSummary|auditTimeline|auditPager|auditDetail|opsTools|opsPager|opsTimeline|opsComparePanel|recordTools|recordPager|recordTimeline|recordDetail|longshotTools|longshotList|longshotPager|longshotTimeline)"[^>]*aria-label="([^"]*)"/g)) {
      assert.doesNotMatch(match[1], /[\u4e00-\u9fa5]/, file + ' 新容器 aria-label 不应写死中文：' + match[1]);
    }
  }
  // 动态状态区域要能被读屏播报
  const audit = read('extension/ui/audit.html');
  assert.match(audit, /id="auditSummary"[^>]*role="status"[^>]*aria-live="polite"/);
  const note = read('extension/ui/audit.html');
  assert.match(note, /id="note"/, '审计页 note 区域仍在（错误提示接线依赖）');
});

test('新增 UI helper 目录结构完整，全部 Node 可直接 import（无顶层 DOM 依赖）', async () => {
  const libDir = path.join(ROOT, 'extension', 'ui', 'lib');
  const viewDir = path.join(ROOT, 'extension', 'ui', 'views');
  const libs = fs.readdirSync(libDir).filter((file) => file.endsWith('.js')).sort();
  const views = fs.readdirSync(viewDir).filter((file) => file.endsWith('.js')).sort();
  assert.ok(libs.length >= 12, 'helper 数量不足：' + libs.join(','));
  assert.ok(views.length >= 3, '视图模块数量不足：' + views.join(','));
  for (const file of libs) {
    const module = await import('../../extension/ui/lib/' + file);
    assert.ok(Object.keys(module).length > 0, file + ' 没有导出');
  }
  for (const file of views) {
    await import('../../extension/ui/views/' + file);
  }
  // 页面用到的 helper 都必须存在（防止 import 路径拼错）。
  for (const page of Object.values(PAGES)) {
    const source = read(page);
    for (const match of source.matchAll(/from '\.\/(lib|views)\/([a-z-]+)\.js'/g)) {
      const target = path.join(ROOT, 'extension', 'ui', match[1], match[2] + '.js');
      assert.ok(fs.existsSync(target), page + ' import 了不存在的 ' + target);
    }
  }
});

test('无回归：页面仍无正数 tabindex / 阻塞式 confirm，样式表保留焦点可见', () => {
  for (const page of Object.values(PAGES)) {
    const source = read(page);
    assert.doesNotMatch(source, /tabindex\s*=\s*["']?[1-9]/, page + ' 出现正数 tabindex');
    assert.doesNotMatch(source, /(?<![\w.])window\.confirm\(|(?<![\w.])alert\(/, page + ' 使用阻塞式原生对话框');
  }
  const css = read('extension/ui/ui.css');
  for (const className of ['state-block', 'pager', 'filters', 'tl-root', 'tl-bar', 'cmp-root', 'diff-row', 'list-spacer']) {
    assert.ok(css.includes('.' + className), 'ui.css 缺新样式 .' + className);
  }
  assert.match(css, /:focus-visible/, 'ui.css 焦点可见样式不能删');
  assert.doesNotMatch(css, /margin-left\s*:|padding-left\s*:/, 'ui.css 不应新增物理方向属性');
});
