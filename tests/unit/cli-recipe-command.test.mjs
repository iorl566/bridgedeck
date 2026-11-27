import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecipeCommand } from '../../cli/commands/recipe.mjs';
import { ArgError, requirePos, intFlag } from '../../cli/lib/args.mjs';
import { renderTable } from '../../cli/lib/format.mjs';

class TestBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function makeCommand({ rpcResult = { ok: true, result: {} } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-recipe-cmd-'));
  const printed = [];
  const cmd = createRecipeCommand({
    recipeDir: dir,
    executeRecipeBlocks: async () => ({ ok: true, result: { completed: 1 } }),
    isJson: () => false,
    emitJson: () => 0,
    print: (line) => printed.push(line),
    outputFailure: (body) => { throw new TestBridgeError(body.error.code, body.error.message); },
    outputJsonBody: () => 0,
    BridgeError: TestBridgeError,
    ArgError,
    requirePos,
    intFlag,
    callRpc: async () => rpcResult,
    timeoutOf: () => 5000,
    renderTable,
  });
  return { dir, cmd, printed };
}

test('recipe save/list/show 闭环', async () => {
  const { dir, cmd, printed } = makeCommand();
  try {
    const source = path.join(dir, 'in.json');
    fs.writeFileSync(source, JSON.stringify({ steps: [{ method: 'navigate', params: { url: 'https://x' } }] }), 'utf8');
    assert.equal(await cmd({ file: source }, ['recipe', 'save', 'demo']), 0);
    assert.match(printed.join('\n'), /已保存 recipe/);
    printed.length = 0;
    assert.equal(await cmd({}, ['recipe', 'list']), 0);
    assert.match(printed.join('\n'), /demo/);
    printed.length = 0;
    assert.equal(await cmd({}, ['recipe', 'show', 'demo']), 0);
    assert.match(printed.join('\n'), /navigate/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recipe approve 不带 --confirm-human 抛 ArgError', async () => {
  const { dir, cmd } = makeCommand();
  try {
    const source = path.join(dir, 'in.json');
    fs.writeFileSync(source, JSON.stringify({ steps: [{ method: 'navigate', params: {} }] }), 'utf8');
    await cmd({ file: source }, ['recipe', 'save', 'demo']);
    await assert.rejects(() => cmd({}, ['recipe', 'approve', 'demo']), ArgError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recipe run 未审批被拒绝', async () => {
  const { dir, cmd } = makeCommand();
  try {
    const source = path.join(dir, 'in.json');
    fs.writeFileSync(source, JSON.stringify({ steps: [{ method: 'click', params: { selector: '#x' } }] }), 'utf8');
    await cmd({ file: source }, ['recipe', 'save', 'dangerous']);
    await assert.rejects(() => cmd({}, ['recipe', 'run', 'dangerous']), (error) => error.code === 'E_RECIPE_NOT_APPROVED');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('recipe draft 从 run log 生成草稿', async () => {
  const { dir, cmd, printed } = makeCommand({
    rpcResult: { ok: true, result: { steps: [{ kind: 'navigate', method: 'navigate', origin: 'https://x', path: '/', ok: true }] } },
  });
  try {
    assert.equal(await cmd({ session: 's1', name: 'd1' }, ['recipe', 'draft']), 0);
    assert.match(printed.join('\n'), /已生成 recipe 草稿/);
    assert.ok(fs.existsSync(path.join(dir, 'd1.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
