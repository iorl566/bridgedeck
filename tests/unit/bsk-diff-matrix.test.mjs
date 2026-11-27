// tests/unit/bsk-diff-matrix.test.mjs —— BSK 差分矩阵的结构不变量（计数/状态/证据/规模）。
//
// 被测对象：tools/bsk-diff/build.mjs（build()）与仓库内产物 matrix.json / docs/BSK-DIFF-MATRIX.md。
// 这些断言就是「可复核」的定义：任何人跑 `node --test tests/unit/bsk-diff-*.test.mjs` 都能重放。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { build, PATHS } from '../../tools/bsk-diff/build.mjs';
import { renderMarkdown, serializeMatrix } from '../../tools/bsk-diff/lib/report.mjs';
import { STATUS_VALUES, AXES } from '../../tools/bsk-diff/lib/mapping.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MATRIX = await build();

const ABSOLUTE_PATH_PATTERNS = [
  /[A-Za-z]:\\\\/,
  /[A-Za-z]:\//,
  /(^|[^A-Za-z0-9_])D:\\/,
  /\/home\/[^\s"']+/,
  /\/Users\/[^\s"']+/,
];

function assertRelativeEvidence(value, label) {
  for (const pattern of ABSOLUTE_PATH_PATTERNS) {
    assert.ok(!pattern.test(value), `${label} 含绝对路径：${value}`);
  }
  assert.ok(!value.includes('\\'), `${label} 含反斜杠（应统一为正斜杠）：${value}`);
}

test('矩阵规模：两侧清单数必须与仓库事实一致', () => {
  assert.equal(MATRIX.inventory.bsk.cliCommands, 56, 'BSK 0.5.0 应有 56 个命令');
  assert.equal(MATRIX.inventory.ours.rpcMethods, 165, '我方应有 165 个协议方法');
  assert.equal(MATRIX.inventory.ours.mcpTools, 92, '我方应有 92 个 MCP 工具');
  assert.equal(MATRIX.inventory.ours.errorCodes, 161, '我方应有 161 个错误码');
  assert.equal(MATRIX.inventory.ours.features, 15, '我方应有 15 个 feature floor（M6-P0② 补 6 个 BSK 门）');
  assert.equal(MATRIX.inventory.bsk.features, 9, 'BSK 0.5.0 应有 9 个 Feature');
  assert.equal(MATRIX.inventory.bsk.errorCodes, 15, 'BSK 0.5.0 应有 15 个 ErrorCode');
  assert.equal(MATRIX.inventory.bsk.rpcMethods, 77, 'BSK 0.5.0 方法表应有 77 个方法');
});

test('每行状态与优先级都在枚举内', () => {
  for (const [axis, rows] of Object.entries(MATRIX.axes)) {
    assert.ok(rows.length > 0, `${axis} 轴不应为空`);
    for (const row of rows) {
      assert.ok(STATUS_VALUES.includes(row.status), `${axis}/${row.id} 状态非法：${row.status}`);
      assert.ok(['P0', 'P1', 'P2'].includes(row.priority), `${axis}/${row.id} 优先级非法：${row.priority}`);
    }
  }
});

test('每格证据非空，且 unknown 必须写明缺什么证据', () => {
  for (const [axis, rows] of Object.entries(MATRIX.axes)) {
    for (const row of rows) {
      const { ours, bsk } = row.evidence;
      assert.ok(ours.length + bsk.length > 0, `${axis}/${row.id} 没有任何证据`);
      if (row.status === 'unknown') {
        assert.ok(row.gap && row.gap.length >= 12, `${axis}/${row.id} unknown 必须解释缺证据`);
        assert.match(
          row.gap,
          /无法|未|缺|不透明|零交集|没有/,
          `${axis}/${row.id} unknown 的说明没有指出缺证据：${row.gap}`,
        );
      } else {
        assert.ok(row.gap && row.gap.trim().length > 0, `${axis}/${row.id} 状态 ${row.status} 缺差距说明`);
      }
    }
  }
});

test('证据全部是仓库相对路径 file:line，且文件/行号真实存在', () => {
  for (const row of MATRIX.rows) {
    for (const evidence of [...row.evidence.ours, ...row.evidence.bsk]) {
      assertRelativeEvidence(evidence, `${row.axis}/${row.id}`);
      const match = evidence.match(/^([^:]+):(\d+)$/);
      if (!match) {
        // BSK 扩展产物按路径取证（无行号）：只要求是仓库内相对文件
        assert.ok(fs.existsSync(path.join(REPO_ROOT, evidence)), `${row.id} 引用的 BSK 产物不存在：${evidence}`);
        continue;
      }
      const [, file, lineText] = match;
      const abs = path.join(REPO_ROOT, file);
      assert.ok(fs.existsSync(abs), `${row.id} 引用的文件不存在：${file}`);
      const lineCount = fs.readFileSync(abs, 'utf8').split('\n').length;
      const line = Number(lineText);
      assert.ok(line >= 1 && line <= lineCount, `${row.id} 行号越界：${evidence}（文件共 ${lineCount} 行）`);
    }
  }
});

test('总览计数与各轴行数一致（不允许出现无来源的计数）', () => {
  let rowTotal = 0;
  for (const axis of AXES) {
    const rows = MATRIX.axes[axis.id];
    const summary = MATRIX.summary[axis.id];
    assert.ok(summary, `缺少 ${axis.id} 轴总览`);
    assert.equal(summary.total, rows.length, `${axis.id} 轴 total 与行数不一致`);
    const counted = summary.equal + summary.partial + summary.missing + summary.extra + summary.unknown;
    assert.equal(counted, rows.length, `${axis.id} 轴状态计数之和 != 行数`);
    for (const status of STATUS_VALUES) {
      const actual = rows.filter((row) => row.status === status).length;
      assert.equal(summary[status], actual, `${axis.id} 轴 ${status} 计数不一致`);
    }
    rowTotal += rows.length;
  }
  assert.equal(MATRIX.totals.rows, rowTotal, '总行数与各轴行数之和不一致');
  const totalCounted = MATRIX.totals.equal + MATRIX.totals.partial + MATRIX.totals.missing + MATRIX.totals.extra + MATRIX.totals.unknown;
  assert.equal(totalCounted, MATRIX.totals.rows, '总计状态计数之和 != 总行数');
});

test('unknown 不计入等价：行数口径就是「非 unknown」', () => {
  for (const axis of AXES) {
    const rows = MATRIX.axes[axis.id];
    const nonUnknown = rows.filter((row) => row.status !== 'unknown').length;
    const denominator = rows.length;
    const expected = denominator === 0 ? 0 : Math.round((nonUnknown / denominator) * 1000) / 10;
    assert.equal(MATRIX.summary[axis.id].evidenceCoverage, expected, `${axis.id} 轴已取证比例口径不一致`);
  }
});

test('三态映射完整性：BSK 的每个命令/MCP 动作/feature/错误码都有行', () => {
  const cliNames = new Set(MATRIX.axes.cli.filter((row) => row.id.startsWith('cli:') && !row.id.startsWith('cli:extra:')).map((row) => row.name));
  assert.equal(cliNames.size, MATRIX.inventory.bsk.cliCommands, 'CLI 轴未覆盖全部 BSK 命令');
  const bskMcpActions = MATRIX.axes.mcp.filter((row) => row.id.startsWith('mcp:bsk:'));
  assert.equal(bskMcpActions.length, MATRIX.inventory.bsk.mcpActions, 'MCP 轴 ③b 未覆盖全部 BSK MCP 动作');
  const bskFeatures = MATRIX.axes.feature.filter((row) => row.status === 'missing');
  // M6-P0② 已补齐 6 个 BSK feature 门（borrow_confirmation_timeout/target_control/
  // interaction_policy/incognito_sessions/dialog_control/click_move_click），故 missing 归零。
  assert.equal(bskFeatures.length, 0, 'BSK 独有 feature 应为 0 个（6 个已对齐）');
  const errorBskRows = MATRIX.axes.error.filter((row) => row.id.startsWith('error:bsk:'));
  assert.equal(errorBskRows.length, MATRIX.inventory.bsk.errorCodes + MATRIX.inventory.bsk.rpcErrorReasons, '错误码轴未覆盖 BSK 全部 15 码 + 102 reason');
});

test('我方清单每个条目都出现在对应轴', () => {
  const cliVerbs = new Set(MATRIX.axes.cli.filter((row) => row.oursName).map((row) => row.oursName));
  assert.equal(cliVerbs.size, MATRIX.inventory.ours.cliVerbs, 'CLI 轴未覆盖我方全部动词');
  const mcpTools = new Set(MATRIX.axes.mcp.filter((row) => !row.id.startsWith('mcp:bsk:')).map((row) => row.oursName));
  assert.equal(mcpTools.size, MATRIX.inventory.ours.mcpTools, 'MCP 轴未覆盖我方全部 92 工具');
  const rpcOurs = new Set(MATRIX.axes.rpc.filter((row) => row.oursName && !(row.detail && row.detail.compat)).map((row) => row.oursName));
  assert.equal(rpcOurs.size, MATRIX.inventory.ours.rpcMethods, 'RPC 轴未覆盖我方全部 165 方法');
  const errorOurs = new Set(MATRIX.axes.error.filter((row) => row.oursName).map((row) => row.oursName));
  assert.equal(errorOurs.size, MATRIX.inventory.ours.errorCodes, '错误码轴未覆盖我方全部 161 码');
});

test('P0 清单结构合法：每条都是 P0，top10 是 P0 的子集（允许多轮收敛后为空）', () => {
  assert.ok(Array.isArray(MATRIX.p0));
  assert.ok(MATRIX.topP0.length <= 10, 'topP0 不得超过 10 条');
  assert.ok(MATRIX.topP0.length <= MATRIX.p0.length, 'topP0 不得超过 P0 总数');
  for (const row of MATRIX.p0) assert.equal(row.priority, 'P0');
  for (const row of MATRIX.topP0) assert.equal(row.priority, 'P0');
});

test('document 与 JSON 都不含绝对路径 / 时间戳（OS 与时间无关）', () => {
  const json = serializeMatrix(MATRIX);
  const doc = renderMarkdown(MATRIX);
  for (const text of [json, doc]) {
    for (const pattern of ABSOLUTE_PATH_PATTERNS) {
      assert.ok(!pattern.test(text), `产物含绝对路径：${pattern}`);
    }
    assert.ok(!/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text), '产物含 ISO 时间戳，破坏确定性');
  }
});

test('仓库内 matrix.json 与生成结果逐字节一致', () => {
  assert.ok(fs.existsSync(PATHS.matrixJson), 'matrix.json 不存在，先运行 node tools/bsk-diff/run.mjs');
  assert.equal(fs.readFileSync(PATHS.matrixJson, 'utf8'), serializeMatrix(MATRIX), 'matrix.json 与生成结果不一致');
});

test('docs/BSK-DIFF-MATRIX.md 完全由 JSON 复现（逐字节）', () => {
  assert.ok(fs.existsSync(PATHS.matrixMarkdown), '文档不存在，先运行 node tools/bsk-diff/run.mjs');
  assert.equal(fs.readFileSync(PATHS.matrixMarkdown, 'utf8'), renderMarkdown(MATRIX), '文档与 JSON 渲染结果不一致');
});

test('文档总览表数字与 JSON 一致，并写明 unknown 不计入等价', () => {
  const doc = fs.readFileSync(PATHS.matrixMarkdown, 'utf8');
  assert.match(doc, /unknown 不计入等价/, '文档必须写明 unknown 不计入等价');
  for (const axis of AXES) {
    const summary = MATRIX.summary[axis.id];
    const line = doc.split('\n').find((entry) => entry.startsWith('| ') && entry.includes(`| ${summary.total} |`));
    assert.ok(line, `${axis.id} 轴总览行缺失`);
    assert.ok(line.includes(` ${summary.equal} (`), `${axis.id} 轴 equal 计数未出现在总览行`);
  }
  assert.match(doc, /## ① CLI 命令/, '缺少 CLI 轴表格');
  assert.match(doc, /## ② RPC 方法/, '缺少 RPC 轴表格');
  assert.match(doc, /## ③ MCP 工具/, '缺少 MCP 轴表格');
  assert.match(doc, /## ④ 扩展能力/, '缺少扩展轴表格');
  assert.match(doc, /## ⑤ 协议 \/ feature floor/, '缺少 feature 轴表格');
  assert.match(doc, /## ⑥ 错误码/, '缺少错误码轴表格');
  assert.match(doc, /## 最关键的 P0 差距（前 10 条）/, '缺少前 10 条 P0 差距');
  const p0Section = doc.split('### 最关键的 P0 差距（前 10 条）')[1] || '';
  const p0Rows = p0Section.split('\n').filter((entry) => /^\| \d+ \|/.test(entry));
  assert.equal(p0Rows.length, Math.min(10, MATRIX.p0.length), 'P0 差距表行数应为 min(10, P0 总数)');
});
