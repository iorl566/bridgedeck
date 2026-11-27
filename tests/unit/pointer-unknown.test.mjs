import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../extension/src/tools/pointer-actions.js', import.meta.url), 'utf8');

test('pointer 事务：click/click-backend/drag 按下后失败必须 unknown', () => {
  assert.ok((source.match(/effect_state: 'unknown'/g) || []).length >= 3, '缺少 unknown 语义');
  assert.ok(source.includes('pressedAt =') && source.includes('pressedAtBackend') && source.includes('pressedAtDrag'), '缺少按下标记');
  assert.ok(source.includes("if (error && error.data && error.data.effect_state === 'unknown') throw error;"), 'click 仍可能在按下后回退');
});
