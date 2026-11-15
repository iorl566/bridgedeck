// AX 表格事实：row / col / header 推导。
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTableFacts, summarizeTables } from '../../extension/src/lib/table-facts.js';

function node(nodeId, parentId, role, backendNodeId, name = '') {
  return { nodeId, parentId, role, backendNodeId, name, depth: 0 };
}

const axNodes = [
  node(1, null, 'RootWebArea', 1),
  node(2, 1, 'table', 2),
  node(3, 2, 'row', 3),
  node(4, 3, 'columnheader', 4, '姓名'),
  node(5, 3, 'columnheader', 5, '城市'),
  node(6, 2, 'row', 6),
  node(7, 6, 'cell', 7, '张三'),
  node(8, 6, 'cell', 8, '北京'),
  node(9, 2, 'row', 9),
  node(10, 9, 'cell', 10, '李四'),
  node(11, 9, 'cell', 11, '上海'),
];

test('表格单元格带 row/col/header；表头行标记 headerRow', () => {
  const facts = computeTableFacts(axNodes);
  assert.equal(facts.size, 6);
  assert.deepEqual(facts.get(4), { role: 'columnheader', row: 0, col: 0, headerRow: true });
  assert.deepEqual(facts.get(7), { role: 'cell', row: 1, col: 0, header: '姓名' });
  assert.deepEqual(facts.get(8), { role: 'cell', row: 1, col: 1, header: '城市' });
  assert.deepEqual(facts.get(10), { role: 'cell', row: 2, col: 0, header: '姓名' });
});

test('grid/treegrid 同样处理；空输入返回空 Map', () => {
  const grid = [
    node(1, null, 'grid', 1),
    node(2, 1, 'row', 2),
    node(3, 2, 'gridcell', 3, 'A'),
  ];
  const facts = computeTableFacts(grid);
  assert.deepEqual(facts.get(3), { role: 'gridcell', row: 0, col: 0 });
  assert.equal(computeTableFacts(null).size, 0);
  assert.equal(computeTableFacts([]).size, 0);
});

test('summarizeTables 汇总行列数与表头', () => {
  const tables = summarizeTables(axNodes);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].role, 'table');
  assert.equal(tables[0].rowCount, 2);
  assert.equal(tables[0].colCount, 2);
  assert.deepEqual(tables[0].headers, ['姓名', '城市']);
  assert.deepEqual(summarizeTables([]), []);
});
