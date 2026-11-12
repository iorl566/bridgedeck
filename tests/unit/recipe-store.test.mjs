import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertRunnable,
  approveRecipe,
  listRecipes,
  readRecipe,
  recipePath,
  saveRecipe,
  substituteParams,
} from '../../lib/recipe-store.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-recipe-test-'));
}

test('save/read/list recipe', () => {
  const dir = tempDir();
  const { file, recipe } = saveRecipe(dir, 'demo', { name: 'Demo', steps: [{ method: 'click' }] });
  assert.equal(recipe.approved, false);
  assert.equal(readRecipe(dir, 'demo').name, 'Demo');
  assert.equal(listRecipes(dir).length, 1);
  assert.ok(fs.existsSync(file));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('approve then tamper is rejected', () => {
  const dir = tempDir();
  saveRecipe(dir, 'demo', { steps: [{ method: 'fill', params: { value: 'a' } }] });
  const approved = approveRecipe(dir, 'demo', { approver: 'tester', host: 'host', ttlMs: 60000 });
  assert.equal(approved.approved, true);
  assert.doesNotThrow(() => assertRunnable(approved));
  const tampered = { ...approved, steps: [{ method: 'fill', params: { value: 'b' } }] };
  assert.throws(() => assertRunnable(tampered), (error) => error.code === 'E_RECIPE_CHANGED');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('expired recipe is rejected', () => {
  const dir = tempDir();
  saveRecipe(dir, 'demo', { steps: [{ method: 'click' }] });
  const approved = approveRecipe(dir, 'demo', { approver: 'tester', ttlMs: 1 });
  assert.throws(() => assertRunnable(approved, Date.now() + 10), (error) => error.code === 'E_RECIPE_EXPIRED');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('substituteParams replaces placeholders and reports missing keys', () => {
  assert.deepEqual(substituteParams({ a: '{{x}}', b: ['{{y}}'] }, { x: '1', y: '2' }), { a: '1', b: ['2'] });
  assert.throws(() => substituteParams('{{missing}}', {}), (error) => error.code === 'E_BAD_ARG');
  assert.match(recipePath('/tmp', 'a b'), /a_b\.json$/);
});
