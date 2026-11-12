#!/usr/bin/env node
// tests/mcp/selftest.mjs —— MCP server 协议面自测（不需要浏览器）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-mcp-test-'));
const server = spawn(process.execPath, [path.join(ROOT, 'mcp', 'server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, BB_HOME: home },
});

const pending = new Map();
let seq = 0;
const rl = readline.createInterface({ input: server.stdout });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  entry(message);
});

function rpc(method, params) {
  const id = ++seq;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MCP 响应超时: ' + method)), 10000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return promise;
}

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail });
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' — ' + detail : ''));
}

const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest' } });
check('initialize 返回 serverInfo', init.result && init.result.serverInfo && init.result.serverInfo.name === 'browser-bridge', JSON.stringify(init.result && init.result.serverInfo));
check('initialize 声明 tools 能力', Boolean(init.result && init.result.capabilities && init.result.capabilities.tools));

const list = await rpc('tools/list', {});
const tools = (list.result && list.result.tools) || [];
check('tools/list 至少 10 个工具', tools.length >= 10, String(tools.length));
check('每个工具都有 inputSchema', tools.every((tool) => tool.inputSchema && tool.inputSchema.type === 'object'));

const unknown = await rpc('tools/nope', {});
check('未知方法返回 -32601', unknown.error && unknown.error.code === -32601, JSON.stringify(unknown.error));

const unknownTool = await rpc('tools/call', { name: 'browser_nope', arguments: {} });
check('未知工具 isError', unknownTool.result && unknownTool.result.isError === true);

const status = await rpc('tools/call', { name: 'browser_status', arguments: {} });
const statusText = status.result && status.result.content && status.result.content[0].text;
check('无 daemon 时 browser_status 返回 E_DAEMON', status.result.isError === true && String(statusText).includes('E_DAEMON'), String(statusText).slice(0, 120));

const ping = await rpc('ping', {});
check('ping 返回空结果', ping.result && Object.keys(ping.result).length === 0);

const shutdown = await rpc('shutdown', {});
check('shutdown 有响应', Boolean(shutdown.result));

server.stdin.end();
server.kill();
const failed = results.filter((item) => !item.ok);
console.log('');
console.log('== MCP 结果 ==');
console.log('通过 ' + (results.length - failed.length) + ' 项，失败 ' + failed.length + ' 项');
process.exit(failed.length ? 1 : 0);
