import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVomGroups } from '../../extension/src/lib/vom-groups.js';

test('buildVomGroups 按 section/row/form 聚合', () => {
  const entries = [
    { id: 'n1', node: { ancestors: [{ tag: 'nav', role: 'navigation', id: 'top' }] } },
    { id: 'n2', node: { ancestors: [{ tag: 'nav', role: 'navigation', id: 'top' }] } },
    { id: 'n3', node: { ancestors: [{ tag: 'tr', id: 'r1' }, { tag: 'form', id: 'f1' }] } },
  ];
  const groups = buildVomGroups(entries);
  assert.equal(groups.sections.length, 2);
  assert.deepEqual(groups.sections.find((group) => group.anchor.id === 'top').nodeIds, ['n1', 'n2']);
  assert.ok(groups.sections.find((group) => group.anchor.id === 'top').tokens > 0);
  assert.ok(groups.sections.every((group) => typeof group.id === 'string' && group.id.length > 0));
  assert.deepEqual(groups.sections.find((group) => group.anchor.id === 'f1').nodeIds, ['n3']);
  assert.equal(groups.rows[0].nodeIds[0], 'n3');
  assert.equal(groups.forms[0].nodeIds[0], 'n3');
});

test('buildVomGroups 空输入/无效条目', () => {
  const groups = buildVomGroups([null, {}, { id: 'x', node: {} }]);
  assert.deepEqual(groups.sections, []);
  assert.equal(groups.total, 0);
});
