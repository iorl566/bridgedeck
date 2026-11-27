import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 移除外层注释，保留字符串内容；用于解析 JSONC。 */
export function stripJsonc(text) {
  let out = '';
  let i = 0;
  let inString = false;
  let quote = '';
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        if (i + 1 < text.length) { out += text[i + 1]; i += 2; continue; }
      } else if (ch === quote) {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; out += ch; i += 1; continue; }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i = Math.min(text.length, i + 2);
      continue;
    }
    out += ch;
    i += 1;
  }
  // 去尾逗号（字符串感知）
  let clean = '';
  inString = false;
  quote = '';
  for (let k = 0; k < out.length; k += 1) {
    const ch = out[k];
    if (inString) {
      clean += ch;
      if (ch === '\\') { clean += out[k + 1] || ''; k += 1; continue; }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; clean += ch; continue; }
    if (ch === ',') {
      let j = k + 1;
      while (j < out.length && /\s/.test(out[j])) j += 1;
      if (out[j] === '}' || out[j] === ']') continue;
    }
    clean += ch;
  }
  return clean;
}

export function parseJsonc(text) {
  if (!text || !text.trim()) return {};
  return JSON.parse(stripJsonc(text));
}

function skipWs(text, i) {
  while (i < text.length) {
    if (/\s/.test(text[i])) { i += 1; continue; }
    if (text[i] === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i = Math.min(text.length, i + 2);
      continue;
    }
    break;
  }
  return i;
}

function stringEnd(text, i) {
  const quote = text[i];
  i += 1;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === quote) return i + 1;
    i += 1;
  }
  return text.length;
}

function matchBracket(text, open) {
  const opener = text[open];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") { i = stringEnd(text, i); continue; }
    if (ch === '/' && text[i + 1] === '/') { i += 2; while (i < text.length && text[i] !== '\n') i += 1; continue; }
    if (ch === '/' && text[i + 1] === '*') { i += 2; while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i = Math.min(text.length, i + 2); continue; }
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function rootObjectSpan(text) {
  const open = skipWs(text, 0);
  if (text[open] !== '{') return null;
  const close = matchBracket(text, open);
  return close < 0 ? null : { open, close };
}

function findPropertyObject(text, span, key) {
  let i = span.open + 1;
  while (i < span.close) {
    i = skipWs(text, i);
    if (i >= span.close) break;
    if (text[i] === ',') { i += 1; continue; }
    if (text[i] !== '"' && text[i] !== "'") { i += 1; continue; }
    const end = stringEnd(text, i);
    let name;
    try { name = JSON.parse(text.slice(i, end).replace(/^'|'$/g, '"')); } catch { name = text.slice(i + 1, end - 1); }
    const after = skipWs(text, end);
    if (text[after] !== ':') { i = end; continue; }
    const valueStart = skipWs(text, after + 1);
    if (name === key && text[valueStart] === '{') {
      const valueEnd = matchBracket(text, valueStart);
      if (valueEnd > 0) return { open: valueStart, close: valueEnd };
    }
    if (text[valueStart] === '{' || text[valueStart] === '[') {
      const valueEnd = matchBracket(text, valueStart);
      i = valueEnd > 0 ? valueEnd + 1 : valueStart + 1;
    } else if (text[valueStart] === '"' || text[valueStart] === "'") {
      i = stringEnd(text, valueStart);
    } else {
      i = valueStart + 1;
    }
  }
  return null;
}

function insertProperty(text, span, key, valueText) {
  const close = span.close;
  const lineStart = text.lastIndexOf('\n', close - 1) + 1;
  const closeIndent = /^\s*/.exec(text.slice(lineStart, close))[0];
  const indent = closeIndent + '  ';
  const body = text.slice(span.open + 1, close);
  const empty = body.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim() === '';
  const hasTrailingComma = /,\s*$/.test(body.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, ''));
  const insert = empty
    ? `\n${indent}${JSON.stringify(key)}: ${valueText}\n${closeIndent}`
    : `${hasTrailingComma ? '' : ','}\n${indent}${JSON.stringify(key)}: ${valueText}\n${closeIndent}`;
  return text.slice(0, close) + insert + text.slice(close);
}

/** 对象级合并（供测试/内部使用）。 */
export function upsertMcpServer(config, keyPath, name, server) {
  const keys = Array.isArray(keyPath) ? keyPath : [keyPath];
  let node = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  for (const key of keys) {
    if (node[key] === undefined) node[key] = {};
    if (!node[key] || typeof node[key] !== 'object' || Array.isArray(node[key])) {
      return { status: 'invalid', error: 'MCP 配置里的 ' + keys.join('.') + ' 不是对象' };
    }
    node = node[key];
  }
  const existing = node[name];
  if (existing) {
    return JSON.stringify(existing) === JSON.stringify(server)
      ? { status: 'already', config }
      : { status: 'conflict', config, existing };
  }
  node[name] = server;
  return { status: 'installed', config };
}

export function getMcpServer(config, keyPath, name) {  const keys = Array.isArray(keyPath) ? keyPath : [keyPath];
  let node = config;
  for (const key of keys) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = node[key];
  }
  return node && typeof node === 'object' && !Array.isArray(node) ? node[name] : undefined;
}

function nestedObject(keys, name, server) {
  const root = {};
  let node = root;
  for (const key of keys) { node[key] = {}; node = node[key]; }
  node[name] = server;
  return root;
}

/** 在 JSON/JSONC 文本上按 keyPath 插入 server；保留注释与格式。 */
export function upsertMcpServerText(text, keyPath, name, server) {
  const keys = Array.isArray(keyPath) ? keyPath : [keyPath];
  const config = text && text.trim() ? parseJsonc(text) : {};
  const existing = getMcpServer(config, keys, name);
  if (existing) {
    return { status: JSON.stringify(existing) === JSON.stringify(server) ? 'already' : 'conflict', text, config };
  }
  if (!text || !text.trim()) return { status: 'installed', text: JSON.stringify(nestedObject(keys, name, server), null, 2) + '\n', config };
  let next = text;
  let span = rootObjectSpan(next);
  if (!span) throw new Error('MCP 配置根不是 JSON 对象');
  for (let i = 0; i < keys.length; i += 1) {
    const found = findPropertyObject(next, span, keys[i]);
    if (!found) {
      next = insertProperty(next, span, keys[i], JSON.stringify(nestedObject(keys.slice(i + 1), name, server)));
      const verified = parseJsonc(next);
      if (!getMcpServer(verified, keys, name)) throw new Error('写入后校验失败：' + keys.join('.'));
      return { status: 'installed', text: next, config: verified };
    }
    span = found;
  }
  next = insertProperty(next, span, name, JSON.stringify(server));
  const verified = parseJsonc(next);
  if (!getMcpServer(verified, keys, name)) throw new Error('写入后校验失败：' + keys.join('.'));
  return { status: 'installed', text: next, config: verified };
}

export function mcpClientPaths({ home = os.homedir(), env = process.env, platform = process.platform } = {}) {
  const configHome = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const app = (name) => platform === 'win32'
    ? path.join(appData, name)
    : platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', name)
      : path.join(configHome, name);
  return {
    claude: { file: path.join(home, '.claude.json'), keyPath: ['mcpServers'] },
    'claude-desktop': { file: path.join(app('Claude'), 'claude_desktop_config.json'), keyPath: ['mcpServers'] },
    cursor: { file: path.join(home, '.cursor', 'mcp.json'), keyPath: ['mcpServers'] },
    opencode: { file: path.join(configHome, 'opencode', 'opencode.json'), keyPath: ['mcp', 'servers'] },
    vscode: { file: path.join(app('Code'), 'User', 'mcp.json'), keyPath: ['servers'] },
    windsurf: { file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), keyPath: ['mcpServers'] },
    kilo: { file: path.join(configHome, 'kilo', 'kilo.json'), keyPath: ['mcp'] },
    amp: { file: path.join(configHome, 'amp', 'settings.json'), keyPath: ['amp', 'mcpServers'] },
    copilot: { file: path.join(home, '.copilot', 'mcp-config.json'), keyPath: ['mcpServers'] },
    kiro: { file: path.join(home, '.kiro', 'settings', 'mcp.json'), keyPath: ['mcpServers'] },
    qwen: { file: path.join(home, '.qwen', 'settings.json'), keyPath: ['mcpServers'] },
    codebuddy: { file: path.join(home, '.codebuddy', '.mcp.json'), keyPath: ['mcpServers'] },
    cortex: { file: path.join(home, '.snowflake', 'cortex', 'mcp.json'), keyPath: ['mcpServers'] },
    pi: { file: path.join(home, '.pi', 'agent', 'mcp.json'), keyPath: ['mcpServers'] },
    qoder: { file: path.join(home, '.qoder', 'settings.json'), keyPath: ['mcpServers'] },
    warp: { file: path.join(home, '.warp', '.mcp.json'), keyPath: ['mcpServers'] },
    junie: { file: path.join(home, '.junie', 'mcp', 'mcp.json'), keyPath: ['mcpServers'] },
    kimi: { file: path.join(home, '.kimi', 'mcp.json'), keyPath: ['mcpServers'] },
    'lm-studio': { file: path.join(home, '.lmstudio', 'mcp.json'), keyPath: ['mcpServers'] },
    'trae-cn': { file: path.join(appData, 'Trae CN', 'User', 'mcp.json'), keyPath: ['mcpServers'] },
    trae: { file: path.join(appData, 'Trae', 'User', 'mcp.json'), keyPath: ['mcpServers'] },
    'vscode-insiders': { file: path.join(app('Code - Insiders'), 'User', 'mcp.json'), keyPath: ['servers'] },
    cline: { file: path.join(app('Code'), 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), keyPath: ['mcpServers'] },
    'roo-cline': { file: path.join(app('Code'), 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'mcp_settings.json'), keyPath: ['mcpServers'] },
    augment: { file: path.join(home, '.augment', 'settings.json'), keyPath: ['mcpServers'] },
  };
}

export function installJsonMcp(client, server, options = {}) {
  const paths = options.paths || mcpClientPaths(options);
  const target = paths[client];
  if (!target) return { client, status: 'unsupported' };
  const text = fs.existsSync(target.file) ? fs.readFileSync(target.file, 'utf8') : '';
  const result = upsertMcpServerText(text, target.keyPath, 'browser-bridge', server);
  if (result.status === 'installed') {
    if (options.dryRun !== true) {
      fs.mkdirSync(path.dirname(target.file), { recursive: true });
      fs.writeFileSync(target.file, result.text, 'utf8');
    }
    return { client, status: 'installed', path: target.file, preview: options.dryRun === true ? result.text : undefined };
  }
  return { client, status: result.status, path: target.file };
}

/** 各客户端的 server 形状差异。 */
export function serverForClient(client, base) {
  if (client === 'opencode') return { type: 'local', command: [base.command, ...base.args], cwd: os.homedir(), enabled: true };
  if (client === 'kilo') return { type: 'local', command: [base.command, ...base.args] };
  if (client === 'copilot') return { type: 'local', command: base.command, args: base.args, tools: ['*'] };
  if (client === 'vscode') return { type: 'stdio', command: base.command, args: base.args };
  return { ...base };
}

/** DSH：cordis.patch.yml 顶层 patch 列表，插入一行 @deepseek-ai/dsh-mcp-client。 */
export function installDshMcp(server, options = {}) {
  const home = options.home || os.homedir();
  const dshHome = String(options.env?.DSH_HOME || '').trim() || path.join(home, '.dsh');
  const file = path.join(dshHome, 'cordis.patch.yml');
  const command = String(server.command || '');
  const args = Array.isArray(server.args) ? server.args : [];
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (/serverName:\s*['"]?browser-bridge['"]?/m.test(text)) {
    const lines = text.split('\n');
    const at = lines.findIndex((line) => /serverName:\s*['"]?browser-bridge['"]?/.test(line));
    let end = lines.length;
    for (let i = at + 1; i < lines.length; i += 1) {
      if (/^\s*-\s+/.test(lines[i]) && !/^\s{2,}/.test(lines[i])) { end = i; break; }
    }
    const commandIndex = lines.findIndex((line, index) => index > at && index < end && /^\s*command\s*:/.test(line));
    const argsIndex = lines.findIndex((line, index) => index > at && index < end && /^\s*args\s*:/.test(line));
    const currentCommand = commandIndex >= 0 ? lines[commandIndex].replace(/^\s*command\s*:\s*/, '').trim() : '';
    if (currentCommand === JSON.stringify(command) && argsIndex >= 0) {
      return { client: 'dsh', status: 'already', path: file };
    }
    if (commandIndex < 0) return { client: 'dsh', status: 'conflict', path: file, reason: 'browser-bridge row has no command' };
    if (argsIndex < 0) return { client: 'dsh', status: 'conflict', path: file, reason: 'browser-bridge row has no args' };
    const commandIndent = (lines[commandIndex].match(/^\s*/) || [''])[0];
    lines[commandIndex] = commandIndent + 'command: ' + JSON.stringify(command);
    const argsIndent = (lines[argsIndex].match(/^\s*/) || [''])[0];
    const inline = lines[argsIndex].replace(/^\s*args\s*:\s*/, '').trim();
    if (inline) {
      lines[argsIndex] = argsIndent + 'args: [' + args.map((arg) => JSON.stringify(String(arg))).join(', ') + ']';
    } else {
      let stop = argsIndex + 1;
      while (stop < end && (!lines[stop].trim() || /^\s{2,}/.test(lines[stop]))) stop += 1;
      const replacement = args.map((arg) => argsIndent + '  - ' + JSON.stringify(String(arg)));
      lines.splice(argsIndex + 1, stop - argsIndex - 1, ...replacement);
    }
    const next = lines.join('\n');
    if (options.dryRun !== true) fs.writeFileSync(file, next, 'utf8');
    return { client: 'dsh', status: 'updated', path: file, preview: options.dryRun === true ? next : undefined };
  }
  const quoting = (value) => JSON.stringify(String(value));
  const row = [
    '- insert:',
    '    - id: browser-bridge',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: browser-bridge',
    '        transport: stdio',
    '        command: ' + quoting(command),
    '        args:',
    ...args.map((arg) => '          - ' + quoting(arg)),
    '',
  ].join('\n');
  const next = (text && !text.endsWith('\n') ? text + '\n' : text) + (text ? '\n' : '') + row;
  if (options.dryRun !== true) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next, 'utf8');
  }
  return { client: 'dsh', status: 'installed', path: file, preview: options.dryRun === true ? next : undefined };
}

const YAML_CLIENTS = {
  goose: ({ home, appData, platform }) => (platform === 'win32'
    ? path.join(appData, 'Block', 'goose', 'config', 'config.yaml')
    : path.join(home, '.config', 'goose', 'config.yaml')),
  hermes: ({ home }) => path.join(home, '.hermes', 'config.yaml'),
};

/** YAML 客户端：顶层 key 已存在时插入 browser-bridge 子项；不重写其他条目。 */
export function installYamlMcp(client, server, options = {}) {
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const locate = YAML_CLIENTS[client];
  if (!locate) return { client, status: 'unsupported' };
  const file = locate({ home, appData, platform });
  const topKey = client === 'goose' ? 'extensions' : 'mcp_servers';
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const args = Array.isArray(server.args) ? server.args : [];
  const blockLines = (indent) => [
    indent + 'browser-bridge:',
    indent + '  transport: stdio',
    indent + '  command: ' + JSON.stringify(String(server.command || '')),
    indent + '  args:',
    ...args.map((arg) => indent + '    - ' + JSON.stringify(String(arg))),
  ];
  const keyRe = new RegExp('^' + topKey + '\\s*:\\s*(#.*)?$');
  const lines = text.split(/\r?\n/);
  const keyIndex = lines.findIndex((line) => keyRe.test(line));
  if (keyIndex >= 0) {
    let end = lines.length;
    for (let i = keyIndex + 1; i < lines.length; i += 1) {
      if (lines[i].trim() && !/^\s/.test(lines[i]) && !lines[i].trimStart().startsWith('#')) { end = i; break; }
    }
    const section = lines.slice(keyIndex + 1, end);
    const existing = section.findIndex((line) => /^\s+browser-bridge\s*:/.test(line));
    if (existing >= 0) {
      const commandLine = section.slice(existing + 1).find((line) => /^\s+command\s*:/.test(line)) || '';
      if (commandLine.includes(JSON.stringify(String(server.command || '')))) {
        return { client, status: 'already', path: file };
      }
      return { client, status: 'conflict', path: file, reason: 'browser-bridge exists with different command' };
    }
    const firstChild = section.find((line) => line.trim() && !line.trimStart().startsWith('#'));
    const childIndent = firstChild && /^\s+/.test(firstChild) ? (firstChild.match(/^\s+/) || ['  '])[0] : '  ';
    const before = lines.slice(0, keyIndex + 1);
    const after = lines.slice(keyIndex + 1);
    const nextLines = [...before, ...blockLines(childIndent), ...after];
    const next = nextLines.join(newline);
    if (options.dryRun !== true) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, next, 'utf8');
    }
    return { client, status: 'installed', path: file, merged: true, preview: options.dryRun === true ? next : undefined };
  }
  const block = [topKey + ':', ...blockLines('  '), ''].join(newline);
  const next = (text && !text.endsWith('\n') ? text + newline : text) + (text ? newline : '') + block;
  if (options.dryRun !== true) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next, 'utf8');
  }
  return { client, status: 'installed', path: file, preview: options.dryRun === true ? next : undefined };
}

/** TOML 客户端：追加/校验 [mcp_servers.browser-bridge]。 */
const TOML_CLIENTS = {
  codex: (home) => path.join(home, '.codex', 'config.toml'),
  grok: (home) => path.join(home, '.grok', 'config.toml'),
};

export function installTomlMcp(client, server, options = {}) {
  const home = options.home || os.homedir();
  const file = (TOML_CLIENTS[client] || (() => ''))(home);
  if (!file) return { client, status: 'unsupported' };
  const command = JSON.stringify(String(server.command || ''));
  const args = '[' + (Array.isArray(server.args) ? server.args.map((arg) => JSON.stringify(String(arg))).join(', ') : '') + ']';
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const marker = '[mcp_servers.browser-bridge]';
  if (text.includes(marker)) {
    const section = text.slice(text.indexOf(marker) + marker.length).split(/\n\[/)[0];
    if (!section.includes('command = ' + command) || !section.includes('args = ' + args)) {
      return { client, status: 'conflict', path: file };
    }
    return { client, status: 'already', path: file };
  }
  const block = marker + '\ncommand = ' + command + '\nargs = ' + args + '\n';
  const next = (text && !text.endsWith('\n') ? text + '\n' : text) + (text ? '\n' : '') + block;
  if (options.dryRun !== true) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next, 'utf8');
  }
  return { client, status: 'installed', path: file, preview: options.dryRun === true ? next : undefined };
}
