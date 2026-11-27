// tests/unit/ui-page-tools.test.mjs —— 旧页面 IO 增强（extension/ui/lib/page-tools.js）单测。
//
// 用最小 DOM 桩验证：工具栏安装、导出载荷（脱敏）、复制、导入校验/合并、重复安装防护、
// 下载描述符与 DOM 兜底行读取。目标是把“页面接线”这段唯一 DOM 代码也纳入测试。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PAGE_EXPORT_COLUMNS,
  columnsForPage,
  copyText,
  downloadText,
  emptyExportHint,
  installPageTools,
  pageToolsDescriptor,
  previewPayload,
  readDomRows,
  rowsToObjects,
} from '../../extension/ui/lib/page-tools.js';

function makeElement(tag = 'div') {
  const element = {
    tagName: String(tag).toUpperCase(),
    children: [],
    childNodes: [],
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    className: '',
    textContent: '',
    hidden: false,
    value: '',
    files: [],
    type: '',
    accept: '',
    href: '',
    download: '',
    rel: '',
    attributes: {},
    listeners: {},
    appendChild(child) { this.children.push(child); return child; },
    append(...items) { this.children.push(...items); },
    insertBefore(child) { this.children.push(child); return child; },
    remove() {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
    addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); },
    removeEventListener() {},
    click() { this.clicked = (this.clicked || 0) + 1; },
    focus() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
    cloneNode() { return makeElement(tag); },
  };
  return element;
}

function makeDocument() {
  const ids = new Map();
  const created = [];
  const doc = {
    body: makeElement('body'),
    documentElement: makeElement('html'),
    createElement(tag) { const node = makeElement(tag); created.push(node); return node; },
    createTextNode(text) { const node = makeElement('#text'); node.textContent = String(text); return node; },
    createDocumentFragment() { return makeElement('#fragment'); },
    getElementById(id) { return ids.get(id) || null; },
    querySelector() { return null; },
    addEventListener() {},
  };
  doc.__ids = ids;
  doc.__created = created;
  return doc;
}

test('页面列目录：每个页面都有 3 列以上，未知回退 debug', () => {
  for (const surface of ['debug', 'audit', 'ops', 'record', 'longshot']) {
    const columns = columnsForPage(surface);
    assert.ok(columns.length >= 3, surface + ' 列太少');
    assert.ok(columns.every((column) => column.key && column.label));
    assert.equal(columns, PAGE_EXPORT_COLUMNS[surface]);
  }
  assert.equal(columnsForPage('nope'), PAGE_EXPORT_COLUMNS.debug);
});

test('installPageTools：缺少容器时静默返回 null；安装后重复调用返回 null', () => {
  const doc = makeDocument();
  assert.equal(installPageTools({ surface: 'audit', toolsId: 'auditTools', doc }), null);
  const container = makeElement();
  doc.__ids.set('auditTools', container);
  const handle = installPageTools({ surface: 'audit', toolsId: 'auditTools', doc, rows: () => [{ ts: 1 }, { ts: 2 }] });
  assert.ok(handle);
  assert.equal(container.children.length >= 3, true, '应追加工具栏/文件输入/报告容器');
  assert.equal(container.dataset.bbIoTools, '1');
  assert.equal(installPageTools({ surface: 'audit', toolsId: 'auditTools', doc }), null);
  assert.match(handle.statusText(), /2 行/);
});

test('installPageTools：导出载荷脱敏 + 下载描述符 + 状态播报', () => {
  const doc = makeDocument();
  const container = makeElement();
  doc.__ids.set('liveTools', container);
  const downloads = [];
  const rows = [{ ts: 1, url: 'https://api/a?token=secret', method: 'GET' }, { ts: 2, url: 'https://api/b', method: 'POST' }];
  const handle = installPageTools({
    surface: 'debug',
    toolsId: 'liveTools',
    doc,
    rows: () => rows,
    download: (descriptor) => { downloads.push(descriptor); return true; },
  });
  const payload = handle.exportNow('csv');
  assert.equal(payload.format, 'csv');
  assert.equal(payload.rowCount, 2);
  assert.ok(payload.redacted >= 1, 'URL token 应被脱敏');
  assert.doesNotMatch(payload.text, /token=secret/);
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].name, /\.csv$/);
  assert.match(handle.statusText(), /已导出 2 行/);

  // JSON 导出同样可用。
  const json = handle.exportNow('json');
  assert.equal(json.mime, 'application/json;charset=utf-8');
  assert.equal(JSON.parse(json.text).rows.length, 2);
});

test('installPageTools：导入文本 → 解析/校验/合并报告；下载合并结果', () => {
  const doc = makeDocument();
  const container = makeElement();
  doc.__ids.set('opsTools', container);
  const rows = [{ ts: 1, type: 'click' }];
  const downloads = [];
  const handle = installPageTools({
    surface: 'ops',
    toolsId: 'opsTools',
    doc,
    rows: () => rows,
    download: (descriptor) => { downloads.push(descriptor); return true; },
  });
  const result = handle.importText('method,status\nGET,200\nPOST,500', 'import.csv');
  assert.equal(result.parsed.format, 'csv');
  assert.equal(result.parsed.objects.length, 2);
  assert.equal(result.merge.stats.existing, 1);
  assert.equal(result.merge.stats.appended, 2);
  assert.equal(result.preview.total, 2);
  assert.ok(container.children.some((child) => child.className === 'io-report-host'));
  const downloaded = handle.downloadImportResult();
  assert.equal(downloaded.rowCount, 3);
  assert.equal(downloads.length, 1);

  // 空文本不产生导入结果，只提示。
  const empty = handle.importText('', '');
  assert.equal(empty.parsed.ok, false);
});

test('installPageTools：没有 rows provider 时从 DOM 列表兜底读行', () => {
  const doc = makeDocument();
  const container = makeElement();
  const list = makeElement();
  list.children = [
    Object.assign(makeElement('div'), { textContent: 'GET 200 https://a' }),
    Object.assign(makeElement('div'), { textContent: 'POST 500 https://b' }),
    Object.assign(makeElement('div'), { textContent: '   ' }),
  ];
  doc.__ids.set('recordTools', container);
  doc.__ids.set('list', list);
  const handle = installPageTools({ surface: 'record', toolsId: 'recordTools', listId: 'list', doc });
  assert.equal(handle.rows().length, 2);
  const payload = handle.exportNow('json');
  assert.equal(payload.rowCount, 2);
  assert.match(payload.text, /GET 200/);
});

test('copyText：无 clipboard 返回 false；有 clipboard 调用 writeText', async () => {
  assert.equal(await copyText('x', { clipboard: null }), false);
  const written = [];
  assert.equal(await copyText('hello', { clipboard: { writeText: async (value) => { written.push(value); } } }), true);
  assert.deepEqual(written, ['hello']);
  assert.equal(await copyText('x', { clipboard: { writeText: async () => { throw new Error('denied'); } } }), false);
});

test('installPageTools 复制：注入对象后状态变为已复制', async () => {
  const doc = makeDocument();
  const container = makeElement();
  doc.__ids.set('auditTools', container);
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true,
    writable: true,
  });
  try {
    const handle = installPageTools({ surface: 'audit', toolsId: 'auditTools', doc, rows: () => [{ a: 1 }] });
    const payload = await handle.copyNow('json');
    assert.equal(payload.rowCount, 1);
    assert.match(handle.statusText(), /已复制/);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
    else delete globalThis.navigator;
  }
});

test('downloadText：构造 Blob 链接并点击 a；缺能力返回 false', () => {
  const doc = makeDocument();
  const created = [];
  const url = { createObjectURL: () => 'blob:stub', revokeObjectURL: () => { url.revoked = true; } };
  const node = makeElement('a');
  doc.createElement = (tag) => { const createdNode = makeElement(tag); created.push(createdNode); return createdNode; };
  assert.equal(downloadText({ name: 'x.json', mime: 'application/json', text: '{}' }, { doc, url, anchor: node }), true);
  assert.equal(node.download, 'x.json');
  assert.equal(node.clicked, 1);
  // 无 URL 能力（传入不含 createObjectURL 的对象）。
  assert.equal(downloadText({ name: 'x', text: '' }, { doc, url: {} }), false);
  assert.equal(downloadText({ name: 'x', text: '' }, { doc: null }), false);
});

test('readDomRows / rowsToObjects / 描述与预览/空提示', () => {
  const list = makeElement();
  list.children = [
    Object.assign(makeElement(), { textContent: ' a   b ' }),
    Object.assign(makeElement(), { textContent: '' }),
  ];
  assert.deepEqual(readDomRows(list), [{ index: 0, text: 'a b' }]);
  assert.deepEqual(readDomRows(null), []);
  const rows = rowsToObjects(['x', { id: 1 }], [{ key: 'text' }]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].text, 'x');
  assert.equal(rows[1].id, 1);

  const descriptor = pageToolsDescriptor('debug', 'en');
  assert.equal(descriptor.length, 4);
  assert.equal(descriptor[0].format, 'json');
  assert.ok(descriptor.every((item) => item.label.length > 0 && item.surface === 'debug'));

  const payload = { rowCount: 2, preview: [{ a: 1 }], columns: [{ key: 'a' }], bytes: 10 };
  const preview = previewPayload(payload, [{ key: 'a', label: 'A' }], 'zh');
  assert.equal(preview.model.rows.length, 1);
  assert.equal(previewPayload(null), null);
  assert.equal(emptyExportHint('zh').children[0], '没有可导出的行');
});
