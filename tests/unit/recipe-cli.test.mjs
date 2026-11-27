import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecipeCommand } from '../../cli/commands/recipe.mjs';
import { ContractError } from '../../cli/lib/arg-contract.mjs';

class FakeBridgeError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.extra = extra;
  }
}

class FakeArgError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgError';
    this.code = 'E_ARG_MISSING';
  }
}

function planOk(steps) {
  return {
    ok: true,
    result: {
      steps: steps.map((step, index) => ({ index, method: step.method, ok: true, result: { ok: true } })),
      completed: steps.length,
      failedAt: null,
    },
  };
}

function planFail(steps, at = 0, code = 'E_NOT_FOUND', message = '目标不存在') {
  return {
    ok: true,
    result: {
      steps: steps.map((step, index) => ({
        index,
        method: step.method,
        ok: index < at,
        ...(index === at ? { error: { code, message } } : {}),
      })),
      completed: at,
      failedAt: at,
    },
  };
}

function harness(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-recipe-cli-'));
  const state = {
    dir,
    json: false,
    jsonOut: [],
    prints: [],
    failures: [],
    rpc: [],
    calls: [],
  };
  const rpcHandler = options.rpcHandler || ((method, params) => {
    if (method === 'plan') return planOk(params.steps);
    if (method === 'evaluate') return { ok: true, result: { value: 'https://x.test/' } };
    if (method === 'request-help') return { ok: true, result: { action: 'approve' } };
    return { ok: true, result: {} };
  });
  const callRpc = async (method, params, timeout) => {
    state.rpc.push({ method, params, timeout });
    return rpcHandler(method, params, state.rpc.length);
  };
  const cmd = createRecipeCommand({
    recipeDir: dir,
    executeRecipeBlocks: async () => ({ ok: true, result: { completed: 0, planned: 0 } }),
    isJson: () => state.json,
    emitJson: (value) => state.jsonOut.push(value),
    print: (line) => state.prints.push(line),
    outputFailure: (body) => { state.failures.push(body); return 1; },
    outputJsonBody: (body) => { state.jsonOut.push(body); return 0; },
    BridgeError: FakeBridgeError,
    ArgError: FakeArgError,
    requirePos: (pos, index, label) => {
      if (pos[index] === undefined || pos[index] === '') throw new FakeArgError('缺少参数 ' + label);
      return pos[index];
    },
    intFlag: (flags, name, { min } = {}) => {
      if (flags[name] === undefined) return undefined;
      const value = Number(flags[name]);
      if (!Number.isInteger(value) || (min !== undefined && value < min)) throw new FakeArgError('--' + name + ' 需要整数');
      return value;
    },
    callRpc,
    timeoutOf: (flags) => Number(flags.timeout) || 60000,
    renderTable: (headers, rows) => headers.join(' | ') + '\n' + rows.map((row) => row.join(' | ')).join('\n'),
    spec: { order: ['list', 'show', 'save', 'draft', 'approve', 'run', 'rm'] },
  });
  async function saveRecipeFile(name, recipe) {
    const file = path.join(dir, name + '.source.json');
    fs.writeFileSync(file, JSON.stringify(recipe), 'utf8');
    const code = await cmd({ file }, ['recipe', 'save', name]);
    assert.equal(code, 0);
    return path.join(dir, name + '.json');
  }
  return { ...state, cmd, saveRecipeFile, dir, state };
}

test('CLI save 校验并保存 v2 字段；非法步骤在参数层拒绝', async () => {
  const h = harness();
  const file = path.join(h.dir, 'r.json');
  fs.writeFileSync(file, JSON.stringify({
    name: 'r',
    version: 2,
    params: [{ name: 'city', type: 'string', default: '上海' }],
    policy: { onError: 'stop', retries: 1 },
    steps: [{ method: 'navigate', params: { url: 'https://x/{{city}}' } }],
  }), 'utf8');
  const code = await h.cmd({ file }, ['recipe', 'save', 'r']);
  assert.equal(code, 0);
  const stored = JSON.parse(fs.readFileSync(path.join(h.dir, 'r.json'), 'utf8'));
  assert.equal(stored.version, 2);
  assert.deepEqual(stored.policy, { onError: 'stop', retries: 1 });
  assert.equal(stored.approved, false);
  assert.equal(h.prints.some((line) => line.includes('需要人工审批')), true);

  const bad = path.join(h.dir, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ steps: [{ params: {} }] }), 'utf8');
  await assert.rejects(() => h.cmd({ file: bad }, ['recipe', 'save', 'bad']), (error) => error instanceof ContractError && error.code === 'E_INVALID_PARAMS');
});

test('CLI run --dry-run：保留旧 risk/steps/confirmations 字段并附 v2 预检', async () => {
  const h = harness();
  await h.saveRecipeFile('dry', {
    name: 'dry',
    steps: [
      { method: 'click', params: { selector: '#btn' } },
      { type: 'human', reason: '人工确认' },
      { type: 'loop', times: 2, steps: [{ method: 'observe' }] },
    ],
  });
  await h.cmd({ 'confirm-human': true, by: 'tester' }, ['recipe', 'approve', 'dry']);
  h.state.json = true;
  const code = await h.cmd({ 'dry-run': true, json: true }, ['recipe', 'run', 'dry']);
  assert.equal(code, 0);
  const payload = h.jsonOut.at(-1);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.result.risk, 'browser_mutation');
  assert.ok(payload.result.steps.some((step) => step.method === 'plan'));
  assert.ok(payload.result.steps.some((step) => step.method === 'request-help'));
  assert.ok(payload.result.confirmations.some((line) => line.includes('已审批')));
  assert.equal(payload.result.preflight.counts.dangerous, 1);
  assert.equal(payload.result.preflight.counts.humanGates, 1);
  assert.ok(payload.result.model.plan.some((entry) => entry.method === 'observe'));
  assert.equal(h.rpc.length, 0, 'dry-run 不应调用 daemon');
});

test('CLI run 真正回放：plan RPC + run marker + report.json', async () => {
  const h = harness();
  await h.saveRecipeFile('go', { name: 'go', steps: [{ method: 'click', params: { selector: '#go' } }] });
  await h.cmd({ 'confirm-human': true }, ['recipe', 'approve', 'go']);
  h.state.json = true;
  const code = await h.cmd({ json: true, session: 'sess-1' }, ['recipe', 'run', 'go']);
  assert.equal(code, 0);
  const payload = h.jsonOut.at(-1);
  assert.equal(payload.ok, true);
  assert.equal(payload.result.completed, 1);
  assert.equal(payload.result.planned, 1);
  assert.equal(payload.result.failedAt, null);
  assert.ok(Array.isArray(payload.result.steps) && payload.result.steps[0].status === 'ok');
  assert.equal(h.rpc[0].method, 'plan');
  assert.equal(h.rpc[0].params.session, 'sess-1');
  const marker = JSON.parse(fs.readFileSync(path.join(h.dir, 'go.run.json'), 'utf8'));
  assert.equal(marker.status, 'done');
  assert.equal(marker.completed, 1);
  assert.ok(marker.paramsFingerprint);
  const report = JSON.parse(fs.readFileSync(path.join(h.dir, 'go.report.json'), 'utf8'));
  assert.equal(report.ok, true);
  assert.equal(report.completed, 1);
  assert.ok(fs.existsSync(path.join(h.dir, 'go.report.json')));
});

test('CLI run 失败：错误证据（失败步骤/原因/可否重试）与失败 marker', async () => {
  const h = harness({ rpcHandler: (method, params) => (method === 'plan' ? planFail(params.steps) : { ok: true, result: {} }) });
  await h.saveRecipeFile('bad', { name: 'bad', steps: [{ method: 'click', params: { selector: '#missing' } }] });
  await h.cmd({ 'confirm-human': true }, ['recipe', 'approve', 'bad']);
  h.state.json = true;
  const code = await h.cmd({ json: true, session: 's' }, ['recipe', 'run', 'bad']);
  assert.equal(code, 1);
  const body = h.failures.at(-1);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'E_NOT_FOUND');
  assert.equal(body.error.data.failedStep.method, 'click');
  assert.equal(body.error.data.canRetry, false);
  assert.ok(body.error.data.reportFile.endsWith('bad.report.json'));
  const marker = JSON.parse(fs.readFileSync(path.join(h.dir, 'bad.run.json'), 'utf8'));
  assert.equal(marker.status, 'failed');
  assert.equal(marker.evidence.failedStep.method, 'click');
  const report = JSON.parse(fs.readFileSync(path.join(h.dir, 'bad.report.json'), 'utf8'));
  assert.equal(report.ok, false);
  assert.equal(report.error.code, 'E_NOT_FOUND');
});

test('CLI run 参数化：默认值/类型保持/必需参数校验', async () => {
  const h = harness();
  const stored = await h.saveRecipeFile('param', {
    name: 'param',
    version: 2,
    params: [
      { name: 'city', type: 'string', default: '上海' },
      { name: 'count', type: 'integer', required: true },
    ],
    steps: [
      { method: 'navigate', params: { url: 'https://x/{{city}}' } },
      { method: 'fill', params: { selector: '#n', value: '{{count}}' } },
    ],
  });
  assert.ok(stored.endsWith('param.json'));
  await h.cmd({ 'confirm-human': true }, ['recipe', 'approve', 'param']);
  h.state.json = true;
  const code = await h.cmd({ json: true, session: 's', param: ['count=3'] }, ['recipe', 'run', 'param']);
  assert.equal(code, 0);
  const plan = h.rpc.find((item) => item.method === 'plan');
  assert.equal(plan.params.steps[0].params.url, 'https://x/上海');
  assert.equal(plan.params.steps[1].params.value, 3, '整串占位符应保持数字类型');

  await assert.rejects(
    () => h.cmd({ json: true, session: 's' }, ['recipe', 'run', 'param']),
    (error) => error instanceof FakeArgError && /缺少必需参数 count/.test(error.message),
  );
  await assert.rejects(
    () => h.cmd({ json: true, session: 's', param: ['count=abc'] }, ['recipe', 'run', 'param']),
    (error) => error instanceof ContractError && error.code === 'E_ARG_TYPE',
  );
});

test('CLI run 只读安全：recipe.safety.readOnly 阻止写动作', async () => {
  const h = harness();
  await h.saveRecipeFile('ro', {
    name: 'ro',
    version: 2,
    safety: { readOnly: true },
    steps: [{ method: 'click', params: { selector: '#go' } }],
  });
  await h.cmd({ 'confirm-human': true }, ['recipe', 'approve', 'ro']);
  await assert.rejects(
    () => h.cmd({ session: 's' }, ['recipe', 'run', 'ro']),
    (error) => error.code === 'E_READ_ONLY',
  );
  assert.equal(h.rpc.length, 0);
});

test('CLI draft 使用 v2 草稿：来源/跳过/人工补值建议写入文件', async () => {
  const h = harness({
    rpcHandler: (method) => {
      if (method === 'session.run_log') {
        return {
          ok: true,
          result: {
            steps: [
              { kind: 'navigate', method: 'navigate', origin: 'https://a.test', path: '/form', ok: true },
              { kind: 'action', method: 'click', target: { selector: '#go' }, replayable: true, ok: true },
              { kind: 'action', method: 'fill', target: { selector: '#q' }, replayable: false, ok: true },
            ],
          },
        };
      }
      return { ok: true, result: {} };
    },
  });
  h.state.json = true;
  const code = await h.cmd({ json: true, name: 'draft', session: 'sess-1' }, ['recipe', 'draft', '--name', 'draft', '--session', 'sess-1']);
  assert.equal(code, 0);
  const payload = h.jsonOut.at(-1);
  assert.equal(payload.result.version, 2);
  assert.equal(payload.result.count, 2);
  assert.deepEqual(payload.result.skipped.map((item) => item.method), ['fill']);
  assert.equal(payload.result.humanGates.length, 1);
  assert.equal(payload.result.source.sessionId, 'sess-1');
  const stored = JSON.parse(fs.readFileSync(path.join(h.dir, 'draft.json'), 'utf8'));
  assert.equal(stored.version, 2);
  assert.equal(stored.steps[0].expect.urlIncludes, '/form');
  assert.ok(stored.steps.every((step) => step.ref && step.fallback));
});

test('CLI show --json 附带 v2 预检详情；未知子命令报 E_BAD_SUBCOMMAND', async () => {
  const h = harness();
  await h.saveRecipeFile('show', { name: 'show', steps: [{ method: 'observe' }] });
  h.state.json = true;
  const code = await h.cmd({ json: true }, ['recipe', 'show', 'show']);
  assert.equal(code, 0);
  const payload = h.jsonOut.at(-1);
  assert.equal(payload.result.recipe.name, 'show');
  assert.equal(payload.result.details.modelVersion, 2);
  assert.equal(payload.result.details.preflight.counts.actions, 1);
  await assert.rejects(
    () => h.cmd({}, ['recipe', 'nope', 'x']),
    (error) => error instanceof ContractError && error.code === 'E_BAD_SUBCOMMAND',
  );
});
