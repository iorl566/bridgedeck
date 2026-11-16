import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES, ERROR_CODE_LIST, ERROR_RECOVERY, normalizeErrorCode, recoveryHint } from '../../lib/error-codes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HINT = '（改完 lib/error-codes.mjs 后运行 node tools/gen-error-codes.mjs 同步文档与 SDK）';

test('错误码清单格式正确', () => {
  assert.ok(ERROR_CODE_LIST.length >= 50, '错误码不应少于 50 个');
  for (const code of ERROR_CODE_LIST) {
    assert.match(code, /^E_[A-Z0-9_]+$/, '错误码格式：' + code);
    assert.ok(ERROR_CODES[code] && ERROR_CODES[code].length >= 4, '缺少含义：' + code);
  }
  assert.equal(new Set(ERROR_CODE_LIST).size, ERROR_CODE_LIST.length, '不能重复');
});

test('扩展侧错误码必须是清单子集', () => {
  const source = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'errors.js'), 'utf8');
  const known = new Set([...source.matchAll(/'(E_[A-Z_]+)'/g)].map((m) => m[1]));
  const missing = [...known].filter((code) => !(code in ERROR_CODES));
  assert.deepEqual(missing, [], '扩展用了未登记的错误码：' + missing.join(', '));
});

test('daemon / CLI / MCP / 扩展抛出的每个码都要登记', () => {
  const roots = ['daemon', 'lib', 'cli', 'mcp', 'extension/src'];
  const files = [];
  for (const root of roots) {
    const base = path.join(ROOT, root);
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) files.push(path.join(entry.parentPath || base, entry.name));
    }
  }
  assert.ok(files.length > 50, '应该扫描到足够多的源文件，实际 ' + files.length);
  const unregistered = new Set();
  for (const file of files) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/'(E_[A-Z0-9_]+)'/g)) {
      if (!(match[1] in ERROR_CODES)) unregistered.add(match[1]);
    }
  }
  assert.deepEqual([...unregistered].sort(), [], '这些码被抛出但没登记：' + [...unregistered].sort().join(', '));
});

test('文档与 SDK 覆盖清单里的每个码', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'PROTOCOL.md'), 'utf8');
  const absent = ERROR_CODE_LIST.filter((code) => !doc.includes(code));
  assert.deepEqual(absent, [], 'PROTOCOL.md 缺少这些错误码：' + absent.join(', ') + HINT);

  const dts = fs.readFileSync(path.join(ROOT, 'sdk', 'index.d.ts'), 'utf8');
  const dtsMissing = ERROR_CODE_LIST.filter((code) => !dts.includes("'" + code + "'"));
  assert.deepEqual(dtsMissing, [], 'SDK 类型缺少这些错误码：' + dtsMissing.join(', ') + HINT);

  const py = fs.readFileSync(path.join(ROOT, 'sdk', 'python', 'browser_bridge.py'), 'utf8');
  const pyMissing = ERROR_CODE_LIST.filter((code) => !py.includes("'" + code + "'"));
  assert.deepEqual(pyMissing, [], 'Python SDK 缺少这些错误码：' + pyMissing.join(', ') + HINT);
});

test('未知码归一为 E_INTERNAL', () => {
  assert.equal(normalizeErrorCode('E_NOT_FOUND'), 'E_NOT_FOUND');
  assert.equal(normalizeErrorCode('E_NOT_A_REAL_CODE'), 'E_INTERNAL');
  assert.equal(normalizeErrorCode(undefined), 'E_INTERNAL');
});

test('高频失败码都带恢复建议，且 retry 取值合法', () => {
  const allowed = new Set(['no', 'transient', 'after-action']);
  const hot = [
    'E_STALE_REF', 'E_OBSERVATION_STALE', 'E_OBSERVATION_CHANGED', 'E_CAPTURE_STALE',
    'E_SESSION_PAUSED', 'E_LEDGER_PENDING', 'E_NO_SESSION', 'E_TIMEOUT', 'E_OCCLUDED',
    'E_OBSCURED', 'E_TARGET_MISMATCH', 'E_NOT_ACTIONABLE', 'E_NOT_FOUND',
  ];
  for (const code of hot) {
    const advice = recoveryHint(code);
    assert.ok(advice.hint, '高频码缺少恢复建议：' + code);
    assert.ok(allowed.has(advice.retry), code + ' 的 retry 取值非法：' + advice.retry);
  }
  for (const [code, advice] of Object.entries(ERROR_RECOVERY)) {
    assert.ok(code in ERROR_CODES, '恢复建议里有未登记的码：' + code);
    assert.ok(allowed.has(advice.retry), code + ' 的 retry 取值非法：' + advice.retry);
  }
  // 未登记的码按"不可自动重试"兜底，且不编造建议。
  assert.deepEqual(recoveryHint('E_SOMETHING_UNKNOWN'), { retry: 'no', hint: '' });
});
