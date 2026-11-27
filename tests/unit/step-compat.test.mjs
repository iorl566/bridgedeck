// tests/unit/step-compat.test.mjs —— step 的 --action/--method/--params 兼容（0 位置参数）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'cli', 'bridge.mjs');

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
}

test('step --action --params：0 位置参数 + params 合并进 action', () => {
  const r = run(['step', '--action', 'click', '--params', JSON.stringify({ ref: '@e1' }), '--dry-run', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(r.stdout.trim());
  assert.equal(body.ok, true);
  const action = body.result.steps[0].params.action;
  assert.equal(action.method, 'click');
  assert.deepEqual(action.params, { ref: '@e1' });
});

test('step --method 别名同样可用，显式 flag 覆盖 params', () => {
  const r = run(['step', '--method', 'click', '--params', JSON.stringify({ ref: '@e1' }), '--selector', '#go', '--dry-run', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const action = JSON.parse(r.stdout.trim()).result.steps[0].params.action;
  assert.equal(action.method, 'click');
  assert.equal(action.params.selector, '#go');
  assert.equal(action.params.ref, '@e1');
});

test('step 位置参数写法保持可用', () => {
  const r = run(['step', 'click', '--ref', '@e2', '--dry-run', '--json']);
  const body = JSON.parse(r.stdout.trim());
  assert.equal(body.ok, true);
  assert.equal(body.result.steps[0].params.action.method, 'click');
});

test('step：非法 params 与缺方法都给出参数错误', () => {
  const bad = run(['step', '--action', 'click', '--params', '{bad}', '--dry-run']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /不是合法 JSON/);
  const missing = run(['step', '--dry-run']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /--action/);
});
