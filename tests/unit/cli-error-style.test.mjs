import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'cli', 'bridge.mjs');
const NODE = process.execPath;

function run(args) {
  const result = spawnSync(NODE, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, BB_NO_PROBE: '1' },
  });
  const line = (result.stdout || '').split(/\r?\n/).filter((item) => item.trim().startsWith('{')).pop();
  return { code: result.status, json: line ? JSON.parse(line) : null, raw: (result.stdout || '') + (result.stderr || '') };
}

test('--error-style bsk：未知命令映射 invalid_params（保留 bbCode）', () => {
  const result = run(['--error-style bsk', 'badcmd', '--json'].flatMap((item) => item.split(' ')));
  assert.equal(result.code, 2);
  assert.equal(result.json.error.code, 'invalid_params');
  assert.ok(result.json.error.bbCode);
});

test('--error-style bsk：未知选项映射 invalid_params', () => {
  const result = run(['--error-style', 'bsk', 'status', '--definitely-not-a-flag', '--json']);
  assert.equal(result.code, 2);
  assert.equal(result.json.error.code, 'invalid_params');
});

test('默认错误码保持 E_*（不启用 --error-style 时不映射）', () => {
  const result = run(['badcmd', '--json']);
  assert.equal(result.code, 2);
  assert.equal(result.json.error.code, 'E_ARG_USAGE');
});
