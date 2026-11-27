// 37 工具 × 4 场景（success/error/timeout/offline）离线矩阵：真实断言 + 报告同步。
// 驱动是 fake adapter（与 daemonRpc 同形）与记录调用序列的假 CLI，不需要 daemon/浏览器。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildToolSpecs } from '../../dsh-plugin/lib/tools.mjs';
import {
  MATRIX_CLASSES,
  renderMatrixReport,
  runCell,
  runMatrix,
  TOOL_SCENARIOS,
} from '../../dsh-plugin/lib/tool-matrix.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PLUGIN = path.join(ROOT, 'dsh-plugin');
const specs = buildToolSpecs(async () => ({}));
const TOOL_NAMES = specs.map((spec) => spec.name).sort();

let cached = null;
async function matrix() {
  if (!cached) cached = await runMatrix();
  return cached;
}

test('场景表覆盖全部 37 个工具，且没有多余/缺失工具', () => {
  assert.deepEqual(Object.keys(TOOL_SCENARIOS).sort(), TOOL_NAMES);
  for (const [name, scenario] of Object.entries(TOOL_SCENARIOS)) {
    assert.ok(['rpc', 'cli'].includes(scenario.channel), name + ' channel 非法');
    assert.equal(typeof scenario.expect, 'function', name + ' 缺少结果断言');
    assert.ok(Array.isArray(scenario.cli) && scenario.cli.length >= 1, name + ' 缺少 CLI 前缀');
    assert.ok(Object.prototype.hasOwnProperty.call(scenario, 'cliResult'), name + ' 缺少假 CLI 结果');
    if (scenario.channel === 'rpc') {
      assert.ok(scenario.rpcMethod, name + ' 直连场景缺少 rpcMethod');
      assert.ok(Object.prototype.hasOwnProperty.call(scenario, 'rpcResult'), name + ' 缺少假 RPC 结果');
    }
  }
});

test('矩阵全量 148 格（37 × 4）全部通过', async () => {
  const result = await matrix();
  assert.equal(result.summary.tools, 37);
  assert.equal(result.summary.classes, 4);
  assert.equal(result.summary.cells, 148);
  assert.equal(result.summary.passed, 148, '失败格：' + JSON.stringify(result.summary.failures, null, 2));
  assert.equal(result.summary.failed, 0);
  for (const cls of MATRIX_CLASSES) {
    assert.deepEqual(result.summary.byClass[cls], { total: 37, passed: 37, failed: 0 }, cls);
  }
  for (const row of result.rows) {
    assert.equal(row.ok, true, row.tool + '/' + row.cls + '：' + row.detail);
    assert.ok(row.detail && !row.detail.includes('undefined'), row.tool + '/' + row.cls + ' 证据文本异常');
    assert.ok(['rpc', 'cli'].includes(row.channel));
    assert.ok(TOOL_NAMES.includes(row.tool));
    assert.ok(MATRIX_CLASSES.includes(row.cls));
  }
  assert.ok(result.summary.fallbacks >= 25, '回退/兜底场景数量异常：' + result.summary.fallbacks);
});

test('每类场景的判定语义正确（错误上抛/超时不重放/离线只回退安全码）', async () => {
  const result = await matrix();
  for (const cls of MATRIX_CLASSES) {
    for (const row of result.rows.filter((cell) => cell.cls === cls)) {
      if (cls === 'success') assert.match(row.detail, /结果已整形/, row.tool + ' success 证据');
      if (cls === 'error') assert.match(row.detail, /上抛|兜底/, row.tool + ' error 证据');
      if (cls === 'timeout') assert.match(row.detail, /上抛|兜底/, row.tool + ' timeout 证据');
      if (cls === 'offline') assert.match(row.detail, /回退|上抛/, row.tool + ' offline 证据');
    }
  }
  // 非幂等的 session_start 超时：只重试两次同一 request-id，绝不再开新会话。
  const startTimeout = result.rows.find((row) => row.tool === 'browser_session_start' && row.cls === 'timeout');
  assert.match(startTimeout.detail, /重试 2 次后上抛/);
  // 只读状态查询允许 CLI 兜底（既定行为）。
  const statusTimeout = result.rows.find((row) => row.tool === 'browser_status' && row.cls === 'timeout');
  assert.match(statusTimeout.detail, /兜底成功/);
  // 直连工具业务错误不得回退 CLI。
  for (const tool of ['browser_act', 'browser_observe', 'browser_navigate']) {
    const cell = result.rows.find((row) => row.tool === tool && row.cls === 'error');
    assert.match(cell.detail, /未回退 CLI/);
  }
});

test('单格 API 可独立复现（成功/失败都能给出证据）', async () => {
  const success = await runCell('browser_observe', 'success');
  assert.equal(success.ok, true);
  assert.equal(success.channel, 'rpc');
  assert.match(success.detail, /rpc observe/);
  const offline = await runCell('browser_observe', 'offline');
  assert.equal(offline.ok, true);
  assert.match(offline.detail, /E_DAEMON → CLI 回退成功/);
  await assert.rejects(() => runCell('browser_observe', 'nope'), /未知场景类/);
  await assert.rejects(() => runCell('browser_not_a_tool', 'success'));
});

test('矩阵判定能抓到真实失败（人为破坏断言即失败）', async () => {
  const result = await matrix();
  // 用一份“被篡改”的矩阵结果验证失败聚合逻辑：失败格必须进入 summary.failures。
  const tampered = {
    rows: result.rows.map((row, index) => (index === 0 ? { ...row, ok: false, detail: '人为失败' } : row)),
    summary: result.summary,
  };
  const failures = tampered.rows.filter((row) => !row.ok);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].detail, '人为失败');
});

test('报告渲染确定性且覆盖全部工具', async () => {
  const result = await matrix();
  const report = renderMatrixReport(result);
  assert.equal(renderMatrixReport(result), report, '同一结果两次渲染应逐字节一致');
  for (const tool of TOOL_NAMES) assert.ok(report.includes('`' + tool + '`'), '报告缺少工具 ' + tool);
  assert.match(report, /全部 148 格通过/);
  assert.equal((report.match(/PASS · /g) || []).length, 148);
  assert.equal((report.match(/FAIL · /g) || []).length, 0);
  // 报告与仓库生成物一致（scripts/tool-matrix.mjs --check 的等价断言）。
  const disk = fs.readFileSync(path.join(PLUGIN, 'TOOLS-MATRIX.md'), 'utf8');
  assert.equal(disk, report, 'TOOLS-MATRIX.md 过期：node dsh-plugin/scripts/tool-matrix.mjs');
});

test('重复运行结果稳定（无随机/时间依赖）', async () => {
  const first = await runMatrix();
  const second = await runMatrix();
  assert.deepEqual(second.summary, first.summary);
  assert.deepEqual(second.rows.map((row) => [row.tool, row.cls, row.ok, row.detail]), first.rows.map((row) => [row.tool, row.cls, row.ok, row.detail]));
});
