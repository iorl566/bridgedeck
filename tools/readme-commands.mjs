#!/usr/bin/env node
// tools/readme-commands.mjs —— README「命令索引」与 cli/lib/command-specs.mjs 的一致性门禁。
//
// 背景：命令的参数契约已经是单一来源（cli/lib/command-specs.mjs），`bridge help <命令>`
// 也由它渲染；但 README 里的命令说明一直是手写的，改 specs 不一定会同步文档，
// 于是出现「帮助说一套、文档写一套、校验做第三套」。本生成器只做一件事：
// 把 specs 里的 命令 / 子命令 / 风险 / 说明 渲染进 README 的标记区间。
//
//   node tools/readme-commands.mjs            # 覆盖写入标记区间（幂等）
//   node tools/readme-commands.mjs --check    # 只比对：漂移 → 退出码 1
//   node tools/readme-commands.mjs --stdout   # 把生成块打到 stdout（不写文件）
//   node tools/readme-commands.mjs --json     # 机器可读结果
//   node tools/readme-commands.mjs --file <path>   # 指定 README（默认仓库根 README.md）
//
// 约定：只有 BEGIN/END 标记**之间**的内容是生成物；标记之外的字可自由编辑。
// 标记缺失时默认退出 2（避免生成器悄悄把整篇 README 重写），提示先手工加标记。
//
// 退出码：0 一致/已写入；1 漂移（--check）；2 用法或 README 结构问题。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { COMMAND_SPECS } from '../cli/lib/command-specs.mjs';
import { RISK_INFO } from '../cli/lib/arg-contract.mjs';
import { PLAN_SUBCOMMANDS } from '../cli/lib/command-plans.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_README = path.resolve(HERE, '..', 'README.md');

export const BEGIN_MARKER = '<!-- bridge-commands:start（由 tools/readme-commands.mjs 生成，勿手改）-->';
export const END_MARKER = '<!-- bridge-commands:end -->';

/** 一行说明的固定头部：告诉读者这段是生成物、怎么刷新。 */
const GENERATED_NOTE = '> 本段由 `node tools/readme-commands.mjs` 从 `cli/lib/command-specs.mjs` 生成，'
  + '`--check` 漂移即失败；参数表与示例用 `bridge help <命令>` 查看。';

function escapeCell(value) {
  return String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function riskLabelsFor(spec) {
  const risks = [];
  for (const name of spec.order) {
    const subSpec = spec.subs[name];
    if (!subSpec) continue;
    const risk = String(subSpec.risk || '');
    if (risk && !risks.includes(risk)) risks.push(risk);
  }
  return risks;
}

function riskCell(risks) {
  return risks.map((risk) => {
    const info = RISK_INFO[risk];
    return '`' + risk + '`' + (info && info.label ? '（' + info.label + '）' : '');
  }).join('<br>');
}

/** 统计全部命令 / 子命令数量（README 生成块底部的“覆盖面”数字）。 */
export function countSubcommands(specs = COMMAND_SPECS) {
  let total = 0;
  for (const spec of Object.values(specs || {})) total += (spec.order || []).length;
  return total;
}

/**
 * 推导“可 --dry-run 预检”的命令：只有当该命令**所有**子命令都声明 dryRun === true
 * 才写进 README（避免把只支持一半的命令宣传成全部支持）。
 */
export function dryRunTopics(specs = COMMAND_SPECS) {
  const topics = [];
  for (const [topic, spec] of Object.entries(specs || {})) {
    const names = Array.isArray(spec.order) ? spec.order : [];
    if (!names.length) continue;
    const all = names.every((name) => {
      const subSpec = spec.subs && spec.subs[name];
      return Boolean(subSpec && subSpec.dryRun === true);
    });
    if (all) topics.push(topic);
  }
  return topics;
}

/**
 * 校验 specs 形状：生成器宁可失败也不生成半截文档。
 * 返回问题清单（空数组 = 通过）。
 */
export function auditCommandSpecs(specs = COMMAND_SPECS) {
  const problems = [];
  if (!specs || typeof specs !== 'object') return ['COMMAND_SPECS 不是对象'];
  for (const [topic, spec] of Object.entries(specs)) {
    if (!spec || typeof spec !== 'object') {
      problems.push(topic + ': spec 不是对象');
      continue;
    }
    if (spec.command !== topic) problems.push(topic + ': spec.command 与键名不一致（' + spec.command + '）');
    if (!spec.summary) problems.push(topic + ': 缺少 summary');
    if (!Array.isArray(spec.order) || spec.order.length === 0) problems.push(topic + ': 缺少 order');
    if (!spec.subs || typeof spec.subs !== 'object') {
      problems.push(topic + ': 缺少 subs');
      continue;
    }
    for (const name of spec.order || []) {
      const subSpec = spec.subs[name];
      if (!subSpec) problems.push(topic + ': order 里的 ' + name + ' 不在 subs 里');
      else if (!subSpec.usage) problems.push(topic + ' ' + name + ': 缺少 usage');
      else if (subSpec.dryRun !== undefined && typeof subSpec.dryRun !== 'boolean') {
        problems.push(topic + ' ' + name + ': dryRun 必须是布尔值');
      } else if (subSpec.dryRun === true && !(PLAN_SUBCOMMANDS[topic] || []).includes(name)) {
        // specs 声称支持 --dry-run，但命令实现没有对应计划构造器：代码与文档脱节。
        problems.push(topic + ' ' + name + ': 声明了 dryRun 但 cli/lib/command-plans.mjs 没有该子命令的计划');
      } else if (subSpec.dryRun === true && !subSpec.risk) {
        problems.push(topic + ' ' + name + ': 声明了 dryRun 但缺少 risk');
      }
    }
    for (const name of Object.keys(spec.subs)) {
      if (!(spec.order || []).includes(name)) problems.push(topic + ': subs 里的 ' + name + ' 不在 order 里');
    }
  }
  return problems;
}

/** 表格行（不含表头/分隔行）：每行 [命令, 子命令, 风险, 说明]。 */
export function buildCommandIndexRows(specs = COMMAND_SPECS) {
  const rows = [];
  for (const [topic, spec] of Object.entries(specs)) {
    const subs = (spec.order || []).map((name) => (name === 'default' ? '（无子命令）' : name));
    rows.push([
      '`bridge ' + topic + '`',
      subs.join(' / '),
      riskCell(riskLabelsFor(spec)),
      spec.summary || '',
    ]);
  }
  return rows;
}

/**
 * 渲染标记区间内的内容（不含标记本身）。纯函数：同样的 specs 永远得到同样的文本，
 * 方便 `--check` 做逐字节比对。
 */
export function renderCommandIndexBody(specs = COMMAND_SPECS) {
  const lines = [];
  lines.push(GENERATED_NOTE);
  lines.push('');
  lines.push('| 命令 | 子命令 | 风险 | 说明 |');
  lines.push('| --- | --- | --- | --- |');
  for (const row of buildCommandIndexRows(specs)) {
    lines.push('| ' + row.map(escapeCell).join(' | ') + ' |');
  }
  lines.push('');
  lines.push('覆盖面：' + Object.keys(specs).length + ' 个命令 / ' + countSubcommands(specs) + ' 个子命令；'
    + '参数层严格校验（未知 flag / 子命令 / 枚举越界在发 RPC 前退出 2）。');
  const dryTopics = dryRunTopics(specs);
  lines.push(dryTopics.length
    ? '支持 `--dry-run` 预检（该命令全部子命令）：' + dryTopics.map((topic) => '`' + topic + '`').join('、') + '。'
    : '支持 `--dry-run` 预检（该命令全部子命令）：暂无。');
  return lines.join('\n');
}

/** 完整标记块（含 BEGIN/END）：README 里原样保存这一段。 */
export function renderCommandIndexSection(specs = COMMAND_SPECS) {
  return [BEGIN_MARKER, renderCommandIndexBody(specs), END_MARKER].join('\n');
}

/** 从 README 文本里取出标记区间：[beginIndex, endIndex]；缺失/顺序错返回原因。 */
export function locateMarkers(readmeText) {
  const text = String(readmeText == null ? '' : readmeText);
  const begin = text.indexOf(BEGIN_MARKER);
  const end = text.indexOf(END_MARKER);
  if (begin < 0) return { ok: false, reason: '缺少 BEGIN 标记：' + BEGIN_MARKER };
  if (end < 0) return { ok: false, reason: '缺少 END 标记：' + END_MARKER };
  if (end < begin) return { ok: false, reason: 'END 标记出现在 BEGIN 之前' };
  return { ok: true, begin, end, beginLine: lineOf(text, begin), endLine: lineOf(text, end) };
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/** 用新内容替换标记区间；标记之外一个字节都不动。 */
export function replaceCommandIndex(readmeText, body = renderCommandIndexBody()) {
  const text = String(readmeText == null ? '' : readmeText);
  const located = locateMarkers(text);
  if (!located.ok) return { ok: false, reason: located.reason, text };
  const head = text.slice(0, located.begin + BEGIN_MARKER.length);
  const tail = text.slice(located.end);
  return {
    ok: true,
    text: head + '\n' + String(body).replace(/\r\n/g, '\n') + '\n' + tail,
  };
}

/** 提取 README 里现有的生成内容（用于 diff 诊断）。 */
export function extractCommandIndexBody(readmeText) {
  const text = String(readmeText == null ? '' : readmeText);
  const located = locateMarkers(text);
  if (!located.ok) return { ok: false, reason: located.reason, body: '' };
  const body = text.slice(located.begin + BEGIN_MARKER.length, located.end);
  return { ok: true, body: body.replace(/^\n/, '').replace(/\n$/, '') };
}

/**
 * 比对 README 与 specs：返回 { ok, reason?, expected, actual, commandCount }。
 * reason 固定短语（测试断言用）：missing-marker / drift / clean。
 */
export function checkReadmeText(readmeText, specs = COMMAND_SPECS) {
  const problems = auditCommandSpecs(specs);
  if (problems.length) return { ok: false, reason: 'invalid-specs', problems, expected: '', actual: '' };
  const expected = renderCommandIndexBody(specs);
  const extracted = extractCommandIndexBody(readmeText);
  if (!extracted.ok) return { ok: false, reason: 'missing-marker', detail: extracted.reason, expected, actual: '' };
  const actual = extracted.body;
  if (actual === expected) {
    return { ok: true, reason: 'clean', expected, actual, commandCount: Object.keys(specs).length };
  }
  return {
    ok: false,
    reason: 'drift',
    expected,
    actual,
    commandCount: Object.keys(specs).length,
    detail: describeDrift(expected, actual),
  };
}

/** 人读的漂移摘要：行数 + 第一处差异 + 缺失/多余的命令行。 */
export function describeDrift(expected, actual) {
  const expectedLines = String(expected || '').split('\n');
  const actualLines = String(actual || '').split('\n');
  const details = ['行数 expected=' + expectedLines.length + ' actual=' + actualLines.length];
  const max = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < max; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      details.push('第一处差异在第 ' + (index + 1) + ' 行');
      details.push('expected: ' + (expectedLines[index] == null ? '(缺少)' : expectedLines[index]));
      details.push('actual:   ' + (actualLines[index] == null ? '(缺少)' : actualLines[index]));
      break;
    }
  }
  const missing = expectedLines.filter((line) => line.startsWith('| `bridge ') && !actualLines.includes(line));
  if (missing.length) details.push('README 未出现在 specs 里的命令行：' + missing.length);
  return details.join('；');
}

/** 读文件 + 生成/校验的统一入口（供 main 与测试复用）。 */
export function generateForFile(file, { check = false, specs = COMMAND_SPECS } = {}) {
  const readmePath = path.resolve(String(file));
  if (!fs.existsSync(readmePath)) {
    return { ok: false, reason: 'missing-file', file: readmePath };
  }
  const text = fs.readFileSync(readmePath, 'utf8');
  if (check) {
    const result = checkReadmeText(text, specs);
    return { ...result, file: readmePath, check: true };
  }
  const replaced = replaceCommandIndex(text, renderCommandIndexBody(specs));
  if (!replaced.ok) return { ok: false, reason: 'missing-marker', detail: replaced.reason, file: readmePath };
  if (replaced.text === text) {
    return { ok: true, reason: 'unchanged', file: readmePath, commandCount: Object.keys(specs).length, check: false };
  }
  writeAtomic(readmePath, replaced.text);
  return { ok: true, reason: 'written', file: readmePath, commandCount: Object.keys(specs).length, check: false };
}

/** 原子写：同目录临时文件 + rename，避免中途失败留下半篇 README。 */
function writeAtomic(file, content) {
  const dir = path.dirname(file);
  const temp = path.join(dir, '.readme-commands-' + process.pid + '-' + Date.now() + '.tmp');
  fs.writeFileSync(temp, content, 'utf8');
  fs.renameSync(temp, file);
}

function parseArgs(argv) {
  const options = { check: false, stdout: false, json: false, quiet: false, file: DEFAULT_README, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') options.check = true;
    else if (arg === '--stdout') options.stdout = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--file') { options.file = argv[index + 1]; index += 1; }
    else if (arg.startsWith('--file=')) options.file = arg.slice('--file='.length);
    else if (arg === '-h' || arg === '--help') options.help = true;
    else return { error: '未知参数：' + arg };
  }
  if (options.file == null || options.file === '') return { error: '--file 需要一个路径' };
  return options;
}

const USAGE = [
  '用法：node tools/readme-commands.mjs [--check] [--stdout] [--json] [--quiet] [--file <README.md>]',
  '',
  '  （无参数）   从 cli/lib/command-specs.mjs 生成 README 命令索引标记区间',
  '  --check     只比对；漂移退出 1，README 结构问题退出 2',
  '  --stdout    把生成的标记区间打到 stdout（不写文件）',
  '  --json      输出 JSON 结果（ok/reason/file/commandCount/...）',
  '  --file      指定 README 路径（默认仓库根 README.md）',
].join('\n');

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.error) {
    console.error('[readme-commands] ' + options.error);
    console.error(USAGE);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.stdout) {
    const body = renderCommandIndexBody();
    if (options.json) {
      console.log(JSON.stringify({ ok: true, reason: 'stdout', commandCount: Object.keys(COMMAND_SPECS).length, body }));
    } else {
      console.log(renderCommandIndexSection());
    }
    return 0;
  }
  const problems = auditCommandSpecs();
  if (problems.length) {
    const message = 'command-specs 结构不完整：' + problems.join('；');
    if (options.json) console.log(JSON.stringify({ ok: false, reason: 'invalid-specs', problems }));
    else console.error('[readme-commands] ' + message);
    return 2;
  }
  const result = generateForFile(options.file, { check: options.check });
  if (options.json) {
    const { expected, actual, ...rest } = result;
    console.log(JSON.stringify({ ...rest, commandCount: result.commandCount || Object.keys(COMMAND_SPECS).length }));
  } else if (result.ok) {
    if (!options.quiet) {
      if (result.reason === 'unchanged') {
        console.log('[readme-commands] clean：README 命令索引与 command-specs 一致（' + result.commandCount + ' 个命令）');
      } else if (result.reason === 'written') {
        console.log('[readme-commands] 已更新 ' + result.file + '（' + result.commandCount + ' 个命令）');
      } else {
        console.log('[readme-commands] clean（' + result.commandCount + ' 个命令）');
      }
    }
  } else if (result.reason === 'drift') {
    console.error('[readme-commands] README 命令索引漂移（' + result.detail + '）');
    console.error('  修复：node tools/readme-commands.mjs   （或把生成内容贴回标记区间）');
  } else if (result.reason === 'missing-marker') {
    console.error('[readme-commands] ' + (result.detail || 'README 缺少命令索引标记'));
    console.error('  在 README 里加入下面两行标记后再运行生成器：');
    console.error('    ' + BEGIN_MARKER);
    console.error('    ' + END_MARKER);
  } else if (result.reason === 'missing-file') {
    console.error('[readme-commands] 读不到 README：' + result.file);
  } else {
    console.error('[readme-commands] 失败：' + (result.reason || 'unknown'));
  }
  if (result.ok) return 0;
  if (result.reason === 'drift') return 1;
  return 2;
}

const invokedDirectly = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (invokedDirectly) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error('[readme-commands] 意外错误：' + (error && error.stack ? error.stack : error));
    process.exitCode = 2;
  });
}
