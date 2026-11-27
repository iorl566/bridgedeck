#!/usr/bin/env node
// tools/scale-report.mjs —— 规模报告 + 规模门禁（文件数/行数/单文件上限 + 上游 对标百分比）。
//
// 0.3.0 早期版本只打印“文件数 / 行数 / 目标百分比”，没有上限、没有单文件约束、阈值写死。
// W4 起把它升级成真正的门禁（默认只报告，--check 才按门禁退出）：
//   - 绝对上限：文件数、总行数、单文件行数（生成物用更宽的上限，避免把 generated 表算成手写膨胀）；
//   - 上游 对标：上游 0.5.0 代码行基线 316,463（docs/上游-PARITY-PROGRAM.md §1），
//     报告对标百分比，并可设最低门槛；
//   - 基线回归：tools/scale-baseline.json 记录上一次确认的规模；超容差即失败，
//     必须显式 `--update-baseline` 才会抬高上限（避免“越写越多顺手改基线”）；
//   - 阈值可配置：--limits <file|json>、BB_SCALE_MAX_FILES / BB_SCALE_MAX_LINES /
//     BB_SCALE_MAX_FILE_LINES / BB_SCALE_REFERENCE_LINES / BB_SCALE_TARGET / BB_SCALE_MIN_PARITY。
//
// 统计口径与旧版一致：只数 .js/.mjs，排除 node_modules/.git/dist/ref/reference/.tmp 等目录，
// 这样跨轮次的数字可直接对比。
//
// 用法：
//   node tools/scale-report.mjs                     # 只报告（exit 0）
//   node tools/scale-report.mjs --check             # 门禁（超限/基线漂移 exit 1）
//   node tools/scale-report.mjs --json [--check]    # 机器可读
//   node tools/scale-report.mjs --limits .tmp/scale-limits.json
//   node tools/scale-report.mjs --update-baseline   # 显式更新基线（写 tools/scale-baseline.json）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = path.join(ROOT, 'tools', 'scale-baseline.json');
const SELF = fileURLToPath(import.meta.url);

/** 上游 0.5.0 代码行基线（docs/上游-PARITY-PROGRAM.md §1，口径 rs/ts/tsx/js/mjs）。 */
export const REFERENCE_LINES = 316463;
/** 路线 A 的 scale target（旧报告里的 329,000 行目标，可由 BB_SCALE_TARGET 覆盖）。 */
export const SCALE_TARGET_LINES = 329000;

export const DEFAULT_LIMITS = Object.freeze({
  // 0.3.0 冻结期上限 1,400/260,000 是为当时的发布范围设的护栏；上游 0.5.0 体量对标
  // 目标本身是 316,463 行（见 docs/上游-PARITY-PROGRAM.md §5），护栏必须高于目标才可执行，
  // 否则对标程序会被“发布护栏”而不是质量标准卡住。回归仍由 baseline.regression（±0.5%）把关。
  maxFiles: 1800,
  maxLines: 380000,
  maxFileLines: 8000,
  maxGeneratedFileLines: 24000,
  baselineLineGrowthRatio: 0.005,
  baselineFileGrowth: 5,
  minParityPct: 25,
});

/** 统计时跳过的目录（与旧版完全一致，外加构建产物与参考实现）。 */
export const SKIP_DIRS = Object.freeze(['node_modules', '.git', 'dist', 'ref', 'reference', '.ref', '.tmp-bench', '.tmp', '0.4']);
/** 生成物目录：单文件上限更宽（表随方法数/状态数增长，不是手写膨胀）。 */
export const GENERATED_DIRS = Object.freeze(['extension/src/generated/']);

const GROUP_RULES = Object.freeze([
  ['daemon/', 'daemon'],
  ['cli/', 'cli'],
  ['extension/', 'extension'],
  ['mcp/', 'mcp'],
  ['lib/', 'lib'],
]);

function toPosix(value) {
  return String(value || '').replace(/\\/g, '/');
}

function groupOf(relative) {
  for (const [prefix, group] of GROUP_RULES) {
    if (relative.startsWith(prefix)) return group;
  }
  return 'other';
}

function isGenerated(relative) {
  return GENERATED_DIRS.some((prefix) => relative.startsWith(prefix));
}

function formatNumber(value) {
  return String(Math.round(Number(value) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

/** 递归收集 .js/.mjs（与旧版口径一致；导出便于测试临时目录）。 */
export function walkFiles(root) {
  const out = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.includes(entry.name)) continue;
        visit(full);
      } else if (/\.(mjs|js)$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  visit(root);
  return out;
}

/** 读文件行数（旧版同口径：split('\n').length）。 */
export function countLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').length;
  } catch {
    return 0;
  }
}

/** 仓库扫描 → [{file:相对路径, lines, group, generated}]。 */
export function scanRepository(root = ROOT) {
  return walkFiles(root).map((file) => {
    const relative = toPosix(path.relative(root, file));
    return { file: relative, lines: countLines(file), group: groupOf(relative), generated: isGenerated(relative) };
  }).sort((a, b) => a.file.localeCompare(b.file));
}

/** 汇总：总文件/总行/分组/最大文件（纯函数，输入为 scanRepository 的 records）。 */
export function summarizeScale(records, { largest = 8 } = {}) {
  const rows = Array.isArray(records) ? records : [];
  const groups = {};
  let lines = 0;
  for (const row of rows) {
    lines += Number(row.lines) || 0;
    const group = row.group || groupOf(toPosix(row.file || ''));
    groups[group] = (groups[group] || 0) + (Number(row.lines) || 0);
  }
  const largestFiles = rows
    .map((row) => ({ file: toPosix(row.file), lines: Number(row.lines) || 0, generated: row.generated === true || isGenerated(toPosix(row.file)) }))
    .sort((a, b) => b.lines - a.lines || a.file.localeCompare(b.file))
    .slice(0, Math.max(0, Math.round(Number(largest) || 0)));
  return {
    files: rows.length,
    lines,
    groups: Object.fromEntries(Object.entries(groups).sort((a, b) => b[1] - a[1])),
    largest: largestFiles,
  };
}

/** 阈值：默认 → 配置文件/inline JSON → 环境变量，后两者覆盖默认。 */
export function resolveLimits({ limits = null, env = process.env } = {}) {
  const merged = { ...DEFAULT_LIMITS };
  if (limits) {
    for (const [key, value] of Object.entries(limits)) {
      if (key in merged && Number.isFinite(Number(value))) merged[key] = Number(value);
    }
  }
  const envMap = {
    BB_SCALE_MAX_FILES: 'maxFiles',
    BB_SCALE_MAX_LINES: 'maxLines',
    BB_SCALE_MAX_FILE_LINES: 'maxFileLines',
    BB_SCALE_MAX_GENERATED_FILE_LINES: 'maxGeneratedFileLines',
    BB_SCALE_MIN_PARITY: 'minParityPct',
    BB_SCALE_BASELINE_GROWTH: 'baselineLineGrowthRatio',
    BB_SCALE_BASELINE_FILES: 'baselineFileGrowth',
  };
  for (const [name, key] of Object.entries(envMap)) {
    const raw = env && env[name];
    if (raw !== undefined && raw !== '' && Number.isFinite(Number(raw))) merged[key] = Number(raw);
  }
  merged.referenceLines = Number(env && env.BB_SCALE_REFERENCE_LINES) > 0 ? Number(env.BB_SCALE_REFERENCE_LINES) : REFERENCE_LINES;
  merged.targetLines = Number(env && env.BB_SCALE_TARGET) > 0 ? Number(env.BB_SCALE_TARGET) : SCALE_TARGET_LINES;
  return merged;
}

/** 读 --limits 文件或 inline JSON；非法直接抛（阈值坏了不能静默回默认）。 */
export function loadLimits(source) {
  if (!source) return null;
  const text = fs.existsSync(source) ? fs.readFileSync(source, 'utf8') : String(source);
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('需要对象');
    return parsed;
  } catch (error) {
    throw new Error('--limits 不是合法 JSON 对象：' + ((error && error.message) || error));
  }
}

/** 读基线（{files,lines}）；不存在返回 null，非法抛。 */
export function loadScaleBaseline(file = BASELINE_PATH) {
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error('规模基线不是合法 JSON：' + file + '（' + ((error && error.message) || error) + '）');
  }
  if (!parsed || !Number.isFinite(Number(parsed.files)) || !Number.isFinite(Number(parsed.lines))) {
    throw new Error('规模基线格式非法（需要 {files,lines}）：' + file);
  }
  return { files: Number(parsed.files), lines: Number(parsed.lines) };
}

export function writeScaleBaseline(summary, { file = BASELINE_PATH, recordedAt = new Date().toISOString() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ files: summary.files, lines: summary.lines, recordedAt }, null, 2) + '\n', 'utf8');
  return file;
}

/**
 * 门禁判定：绝对上限 + 单文件上限 + 基线容差 + 上游 对标门槛。
 * @param {{summary:object, records?:Array<{file:string,lines:number,generated?:boolean}>|null,
 *   limits?:object, baseline?:object|null, bskLines?:number}} input
 */
export function evaluateScale({ summary, records = null, limits = null, baseline = null, referenceLines = REFERENCE_LINES } = {}) {
  const merged = { ...DEFAULT_LIMITS, ...(limits || {}), referenceLines: Number(referenceLines) || REFERENCE_LINES };
  if (!(Number(merged.targetLines) > 0)) merged.targetLines = SCALE_TARGET_LINES;
  const checks = [];
  const violations = [];
  const push = (id, ok, detail) => {
    checks.push({ id, ok, detail });
    if (!ok) violations.push({ id, detail });
  };
  const files = Number(summary && summary.files) || 0;
  const lines = Number(summary && summary.lines) || 0;

  push('limits.files', files <= merged.maxFiles, '文件数 ' + formatNumber(files) + (files <= merged.maxFiles ? ' ≤ ' : ' > ') + formatNumber(merged.maxFiles));
  push('limits.lines', lines <= merged.maxLines, '行数 ' + formatNumber(lines) + (lines <= merged.maxLines ? ' ≤ ' : ' > ') + formatNumber(merged.maxLines));

  const largest = (summary && Array.isArray(summary.largest) ? summary.largest : []);
  // 有全量 records 时逐文件检查（否则退化为最大文件 topN，仍能抓到最大那一个）。
  const fileRows = Array.isArray(records) && records.length
    ? records.map((row) => ({ file: toPosix(row.file), lines: Number(row.lines) || 0, generated: row.generated === true || isGenerated(toPosix(row.file)) }))
    : largest;
  const overLimit = fileRows.filter((row) => row.lines > (row.generated ? merged.maxGeneratedFileLines : merged.maxFileLines));
  const largestText = largest.length
    ? '最大 ' + largest[0].file + ' ' + formatNumber(largest[0].lines) + ' 行（手写上限 ' + formatNumber(merged.maxFileLines) + '，生成物上限 ' + formatNumber(merged.maxGeneratedFileLines) + '）'
    : '没有可统计文件';
  push('limits.file-size', overLimit.length === 0, overLimit.length
    ? '超单文件上限：' + overLimit.map((row) => row.file + ' ' + formatNumber(row.lines) + ' 行').join('；')
    : largestText);

  // 基线容差：基线是“上一次确认过的规模”，涨过容差必须显式更新基线。
  if (!baseline) {
    push('baseline.present', false, '缺少规模基线 ' + BASELINE_PATH + '（运行 --update-baseline 显式写入）');
  } else {
    const maxLines = Math.ceil(Number(baseline.lines) * (1 + Number(merged.baselineLineGrowthRatio)));
    const maxFiles = Number(baseline.files) + Number(merged.baselineFileGrowth);
    const ok = lines <= maxLines && files <= maxFiles;
    push('baseline.regression', ok, ok
      ? '基线 ' + formatNumber(baseline.files) + ' 文件 / ' + formatNumber(baseline.lines) + ' 行（容差 +'
        + round(Number(merged.baselineLineGrowthRatio) * 100, 2) + '% 行 / +' + merged.baselineFileGrowth + ' 文件）'
      : '规模超过基线容差：' + formatNumber(files) + ' 文件 / ' + formatNumber(lines) + ' 行，上限 '
        + formatNumber(maxFiles) + ' / ' + formatNumber(maxLines) + '；如确认是有意增长，运行 node tools/scale-report.mjs --update-baseline');
  }

  const parityPct = merged.referenceLines > 0 ? round((lines / merged.referenceLines) * 100, 1) : 0;
  const targetPct = merged.targetLines > 0 ? round((lines / merged.targetLines) * 100, 1) : 0;
  push('reference.parity', parityPct >= Number(merged.minParityPct), '参考实现对标 ' + parityPct + '%（下限 ' + merged.minParityPct + '%；参考 ' + formatNumber(merged.referenceLines) + ' 行）');

  return {
    ok: violations.length === 0,
    checks,
    violations,
    parity: { referenceLines: merged.referenceLines, targetLines: merged.targetLines, parityPct, targetPct },
    limits: merged,
  };
}

/** 可读报告（纯函数）。 */
export function formatReport(result) {
  const lines = [];
  const summary = result.summary || { files: 0, lines: 0, groups: {}, largest: [] };
  lines.push('BridgeDeck 规模：' + formatNumber(summary.files) + ' 文件 / ' + formatNumber(summary.lines) + ' 行');
  lines.push('  参考实现对标：' + result.parity.parityPct + '%（参考 ' + formatNumber(result.parity.referenceLines) + ' 行）'
    + '；scale target ' + formatNumber(result.parity.targetLines) + ' 行（' + result.parity.targetPct + '%）');
  lines.push('  分组：');
  for (const [group, count] of Object.entries(summary.groups || {})) {
    lines.push('    ' + String(group).padEnd(10) + formatNumber(count).padStart(9) + ' 行');
  }
  lines.push('  上限检查：');
  for (const item of result.checks || []) {
    lines.push('    ' + (item.ok ? '[ok]' : '[!!]') + ' ' + item.id.padEnd(20) + item.detail);
  }
  lines.push('  最大文件：');
  for (const row of summary.largest || []) {
    lines.push('    ' + formatNumber(row.lines).padStart(8) + ' 行  ' + row.file + (row.generated ? '（生成物）' : ''));
  }
  if (result.checkMode) {
    lines.push(result.ok ? 'SCALE GATE PASS' : 'SCALE GATE FAILED');
  } else {
    lines.push('SCALE REPORT（只报告；加 --check 才按门禁退出）'
      + (result.ok ? '' : '；当前未满足：' + (result.violations || []).map((item) => item.id).join(', ')));
  }
  return lines.join('\n');
}

export class UsageError extends Error {}

export function parseArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  const options = { check: false, json: false, updateBaseline: false, help: false, limits: null, baseline: process.env.BB_SCALE_BASELINE || BASELINE_PATH };
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === '--check') options.check = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--update-baseline') { options.updateBaseline = true; options.check = true; }
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--limits') {
      options.limits = args[index + 1];
      if (!options.limits) throw new UsageError('--limits 需要一个 JSON 文件或 inline JSON');
      index += 1;
    } else if (arg.startsWith('--limits=')) {
      options.limits = arg.slice('--limits='.length);
      if (!options.limits) throw new UsageError('--limits 需要一个 JSON 文件或 inline JSON');
    } else if (arg === '--baseline') {
      options.baseline = args[index + 1];
      if (!options.baseline) throw new UsageError('--baseline 需要文件路径');
      index += 1;
    } else if (arg.startsWith('--baseline=')) {
      options.baseline = arg.slice('--baseline='.length);
      if (!options.baseline) throw new UsageError('--baseline 需要文件路径');
    } else {
      throw new UsageError('未知参数：' + arg);
    }
  }
  return options;
}

function printUsageText() {
  return `规模报告与门禁

用法：
  node tools/scale-report.mjs                     # 只报告
  node tools/scale-report.mjs --check             # 门禁（超限/基线漂移/对标下限）
  node tools/scale-report.mjs --json [--check]    # 机器可读
  node tools/scale-report.mjs --limits <file|json>
  node tools/scale-report.mjs --baseline <file>
  node tools/scale-report.mjs --update-baseline   # 显式写入 tools/scale-baseline.json

默认阈值：${JSON.stringify(DEFAULT_LIMITS)}
环境覆盖：BB_SCALE_MAX_FILES / BB_SCALE_MAX_LINES / BB_SCALE_MAX_FILE_LINES /
          BB_SCALE_MIN_PARITY / BB_SCALE_REFERENCE_LINES / BB_SCALE_TARGET`;
}

/** 主流程（返回退出码，便于测试）。 */
export function main(argv = [], io = {}) {
  const stdout = io.stdout || ((text) => process.stdout.write(text + '\n'));
  const stderr = io.stderr || ((text) => process.stderr.write(text + '\n'));
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr(String((error && error.message) || error));
    return 2;
  }
  if (options.help) { stdout(printUsageText()); return 0; }
  let limits;
  let baseline;
  try {
    limits = resolveLimits({ limits: loadLimits(options.limits) });
    baseline = loadScaleBaseline(options.baseline);
  } catch (error) {
    stderr(String((error && error.message) || error));
    return 2;
  }
  const records = scanRepository(ROOT);
  const summary = summarizeScale(records);
  if (options.updateBaseline) {
    const target = writeScaleBaseline(summary, { file: options.baseline });
    stdout('规模基线已更新：' + path.relative(ROOT, target).replace(/\\/g, '/') + '（' + summary.files + ' 文件 / ' + summary.lines + ' 行）');
    baseline = { files: summary.files, lines: summary.lines };
  }
  const evaluated = evaluateScale({ summary, records, limits, baseline, referenceLines: limits.referenceLines });
  const result = {
    ok: evaluated.ok,
    summary,
    parity: evaluated.parity,
    limits: evaluated.limits,
    checks: evaluated.checks,
    violations: evaluated.violations,
    baseline: baseline ? { files: baseline.files, lines: baseline.lines } : null,
    baselinePath: path.relative(ROOT, path.resolve(options.baseline)).replace(/\\/g, '/'),
    checkMode: options.check,
  };
  if (options.json) stdout(JSON.stringify(result, null, 2));
  else stdout(formatReport(result));
  // 默认只报告（exit 0）；--check 才按门禁退出。
  return options.check ? (evaluated.ok ? 0 : 1) : 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isMain = invokedPath.toLowerCase() === SELF.toLowerCase();
if (isMain) process.exit(main(process.argv.slice(2)));
