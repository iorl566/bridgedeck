// tests/unit/protocol-param-compat.test.mjs —— 兼容字段归一化（read/extract/drag/wheel/upload/record）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCompatParams } from '../../extension/src/lib/compat-params.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('read：fields 映射到 fieldsJson，保留 fields', () => {
  const out = normalizeCompatParams('read', { fields: [{ key: 'text', read: 'text' }] });
  assert.deepEqual(JSON.parse(out.fieldsJson), [{ key: 'text', read: 'text' }]);
  assert.equal(out.fields.length, 1);
});

test('extract：action 校验、target_id → target、item_selector 保留', () => {
  const out = normalizeCompatParams('extract', { action: 'table', target_id: 't1', item_selector: 'tr' });
  assert.equal(out.target, 't1');
  assert.equal(out.itemSelector, 'tr');
  assert.throws(() => normalizeCompatParams('extract', { action: 'nope' }), /E_BAD_ARG|action/);
});

test('drag：source/target/delta/mode/modifiers 归一化', () => {
  const out = normalizeCompatParams('drag', {
    source: { ref: '@e1' }, target: { selector: '#drop' }, mode: 'press-move-release', modifiers: ['Alt', 'Shift'], hold_ms: 100, duration_ms: 300,
  });
  assert.deepEqual(out.from, { ref: '@e1' });
  assert.deepEqual(out.to, { selector: '#drop' });
  assert.equal(out.mode, 'hold');
  assert.equal(out.modifiers, 9);
  const delta = normalizeCompatParams('drag', { source: { x: 1, y: 2 }, delta: { x: 10, y: 20 } });
  assert.equal(delta.dx, 10);
  assert.equal(delta.dy, 20);
});

test('wheel：modifiers 数组转位掩码；upload drop 明确不支持', () => {
  assert.equal(normalizeCompatParams('wheel', { modifiers: ['Control'] }).modifiers, 2);
  assert.equal(normalizeCompatParams('upload', { mode: 'input', files: [] }).mode, 'input');
  assert.equal(normalizeCompatParams('upload', { mode: 'drop', files: [] }).mode, 'drop');
  assert.throws(() => normalizeCompatParams('upload', { mode: 'nope' }), /input\/drop/);
});

test('record.start：trace_version 只接受 2/3', () => {
  assert.equal(normalizeCompatParams('record.start', { traceVersion: 3 }).traceVersion, 3);
  assert.throws(() => normalizeCompatParams('record.start', { traceVersion: 4 }), /trace_version/);
});

test('schema 已接受 P0 兼容字段；page-lib wheel 带修饰键', () => {
  const schemas = fs.readFileSync(path.join(ROOT, 'lib', 'schemas.mjs'), 'utf8');
  for (const snippet of ["fields: { type: 'array'", 'timeoutMs: TIMEOUT_HINT', "mode: { type: 'string', enum: ['press-move-release'", "targetId: { type: 'string'", "scope: { type: 'string', enum: ['follow', 'current']" ]) {
    assert.ok(schemas.includes(snippet), 'schema 缺少 ' + snippet);
  }
  const pageLib = fs.readFileSync(path.join(ROOT, 'extension', 'injected', 'parts', '91-wheel-upload.part'), 'utf8');
  assert.match(pageLib, /ctrlKey: \(modBits & 2\)/);
});
