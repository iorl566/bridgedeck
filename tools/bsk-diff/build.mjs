// tools/bsk-diff/build.mjs —— 组装 matrix 对象（纯数据，可被 run.mjs 与单测共同调用）。
//
// 输出结构（matrix.json）：
//   { schemaVersion, generator, protocol, provenance, summary, totals, topP0, axes, rows, p0 }
// 其中 axes[axis] 是渲染/计数用的行数组，rows 是同一个行集合的扁平视图。

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractBsk } from './lib/extract-bsk.mjs';
import { extractOurs, REPO_ROOT } from './lib/extract-ours.mjs';
import { buildMatrix } from './lib/join.mjs';
import { probeHelpSnapshots, surfaceDigest } from './lib/exe.mjs';

export const SCHEMA_VERSION = 1;
export const GENERATOR = 'tools/bsk-diff';

const TOP_P0_LIMIT = 10;
/** 「最关键」的排序：先按轴轮转（每轴取最严重的一条），再按缺口规模。 */
const AXIS_ROUND_ROBIN = ['cli', 'rpc', 'mcp', 'feature', 'extension', 'error'];
const STATUS_SEVERITY = { missing: 0, partial: 1, unknown: 2, extra: 8, equal: 9 };

function gapMagnitude(row) {
  const detail = row.detail || {};
  return (detail.uncoveredOptions || []).length
    + (detail.subcommands && detail.subcommands.uncovered ? detail.subcommands.uncovered.length : 0)
    + (detail.bskOnlyFields || []).length
    + (row.status === 'missing' ? 3 : 0);
}

/**
 * 前 10 条 P0：按轴轮转，保证 CLI/RPC/MCP/feature/extension 都被代表，
 * 而不是被行数最多的轴独占。轴内按（状态严重度, 缺口规模, id）稳定排序。
 */
function rankP0(rows) {
  const byAxis = new Map();
  for (const row of rows) {
    if (!byAxis.has(row.axis)) byAxis.set(row.axis, []);
    byAxis.get(row.axis).push(row);
  }
  for (const list of byAxis.values()) {
    list.sort((a, b) => {
      const statusA = STATUS_SEVERITY[a.status] ?? 9;
      const statusB = STATUS_SEVERITY[b.status] ?? 9;
      if (statusA !== statusB) return statusA - statusB;
      // 核心链路（MCP 输入/观测动作）优先于同状态的其他行；核心链路内部按声明顺序。
      const coreA = a.detail && a.detail.coreAction ? a.detail.coreOrder : 99;
      const coreB = b.detail && b.detail.coreAction ? b.detail.coreOrder : 99;
      if (coreA !== coreB) return coreA - coreB;
      const magA = gapMagnitude(a);
      const magB = gapMagnitude(b);
      if (magA !== magB) return magB - magA;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
  }
  const picked = [];
  const seen = new Set();
  let round = 0;
  while (picked.length < TOP_P0_LIMIT) {
    let added = false;
    for (const axis of AXIS_ROUND_ROBIN) {
      const list = byAxis.get(axis) || [];
      if (round >= list.length) continue;
      const row = list[round];
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      picked.push(row);
      added = true;
      if (picked.length >= TOP_P0_LIMIT) break;
    }
    if (!added) break;
    round += 1;
  }
  return picked;
}

/**
 * 计算 provenance：证明每条证据从哪来、旁证是否过期。
 *
 * `.ref/bsk-help` 的过期判定是**静态**的：把它与 data/bsk-exe-help 实机快照逐命令比对
 * （字节 + 可核对面）。这样默认生成不需要执行参照二进制；`--probe-exe` 再把 exe 拉进来
 * 做第三重校验（exe vs 快照），并把结果写进 provenance.externalProbe。
 */
async function buildProvenance(root, bsk, options) {
  const refRows = [];
  for (const surface of bsk.cliSurfaces) {
    if (!surface.refSnapshotFile || !surface.helpFile) continue;
    const refAbs = path.join(root, surface.refSnapshotFile);
    const snapAbs = path.join(root, surface.helpFile);
    const refText = fs.readFileSync(refAbs, 'utf8');
    const snapText = fs.readFileSync(snapAbs, 'utf8');
    const refCanonical = refText.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd();
    const snapCanonical = snapText.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd();
    const bytesEqual = refCanonical === snapCanonical;
    const surfaceEqual = bytesEqual ? true : JSON.stringify(surfaceDigest(refText)) === JSON.stringify(surfaceDigest(snapText));
    refRows.push({ command: surface.name, bytesEqual, surfaceEqual });
  }
  const refHelpStats = {
    total: refRows.length,
    bytesEqual: refRows.filter((row) => row.bytesEqual).length,
    surfaceEqual: refRows.filter((row) => row.surfaceEqual).length,
    surfaceDiffer: refRows.filter((row) => !row.surfaceEqual).length,
    staleCommands: refRows.filter((row) => !row.surfaceEqual).map((row) => row.command),
    note: '与 data/bsk-exe-help 实机快照静态比对（不执行 exe）；旁证过期只影响交叉校验，不影响 CLI 轴结论',
  };

  let externalProbe = null;
  if (options.runProbe) {
    const result = probeHelpSnapshots(root, [...bsk.commands.map((command) => command.name), '_root']);
    externalProbe = result.ok
      ? { ok: true, checked: result.rows.length, mismatched: result.rows.filter((row) => !row.snapshotMatch).map((row) => row.command) }
      : { ok: false, reason: result.reason, checked: result.rows.length, mismatched: [] };
  }

  return {
    generator: GENERATOR,
    schemaVersion: SCHEMA_VERSION,
    bskBin: bsk.paths.bin,
    bskSrc: bsk.paths.src,
    bskExt: bsk.paths.ext,
    helpSnapshotDir: bsk.paths.snapshot,
    refHelpDir: bsk.paths.help,
    bskResults: bsk.paths.results,
    bskResultsCount: bsk.results.files.length,
    bskCliCommandCount: bsk.commands.length,
    helpSnapshotSource: bsk.commands.length ? bsk.commands[0].helpSource : 'unknown',
    refHelp: refHelpStats,
    externalProbe,
    protocol: {
      bsk: bsk.vocabulary.protocolVersion,
      bskMinCompatible: bsk.vocabulary.minCompatible,
      oursCurrent: null,
      oursBaseline: null,
    },
    notes: [
      'CLI 轴以 data/bsk-exe-help 实机快照为权威；.ref/bsk-help 仅作旁证（其中 help.txt 是采集失败的报错文本）。',
      '生成器默认不执行参照二进制，产物只依赖仓库内文件，保证跨平台逐字节复现。',
      '.ref/bsk-help 的过期统计是与实机快照的静态比对，不含执行时刻依赖。',
    ],
  };
}

/** 组装完整 matrix。纯确定性：不含时间戳/随机/绝对路径。 */
export async function build(root = REPO_ROOT, options = {}) {
  const bsk = extractBsk(root);
  const ours = await extractOurs();
  const core = buildMatrix(bsk, ours);
  const provenance = await buildProvenance(root, bsk, options);
  provenance.protocol.oursCurrent = ours.methods.protocolCurrent;
  provenance.protocol.oursBaseline = ours.methods.protocolBaseline;

  const matrix = {
    schemaVersion: SCHEMA_VERSION,
    generator: GENERATOR,
    protocol: provenance.protocol,
    provenance,
    inventory: {
      bsk: {
        cliCommands: bsk.commands.length,
        rpcMethods: bsk.methods.length,
        errorCodes: bsk.vocabulary.errorCodes.length,
        rpcErrorReasons: bsk.vocabulary.reasons.length,
        features: bsk.features.length,
        mcpTools: bsk.mcp.tools.length + (bsk.mcp.recipeTool ? 1 : 0),
        mcpActions: Object.values(bsk.mcp.actionEnums).reduce((sum, block) => sum + block.actions.length, 0),
        extPages: bsk.ext.pages.length,
        extChunks: bsk.ext.chunks.length,
      },
      ours: {
        cliVerbs: ours.cli.verbs.length,
        rpcMethods: ours.methods.methods.length,
        methodSchemas: ours.methods.schemaCount,
        errorCodes: ours.errors.count,
        features: ours.methods.featureNames.length,
        mcpTools: ours.mcp.tools.length,
        dispatchHandlers: ours.dispatch.handlers.length,
        extUiPages: ours.extension.uiPages.length,
      },
    },
    summary: core.summary,
    totals: core.totals,
    topP0: rankP0(core.p0),
    p0: core.p0,
    axes: core.axes,
    rows: core.rows,
  };
  return matrix;
}

/** 当前文件所在仓库根（供 CLI 与单测共用）。 */
export const BUILD_ROOT = REPO_ROOT;
export const buildRoot = (options = {}) => build(REPO_ROOT, options);

export const PATHS = Object.freeze({
  matrixJson: path.join(REPO_ROOT, 'tools/bsk-diff/matrix.json'),
  matrixMarkdown: path.join(REPO_ROOT, 'docs/BSK-DIFF-MATRIX.md'),
  matrixJsonRel: 'tools/bsk-diff/matrix.json',
  matrixMarkdownRel: 'docs/BSK-DIFF-MATRIX.md',
});

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
