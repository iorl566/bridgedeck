// tools/bsk-diff/lib/extract-bsk.mjs —— 上游 0.5.0（只读参照物）侧事实抽取。
//
// 证据来源优先级（全部是仓库内文件，不依赖网络/环境）：
//   1) `.ref/bsk-help/*.txt`            —— 49 个命令的 CLI `--help` 快照
//   2) `tools/bsk-diff/data/bsk-exe-help/*.txt` —— 缺失的 7 个命令帮助快照
//      （由 `run.mjs --snapshot-help` 从参考实现 CLI 二进制采集，见 README 段）
//   3) 参考实现源码树的 `crates/**` —— Rust 源码（方法表、
//      参数结构、错误码、feature floor、MCP 工具定义）
//   4) 参考实现扩展产物目录 `**`           —— 扩展产物（manifest / pages / chunks）
//   5) `.ref/bsk-results/**`            —— 历史真实 CLI 结果（行为证据）
//
// 说明：生成器**不执行** 参考实现 CLI（Windows x64 二进制），否则产物会随宿主平台漂移；
// `run.mjs --probe-exe` 才逐命令执行 exe 并与快照比对，用于校验快照未过期。

import fs from 'node:fs';
import path from 'node:path';
import { readLines, lineOf, repoPath, stableSortBy, toSnake } from './text.mjs';

export const BSK_PATHS = Object.freeze({
  bin: 'ref/bsk-0.5.0-bin/bsk.exe',
  src: 'ref/bsk-0.5.0-src/BrowserSkill-cli-v0.5.0',
  ext: 'ref/bsk-0.5.0-ext',
  help: '.ref/bsk-help',
  results: '.ref/bsk-results',
  snapshot: 'tools/bsk-diff/data/bsk-exe-help',
});

const SRC = BSK_PATHS.src;

/** 递归列出目录下的文件（repo 相对路径，正斜杠，稳定排序）。 */
export function listFiles(root, relDir, filter = () => true) {
  const abs = path.join(root, relDir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else {
        const rel = repoPath(root, child);
        if (filter(rel)) out.push(rel);
      }
    }
  };
  walk(abs);
  return out.sort();
}

/**
 * 读取帮助主题文本，来源优先级：
 *   1) `tools/bsk-diff/data/bsk-exe-help/<cmd>.txt` —— 由 `run.mjs --snapshot-help`
 *      从 ref/参考实现 CLI 目录/参考实现 CLI（bsk 0.5.0）实际采集，是 CLI 轴的权威证据；
 *   2) `.ref/bsk-help/<cmd>.txt` —— 仓库既有旁证快照（部分命令比 0.5.0 实机输出旧）。
 * 两者都记录在 provenance 里，`--probe-exe` 会重新执行 exe 校验快照是否过期。
 */
export function helpTopicPath(root, command) {
  const name = command === null ? '_root' : command;
  const primary = path.join(BSK_PATHS.snapshot, `${name}.txt`);
  if (fs.existsSync(path.join(root, primary))) {
    return { file: primary.split(path.sep).join('/'), source: 'exe-snapshot' };
  }
  const secondary = path.join(BSK_PATHS.help, `${name}.txt`);
  if (fs.existsSync(path.join(root, secondary))) {
    return { file: secondary.split(path.sep).join('/'), source: 'ref-snapshot' };
  }
  return null;
}

const OPTION_LINE = /^(?: {2,6})(?:-[A-Za-z], )?(--[a-z0-9][a-z0-9-]*)(?:[ <]|$)/;
const POSITIONAL_LINE = /^(?: {2,4})((?:<[A-Z0-9_]+>|\[[A-Z0-9_]+(?:=[A-Z0-9_]+)?\]))/;

/** 解析 `参考实现 CLI <cmd> --help` 文本 → 结构化命令帮助。 */
export function parseHelpText(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  const summary = nonEmpty.length ? nonEmpty[0].trim() : '';
  const usageIndex = lines.findIndex((line) => line.startsWith('Usage: '));
  const usage = usageIndex >= 0 ? lines[usageIndex].trim() : '';
  const positionalLine = usageIndex >= 0 ? lineOf(lines, /^Usage: /) : 0;

  const options = [];
  const positionals = [];
  const subcommands = [];
  let section = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^Arguments:\s*$/.test(line)) { section = 'args'; continue; }
    if (/^Options:\s*$/.test(line)) { section = 'options'; continue; }
    if (/^Commands:\s*$/.test(line)) { section = 'commands'; continue; }
    if (/^\S/.test(line) && /:\s*$/.test(line) && !/^(Options|Arguments|Commands):/.test(line)) { section = ''; continue; }

    if (section === 'commands') {
      const match = line.match(/^ {2}([a-z][a-z0-9-]*)(?: {2,})(.*)$/);
      if (match) subcommands.push({ name: match[1], summary: match[2].trim(), line: i + 1 });
      if (/^Options:/.test(line)) section = '';
      continue;
    }

    if (section === 'options') {
      const match = line.match(OPTION_LINE);
      if (match) {
        // 取值判定：同一行出现 `<NAME>`，或后续（verbose 版）叙述行里出现 `<NAME>`。
        const inlineValue = /<[A-Z0-9_]+>/.test(line);
        let takesValue = inlineValue;
        const values = [];
        const possible = line.match(/\[possible values: ([^\]]+)\]/);
        if (possible) values.push(...possible[1].split(',').map((value) => value.trim()).filter(Boolean));
        for (let j = i + 1; j < lines.length && j < i + 6; j += 1) {
          const next = lines[j];
          if (OPTION_LINE.test(next) || /^\S/.test(next)) break;
          if (/<[A-Z0-9_]+>/.test(next)) takesValue = true;
          const pv = next.match(/\[possible values: ([^\]]+)\]/);
          if (pv) values.push(...pv[1].split(',').map((value) => value.trim()).filter(Boolean));
        }
        options.push({
          name: match[1],
          takesValue,
          possibleValues: [...new Set(values)].sort(),
          line: i + 1,
        });
        continue;
      }
    }

    if (section === 'args') {
      const match = line.match(POSITIONAL_LINE);
      if (match) {
        const required = match[1].startsWith('<');
        positionals.push({ name: match[1].replace(/^[<[]|[>\]]$/g, '').split('=')[0], required, line: i + 1 });
      }
    }
  }

  return {
    summary,
    usage,
    usageLine: positionalLine,
    positionals,
    subcommands,
    options,
    // `-h, --help` 这类全局开关不算命令能力差异。
    globalOptions: ['--json', '--quiet', '--verbose', '--help'],
  };
}

/**
 * 根帮助文本 → 56 个命令。返回 [{ name, summary, file, line }]。
 * 命令行格式：`  <name>  <summary>`，位于 `Commands:` 与 `Options:` 之间。
 */
export function parseRootCommands(text, file) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.trim() === 'Commands:');
  if (start < 0) throw new Error(`${file} 中找不到 Commands 段`);
  const commands = [];
  const seen = new Set();
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^Options:/.test(line)) break;
    const match = line.match(/^ {2}([a-z][a-z0-9-]*)(?: {2,})(.*)$/);
    if (!match) continue;
    if (seen.has(match[1])) throw new Error(`${file} 中命令重复：${match[1]}`);
    seen.add(match[1]);
    commands.push({ name: match[1], summary: match[2].trim(), file, line: i + 1 });
  }
  return commands;
}

/** 从仓库内（快照/旁证）读取根帮助并解析出命令表。 */
export function loadCliCommands(root) {
  const rootHelp = helpTopicPath(root, null);
  if (!rootHelp) throw new Error('BSK 根帮助缺失：既无 data/bsk-exe-help/_root.txt，也无 .ref/bsk-help/_root.txt');
  const { text } = readLines(path.join(root, rootHelp.file));
  return parseRootCommands(text, rootHelp.file).map((command) => ({ ...command, helpSource: rootHelp.source }));
}

/** 每个命令的帮助：{ name, summary, usage, positionals, options, file, source }。 */
export function loadCliSurfaces(root) {
  const commands = loadCliCommands(root);
  const surfaces = [];
  for (const command of commands) {
    const topic = helpTopicPath(root, command.name);
    if (!topic) {
      surfaces.push({
        name: command.name,
        summary: command.summary,
        rootSummary: command.summary,
        rootFile: command.file,
        rootLine: command.line,
        helpFile: null,
        helpSource: 'missing',
        usage: '',
        usageLine: 0,
        positionals: [],
        subcommands: [],
        options: [],
        globalOptions: ['--json', '--quiet', '--verbose', '--help'],
      });
      continue;
    }
    const { text } = readLines(path.join(root, topic.file));
    const parsed = parseHelpText(text);
    const refTopic = path.join(BSK_PATHS.help, `${command.name}.txt`);
    surfaces.push({
      name: command.name,
      summary: command.summary,
      rootSummary: command.summary,
      rootFile: command.file,
      rootLine: command.line,
      helpFile: topic.file,
      helpSource: topic.source,
      helpSummary: parsed.summary,
      usage: parsed.usage,
      usageLine: parsed.usageLine,
      positionals: parsed.positionals,
      subcommands: parsed.subcommands,
      options: parsed.options,
      globalOptions: parsed.globalOptions,
      refSnapshotFile: fs.existsSync(path.join(root, refTopic)) ? `${BSK_PATHS.help}/${command.name}.txt` : null,
    });
  }
  return surfaces;
}

/**
 * 解析 `crates/bsk-protocol/src/method.rs` 的 `methods! { ... }` 宏块。
 * 一行一个方法：`ToolClick => ("tool.click", Extension, BrowserMutation, true, ClickParams, ClickResult, [ActionConditions]),`
 */
export function loadMethods(root) {
  const file = `${SRC}/crates/bsk-protocol/src/method.rs`;
  const { lines } = readLines(path.join(root, file));
  const open = lines.findIndex((line) => line.startsWith('methods! {'));
  if (open < 0) throw new Error(`${file} 中找不到 methods! 宏块`);
  const entry = /^\s+(\w+) => \(\s*"([^"]+)",\s*(\w+),\s*(\w+),\s*(true|false),\s*([A-Za-z0-9_:<>, ]+?),\s*([A-Za-z0-9_:<>, ]+?),\s*\[([^\]]*)\]\s*\),?\s*$/;
  const methods = [];
  let closed = false;
  for (let i = open + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\}\s*$/.test(line)) { closed = true; break; }
    const match = line.match(entry);
    if (!match) continue;
    methods.push({
      variant: match[1],
      wire: match[2],
      owner: match[3],
      effect: match[4],
      actionMetadata: match[5] === 'true',
      paramsType: match[6].trim(),
      resultType: match[7].trim(),
      features: match[8].split(',').map((value) => value.trim()).filter(Boolean),
      file,
      line: i + 1,
    });
  }
  if (!closed) throw new Error(`${file} 的 methods! 块未闭合`);
  return methods;
}

/**
 * 解析 bsk-protocol 里的参数结构体字段（含多行 `#[serde(rename = "...")]` 覆盖）。
 * 返回 { [structName]: { fields: [{ wire, rust, optional, type }], file, line } }。
 */
export function loadParamStructs(root) {
  const files = listFiles(root, `${SRC}/crates/bsk-protocol/src`, (rel) => rel.endsWith('.rs'));
  const structs = {};
  for (const file of files) {
    const { lines } = readLines(path.join(root, file));
    for (let i = 0; i < lines.length; i += 1) {
      const head = lines[i].match(/^\s*pub struct ([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*\{\s*$/);
      if (!head) continue;
      const name = head[1];
      const fields = [];
      let rename = null;
      let attrBuffer = '';
      let inAttr = false;
      for (let j = i + 1; j < lines.length; j += 1) {
        const line = lines[j];
        if (/^\}\s*$/.test(line)) break;
        const trimmed = line.trim();
        if (inAttr || /^#\[serde\(/.test(trimmed)) {
          attrBuffer += ` ${trimmed}`;
          if (line.includes(')]')) {
            const match = attrBuffer.match(/rename = "([^"]+)"/);
            if (match) rename = match[1];
            attrBuffer = '';
            inAttr = false;
          } else {
            inAttr = true;
          }
          continue;
        }
        if (/^#\[/.test(trimmed)) continue;
        const field = line.match(/^\s*pub ([a-z0-9_]+):\s*(.+?),\s*$/);
        if (field) {
          fields.push({
            rust: field[1],
            wire: rename || field[1],
            type: field[2].trim(),
            optional: /^Option</.test(field[2].trim()),
            line: j + 1,
          });
          rename = null;
        }
      }
      structs[name] = { fields, file, line: i + 1 };
    }
  }
  return structs;
}

/** 解析 error.rs → ErrorCode（15）与 RpcErrorReason（reason 词汇表）。 */
export function loadErrorVocabulary(root) {
  const file = `${SRC}/crates/bsk-protocol/src/error.rs`;
  const { lines } = readLines(path.join(root, file));

  const errorCodes = [];
  const allStart = lines.findIndex((line) => /pub const ALL: &'static \[Self\] = &\[/.test(line));
  if (allStart < 0) throw new Error(`${file} 中找不到 ErrorCode::ALL`);
  for (let i = allStart + 1; i < lines.length; i += 1) {
    if (/^\s*\];/.test(lines[i])) break;
    const match = lines[i].match(/Self::(\w+),/);
    if (match) errorCodes.push({ variant: match[1] });
  }
  // wire_name() 的映射臂
  const wireStart = lines.findIndex((line) => /pub const fn wire_name\(self\) -> &'static str/.test(line));
  const wireMap = {};
  for (let i = wireStart; i < lines.length; i += 1) {
    const match = lines[i].match(/Self::(\w+) => "([a-z0-9_]+)"/);
    if (match) wireMap[match[1]] = match[2];
    if (i > wireStart && /^\s{4}\}\s*$/.test(lines[i])) break;
  }
  const codes = errorCodes.map(({ variant }) => ({
    variant,
    wire: wireMap[variant] || toSnake(variant),
    file,
    line: lineOf(lines, `Self::${variant},`),
  }));
  if (codes.length !== 15) throw new Error(`ErrorCode 抽取数量异常：${codes.length}（期望 15）`);

  const reasons = [];
  const reasonStart = lines.findIndex((line) => /pub enum RpcErrorReason \{/.test(line));
  if (reasonStart < 0) throw new Error(`${file} 中找不到 RpcErrorReason`);
  for (let i = reasonStart + 1; i < lines.length; i += 1) {
    if (/^\}\s*$/.test(lines[i])) break;
    const match = lines[i].match(/^ {4}([A-Z][A-Za-z0-9]*),\s*$/);
    if (match) {
      reasons.push({ variant: match[1], wire: toSnake(match[1]), file, line: i + 1 });
    }
  }
  return { errorCodes: codes, reasons, minCompatible: '1.0', protocolVersion: '1.9' };
}

/**
 * 解析 compatibility.rs 的 Feature 枚举与 FeatureRequirement（daemon/extension floor + when 条件）。
 */
export function loadFeatureFloors(root) {
  const file = `${SRC}/crates/bsk-protocol/src/compatibility.rs`;
  const { lines } = readLines(path.join(root, file));
  const enumStart = lines.findIndex((line) => /pub enum Feature \{/.test(line));
  if (enumStart < 0) throw new Error(`${file} 中找不到 Feature 枚举`);
  const variants = [];
  for (let i = enumStart + 1; i < lines.length; i += 1) {
    if (/^\}\s*$/.test(lines[i])) break;
    const match = lines[i].match(/^ {4}([A-Z][A-Za-z0-9]*),\s*$/);
    if (match) variants.push({ variant: match[1], line: i + 1 });
  }

  const features = [];
  for (let i = 0; i < lines.length; i += 1) {
    const head = lines[i].match(/Self::(\w+) => &FeatureRequirement \{/);
    if (!head) continue;
    const variant = head[1];
    const block = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s{12}\},?\s*$/.test(lines[j]) || /^\s{8}\};?\s*$/.test(lines[j])) break;
      block.push(lines[j]);
    }
    const body = block.join('\n');
    const operation = (body.match(/operation: "([^"]*)"/) || [])[1] || '';
    const daemon = (body.match(/daemon: "([^"]*)"/) || [])[1] || '';
    const extension = (body.match(/extension: "([^"]*)"/) || [])[1] || '';
    const whenKind = (body.match(/when: FeatureWhen::(\w+)/) || [])[1] || '';
    const whenField = (body.match(/field: "([^"]*)"/) || [])[1] || '';
    const whenValue = (body.match(/value: "([^"]*)"/) || [])[1] || '';
    features.push({
      variant,
      feature: toSnake(variant),
      operation,
      daemonFloor: daemon,
      extensionFloor: extension,
      whenKind: toSnake(whenKind),
      whenField,
      whenValue,
      file,
      line: i + 1,
    });
  }

  return stableSortBy(features, ['line']);
}

/**
 * 解析 上游 MCP server 的工具面：7 个常驻工具 + 1 个 opt-in（bsk_recipe），
 * 以及每个粗粒度工具下挂的 action 枚举。
 */
export function loadMcpSurface(root) {
  const file = `${SRC}/crates/bsk-cli/src/cli/mcp/tools.rs`;
  const { lines } = readLines(path.join(root, file));

  const toolNames = [];
  const arrayStart = lines.findIndex((line) => /const TOOL_NAMES: \[&str; \d+\] = \[/.test(line));
  if (arrayStart < 0) throw new Error(`${file} 中找不到 TOOL_NAMES`);
  for (let i = arrayStart + 1; i < lines.length; i += 1) {
    if (/^\];/.test(lines[i])) break;
    const match = lines[i].match(/"([a-z0-9_]+)"/);
    if (match) toolNames.push({ name: match[1], line: i + 1 });
  }
  const recipeLine = lines.findIndex((line) => /const RECIPE_TOOL: &str = "([a-z0-9_]+)"/.test(line));
  const recipeMatch = recipeLine >= 0 ? lines[recipeLine].match(/"([a-z0-9_]+)"/) : null;
  const recipeTool = recipeMatch ? { name: recipeMatch[1], line: recipeLine + 1, optIn: true } : null;

  // `enum XxxAction { A, B, C }`（MCP 工具内部的 action 选择器）
  const actionEnums = {};
  for (let i = 0; i < lines.length; i += 1) {
    const head = lines[i].match(/^enum ([A-Za-z0-9]+)Action \{/);
    if (!head) continue;
    const variants = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\}\s*$/.test(lines[j])) break;
      const match = lines[j].match(/^ {4}([A-Z][A-Za-z0-9]*),\s*$/);
      if (match) variants.push({ variant: match[1], wire: toSnake(match[1]).replace(/_/g, '_'), line: j + 1 });
    }
    actionEnums[head[1]] = { variant: head[1], file, line: i + 1, actions: variants };
  }
  return {
    file,
    tools: toolNames.map(({ name, line }) => ({ name, line, optIn: false })),
    recipeTool,
    actionEnums,
    planArgs: (() => {
      const line = lines.findIndex((entry) => /struct PlanArgs \{/.test(entry));
      return line >= 0 ? { file, line: line + 1 } : null;
    })(),
  };
}

/** 扩展产物面：manifest + 页面 + content script + chunk。 */
export function loadExtSurface(root) {
  const manifestFile = `${BSK_PATHS.ext}/manifest.json`;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, manifestFile), 'utf8'));
  const files = listFiles(root, BSK_PATHS.ext);
  const html = files.filter((file) => file.endsWith('.html'));
  const contentScripts = (manifest.content_scripts || []).flatMap((entry) => entry.js || []);
  return {
    manifestFile,
    manifest,
    version: manifest.version,
    permissions: [...(manifest.permissions || [])].sort(),
    hostPermissions: [...(manifest.host_permissions || [])].sort(),
    pages: html,
    contentScripts,
    chunks: files.filter((file) => file.includes('/chunks/')),
    files: files.length,
  };
}

/** 行为证据清单：历史 CLI 结果文件（存在即可引用，缺失则如实标注）。 */
export function loadResultsEvidence(root) {
  const dir = path.join(root, BSK_PATHS.results);
  if (!fs.existsSync(dir)) return { dir: BSK_PATHS.results, files: [] };
  const files = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({ name: entry.name, file: `${BSK_PATHS.results}/${entry.name}` }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  return { dir: BSK_PATHS.results, files };
}

/** 一次性抽取全部 上游 侧事实。 */
export function extractBsk(root) {
  const schemaRoot = path.join(root, SRC);
  const hasSrc = fs.existsSync(schemaRoot);
  if (!hasSrc) throw new Error(`BSK 源码参照物缺失：${SRC}`);
  return {
    paths: BSK_PATHS,
    commands: loadCliCommands(root),
    cliSurfaces: loadCliSurfaces(root),
    methods: loadMethods(root),
    paramStructs: loadParamStructs(root),
    vocabulary: loadErrorVocabulary(root),
    features: loadFeatureFloors(root),
    mcp: loadMcpSurface(root),
    ext: loadExtSurface(root),
    results: loadResultsEvidence(root),
  };
}
