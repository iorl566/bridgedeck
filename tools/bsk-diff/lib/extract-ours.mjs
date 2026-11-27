// tools/bsk-diff/lib/extract-ours.mjs —— BridgeDeck 0.3.0（冻结树）侧事实抽取。
//
// 全部通过**仓库内静态事实**获得，不启动 daemon、不连浏览器、不跑 E2E：
// - 协议方法/feature floor/effect/owner：导入 lib/method-catalog.mjs（纯数据模块）
// - 方法参数 schema：导入 lib/schemas.mjs
// - MCP 工具名与底层协议方法：静态解析 mcp/tools-*.mjs
// - CLI 命令面：cli/bridge.mjs 的 switch/别名 + cli/commands/page.mjs 的 PAGE_COMMANDS
//   + cli/lib/command-specs.mjs 的 COMMAND_SPECS（命令级 flag 契约）
// - 扩展分发表：extension/src/dispatch.js 的 HANDLERS
// - 错误码：lib/error-codes.mjs
// - 扩展页面/UI 能力：extension/manifest.json + extension/ui/** + extension/src/**

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLines, lineOf, repoPath, stableSortBy, toSnake } from './text.mjs';

/** 仓库根：本文件位于 <repo>/tools/bsk-diff/lib/。证据一律记仓库相对路径。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const OUR_PATHS = Object.freeze({
  methodCatalog: 'lib/method-catalog.mjs',
  schemas: 'lib/schemas.mjs',
  protocolFeatures: 'lib/protocol-features.mjs',
  mcpServer: 'mcp/server.mjs',
  mcpTools: 'mcp/tools.mjs',
  mcpToolFiles: ['mcp/tools-core-a.mjs', 'mcp/tools-core-b.mjs', 'mcp/tools-debug-a.mjs', 'mcp/tools-debug-b.mjs', 'mcp/tools-input.mjs', 'mcp/tools-session-tab.mjs', 'mcp/tools-m6b.mjs'],
  cli: 'cli/bridge.mjs',
  commandSpecs: 'cli/lib/command-specs.mjs',
  pageCommands: 'cli/commands/page.mjs',
  dispatch: 'extension/src/dispatch.js',
  errorCodes: 'lib/error-codes.mjs',
  manifest: 'extension/manifest.json',
  uiDir: 'extension/ui',
  srcDir: 'extension/src',
});

function lines(rel) {
  return readLines(path.join(REPO_ROOT, rel));
}

/**
 * 协议方法目录：名称 / owner / effect / 方法级 feature。
 * 证据行号：`lib/method-catalog.mjs` 的 ROWS 行；schema 行号：`lib/schemas.mjs` 的键行。
 */
export async function loadMethodSurface() {
  const catalog = await import('../../../lib/method-catalog.mjs');
  const catalogText = readLines(path.join(REPO_ROOT, OUR_PATHS.methodCatalog));
  const methods = catalog.METHOD_NAMES.map((name) => ({
    name,
    owner: catalog.CATALOG_BY_METHOD[name].owner,
    effect: catalog.CATALOG_BY_METHOD[name].effect,
    feature: catalog.METHOD_FEATURE[name] || null,
    featureFloor: catalog.METHOD_FEATURE_FLOOR[name] || null,
    catalogFile: OUR_PATHS.methodCatalog,
    catalogLine: lineOf(catalogText.lines, `["${name}", `),
  }));
  return {
    methods,
    featureFloors: catalog.FEATURE_FLOORS,
    featureMeta: catalog.FEATURE_META,
    featureParamRules: catalog.FEATURE_PARAM_RULES,
    featureNames: catalog.FEATURE_NAMES,
    protocolCurrent: catalog.PROTOCOL_CURRENT,
    protocolBaseline: catalog.PROTOCOL_BASELINE,
    catalogFile: OUR_PATHS.methodCatalog,
    methodCount: catalog.METHOD_COUNT,
  };
}

function schemaRegion(schemaText) {
  const start = schemaText.lines.findIndex((line) => line.startsWith('export const METHOD_SCHEMAS = {'));
  if (start < 0) throw new Error(`${OUR_PATHS.schemas} 中找不到 METHOD_SCHEMAS`);
  let end = schemaText.lines.length - 1;
  for (let i = start + 1; i < schemaText.lines.length; i += 1) {
    if (/^\};?\s*$/.test(schemaText.lines[i])) { end = i; break; }
  }
  return { start, end };
}

/** schema 顶层键 → 行号（在 METHOD_SCHEMAS 区间内查）。 */
function schemaKeyLines(schemaText, schemaStart, schemaEnd) {
  const map = new Map();
  for (let i = schemaStart + 1; i < schemaEnd; i += 1) {
    const match = schemaText.lines[i].match(/^ {2}([A-Za-z][A-Za-z0-9._-]*): \{\s*$/);
    if (match && !map.has(match[1])) map.set(match[1], i + 1);
  }
  return map;
}

/** 导入 lib/schemas.mjs 并合并到方法面上（单独一步，保持导入面最小）。 */
export async function withSchemas(methodSurface) {
  const schemas = await import('../../../lib/schemas.mjs');
  const schemaText = readLines(path.join(REPO_ROOT, OUR_PATHS.schemas));
  const { start, end } = schemaRegion(schemaText);
  const keyLines = schemaKeyLines(schemaText, start, end);
  const methods = methodSurface.methods.map((method) => {
    const schema = schemas.METHOD_SCHEMAS[method.name] || null;
    return {
      ...method,
      schema,
      schemaDefined: Boolean(schema),
      schemaFile: OUR_PATHS.schemas,
      schemaLine: keyLines.get(method.name) || 0,
    };
  });
  return {
    ...methodSurface,
    methods,
    schemaFile: OUR_PATHS.schemas,
    schemaCount: Object.keys(schemas.METHOD_SCHEMAS).length,
  };
}

/**
 * MCP 工具面：67 个工具 + 每个工具映射到的底层协议方法（静态解析，不启动 server）。
 */
export function loadMcpSurface() {
  const tools = [];
  for (const file of OUR_PATHS.mcpToolFiles) {
    const { text } = lines(file);
    const nameMatches = [...text.matchAll(/name: '(browser_[a-z0-9_]+)'/g)];
    for (let i = 0; i < nameMatches.length; i += 1) {
      const match = nameMatches[i];
      const start = match.index;
      const end = i + 1 < nameMatches.length ? nameMatches[i + 1].index : text.length;
      const slice = text.slice(start, end);
      const methods = [...slice.matchAll(/(?:mcpInputSchema|rpc)\('([a-zA-Z][a-zA-Z0-9._-]*)'/g)]
        .map((entry) => entry[1]);
      const line = text.slice(0, start).split('\n').length;
      tools.push({
        name: match[1],
        file,
        line,
        methods: [...new Set(methods)].sort(),
      });
    }
  }
  const serverText = readLines(path.join(REPO_ROOT, OUR_PATHS.mcpServer));
  const serverLine = lineOf(serverText.lines, 'createBrowserTools({');
  return {
    tools: stableSortBy(tools, ['name']),
    files: OUR_PATHS.mcpToolFiles,
    serverFile: OUR_PATHS.mcpServer,
    serverLine,
    aggregateFile: OUR_PATHS.mcpTools,
  };
}

/**
 * CLI 命令面：
 * - bridge.mjs 的 `switch (command)` 分支（顶层命令）+ main 里的零仪式别名；
 * - page.mjs 的 PAGE_COMMANDS（default 分支落到的页面命令）；
 * - command-specs.mjs 的 COMMAND_SPECS（命令级 flag 契约 + 子命令）。
 * 每项都带 file:line 证据。
 */
export async function loadCliSurface() {
  const bridge = lines(OUR_PATHS.cli);
  const page = lines(OUR_PATHS.pageCommands);

  const switchVerbs = new Map();
  const switchIndex = bridge.lines.findIndex((line) => /^\s+switch \(command\) \{/.test(line));
  if (switchIndex < 0) throw new Error(`${OUR_PATHS.cli} 中找不到 switch (command)`);
  for (let i = switchIndex + 1; i < bridge.lines.length; i += 1) {
    const match = bridge.lines[i].match(/^\s+case '([a-z0-9-]+)':/);
    if (match) {
      if (!switchVerbs.has(match[1])) switchVerbs.set(match[1], i + 1);
      continue;
    }
    if (/^\s+default:/.test(bridge.lines[i])) break;
  }

  const aliases = new Map();
  for (const alias of ['open', 'sync', 'close', 'ledger']) {
    const line = lineOf(bridge.lines, `if (pos[0] === '${alias}')`);
    if (line) aliases.set(alias, line);
  }

  const pageStart = page.lines.findIndex((line) => line.startsWith('export const PAGE_COMMANDS = new Set(['));
  if (pageStart < 0) throw new Error(`${OUR_PATHS.pageCommands} 中找不到 PAGE_COMMANDS`);
  const pageVerbs = new Map();
  for (let i = pageStart + 1; i < page.lines.length; i += 1) {
    if (/^\]\);/.test(page.lines[i])) break;
    for (const match of page.lines[i].matchAll(/'([a-z0-9-]+)'/g)) {
      if (!pageVerbs.has(match[1])) pageVerbs.set(match[1], i + 1);
    }
  }

  const specs = await import('../../../cli/lib/command-specs.mjs');
  const specText = lines(OUR_PATHS.commandSpecs);
  const specTopics = {};
  for (const [topic, spec] of Object.entries(specs.COMMAND_SPECS)) {
    const topicLine = lineOf(specText.lines, `command: '${topic}'`);
    const subs = {};
    for (const [subName, sub] of Object.entries(spec.subs || {})) {
      subs[subName] = {
        name: subName,
        flags: Object.keys(sub.flags || {}).sort(),
        usage: sub.usage || '',
        risk: sub.risk || '',
        positionals: sub.positionals || null,
        file: OUR_PATHS.commandSpecs,
        line: lineOf(specText.lines, `name: '${subName}',`),
      };
    }
    specTopics[topic] = {
      topic,
      summary: spec.summary || '',
      file: OUR_PATHS.commandSpecs,
      line: topicLine,
      globals: [...specs.GLOBAL_FLAGS].sort(),
      subs,
    };
  }

  const flagUniverse = new Set();
  // bridge.mjs 的 flag 声明区：从 `const BOOL_FLAGS` 到 `const REPEATABLE_FLAGS`（含）。
  // 这一段只有 flag 声明（Set 字面量 + *.add('x') + for(...) 批量 add），没有业务字符串。
  const flagStart = bridge.lines.findIndex((line) => /^const BOOL_FLAGS = /.test(line));
  const flagEnd = bridge.lines.findIndex((line) => /^const REPEATABLE_FLAGS = /.test(line));
  if (flagStart < 0 || flagEnd < flagStart) throw new Error(`${OUR_PATHS.cli} 中找不到 flag 声明区`);
  for (let i = flagStart; i <= flagEnd; i += 1) {
    for (const match of bridge.lines[i].matchAll(/'([a-z][a-z0-9-]+)'/g)) flagUniverse.add(match[1]);
  }
  // main() 里的 `--version` / `-v` / `version` 三入口（cli/bridge.mjs）也是 CLI 全局能力。
  if (lineOf(bridge.lines, "['--version', '-v', 'version']")) {
    flagUniverse.add('version');
    flagUniverse.add('v');
  }
  // 命令实现里实际消费的 flag（`flags['x']` / `flags.x`），作为 CLI flag 全集的一部分。
  for (const rel of listCliSources()) {
    const { text } = lines(rel);
    for (const match of text.matchAll(/flags\[['"]([a-z][a-z0-9-]+)['"]\]/g)) flagUniverse.add(match[1]);
    for (const match of text.matchAll(/flags\.([a-zA-Z][a-zA-Z0-9]*)/g)) flagUniverse.add(match[1]);
  }
  const globalFlagUniverse = [...new Set([...specs.GLOBAL_FLAGS, ...flagUniverse])].sort();

  const verbs = new Map();
  for (const [verb, line] of switchVerbs) verbs.set(verb, { verb, file: OUR_PATHS.cli, line, kind: 'switch' });
  for (const [verb, line] of aliases) verbs.set(verb, { verb, file: OUR_PATHS.cli, line, kind: 'alias' });
  for (const [verb, line] of pageVerbs) {
    if (!verbs.has(verb)) verbs.set(verb, { verb, file: OUR_PATHS.pageCommands, line, kind: 'page' });
  }
  return {
    verbs: [...verbs.values()].sort((a, b) => (a.verb < b.verb ? -1 : 1)),
    specs: specTopics,
    globalFlags: specs.GLOBAL_FLAGS,
    globalFlagUniverse,
    pageCommandsFile: OUR_PATHS.pageCommands,
    pageCommands: [...pageVerbs.keys()].sort(),
    cliFile: OUR_PATHS.cli,
  };
}

function listCliSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (/\.mjs$/.test(entry.name)) out.push(repoPath(REPO_ROOT, abs));
    }
  };
  walk(path.join(REPO_ROOT, 'cli'));
  return out.sort();
}

/** 扩展分发表：dispatch.js 的 HANDLERS 方法 → 行号。 */
export function loadDispatchSurface() {
  const { lines: fileLines } = lines(OUR_PATHS.dispatch);
  const start = fileLines.findIndex((line) => line.startsWith('export const HANDLERS = {'));
  if (start < 0) throw new Error(`${OUR_PATHS.dispatch} 中找不到 HANDLERS`);
  const handlers = [];
  for (let i = start + 1; i < fileLines.length; i += 1) {
    if (/^\};/.test(fileLines[i])) break;
    const match = fileLines[i].match(/^\s+'([^']+)':/);
    if (match) handlers.push({ method: match[1], file: OUR_PATHS.dispatch, line: i + 1 });
  }
  return { handlers, file: OUR_PATHS.dispatch };
}

/** 错误码清单（159）→ 名称 + 行号证据。 */
export async function loadErrorSurface() {
  const { ERROR_CODES, ERROR_CODE_LIST } = await import('../../../lib/error-codes.mjs');
  const { lines: fileLines } = lines(OUR_PATHS.errorCodes);
  const codes = [...ERROR_CODE_LIST].sort().map((code) => ({
    code,
    meaning: ERROR_CODES[code] || '',
    file: OUR_PATHS.errorCodes,
    line: lineOf(fileLines, `  ${code}:`),
  }));
  return { codes, file: OUR_PATHS.errorCodes, count: codes.length };
}

/** 扩展能力面：manifest + UI 页面 + 关键模块（用于第 ④ 轴的证据定位）。 */
export function loadExtensionSurface() {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, OUR_PATHS.manifest), 'utf8'));
  const uiFiles = listFilesUnder(OUR_PATHS.uiDir);
  const srcFiles = listFilesUnder(OUR_PATHS.srcDir);
  return {
    manifestFile: OUR_PATHS.manifest,
    manifest,
    version: manifest.version,
    minChrome: manifest.minimum_chrome_version,
    permissions: [...(manifest.permissions || [])].sort(),
    hostPermissions: [...(manifest.host_permissions || [])].sort(),
    contentScripts: (manifest.content_scripts || []).flatMap((entry) => entry.js || []),
    uiPages: uiFiles.filter((file) => file.endsWith('.html')),
    uiFiles,
    srcFiles,
    contentFiles: listFilesUnder('extension/content'),
  };
}

function listFilesUnder(relDir) {
  const out = [];
  const abs = path.join(REPO_ROOT, relDir);
  if (!fs.existsSync(abs)) return out;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else out.push(repoPath(REPO_ROOT, child));
    }
  };
  walk(abs);
  return out;
}

/** 一次性抽取我方全部事实（异步因为要 import 数据模块）。 */
export async function extractOurs() {
  const methodSurface = await withSchemas(await loadMethodSurface());
  return {
    paths: OUR_PATHS,
    methods: methodSurface,
    mcp: loadMcpSurface(),
    cli: await loadCliSurface(),
    dispatch: loadDispatchSurface(),
    errors: await loadErrorSurface(),
    extension: loadExtensionSurface(),
  };
}

/** 把方法参数 schema 的字段名归一化成线上 snake_case（便于与 上游 Rust 字段比对）。 */
export function schemaFieldNames(schema) {
  const properties = schema && schema.properties ? Object.keys(schema.properties) : [];
  return [...new Set(properties.map((name) => toSnake(name)))].sort();
}

/** 证据字符串 `<file>:<line>`（行号缺失时返回空串，由上层判为无证据）。 */
export function evidence(file, line) {
  return file && line ? `${file}:${line}` : '';
}

/** 请求信封字段：比对参数面时两侧都剔除（它们由各自的 daemon 注入，不属于方法语义）。 */
export const ENVELOPE_FIELDS = Object.freeze([
  'session', 'session_id', 'sessionid', 'tab_id', 'tabid',
]);
