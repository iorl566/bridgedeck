// tests/content-advanced.test.ts —— 页面侧第三批能力（advanced.ts）单测。
//
// 用 tests/support/fake-dom 的最小 DOM 驱动：表格/多行表头/列表/网格提取、
// 度量与滚动、薄动作事件、按坐标点击、get-html 事实、DOM 指纹、资源计时读取。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clickPoint,
  domFingerprint,
  elementStateOf,
  extractPage,
  focusElement,
  hoverElement,
  pageMetrics,
  pressKey,
  readFieldSpecs,
  readResourceEntries,
  scrollPage,
  visualRefsOf,
  wheelScroll,
  dragElement,
} from '../src/content/advanced.ts';
import { clipHtml, getHtmlOf, buildObservation } from '../src/content/dom.ts';
import type { DomEnvironment, ElementLike } from '../src/content/dom.ts';
import { createFakeDom, type FakeElementSpec } from './support/fake-dom.ts';

function tableFixture(): FakeElementSpec[] {
  return [
    {
      tag: 'table',
      id: 'people',
      children: [
        {
          tag: 'tr',
          children: [
            { tag: 'th', text: '姓名' },
            { tag: 'th', text: '城市' },
          ],
        },
        { tag: 'tr', children: [{ tag: 'td', text: '张三' }, { tag: 'td', text: '北京' }] },
        { tag: 'tr', children: [{ tag: 'td', text: '李四' }, { tag: 'td', text: '上海' }] },
        { tag: 'tr', children: [{ tag: 'td', text: '王五' }, { tag: 'td', text: '深圳' }] },
      ],
    },
    {
      tag: 'table',
      id: 'multi-head',
      children: [
        {
          tag: 'tr',
          children: [
            { tag: 'th', text: '等级', attrs: { rowspan: '2' } },
            { tag: 'th', text: '金额', attrs: { colspan: '2' } },
          ],
        },
        { tag: 'tr', children: [{ tag: 'th', text: '小' }, { tag: 'th', text: '大' }] },
        { tag: 'tr', children: [{ tag: 'td', text: 'A' }, { tag: 'td', text: '1' }, { tag: 'td', text: '2' }] },
        { tag: 'tr', children: [{ tag: 'td', text: 'A' }, { tag: 'td', text: '3' }, { tag: 'td', text: '4' }] },
      ],
    },
    {
      tag: 'ul',
      id: 'items',
      children: [{ tag: 'li', text: '第一项' }, { tag: 'li', text: '第二项' }, { tag: 'li', text: '第三项' }],
    },
    {
      tag: 'div',
      id: 'demo-grid',
      attrs: { role: 'grid', 'aria-label': '示例网格' },
      children: [
        {
          tag: 'div',
          attrs: { role: 'row' },
          children: [
            { tag: 'div', attrs: { role: 'columnheader' }, text: '姓名' },
            { tag: 'div', attrs: { role: 'columnheader' }, text: '城市' },
          ],
        },
        {
          tag: 'div',
          attrs: { role: 'row' },
          children: [
            { tag: 'div', attrs: { role: 'gridcell' }, text: '张三' },
            { tag: 'div', attrs: { role: 'gridcell' }, text: '北京' },
          ],
        },
        {
          tag: 'div',
          attrs: { role: 'row' },
          children: [
            { tag: 'div', attrs: { role: 'gridcell' }, text: '李四' },
            { tag: 'div', attrs: { role: 'gridcell' }, text: '上海' },
          ],
        },
      ],
    },
    { tag: 'button', id: 'submit-btn', attrs: { class: 'primary selected' }, text: '提交查询' },
    { tag: 'a', id: 'ext-link', attrs: { href: 'https://example.com/x' }, text: '外链' },
  ];
}

function fixtureEnv(elements: FakeElementSpec[] = tableFixture()) {
  const fake = createFakeDom(elements, { title: '夹具页', url: 'https://example.test/test.html' });
  return fake;
}

test('advanced：pageMetrics 返回视口/滚动尺寸', () => {
  const fake = fixtureEnv();
  const metrics = pageMetrics(fake.env, 'doc-1');
  assert.equal(metrics.innerWidth, 1280);
  assert.equal(metrics.innerHeight, 800);
  assert.equal(metrics.scrollHeight >= 800, true);
  assert.equal(metrics.documentId, 'doc-1');
  assert.equal(metrics.url.includes('test.html'), true);
});

test('advanced：scrollPage 按 y 滚动并给出 clamped/视口', () => {
  const fake = fixtureEnv();
  (fake.window as { scrollHeight?: number }).scrollHeight = 4000;
  const result = scrollPage(fake.env, { x: 0, y: 3000 });
  assert.equal(result.ok, true);
  assert.equal(result.scrollY >= 0, true);
  assert.equal(result.viewport.height, 800);
  assert.equal(typeof result.clampedY, 'number');
});

test('advanced：scrollPage 滚到目标元素时返回 bounds', () => {
  const fake = fixtureEnv();
  const button = fake.byId.get('submit-btn');
  assert.ok(button);
  const result = scrollPage(fake.env, { resolved: { element: button as ElementLike, ref: null, selector: '#submit-btn' } });
  assert.ok(result.bounds);
  assert.equal(result.selector, '#submit-btn');
});

test('advanced：elementStateOf 给出 attached/visible/rect/role/name', () => {
  const fake = fixtureEnv();
  const button = fake.byId.get('submit-btn') as ElementLike;
  const state = elementStateOf(fake.env, { element: button, ref: null, selector: '#submit-btn' });
  assert.equal(state.attached, true);
  assert.equal(state.visible, true);
  assert.equal(state.role, 'button');
  assert.equal(state.name, '提交查询');
  assert.equal(state.inViewport, true);
  assert.equal(state.selector, '#submit-btn');
});

test('advanced：hover/focus/press/wheel 产生合成事件并标注 trusted=false', () => {
  const fake = fixtureEnv();
  const button = fake.byId.get('submit-btn') as ElementLike;
  const resolved = { element: button, ref: null, selector: '#submit-btn' };
  const hover = hoverElement(fake.env, resolved);
  assert.equal(hover.synthetic, true);
  assert.equal(hover.trusted, false);
  assert.equal(fake.events.filter((event) => event.type.startsWith('mouse')).length >= 2, true);
  const focus = focusElement(fake.env, resolved);
  assert.equal(focus.ok, true);
  assert.equal(focus.tag, 'button');
  const press = pressKey(fake.env, resolved, 'Enter');
  assert.equal(press.key, 'Enter');
  assert.equal(press.generated, 3);
  const wheel = wheelScroll(fake.env, null, 0, 120);
  assert.equal(wheel.ok, true);
  assert.equal(fake.events.some((event) => event.type === 'wheel'), true);
});

test('advanced：dragElement 派发 mousedown→mousemove→mouseup 序列', () => {
  const fake = fixtureEnv();
  const button = fake.byId.get('submit-btn') as ElementLike;
  const result = dragElement(fake.env, { element: button, ref: null, selector: '#submit-btn' }, { dx: 40, dy: 30, steps: 3 });
  assert.equal(result.steps, 3);
  assert.deepEqual(result.from, { x: button.getBoundingClientRect().left + 50, y: button.getBoundingClientRect().top + 15 });
  assert.equal(fake.events.filter((event) => event.type === 'mousemove').length, 3);
  assert.equal(fake.events.some((event) => event.type === 'mouseup'), true);
});

test('advanced：clickPoint 按页面坐标命中并点击', () => {
  const fake = createFakeDom(tableFixture(), {
    title: '夹具页',
    url: 'https://example.test/test.html',
    hitTest: (_x, _y) => fakeButton,
  });
  const fakeButton = fake.byId.get('submit-btn') as ElementLike;
  const rect = fakeButton.getBoundingClientRect();
  const result = clickPoint(fake.env, rect.left + 5, rect.top + 5);
  assert.equal(result.ok, true);
  assert.equal(result.tag, 'button');
  assert.equal((fakeButton as unknown as { clicked: number }).clicked >= 1, true);
});

test('advanced：extractPage 表格列名/行数/单元格', () => {
  const fake = fixtureEnv();
  const payload = extractPage(fake.env, new Map(), { selector: '#people' });
  assert.equal(payload.columns.length, 2);
  assert.equal(payload.columns[0]?.label, '姓名');
  assert.equal(payload.rows.length, 3);
  assert.equal(payload.rows[0]?.c1, '张三');
  assert.equal(payload.totalRows, 3);
  assert.equal(typeof payload.fingerprint, 'string');
});

test('advanced：extractPage 多行表头（rowspan/colspan）合并为 3 列', () => {
  const fake = fixtureEnv();
  const payload = extractPage(fake.env, new Map(), { selector: '#multi-head' });
  assert.deepEqual(payload.columns.map((column) => column.label), ['等级', '金额 / 小', '金额 / 大']);
  assert.equal(payload.rows.length, 2);
  assert.deepEqual(payload.rows[0], { c1: 'A', c2: '1', c3: '2' });
  assert.deepEqual(payload.rows[1], { c1: 'A', c2: '3', c3: '4' });
});

test('advanced：extractPage 列表字段映射与 maxRows', () => {
  const fake = fixtureEnv();
  const payload = extractPage(fake.env, new Map(), { mode: 'list', selector: '#items', itemSelector: 'li', fields: [{ key: 'text', read: 'text' }] });
  assert.equal(payload.rows.length, 3);
  assert.equal(payload.columns[0]?.key, 'text');
  assert.equal(payload.rows[0]?.text, '第一项');
});

test('advanced：extractPage discover 找到 table/list/grid 目标并带预览', () => {
  const fake = fixtureEnv();
  const payload = extractPage(fake.env, new Map(), { mode: 'discover' });
  assert.equal(payload.mode, 'discover');
  assert.equal(payload.frameCount, 1);
  assert.equal(payload.framesScanned, 1);
  assert.equal(payload.limits.maxFrames, 16);
  assert.equal(payload.limits.maxTargets, 32);
  assert.equal(payload.limits.previewColumns, 8);
  assert.equal(payload.targets.length >= 3, true);
  assert.equal(payload.targets.some((target) => target.kind === 'table' && target.label.includes('multi-head')), true);
  assert.equal(payload.targets.every((target) => Number.isInteger(target.frameId)), true);
  assert.equal(payload.targets.every((target) => target.preview.columns.length <= 8), true);
});

test('advanced：extractPage 按 discover target id 提取表格', () => {
  const fake = fixtureEnv();
  const discovered = extractPage(fake.env, new Map(), { mode: 'discover' });
  const gridTarget = discovered.targets.find((target) => target.kind === 'table' && target.label.includes('demo-grid'));
  assert.ok(gridTarget, 'discover 应找到 role=grid 目标：' + JSON.stringify(discovered.targets.map((t) => t.label)));
  const table = extractPage(fake.env, new Map(), { mode: 'table', target: String(gridTarget?.id) });
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[0]?.c1, '张三');
  assert.equal(table.columns.length, 2);
});

test('advanced：readFieldSpecs 按字段规格返回扁平对象', () => {
  const fake = fixtureEnv();
  const button = fake.byId.get('submit-btn') as ElementLike;
  const result = readFieldSpecs(fake.env, { element: button, ref: null, selector: '#submit-btn' }, [
    { key: 'v', read: 'text' },
    { key: 'c', read: 'attribute', attribute: 'class' },
  ]);
  assert.equal(result.flatFields[0]?.v, '提交查询');
  assert.equal(result.flatFields[0]?.c, 'primary selected');
});

test('advanced：visualRefsOf 过滤不可见节点并给出页面坐标', () => {
  const fake = fixtureEnv();
  const button = fake.byId.get('submit-btn') as ElementLike;
  const hidden = fake.byId.get('items') as ElementLike;
  (hidden as unknown as { style: { display: string } }).style = { display: 'none' };
  const result = visualRefsOf(fake.env, [
    { ref: '@e1', element: button },
    { ref: '@e2', element: hidden },
  ], 'https://example.test/');
  assert.equal(result.refs.length, 1);
  assert.equal(result.refs[0]?.ref, '@e1');
  assert.equal(result.refs[0]?.pageX >= result.refs[0]!.rect.x, true);
});

test('advanced：readResourceEntries 映射 PerformanceResourceTiming', () => {
  const fake = fixtureEnv();
  const entries = [
    {
      name: 'https://example.test/api/ping',
      initiatorType: 'fetch',
      startTime: 100,
      duration: 4,
      responseStatus: 200,
      transferSize: 330,
      encodedBodySize: 300,
      decodedBodySize: 280,
      responseStart: 102,
      requestStart: 100,
      responseEnd: 104,
    },
    {
      name: 'https://example.test/app.js',
      initiatorType: 'script',
      startTime: 50,
      duration: 10,
      responseStatus: 200,
      transferSize: 0,
      encodedBodySize: 0,
      decodedBodySize: 1000,
    },
  ];
  (fake.window as { performance?: unknown }).performance = {
    timeOrigin: 1000,
    now: () => 200,
    getEntriesByType: (type: string) => (type === 'resource' ? entries : []),
  };
  const result = readResourceEntries(fake.env);
  assert.equal(result.seen, 2);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[0]?.startedAt, 1100, 'startedAt = timeOrigin + startTime');
  assert.equal(result.entries[0]?.status, 200);
  assert.equal(result.entries[0]?.timings.ttfbMs, 2);
  assert.equal(result.entries[1]?.fromCache, true);
});

test('dom：getHtmlOf 整页 outerHTML + 截断事实', () => {
  const fake = fixtureEnv();
  (fake.document.documentElement as unknown as { outerHTML: string }).outerHTML = '<html><body><p>' + 'x'.repeat(500) + '</p></body></html>';
  const result = getHtmlOf(null, fake.env, { outer: true, maxChars: 100 });
  assert.equal(result.outer, true);
  assert.equal(result.truncated, true);
  assert.equal(result.html.length, 100);
  assert.equal(result.fullLength !== undefined && result.fullLength > 100, true);
  assert.ok(result.facts);
  assert.equal(typeof result.facts?.visible, 'boolean');
});

test('dom：clipHtml 不截断时 fullLength 等于原文长度', () => {
  const clipped = clipHtml('<b>x</b>', 100);
  assert.equal(clipped.truncated, false);
  assert.equal(clipped.fullLength, 8);
  const long = clipHtml('a'.repeat(50), 10);
  assert.equal(long.html.length, 10);
  assert.equal(long.truncated, true);
});

test('dom：domFingerprint 随 DOM 文本变化', () => {
  const fake = fixtureEnv();
  (fake.document.documentElement as unknown as { outerHTML: string }).outerHTML = '<html><body><div id="out">idle</div></body></html>';
  const before = domFingerprint(fake.env);
  (fake.document.documentElement as unknown as { outerHTML: string }).outerHTML = '<html><body><div id="out">cursor-stale</div></body></html>';
  const after = domFingerprint(fake.env);
  assert.notEqual(before, after);
});

test('dom：buildObservation 输出 row/链接目标/语义标记与可行动 ref', () => {
  const fake = fixtureEnv([
    { tag: 'tr', children: [{ tag: 'td', text: 'A' }, { tag: 'td', text: '1' }, { tag: 'td', text: '2' }] },
    { tag: 'a', attrs: { href: 'https://example.com/x' }, text: '外链' },
    { tag: 'button', attrs: { 'aria-expanded': 'true', 'aria-haspopup': 'menu', draggable: 'true' }, text: '菜单' },
  ]);
  const built = buildObservation(fake.env, {});
  assert.equal(/- row /.test(built.observation), true);
  assert.equal(built.observation.includes('→ example.com/x'), true);
  assert.equal(built.observation.includes('[expanded]'), true);
  assert.equal(built.observation.includes('[has-submenu]'), true);
  assert.equal(built.observation.includes('[draggable]'), true);
  assert.equal(/@e\d+/.test(built.observation), true);
});

test('dom：buildObservation maxDepth 截断标记', () => {
  const fake = fixtureEnv([
    {
      tag: 'div',
      children: [{ tag: 'div', children: [{ tag: 'div', children: [{ tag: 'button', text: '深层按钮' }] }] }],
    },
  ]);
  const built = buildObservation(fake.env, { maxDepth: 1 });
  assert.equal(built.observation.includes('截断更深层'), true);
  assert.ok(built.depthOmitted >= 1);
});

test('dom：buildObservation 预算省略字符数（omittedChars）与空页游标推进', () => {
  const fake = fixtureEnv([
    { tag: 'button', text: 'a'.repeat(160) },
    { tag: 'button', text: 'b'.repeat(160) },
    { tag: 'button', text: 'c'.repeat(160) },
    { tag: 'button', text: 'd'.repeat(160) },
  ]);
  const built = buildObservation(fake.env, { maxNodes: 40, maxChars: 200 });
  assert.equal(built.truncated, true);
  assert.ok(built.omittedChars > 0);
  assert.ok(built.observation.length > 0, '单行超预算时也应输出截断行，保证分页推进');
});
