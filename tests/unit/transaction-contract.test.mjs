import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

test('事务契约：成功 committed，pointer 失败 unknown', () => {
  const actions = read('extension/src/tools/interaction.js') + read('extension/src/tools/fill-actions.js') + read('extension/src/tools/pointer-actions.js');
  assert.ok((actions.match(/committedEffect\(/g) || []).length >= 4, 'actions 缺少 committedEffect');
  assert.ok((actions.match(/effect_state: 'unknown'/g) || []).length >= 3, 'interaction 缺少 unknown');
  const files = read('extension/src/files.js');
  assert.ok(files.includes("committedEffect('download')"), 'download 缺少 committedEffect');
  assert.ok(files.includes("effect_state: hasTarget ? 'unknown' : 'none'"), 'download 无结果语义缺失');
  const transfer = read('extension/src/tools/file-transfer.js');
  assert.ok((transfer.match(/committedEffect\('upload'\)/g) || []).length >= 5, 'upload 返回缺少 committedEffect');
});
