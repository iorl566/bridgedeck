import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../extension/ui/panels/audit-panel.js', import.meta.url), 'utf8');

test('完整审计页使用 ui/audit.html 路径', () => {
  assert.match(source, /getURL\('ui\/audit\.html'\)/);
  assert.doesNotMatch(source, /getURL\('audit\.html'\)/);
});
