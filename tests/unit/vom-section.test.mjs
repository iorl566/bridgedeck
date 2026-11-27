import test from 'node:test';
import assert from 'node:assert/strict';
import { landmarkSection, rowAnchor, formAnchor } from '../../extension/src/lib/vom-section.js';

test('landmarkSection 找最近 landmark', () => {
  assert.deepEqual(landmarkSection([
    { tag: 'div', role: null },
    { tag: 'nav', role: 'navigation', id: 'top' },
    { tag: 'main', role: 'main' },
  ]), { role: 'navigation', tag: 'nav', id: 'top', ref: null });
});

test('landmarkSection 无 landmark 返回 null', () => {
  assert.equal(landmarkSection([{ tag: 'div' }]), null);
  assert.equal(landmarkSection(null), null);
});

test('rowAnchor 找 tr/role=row', () => {
  assert.deepEqual(rowAnchor([{ tag: 'table' }, { tag: 'tr', id: 'r1' }]), { tag: 'tr', role: null, id: 'r1', ref: null });
  assert.deepEqual(rowAnchor([{ role: 'row', id: 'x' }]), { tag: null, role: 'row', id: 'x', ref: null });
  assert.equal(rowAnchor([{ tag: 'div' }]), null);
});

test('formAnchor 找 form/role=form', () => {
  assert.deepEqual(formAnchor([{ tag: 'form', id: 'f1' }]), { tag: 'form', role: null, id: 'f1', ref: null });
  assert.equal(formAnchor([{ tag: 'div' }]), null);
});
