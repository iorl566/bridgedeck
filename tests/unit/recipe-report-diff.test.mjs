// tests/unit/recipe-report-diff.test.mjs —— W5-B：recipe run 差异报告收口。
// 覆盖：差异文档结构、失败原因分类、文本摘要、diff.json 落盘，以及 run 成功/失败的 CLI 接线。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RECIPE_FAILURE_CATEGORIES,
  buildRecipeDiffDocument,
  classifyRecipeFailure,
  diffFieldFamily,
  failureClassificationOf,
  renderRecipeDiffLines,
  writeRecipeDiffFile,
} from '../../cli/commands/recipe.mjs';
import { createRecipeCommand } from '../../cli/commands/recipe.mjs';
import { ContractError } from '../../cli/lib/arg-contract.mjs';

function difference(field, overrides = {}) {
  return { ref: '@e1', path: '0', method: 'click', field, expected: true, actual: false, severity: 'error', ...overrides };
}

test('classifyRecipeFailure：错误码 → 稳定分类 + 可读建议', () => {
  assert.equal(classifyRecipeFailure('E_RECIPE_NOT_APPROVED').category, 'policy');
  assert.equal(classifyRecipeFailure('E_HUMAN_GATE').category, 'policy');
  assert.equal(classifyRecipeFailure('E_TARGET_MISMATCH').category, 'target');
  assert.equal(classifyRecipeFailure('E_STALE_REF').category, 'target');
  assert.equal(classifyRecipeFailure('E_TIMEOUT').category, 'timing');
  assert.equal(classifyRecipeFailure('E_NETWORK').category, 'transport');
  assert.equal(classifyRecipeFailure('E_PERMISSION_DENIED').category, 'auth');
  assert.equal(classifyRecipeFailure('E_EXPECT_FAILED').category, 'expectation');
  assert.equal(classifyRecipeFailure('E_ARG_TYPE').category, 'input');
  assert.equal(classifyRecipeFailure('E_SOMETHING_NEW').category, 'internal');
  const policy = classifyRecipeFailure('E_RECIPE_NOT_APPROVED');
  assert.equal(policy.label, RECIPE_FAILURE_CATEGORIES.policy);
  assert.match(policy.next, /审批|人工/);
  assert.equal(policy.retryable, false);
  assert.match(policy.retryHint, /不重试/);
  const retryable = classifyRecipeFailure('E_TIMEOUT', { retryable: true, attempts: 3 });
  assert.equal(retryable.retryable, true);
  assert.equal(retryable.attempts, 3);
  assert.match(retryable.retryHint, /重试/);
  assert.equal(classifyRecipeFailure('').code, 'E_INTERNAL');
  assert.equal(failureClassificationOf(null), null);
});

test('diffFieldFamily：差异字段归入 url/target/result/method/other', () => {
  assert.equal(diffFieldFamily('urlIncludes'), 'url');
  assert.equal(diffFieldFamily('urlMatches'), 'url');
  assert.equal(diffFieldFamily('selectorVisible'), 'target');
  assert.equal(diffFieldFamily('equals'), 'result');
  assert.equal(diffFieldFamily('contains'), 'result');
  assert.equal(diffFieldFamily('methodOk'), 'method');
  assert.equal(diffFieldFamily('somethingElse'), 'other');
  assert.equal(diffFieldFamily(null), 'other');
});

test('buildRecipeDiffDocument：差异归一化/聚合/失败分类/证据压缩', () => {
  const engineReport = {
    ok: false,
    planned: 3,
    completed: 1,
    failedAt: 2,
    durationMs: 120,
    statuses: { ok: 1, failed: 1, skipped: 0, blocked: 1, mismatch: 0 },
    failures: [{ ref: '@e2', path: '1', method: 'fill', code: 'E_TARGET_MISMATCH', message: '目标不存在', attempts: 2, retryable: false }],
    differences: [
      difference('selectorVisible', { severity: 'warning' }),
      difference('urlIncludes', { severity: 'bogus', expected: 'https://a', actual: 'https://b' }),
      difference('equals', { ref: '@e2', severity: 'info', expected: 1, actual: 2 }),
    ],
    results: [
      { ref: '@e1', path: '0', kind: 'action', method: 'click', status: 'ok', attempts: 1, durationMs: 10 },
      { ref: '@e2', path: '1', kind: 'action', method: 'fill', status: 'failed', attempts: 2, durationMs: 20, error: { code: 'E_TARGET_MISMATCH', message: 'x' }, diff: [{ field: 'equals' }] },
      { ref: '@e3', path: '2', kind: 'action', method: 'click', status: 'blocked', attempts: 0 },
    ],
  };
  const doc = buildRecipeDiffDocument({ recipe: 'checkout', report: engineReport, now: 1700000000000, paramsFingerprint: 'fp1', files: { report: 'r.json', diff: 'd.json' } });
  assert.equal(doc.version, 1);
  assert.equal(doc.recipe, 'checkout');
  assert.equal(doc.at, 1700000000000);
  assert.equal(doc.ok, false);
  assert.equal(doc.planned, 3);
  assert.equal(doc.completed, 1);
  assert.equal(doc.failedAt, 2);
  assert.equal(doc.durationMs, 120);
  assert.equal(doc.paramsFingerprint, 'fp1');
  assert.deepEqual(doc.statuses, { ok: 1, failed: 1, skipped: 0, blocked: 1, mismatch: 0 });
  assert.equal(doc.differences.length, 3);
  const normalized = doc.differences.find((item) => item.field === 'urlIncludes');
  assert.equal(normalized.severity, 'error', '未知 severity 归一化为 error');
  assert.equal(normalized.family, 'url');
  assert.equal(normalized.severityLabel, '错误');
  assert.equal(doc.summary.differences, 3);
  assert.deepEqual(doc.summary.bySeverity, { error: 1, warning: 1, info: 1 });
  assert.equal(doc.summary.byField.selectorVisible, 1);
  assert.equal(doc.summary.byRef['@e1'], 2);
  assert.equal(doc.summary.byRef['@e2'], 1);
  assert.equal(doc.summary.failures, 1);
  assert.equal(doc.summary.steps, 3);
  assert.equal(doc.classification.category, 'target');
  assert.equal(doc.classification.code, 'E_TARGET_MISMATCH');
  assert.equal(doc.failures[0].attempts, 2);
  assert.equal(doc.evidence.results.length, 3);
  assert.deepEqual(doc.evidence.results[1].diffFields, ['equals']);
  assert.equal(JSON.stringify(doc).includes('"blob"'), false, '证据里不应出现 blob');
  assert.equal(doc.files.report, 'r.json');
  assert.equal(doc.files.diff, 'd.json');
});

test('buildRecipeDiffDocument：成功 run 无失败分类、无差异', () => {
  const doc = buildRecipeDiffDocument({
    recipe: 'ok',
    report: { ok: true, planned: 2, completed: 2, durationMs: 5, statuses: { ok: 2 }, differences: [], failures: [], results: [] },
    ok: true,
  });
  assert.equal(doc.ok, true);
  assert.equal(doc.classification, null);
  assert.equal(doc.summary.differences, 0);
  assert.deepEqual(doc.summary.bySeverity, { error: 0, warning: 0, info: 0 });
  assert.deepEqual(doc.failures, []);
});

test('renderRecipeDiffLines：成功/失败文本都有可读摘要与差异明细', () => {
  const doc = buildRecipeDiffDocument({
    recipe: 'checkout',
    report: {
      ok: false, planned: 3, completed: 1, failedAt: 2, durationMs: 120,
      statuses: { ok: 1, failed: 1 },
      failures: [{ code: 'E_TARGET_MISMATCH', message: 'x', attempts: 1, retryable: false }],
      differences: [difference('selectorVisible'), difference('urlIncludes')],
      results: [],
    },
  });
  const lines = renderRecipeDiffLines(doc, { max: 1 });
  const text = lines.join('\n');
  assert.match(text, /recipe checkout 差异报告：失败，完成 1\/3/);
  assert.match(text, /差异：2 条（错误 2 \/ 警告 0 \/ 信息 0）/);
  assert.match(text, /\[错误\] @e1 click selectorVisible/);
  assert.match(text, /另有 1 条差异/);
  assert.match(text, /差异字段：/);
  assert.match(text, /失败分类：target（目标定位）· E_TARGET_MISMATCH/);
  assert.match(text, /恢复建议：/);

  const clean = renderRecipeDiffLines(buildRecipeDiffDocument({ recipe: 'ok', report: { ok: true, planned: 1, completed: 1, statuses: { ok: 1 }, differences: [], failures: [] }, ok: true }));
  assert.match(clean.join('\n'), /差异：无/);
  assert.doesNotMatch(clean.join('\n'), /失败分类/);
});

test('writeRecipeDiffFile：原子写、自动建目录、内容带文件路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-recipe-diff-'));
  const file = path.join(dir, 'nested', 'r.diff.json');
  const doc = buildRecipeDiffDocument({ recipe: 'x', report: { ok: true, planned: 1, completed: 1, differences: [], failures: [] }, ok: true });
  const written = writeRecipeDiffFile(file, doc);
  assert.equal(written, file);
  assert.equal(fs.existsSync(file), true);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.recipe, 'x');
  assert.equal(parsed.file, file);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['r.diff.json'], '不应残留临时文件');
  assert.throws(() => writeRecipeDiffFile('', doc), /路径为空/);
});

// ---------------------------------------------------------------------------
// CLI 接线
// ---------------------------------------------------------------------------

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
  return { ok: true, result: { steps: steps.map((step, index) => ({ index, method: step.method, ok: true })), completed: steps.length, failedAt: null } };
}

function planFail(steps, at = 0, code = 'E_TARGET_MISMATCH') {
  return {
    ok: true,
    result: {
      steps: steps.map((step, index) => ({ index, method: step.method, ok: index < at, ...(index === at ? { error: { code, message: '目标不存在' } } : {}) })),
      completed: at,
      failedAt: at,
    },
  };
}

function harness(rpcHandler, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-recipe-report-'));
  const state = { json: false, jsonOut: [], prints: [], failures: [{ test: true }], rpc: [] };
  state.failures = [];
  const callRpc = async (method, params) => {
    state.rpc.push({ method, params });
    return rpcHandler(method, params);
  };
  const cmd = createRecipeCommand({
    recipeDir: dir,
    executeRecipeBlocks: async () => ({ ok: true, result: {} }),
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
    timeoutOf: () => 60000,
    renderTable: (headers, rows) => headers.join(' | ') + '\n' + rows.map((row) => row.join(' | ')).join('\n'),
    spec: { order: ['list', 'show', 'save', 'draft', 'approve', 'run', 'rm'] },
    ...options,
  });
  return { dir, state, cmd };
}

async function saveApproved(h, name, steps) {
  const source = path.join(h.dir, name + '.source.json');
  fs.writeFileSync(source, JSON.stringify({ name, steps }), 'utf8');
  assert.equal(await h.cmd({ file: source }, ['recipe', 'save', name]), 0);
  assert.equal(await h.cmd({ 'confirm-human': true, by: 'tester' }, ['recipe', 'approve', name]), 0);
}

test('CLI run 成功：diff.json 落盘 + JSON 带差异文档与文件路径 + 文本摘要', async () => {
  const h = harness((method, params) => (method === 'plan' ? planOk(params.steps) : { ok: true, result: {} }));
  await saveApproved(h, 'good', [{ method: 'observe' }]);
  h.state.json = true;
  const code = await h.cmd({ json: true }, ['recipe', 'run', 'good']);
  assert.equal(code, 0);
  const payload = h.state.jsonOut.at(-1);
  assert.equal(payload.ok, true);
  assert.ok(payload.result.diffFile.endsWith('good.diff.json'));
  assert.ok(payload.result.reportFile.endsWith('good.report.json'));
  assert.equal(payload.result.diff.summary.differences, 0);
  assert.equal(payload.result.diff.classification, null);
  const diffDoc = JSON.parse(fs.readFileSync(payload.result.diffFile, 'utf8'));
  assert.equal(diffDoc.recipe, 'good');
  assert.equal(diffDoc.ok, true);
  assert.equal(Array.isArray(diffDoc.evidence.results), true);
  const reportDoc = JSON.parse(fs.readFileSync(payload.result.reportFile, 'utf8'));
  assert.equal(reportDoc.diffSummary.differences, 0);

  const h2 = harness((method, params) => (method === 'plan' ? planOk(params.steps) : { ok: true, result: {} }));
  await saveApproved(h2, 'good', [{ method: 'observe' }]);
  const text = await h2.cmd({}, ['recipe', 'run', 'good']);
  assert.equal(text, 0);
  const printed = h2.state.prints.join('\n');
  assert.match(printed, /差异：无/);
  assert.match(printed, /报告文件：/);
  assert.match(printed, /差异文件：/);
});

test('CLI run 失败：错误信封带分类/差异文件，diff.json 与 report.json 互相指向', async () => {
  const h = harness((method, params) => (method === 'plan' ? planFail(params.steps) : { ok: true, result: {} }));
  await saveApproved(h, 'bad', [{ method: 'click', params: { selector: '#missing' } }]);
  const code = await h.cmd({ json: true }, ['recipe', 'run', 'bad']);
  assert.equal(code, 1);
  const body = h.state.failures.at(-1);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'E_TARGET_MISMATCH');
  const data = body.error.data;
  assert.ok(data.reportFile.endsWith('bad.report.json'));
  assert.ok(data.diffFile.endsWith('bad.diff.json'));
  assert.equal(data.classification.category, 'target');
  assert.equal(data.failureCategory, 'target');
  assert.ok(Array.isArray(data.differences));
  assert.equal(typeof data.diffSummary.bySeverity.error, 'number');
  const diffDoc = JSON.parse(fs.readFileSync(data.diffFile, 'utf8'));
  assert.equal(diffDoc.ok, false);
  assert.equal(diffDoc.classification.code, 'E_TARGET_MISMATCH');
  assert.equal(diffDoc.files.report, data.reportFile);
  const reportDoc = JSON.parse(fs.readFileSync(data.reportFile, 'utf8'));
  assert.equal(reportDoc.diffFile, data.diffFile);
  assert.equal(reportDoc.classification.category, 'target');
  assert.equal(reportDoc.ok, false);

  const h2 = harness((method, params) => (method === 'plan' ? planFail(params.steps) : { ok: true, result: {} }));
  await saveApproved(h2, 'bad', [{ method: 'click', params: { selector: '#missing' } }]);
  assert.equal(await h2.cmd({}, ['recipe', 'run', 'bad']), 1);
  const printed = h2.state.prints.join('\n');
  assert.match(printed, /失败分类：target（目标定位）· E_TARGET_MISMATCH/);
  assert.match(printed, /报告文件：/);
  assert.match(printed, /差异文件：/);
});

test('CLI run 失败：期望不满足（E_EXPECT_FAILED）被归为 expectation 且有差异明细', () => {
  // 直接用文档构造验证分类接线（真实期望链路由 recipe-engine 单测覆盖）。
  const doc = buildRecipeDiffDocument({
    recipe: 'expect',
    report: {
      ok: false, planned: 1, completed: 0, failedAt: 1,
      statuses: { ok: 0, failed: 1 },
      failures: [{ code: 'E_EXPECT_FAILED', message: '期望不满足：urlIncludes', attempts: 1, retryable: false }],
      differences: [difference('urlIncludes', { expected: 'https://a', actual: 'https://b' })],
      results: [],
    },
  });
  assert.equal(doc.classification.category, 'expectation');
  const text = renderRecipeDiffLines(doc).join('\n');
  assert.match(text, /期望校验/);
  assert.match(text, /urlIncludes/);
});
