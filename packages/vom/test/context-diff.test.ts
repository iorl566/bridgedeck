// packages/vom/test/context-diff.test.ts —— VOM 语义上下文（landmark/form/table）JS ↔ TS 差分测试。
//
// 覆盖边界：空/非对象输入、role 与 tag 两套锚点来源（含大小写与非法值）、表格页面事实与
// 页面图推导两条路径、table > form > landmark 嵌套父子链、ancestorIds/ancestors/ref 三种祖先
// 事实、跨 frame id 前缀与 frames 汇总、四类 limits 截断、以及重复/缺失 id 的异常事实。
//
// 除逐字段 deepEqual 外，还断言输出不变量（成员 ⊆ 输入、parentId 指向已存在组、depth 与
// parents 自洽、统计与组列表自洽），避免“两边一起错”也能过。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTEXT_LIMITS,
  LANDMARK_BY_TAG,
  LANDMARK_ROLES,
  FORM_GROUP_ROLES,
  TABLE_GROUP_ROLES,
  VOM_CONTEXT_VERSION,
  buildVomContext,
  classifyContextAnchor,
  frameIdOfContextNode,
} from '../src/index.ts';
import type {
  BuildVomContextInput,
  ContextKind,
  VomContextModel,
} from '../src/index.ts';

const js: any = await import('../../../extension/src/lib/vom-context.js');

function asInput(value: unknown): BuildVomContextInput {
  return value as BuildVomContextInput;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function entry(
  id: string,
  node: Record<string, unknown> | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { id, node, ...extra };
}

const CASES: readonly { label: string; input: unknown }[] = [
  { label: '空输入', input: {} },
  { label: 'undefined', input: undefined },
  { label: '非对象输入', input: 42 },
  {
    label: '非数组 entries + 非对象 graph',
    input: { entries: { a: 1 }, graph: 'x', frames: 'nope', limits: [] },
  },
  {
    label: 'landmark：role 与 tag 两套来源',
    input: {
      entries: [
        entry('@m1', { role: 'main', name: '主体' }),
        entry('@n1', { role: 'navigation', name: '导航' }),
        entry('@h1', { role: 'banner', name: '页头' }),
        entry('@c1', { role: 'contentinfo' }),
        entry('@a1', { tag: 'aside', name: '侧栏' }),
        entry('@s1', { tag: 'section' }),
        entry('@f1', { tag: 'form' }),
        entry('@sf', { role: 'searchbox' }, { ancestorIds: ['@sf2'] }),
        entry('@sf2', { role: 'search' }),
        entry('@r1', { role: 'region', tag: 'div' }),
        entry('@u1', { role: 'unknown-role', tag: 'div' }),
      ],
    },
  },
  {
    label: '表单：form/fieldset/group/radiogroup/search 容器',
    input: {
      entries: [
        entry('@form', { id: 'login', role: 'form', name: '登录' }),
        entry('@fs', { id: 'fs', tag: 'fieldset', name: '账号信息' }),
        entry('@grp', { id: 'grp', role: 'group', name: '选项组' }),
        entry('@radio', { id: 'radio', role: 'radiogroup', name: '性别' }),
        entry('@search', { id: 'search', role: 'search', name: '搜索' }),
        entry('@txt', { id: 'txt', role: 'textbox', name: '用户名' }, { ancestorIds: ['@fs', '@form'] }),
        entry('@r1', { id: 'r1', role: 'radio', name: '男' }, { ancestorIds: ['@radio'] }),
      ],
    },
  },
  {
    label: '表格：页面侧 tableFacts 优先',
    input: {
      entries: [
        entry('@tbl', { id: 'tbl', role: 'table', name: '用户表', tableFacts: {
          headers: [
            { id: 'h1', role: 'columnheader', name: '姓名' },
            { id: 'h2', name: '年龄' },
            { id: 'h3', name: '' },
          ],
          dataRows: 5,
          caption: '用户数据表',
        } }),
        entry('@tbl2', { id: 'tbl2', role: 'grid', tableFacts: { headers: [], dataRows: 'x', caption: '' } }),
        entry('@tbl3', { id: 'tbl3', tag: 'table', tableFacts: [] }),
      ],
    },
  },
  {
    label: '表格：页面图推导表头/行/题注',
    input: {
      entries: [entry('@cell', { id: 'cell', role: 'gridcell', name: '张三' })],
      graph: {
        nodes: [
          { id: 'tbl', role: 'table', name: '用户表' },
          { id: 'cap', tag: 'caption', name: '用户数据表' },
          { id: 'th1', tag: 'th', name: '姓名' },
          { id: 'th2', role: 'columnheader', domId: 'h2' },
          { id: 'rh', role: 'rowheader', name: '行头' },
          { id: 'r1', tag: 'tr' },
          { id: 'r2', role: 'row' },
          { id: 'wrong', tag: 'tr', parentId: 'elsewhere' },
          { id: 'deep', tag: 'tr', parentId: 'r1' },
        ],
        edges: [
          { type: 'child', from: 'tbl', to: 'th1' },
          { type: 'child', from: 'tbl', to: 'th2' },
          { type: 'child', from: 'tbl', to: 'rh' },
          { type: 'child', from: 'tbl', to: 'r1' },
          { type: 'child', from: 'tbl', to: 'r2' },
          { type: 'sibling', from: 'tbl', to: 'x' },
        ],
      },
    },
  },
  {
    label: '嵌套：table > form > landmark 链与父组',
    input: {
      entries: [
        entry('@main', { id: 'main', role: 'main' }),
        entry('@frm', { id: 'frm', role: 'form' }),
        entry('@tbl', { id: 'tbl', role: 'table' }),
        entry('@cell', { id: 'cell', role: 'gridcell', name: '单元格' }, {
          ancestorIds: ['@tbl', '@frm', '@main'],
        }),
        entry('@other', { id: 'other', role: 'textbox' }, { ancestorIds: ['@frm'] }),
      ],
    },
  },
  {
    label: '祖先事实：dom: 前缀 / ref / 缺失 id',
    input: {
      entries: [
        entry('@a', { id: 'a', role: 'textbox' }, {
          node: { id: 'a', role: 'textbox', ancestors: [
            { id: 'unknown-dom', role: 'navigation', name: '未知导航' },
            { ref: '@known', role: 'main' },
            { role: 'form' },
            null,
          ] },
        }),
        entry('@known', { id: 'known', role: 'main', name: '主体' }),
        entry('@b', null, { ancestorIds: ['@known'] }),
        entry('@c', { id: 'c' }, { node: { id: 'c', ancestors: { role: 'main' } } }),
      ],
      graph: { nodes: [{ id: '@known', role: 'main', name: '主体' }], edges: [] },
    },
  },
  {
    label: '跨 frame：f<id>: 前缀 + frames 汇总',
    input: {
      entries: [
        entry('f2:@e7', { id: 'e7', role: 'textbox', name: '子帧控件' }, { ancestorIds: ['f2:@f'] }),
        entry('f2:@f', { id: 'f', role: 'form', name: '子帧表单' }),
        entry('f3:@e1', { id: 'e1', role: 'navigation', name: '另一子帧导航' }),
        entry('@main', { id: 'main', role: 'main', name: '主帧主体' }),
      ],
      frames: [
        { frameId: 2, url: 'https://example.test/child', parentFrameId: 0 },
        { frameId: 3, url: null, parentFrameId: 'x' },
        { frameId: 'bad', url: 'u' },
        null,
      ],
    },
  },
  {
    label: 'limits 截断（groups/contexts/depth/headers）',
    input: {
      entries: [
        entry('@a1', { id: 'a1', role: 'form' }),
        entry('@a2', { id: 'a2', role: 'main' }),
        entry('@a3', { id: 'a3', role: 'navigation' }),
        entry('@a4', { id: 'a4', role: 'banner' }),
        entry('@e1', { id: 'e1', role: 'textbox' }, { ancestorIds: ['@a1', '@a2', '@a3', '@a4'] }),
        entry('@e2', { id: 'e2', role: 'table', tableFacts: { headers: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], dataRows: 1 } }),
        entry('@e3', { id: 'e3', role: 'region' }),
      ],
      limits: { groups: 2, contexts: 1, depth: 1, headers: 1, bogus: 7 },
    },
  },
  {
    label: '异常事实：重复 id / 空 id / 数组 tableFacts / 非数字 frame',
    input: {
      entries: [
        entry('', { id: 'x', role: 'form' }),
        entry('0', { id: 0, role: 42, tag: null, name: 123 }),
        entry('@dup', { id: 'dup', role: 'table' }),
        entry('@dup', { id: 'dup', role: 'table', tableFacts: { caption: 42 } }),
        { id: '@nonode' },
        { id: '@badanc', node: {}, ancestorIds: [] },
        { id: '@nested', node: null },
        entry('@grid', { id: 'grid', role: 'treegrid' }),
      ],
      graph: { nodes: [{ id: '@dup', role: 'table', name: '表' }, { id: null }], edges: [] },
      frames: [{ frameId: 1.5 }, { frameId: -1 }],
    },
  },
];

function buildPair(value: unknown): { tsModel: VomContextModel; jsModel: any } {
  const inputValue = value === undefined ? {} : value;
  return { tsModel: buildVomContext(asInput(inputValue)), jsModel: js.buildVomContext(inputValue) };
}

const KIND_RANK: Readonly<Record<ContextKind, number>> = { landmark: 0, form: 1, table: 2 };

test('buildVomContext：全部用例逐字段相等', () => {
  for (const { label, input } of CASES) {
    const { tsModel, jsModel } = buildPair(input);
    assert.deepEqual(clone(tsModel), clone(jsModel), label + ' 的上下文模型不一致');
  }
});

test('classifyContextAnchor：role/tag 组合矩阵逐项相等', () => {
  const MATRIX: readonly unknown[] = [
    null,
    undefined,
    'string',
    {},
    { role: '', tag: '' },
    { role: 'table' },
    { tag: 'table' },
    { role: 'TABLE' },
    { role: 'form' },
    { tag: 'form' },
    { role: 'fieldset' },
    { tag: 'fieldset' },
    { role: 'group' },
    { role: 'radiogroup' },
    { role: 'search' },
    { role: 'main' },
    { role: 'MAIN' },
    { role: 'region', tag: 'div' },
    { tag: 'nav' },
    { tag: 'header' },
    { tag: 'footer' },
    { tag: 'aside' },
    { tag: 'main' },
    { tag: 'section' },
    { tag: 'custom-element' },
    { tag: 'grid' },
    { role: 'grid' },
    { role: 'treegrid', tag: 'table' },
    { role: 'dialog' },
    { role: 'combobox' },
    { role: 'menuitem' },
    { role: 42, tag: null },
    { role: 'banner', tag: 'div' },
    { role: 'searchbox', tag: 'input' },
  ];
  for (const item of MATRIX) {
    assert.deepEqual(
      clone(classifyContextAnchor(item as never)),
      clone(js.classifyContextAnchor(item)),
      'anchor ' + JSON.stringify(item) + ' 分类不一致',
    );
  }
  assert.deepEqual(clone(LANDMARK_ROLES), clone(js.LANDMARK_ROLES));
  assert.deepEqual(clone(LANDMARK_BY_TAG), clone(js.LANDMARK_BY_TAG));
  assert.deepEqual(clone(FORM_GROUP_ROLES), clone(js.FORM_GROUP_ROLES));
  assert.deepEqual(clone(TABLE_GROUP_ROLES), clone(js.TABLE_GROUP_ROLES));
});

test('frameIdOfContextNode：id 形态矩阵逐项相等', () => {
  const IDS: readonly unknown[] = [null, undefined, '', 'f2:@e7', 'f2:', 'frame:3', 'F2:x', 'f2:a', 'f12:abc', 123, 'f0:@a'];
  for (const id of IDS) {
    assert.equal(frameIdOfContextNode(id), js.frameIdOfContextNode(id), 'id ' + String(id) + ' 的 frameId 不一致');
  }
  assert.equal(frameIdOfContextNode('f2:@e7'), 2);
  assert.equal(frameIdOfContextNode('@e7'), null);
});

test('输出不变量：成员/父子/深度/统计自洽', () => {
  for (const { label, input } of CASES) {
    const model = buildVomContext(asInput(input === undefined ? {} : input));
    assert.equal(model.version, VOM_CONTEXT_VERSION, label + ' 版本不符');
    const groupIds = new Set(model.groups.map((group) => group.id));
    assert.equal(groupIds.size, model.groups.length, label + ' 组 id 重复');
    const rawEntries = (input as { entries?: unknown } | null | undefined)?.entries;
    const entryIds = new Set(
      (Array.isArray(rawEntries) ? (rawEntries as readonly { id?: unknown }[]) : [])
        .filter((item) => item && item.id)
        .map((item) => String(item.id)),
    );
    for (const group of model.groups) {
      for (const memberId of group.memberIds) {
        assert.ok(entryIds.has(memberId), label + ' 组成员不在输入里：' + memberId);
      }
      assert.equal(group.members, group.memberIds.length, label + ' 组成员计数不符');
      assert.ok(group.depth >= 0, label + ' 组深度非法');
      if (group.parentId != null) {
        assert.ok(groupIds.has(group.parentId), label + ' parentId 指向不存在的组：' + group.parentId);
      }
      for (const childId of group.childIds) {
        assert.ok(groupIds.has(childId), label + ' childId 指向不存在的组：' + childId);
      }
      if (group.table) {
        assert.equal(group.table.headerCount, group.table.headers.length, label + ' 表头计数不符');
        assert.equal(group.table.hasHeaderRow, group.table.headers.length > 0, label + ' hasHeaderRow 与表头不符');
      }
    }
    for (const context of model.contexts) {
      assert.equal(context.chain.length, context.kinds.length, label + ' 上下文链长度不一致');
      assert.equal(context.anchorIds.length, context.chain.length, label + ' anchorIds 长度不一致');
      const ranks = context.kinds.map((kind) => KIND_RANK[kind]);
      assert.deepEqual(clone(ranks), clone(ranks.slice().sort((a, b) => b - a)), label + ' 上下文链不是近→远（table>form>landmark）');
      for (const groupId of context.chain) assert.ok(groupIds.has(groupId), label + ' 链引用了不存在的组');
    }
    assert.deepEqual(clone(model.roots), model.groups.filter((group) => group.parentId == null).map((group) => group.id));
    assert.equal(model.stats.groups, model.groups.length, label + ' stats.groups 不符');
    assert.equal(model.stats.contexts, model.contexts.length, label + ' stats.contexts 不符');
    assert.equal(model.stats.landmarks + model.stats.forms + model.stats.tables, model.groups.length, label + ' 分类计数与组数不符');
    assert.equal(
      model.stats.tableHeaders,
      model.groups.reduce((sum, group) => sum + (group.table ? group.table.headerCount : 0), 0),
      label + ' 表头合计不符',
    );
    assert.equal(model.stats.parented, model.groups.filter((group) => group.parentId != null).length, label + ' parented 不符');
    assert.equal(model.stats.framed, model.contexts.filter((context) => context.frameId != null).length, label + ' framed 不符');
  }
});

test('关键语义硬断言（不依赖 JS 对照）', () => {
  // 锚点优先级：表格 > 表单 > landmark。
  assert.deepEqual(clone(classifyContextAnchor({ role: 'grid' })), { kind: 'table', groupKind: 'grid', role: 'grid', tag: null });
  assert.deepEqual(clone(classifyContextAnchor({ tag: 'table', role: 'main' })), { kind: 'table', groupKind: 'main', role: 'main', tag: 'table' });
  assert.deepEqual(clone(classifyContextAnchor({ tag: 'fieldset' })), { kind: 'form', groupKind: 'fieldset', role: null, tag: 'fieldset' });
  assert.deepEqual(clone(classifyContextAnchor({ tag: 'nav' })), { kind: 'landmark', groupKind: 'navigation', role: null, tag: 'nav' });
  assert.equal(classifyContextAnchor({ role: 'combobox' }), null);

  // 嵌套链：table 的父组是 form，form 的父组是 landmark。
  const nested = buildVomContext(asInput({
    entries: [
      entry('@main', { id: 'main', role: 'main' }),
      entry('@frm', { id: 'frm', role: 'form' }),
      entry('@tbl', { id: 'tbl', role: 'table' }),
      entry('@cell', { id: 'cell', role: 'gridcell' }, { ancestorIds: ['@tbl', '@frm', '@main'] }),
    ],
  }));
  const table = nested.groups.find((group) => group.kind === 'table');
  const form = nested.groups.find((group) => group.kind === 'form');
  const landmark = nested.groups.find((group) => group.kind === 'landmark');
  assert.ok(table && form && landmark);
  assert.equal(table?.parentId, form?.id);
  assert.equal(form?.parentId, landmark?.id);
  assert.equal(landmark?.parentId, null);
  assert.equal(table?.depth, 2);
  const cellContext = nested.contexts.find((context) => context.node === '@cell');
  assert.deepEqual(clone(cellContext?.kinds), ['table', 'form', 'landmark']);
  assert.deepEqual(clone(cellContext?.chain), [table?.id, form?.id, landmark?.id]);
  assert.deepEqual(clone(nested.roots), [landmark?.id]);

  // 表格页面事实：source=page-facts，表头过滤空名，行数来自 dataRows。
  const withFacts = buildVomContext(asInput({
    entries: [entry('@tbl', { id: 'tbl', role: 'table', tableFacts: {
      headers: [{ id: 'h1', role: 'columnheader', name: '姓名' }, { id: 'h3', name: '' }],
      dataRows: 4,
      caption: '用户数据表',
    } })],
  }));
  const factTable = withFacts.groups[0]?.table;
  assert.deepEqual(clone(factTable), {
    headers: [{ id: 'h1', role: 'columnheader', name: '姓名' }],
    headerCount: 1,
    rowCount: 4,
    caption: '用户数据表',
    hasHeaderRow: true,
    source: 'page-facts',
  });
  // 组 token 是成员节点成本合计（8 + name/4 + role/4，向上取整）；本夹具节点无 name。
  assert.equal(withFacts.groups[0]?.tokens, 8 + Math.ceil('table'.length / 4));

  // 组成员角色直方图：generic 兜底。
  assert.deepEqual(clone(withFacts.groups[0]?.roles), { table: 1 });

  // 空输入是合法的空模型。
  assert.deepEqual(clone(buildVomContext()), {
    version: 1,
    groups: [],
    roots: [],
    contexts: [],
    frames: [],
    stats: {
      groups: 0,
      contexts: 0,
      byKind: {},
      byGroupKind: {},
      landmarks: 0,
      forms: 0,
      tables: 0,
      parented: 0,
      depth: 0,
      framed: 0,
      tableHeaders: 0,
      truncated: false,
    },
  });
});

test('limits：groups/contexts/depth/headers 严格截断并置 truncated', () => {
  const input = CASES.find((item) => item.label === 'limits 截断（groups/contexts/depth/headers）')?.input;
  const model = buildVomContext(asInput(input));
  assert.ok(model.groups.length <= 2, 'groups 上限 2 未生效：' + model.groups.length);
  assert.ok(model.contexts.length <= 1, 'contexts 上限 1 未生效：' + model.contexts.length);
  assert.equal(model.stats.truncated, true);
  for (const group of model.groups) {
    assert.ok(group.memberIds.length <= CONTEXT_LIMITS.members, 'members 超过上限');
    if (group.table) assert.ok(group.table.headers.length <= 1, 'headers 上限 1 未生效');
  }
  for (const context of model.contexts) assert.ok(context.chain.length <= 1, 'depth 上限 1 未生效');
});

test('跨 frame：frameId 分组与 frames 汇总', () => {
  const input = CASES.find((item) => item.label === '跨 frame：f<id>: 前缀 + frames 汇总')?.input;
  const model = buildVomContext(asInput(input));
  assert.equal(model.stats.framed, 3);
  assert.deepEqual(clone(model.frames.map((frame) => frame.frameId)), [2, 3]);
  const frame2 = model.frames[0];
  assert.equal(frame2?.url, 'https://example.test/child');
  assert.equal(frame2?.parentFrameId, 0);
  assert.ok((frame2?.groups ?? 0) >= 1);
  assert.ok((frame2?.nodes ?? 0) >= 2);
  for (const group of model.groups.filter((item) => item.frameId === 2)) {
    assert.ok(group.id.startsWith('ctx:'), '组 id 前缀');
    assert.equal(group.frameId, 2);
  }
  assert.equal(model.frames[1]?.parentFrameId, null, '非整数 parentFrameId 归一为 null');
  assert.equal(model.frames[1]?.url, null);
});

test('根输入 null：JS 与 TS 都按同一契约抛错', () => {
  assert.throws(() => js.buildVomContext(null));
  assert.throws(() => buildVomContext(null as unknown as BuildVomContextInput));
});
