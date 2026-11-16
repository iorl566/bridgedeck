import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadActionCache, recallAction, rememberActions } from '../../lib/action-cache.mjs';

test('动作缓存记住 ref 语义并可按 URL 取回', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-actions-'));
  const file = path.join(dir, 'action-cache.json');
  rememberActions(file, [
    { ref: '@e1', action: 'fill', role: 'textbox', name: 'Email' },
    { ref: '@e2', action: 'click', role: 'button', name: 'Sign in' },
  ], 'https://example.com/login');
  assert.equal(loadActionCache(file).length, 2);
  assert.deepEqual(recallAction(file, '@e1', 'https://example.com/login'), {
    ref: '@e1', action: 'fill', role: 'textbox', name: 'Email', url: 'https://example.com/login', updatedAt: recallAction(file, '@e1').updatedAt,
  });
  assert.equal(recallAction(file, '@e2').name, 'Sign in');
  assert.equal(recallAction(file, '@e9'), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
