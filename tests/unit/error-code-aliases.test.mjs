// tests/unit/error-code-aliases.test.mjs —— 外部错误码线名 → 我方 canonical 的兼容解析。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ERROR_CODE_ALIASES,
  ERROR_CODE_SET,
  normalizeErrorCode,
  resolveErrorCode,
  recoveryHint,
} from '../../lib/error-codes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('别名表：27 个外部线名，全部映射到 canonical 错误码', () => {
  assert.equal(Object.keys(ERROR_CODE_ALIASES).length, 27);
  for (const [alias, target] of Object.entries(ERROR_CODE_ALIASES)) {
    assert.ok(ERROR_CODE_SET.has(target), `${alias} -> ${target} 不是 canonical 错误码`);
  }
});

test('resolveErrorCode：canonical 原样返回；别名解析；未知返回 null', () => {
  assert.equal(resolveErrorCode('E_PAGE_ERROR'), 'E_PAGE_ERROR');
  assert.equal(resolveErrorCode('cdp_failed'), 'E_PAGE_ERROR');
  assert.equal(resolveErrorCode('tab_not_active'), 'E_NO_TAB');
  assert.equal(resolveErrorCode('not_a_real_code'), null);
});

test('normalizeErrorCode / recoveryHint 走别名解析', () => {
  assert.equal(normalizeErrorCode('user_aborted'), 'E_CANCELLED');
  assert.equal(normalizeErrorCode('nope'), 'E_INTERNAL');
  assert.equal(recoveryHint('user_aborted').retry, 'no');
  // 别名目标若登记了恢复建议，应返回该目标的建议
  const hint = recoveryHint('loading_stalled');
  assert.equal(hint.retry, 'after-action');
});

test('别名文档包含全部线名（内部文档，不进入发布包）', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'ERROR-CODE-ALIASES.md'), 'utf8');
  for (const alias of Object.keys(ERROR_CODE_ALIASES)) {
    assert.ok(doc.includes('`' + alias + '`'), '文档缺少 ' + alias);
  }
});
