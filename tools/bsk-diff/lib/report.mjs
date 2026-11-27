// tools/bsk-diff/lib/report.mjs —— 报告渲染：matrix.json（机器可复核）+ Markdown（人读）。
//
// 两条硬规则：
//   1) 纯函数：buildMatrix 的输入相同则输出逐字节相同（无时间戳/无随机/无绝对路径）；
//   2) Markdown 完全由 JSON 渲染（docs/上游-DIFF-MATRIX.md == renderMarkdown(matrix)），
//      单测会反向解析文档里的总览数字与 JSON 对齐。

import { AXES, STATUS_SEMANTICS, PRIORITY_RULES, STATUS } from './mapping.mjs';

export const MATRIX_JSON_REL = 'tools/bsk-diff/matrix.json';
export const MATRIX_MD_REL = 'docs/BSK-DIFF-MATRIX.md';

const STATUS_LABEL = Object.freeze({
  equal: 'equal',
  partial: 'partial',
  missing: 'missing',
  extra: 'extra',
  unknown: 'unknown',
});

function escapeCell(text) {
  return String(text == null ? '' : text).replace(/\|/g, '\\|').replace(/\n+/g, ' ');
}

function code(text) {
  if (!text) return '—';
  return '`' + String(text).replace(/`/g, "'") + '`';
}

function evidenceCells(row) {
  const ours = row.evidence.ours.length ? row.evidence.ours.map(code).join('<br>') : '—（无）';
  const bsk = row.evidence.bsk.length ? row.evidence.bsk.map(code).join('<br>') : '—（无）';
  return `${ours} | ${bsk}`;
}

function displayName(row) {
  // 扩展能力轴的"名称"是能力面（record/video/...），上游/我方路径太长，只放在证据列。
  if (row.axis === 'extension') return row.name;
  if (row.bskName && row.oursName) return `${row.bskName} ↔ ${row.oursName}`;
  if (row.bskName) return row.bskName;
  return row.oursName;
}

function renderAxisTable(rows) {
  const header = [
    '| 名称 | 状态 | 我方证据（file:line / ref 路径） | BSK 证据（help 行 / 源码符号 / ref 路径） | 差距说明 | 优先级 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  const lines = [...header];
  for (const row of rows) {
    lines.push(`| ${escapeCell(displayName(row))} | ${STATUS_LABEL[row.status]} | ${evidenceCells(row)} | ${escapeCell(row.gap)} | ${row.priority} |`);
  }
  return lines;
}

/** 总览表：每轴 5 个状态计数 + 百分比；unknown 单列并标注"不计入等价"。 */
function renderOverview(summary, totals) {
  const lines = [
    '| 轴 | 格数 | equal | partial | missing | extra | unknown | 已取证比例 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const axisTitles = {
    cli: '① CLI 命令',
    rpc: '② RPC 方法',
    mcp: '③ MCP 工具',
    extension: '④ 扩展能力',
    feature: '⑤ 协议 feature floor',
    error: '⑥ 错误码',
  };
  for (const axis of AXES) {
    const item = summary[axis.id];
    lines.push(
      `| ${axisTitles[axis.id]} | ${item.total} | ${item.equal} (${item.percentages.equal}%) | ${item.partial} (${item.percentages.partial}%) | ${item.missing} (${item.percentages.missing}%) | ${item.extra} (${item.percentages.extra}%) | ${item.unknown} (${item.percentages.unknown}%) | ${item.evidenceCoverage}% |`,
    );
  }
  lines.push(
    `| **合计** | **${totals.rows}** | **${totals.equal}** | **${totals.partial}** | **${totals.missing}** | **${totals.extra}** | **${totals.unknown}** | **${Math.round((totals.equal + totals.partial + totals.missing + totals.extra) / totals.rows * 1000) / 10}%** |`,
  );
  return lines;
}

function renderProvenance(matrix) {
  const provenance = matrix.provenance;
  const lines = [];
  lines.push('### 证据来源与采集方式');
  lines.push('');
  lines.push('| 来源 | 用途 | 具体文件 / 方式 |');
  lines.push('| --- | --- | --- |');
  lines.push(`| BSK 实机帮助快照 | CLI 轴权威证据（56 命令 + 根帮助） | \`${provenance.helpSnapshotDir}/\`（\`run.mjs --snapshot-help\` 从 \`${provenance.bskBin}\` 采集） |`);
  lines.push(`| BSK 历史帮助旁证 | 交叉校验（**不是**权威） | \`${provenance.refHelpDir}/\` ${provenance.refHelp.total} 个文件：与实机快照字节一致 ${provenance.refHelp.bytesEqual}（\`.ref\` 为 CRLF、快照统一 LF，故字节一致天然偏低）、参数面一致 ${provenance.refHelp.surfaceEqual}、已过期 ${provenance.refHelp.surfaceDiffer} |`);
  lines.push(`| BSK Rust 源码 | RPC/feature/错误码/MCP 面 | \`${provenance.bskSrc}\`（\`method.rs\`/\`tools/*.rs\`/\`error.rs\`/\`compatibility.rs\`/\`cli/mcp/tools.rs\`） |`);
  lines.push(`| 上游 扩展产物 | 扩展能力轴 | \`${provenance.bskExt}\`（manifest.json + pages + content-scripts + chunks） |`);
  lines.push(`| 上游 历史结果 | 行为旁证 | \`${provenance.bskResults}/\`（${provenance.bskResultsCount} 个文件） |`);
  lines.push('| 我方源码 | 全部轴 | `lib/method-catalog.mjs`、`lib/schemas.mjs`、`cli/**`、`mcp/tools-*.mjs`、`extension/**`、`lib/error-codes.mjs` |');
  lines.push('');
  lines.push('**关于我方扩展分发表**：任务简介里写的 `extension/src/dispatch.js（COMMANDS）` 在 0.3.0 冻结树里的实际符号是 `HANDLERS`（`extension/src/dispatch.js` 的 `export const HANDLERS`，103 个方法 → 行号逐条作为证据）。矩阵按 `HANDLERS` 取证，没有另造一份 `COMMANDS` 清单。');
  lines.push('');
  lines.push(`**关于 \`.ref/bsk-help\` 旁证**：该目录是历史采集产物，其中 \`help.txt\` 是 PowerShell 采集失败的报错文本，\`_root.txt\` 仍是 49 命令的旧根帮助（比 0.5.0 实机少 open/sync/close/ledger/plan/recipe/read 七个命令）。因此 CLI 轴以 \`data/bsk-exe-help/\` 实机快照为准；\`run.mjs --probe-exe\` 会重新执行 exe 逐命令校验快照未过期。`);
  lines.push('');
  lines.push(`**关于 ref/参考实现 CLI 目录/参考实现 CLI**：参照二进制存在且可运行（\`bsk 0.5.0\`），但它是 windows-x64 构建；生成器默认**不执行**它（否则产物会随宿主平台漂移），只读已提交快照 + 源码。这样本报告在 Linux/macOS/Windows 上都能逐字节复现。`);
  lines.push('');
  lines.push(`**关于证据缺失**：真实（上游 侧或我方侧）文件/行号解析不到的格子不会写成 equal，只会写成 \`unknown\` 并在「差距」列说明缺哪一侧的什么证据；生成期锚点未命中会直接报错退出。`);
  return lines;
}

function renderTopGaps(matrix) {
  const lines = [];
  lines.push('### 最关键的 P0 差距（前 10 条）');
  lines.push('');
  lines.push('排序口径：P0 行按轴轮转（cli → rpc → mcp → feature → extension → error，每轴取当前最严重的一条），轴内按「状态严重度（missing > partial > unknown）、缺口规模、行 id 字典序」排序。这样前 10 条不会被行数最多的轴独占，也不会引入隐藏的人工排序。完整 P0 清单见 `matrix.json` 根对象的 `p0` 数组。');
  lines.push('');
  lines.push('| # | 轴 | 名称 | 状态 | 差距 |');
  lines.push('| --- | --- | --- | --- | --- |');
  matrix.topP0.forEach((row, index) => {
    lines.push(`| ${index + 1} | ${row.axis} | ${escapeCell(displayName(row))} | ${row.status} | ${escapeCell(row.gap)} |`);
  });
  return lines;
}

function renderAxis(axis, rows, intro) {
  const lines = [];
  lines.push(`## ${axis}`);
  lines.push('');
  if (intro) {
    lines.push(intro);
    lines.push('');
  }
  lines.push(...renderAxisTable(rows));
  lines.push('');
  return lines;
}

export function renderMarkdown(matrix) {
  const lines = [];
  lines.push('# 上游 0.5.0 差分矩阵（可复现）');
  lines.push('');
  lines.push(`本文件由 \`node tools/bsk-diff/run.mjs\` 生成，**不要手改**。机器可复核版本：\`${MATRIX_JSON_REL}\`。`);
  lines.push('');
  lines.push('## 口径（先读这一节）');
  lines.push('');
  lines.push('状态取值只有五种：`equal` / `partial` / `missing` / `extra` / `unknown`。含义如下（这是判定准则，不是修辞）：');
  lines.push('');
  lines.push('| 状态 | 含义 |');
  lines.push('| --- | --- |');
  for (const status of ['equal', 'partial', 'missing', 'extra', 'unknown']) {
    lines.push(`| \`${status}\` | ${STATUS_SEMANTICS[status]} |`);
  }
  lines.push('');
  lines.push('**unknown 不计入等价**。总览里的「已取证比例」只统计 equal/partial/missing/extra 四类；unknown 单独一列并显式扣除。任何一方只有口号没有 file:line / help 行 / 源码符号的格子，一律 unknown。');
  lines.push('');
  lines.push('**equal 的边界**：本报告里的 equal 只证明「可核对面一致」（命令名/参数名集合/字段集合/权限集合/floor 触发条件），不证明行为逐字节等价 —— 行为等价需要 E2E 或双向 golden 结果，不在本任务证据范围内。');
  lines.push('');
  lines.push('**extra 的边界**：extra 只表示在该轴（例如 MCP 工具面）上游 0.5.0 没有对应物，不代表 上游 在别的轴没有该能力（如 video/record/debug 在 上游 是 CLI + 协议方法，但不暴露为 MCP 工具）。');
  lines.push('');
  lines.push('## 总览');
  lines.push('');
  lines.push(...renderOverview(matrix.summary, matrix.totals));
  lines.push('');
  lines.push('> 行数口径：① CLI = 上游 56 命令 + 我方独有动词；② RPC = 两侧方法表并集；③ MCP = 我方 85 工具 + 上游 MCP 动作覆盖缺口；④ 扩展 = 8 个能力面 + manifest 权限面；⑤ floor = 我方 9 个 + 上游 独有 6 个；⑥ 错误码 = 上游 15 ErrorCode + 102 RpcErrorReason + 我方独有码。');
  lines.push('');
  lines.push(...renderProvenance(matrix));
  lines.push('');
  lines.push(...renderTopGaps(matrix));
  lines.push('');
  lines.push('## 优先级规则');
  lines.push('');
  for (const rule of PRIORITY_RULES) lines.push(`- ${rule}`);
  lines.push('');

  const axisTitles = {
    cli: ['① CLI 命令（上游 56 子命令 ↔ 我方 CLI 动词）', '比对口径：命令存在性 + 命令级 flag 契约（`cli/lib/command-specs.mjs`，缺声明时退回 CLI 全局 flag 全集）+ 位置参数契约 + 子命令面。参数名覆盖率在每行「差距」里给出具体未覆盖项。'],
    rpc: ['② RPC 方法（上游 77 方法 ↔ 我方 165 方法）', '比对口径：方法名归一化配对（含显式映射）+ **参数结构体字段集合**（上游 `pub struct *Params` 的 serde 字段 vs 我方 `lib/schemas.mjs` 的 properties）。字段集合完全一致才判 equal；任一侧没有可机械比对的字段就判 unknown。'],
    mcp: ['③ MCP 工具（我方 85 工具 + 上游 MCP 动作覆盖）', '§3a 是我方 85 个工具逐个对照 上游 的 7+1 个粗粒度 MCP 工具；§3b 反向检查 上游 MCP 的 55 个动作在我方工具面上有没有直接入口（`ours: []` 表示只能经 `browser_plan` 间接触达）。'],
    extension: ['④ 扩展能力（8 个能力面 + manifest 权限面）', '比对口径：两侧是否存在该能力的专用产物（页面 / content script / 模块 / 协议方法）+ manifest 权限是否齐备。上游 侧优先引源码（apps/extension/src），构建产物（chunks/pages）作旁证。'],
    feature: ['⑤ 协议 / feature floor（我方 9 个 + 上游 独有 6 个）', '比对口径：floor 值 + 触发条件（`FeatureWhen` vs 我方 `FEATURE_META.kind/params/methods`）。floor 与触发面都一致才判 equal。'],
    error: ['⑥ 错误码（我方 159 ↔ 上游 15 ErrorCode + 102 RpcErrorReason）', '比对口径：归一化 wire 名一致判 equal；语义近似（名称不同但同义）判 partial；上游 有而我方没有判 missing；我方多出的码判 extra。'],
  };

  const cliRows = matrix.axes.cli;
  lines.push(...renderAxis(axisTitles.cli[0], cliRows, axisTitles.cli[1]));
  lines.push(...renderAxis(axisTitles.rpc[0], matrix.axes.rpc, axisTitles.rpc[1]));
  const mcpOurs = matrix.axes.mcp.filter((row) => !row.id.startsWith('mcp:bsk:'));
  const mcpBsk = matrix.axes.mcp.filter((row) => row.id.startsWith('mcp:bsk:'));
  lines.push(`## ③ MCP 工具（我方 85 工具 + 上游 MCP 动作覆盖）`);
  lines.push('');
  lines.push(axisTitles.mcp[1]);
  lines.push('');
  lines.push('### ③a 我方 85 个 MCP 工具');
  lines.push('');  lines.push(...renderAxisTable(mcpOurs));
  lines.push('');
  lines.push('### ③b 上游 MCP 动作在我方工具面的覆盖');
  lines.push('');
  lines.push(...renderAxisTable(mcpBsk));
  lines.push('');
  lines.push(...renderAxis(axisTitles.extension[0], matrix.axes.extension, axisTitles.extension[1]));
  lines.push(...renderAxis(axisTitles.feature[0], matrix.axes.feature, axisTitles.feature[1]));
  lines.push(...renderAxis(axisTitles.error[0], matrix.axes.error, axisTitles.error[1]));

  lines.push('## 复现');
  lines.push('');
  lines.push('```bash');
  lines.push('# 1) 生成 matrix.json + 本文件（确定性，二次运行逐字节一致）');
  lines.push('node tools/bsk-diff/run.mjs');
  lines.push('');
  lines.push('# 2) 校验仓库内产物是否与生成结果一致（CI 用；不一致退出 1）');
  lines.push('node tools/bsk-diff/run.mjs --check');
  lines.push('');
  lines.push('# 3) 打印 JSON 到 stdout（不写文件）');
  lines.push('node tools/bsk-diff/run.mjs --json');
  lines.push('');
  lines.push('# 4) 用参照二进制重新执行 56 个 --help，校验快照没过期（需要 windows-x64 环境）');
  lines.push('node tools/bsk-diff/run.mjs --probe-exe');
  lines.push('');
  lines.push('# 5) 重新采集 help 快照（仅当参照二进制更新时）');
  lines.push('node tools/bsk-diff/run.mjs --snapshot-help');
  lines.push('```');
  lines.push('');
  lines.push('单测：`node --test tests/unit/bsk-diff-*.test.mjs`。');
  lines.push('');
  return lines.join('\n');
}

/** JSON 序列化：2 空格缩进 + 末尾换行，稳定。 */
export function serializeMatrix(matrix) {
  return `${JSON.stringify(matrix, null, 2)}\n`;
}
