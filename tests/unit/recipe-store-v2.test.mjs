import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  approveRecipe,
  assertRunnable,
  listRecipes,
  readRecipe,
  readRunReport,
  recipeContentHash,
  recipePath,
  recipeStepsHash,
  saveRecipe,
  writeRunReport,
} from '../../lib/recipe-store.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-recipe-v2-'));
}

test('saveRecipe 保留 v2 顶层字段，approve 同时绑定 stepsHash 与 contentHash', () => {
  const dir = tempDir();
  const steps = [{ method: 'click', params: { selector: '#go' } }];
  const { file, recipe } = saveRecipe(dir, 'v2', {
    name: 'v2',
    version: 2,
    steps,
    params: [{ name: 'city', type: 'string', default: '上海' }],
    policy: { onError: 'stop', retries: 1 },
    safety: { readOnly: false },
    source: { kind: 'session-run-log', sessionId: 's1' },
    description: '示例',
    tags: ['demo'],
    approved: true, // 用户文件里的 approved 不能直接生效
  });
  assert.equal(recipe.approved, false);
  assert.equal(file, recipePath(dir, 'v2'));
  const stored = readRecipe(dir, 'v2');
  assert.equal(stored.version, 2);
  assert.deepEqual(stored.params, [{ name: 'city', type: 'string', default: '上海' }]);
  assert.deepEqual(stored.policy, { onError: 'stop', retries: 1 });
  assert.deepEqual(stored.safety, { readOnly: false });
  assert.deepEqual(stored.source, { kind: 'session-run-log', sessionId: 's1' });
  assert.equal(stored.description, '示例');
  assert.deepEqual(stored.tags, ['demo']);
  assert.equal(stored.approved, false, '用户文件里的 approved 被忽略（草稿必须人工审批）');

  const approved = approveRecipe(dir, 'v2', { approver: 'tester', host: 'h', ttlMs: 60000 });
  assert.equal(approved.stepsHash, recipeStepsHash(steps));
  assert.equal(approved.contentHash, recipeContentHash(approved));
  assert.doesNotThrow(() => assertRunnable(approved));
  assert.equal(listRecipes(dir)[0].version, 2);
});

test('审批后改 params 默认值/失败策略 → E_RECIPE_CHANGED（contentHash）', () => {
  const dir = tempDir();
  saveRecipe(dir, 'guard', {
    version: 2,
    steps: [{ method: 'click', params: { selector: '#go' } }],
    params: [{ name: 'city', type: 'string', default: '上海' }],
  });
  const approved = approveRecipe(dir, 'guard', { approver: 't', ttlMs: 60000 });
  const paramsTampered = { ...approved, params: [{ name: 'city', type: 'string', default: '北京' }] };
  assert.throws(() => assertRunnable(paramsTampered), (error) => error.code === 'E_RECIPE_CHANGED');
  const policyTampered = { ...approved, policy: { onError: 'skip' } };
  assert.throws(() => assertRunnable(policyTampered), (error) => error.code === 'E_RECIPE_CHANGED');
  // 旧 recipe（没有 contentHash）仍按 stepsHash 校验，不受影响
  const legacy = { steps: approved.steps, approved: true, approvedAt: Date.now(), expiresAt: Date.now() + 60000, stepsHash: recipeStepsHash(approved.steps) };
  assert.doesNotThrow(() => assertRunnable(legacy));
});

test('回放报告落盘并可读回', () => {
  const dir = tempDir();
  const report = { ok: false, completed: 1, planned: 2, failedAt: 2, error: { code: 'E_NOT_FOUND', message: 'x' } };
  const file = writeRunReport(dir, 'demo', report);
  assert.ok(file.endsWith('demo.report.json'));
  const read = readRunReport(dir, 'demo');
  assert.equal(read.name, 'demo');
  assert.equal(read.ok, false);
  assert.equal(read.failedAt, 2);
  assert.ok(typeof read.at === 'number');
  assert.equal(readRunReport(dir, 'missing'), null);
});
