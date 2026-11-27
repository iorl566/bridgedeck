import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonc, upsertMcpServer, upsertMcpServerText, serverForClient, installTomlMcp, installYamlMcp, installDshMcp } from '../../cli/mcp-config.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('插入新 server', () => {
  const config = {};
  const result = upsertMcpServer(config, ['mcpServers'], 'browser-bridge', { command: 'node', args: ['x'] });
  assert.equal(result.status, 'installed');
  assert.equal(result.config.mcpServers['browser-bridge'].command, 'node');
});

test('嵌套 keyPath 自动建对象', () => {
  const result = upsertMcpServer({}, ['mcp', 'servers'], 'browser-bridge', { command: 'node' });
  assert.equal(result.status, 'installed');
  assert.deepEqual(result.config.mcp.servers['browser-bridge'], { command: 'node' });
});

test('相同返回 already、不同返回 conflict', () => {
  const server = { command: 'node', args: ['a'] };
  const config = { mcpServers: { 'browser-bridge': server } };
  assert.equal(upsertMcpServer(config, ['mcpServers'], 'browser-bridge', { ...server }).status, 'already');
  const conflict = upsertMcpServer(config, ['mcpServers'], 'browser-bridge', { command: 'other' });
  assert.equal(conflict.status, 'conflict');
});

test('opencode 用 local command 数组', () => {
  const server = serverForClient('opencode', { command: 'node', args: ['bridge.mjs', 'mcp'] });
  assert.equal(server.type, 'local');
  assert.deepEqual(server.command, ['node', 'bridge.mjs', 'mcp']);
  assert.equal(server.enabled, true);
});

test('JSONC 保注释插入 + 尾逗号', () => {
  const text = `{
  // 用户注释
  "mcp": {
    "servers": {
      // 其它服务器
      "other": { "command": "x" },
    },
  },
}\n`;
  const result = upsertMcpServerText(text, ['mcp', 'servers'], 'browser-bridge', { command: 'node', args: ['a'] });
  assert.equal(result.status, 'installed');
  assert.match(result.text, /\/\/ 用户注释/);
  assert.match(result.text, /\/\/ 其它服务器/);
  assert.match(result.text, /"browser-bridge"/);
  const parsed = parseJsonc(result.text);
  assert.equal(parsed.mcp.servers['browser-bridge'].command, 'node');
});

test('JSONC 嵌套 key 缺失时创建', () => {
  const result = upsertMcpServerText('{\n  "amp": {}\n}\n', ['amp', 'mcpServers'], 'browser-bridge', { command: 'node' });
  assert.equal(result.status, 'installed');
  assert.match(result.text, /"mcpServers"/);
});

test('已有相同/不同 server', () => {
  const text = JSON.stringify({ mcpServers: { 'browser-bridge': { command: 'node' } } });
  assert.equal(upsertMcpServerText(text, ['mcpServers'], 'browser-bridge', { command: 'node' }).status, 'already');
  assert.equal(upsertMcpServerText(text, ['mcpServers'], 'browser-bridge', { command: 'other' }).status, 'conflict');
});

test('TOML 客户端写入/冲突/dry-run', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-toml-'));
  try {
    const server = { command: 'node', args: ['bridge.mjs', 'mcp'] };
    const first = installTomlMcp('codex', server, { home, dryRun: true });
    assert.equal(first.status, 'installed');
    assert.match(first.preview, /\[mcp_servers\.browser-bridge\]/);
    assert.equal(fs.existsSync(path.join(home, '.codex', 'config.toml')), false);
    assert.equal(installTomlMcp('codex', server, { home }).status, 'installed');
    assert.equal(installTomlMcp('codex', server, { home }).status, 'already');
    assert.equal(installTomlMcp('codex', { command: 'other' }, { home }).status, 'conflict');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('DSH patch 行写入/冲突', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-dsh-'));
  try {
    const server = { command: 'node', args: ['bridge.mjs', 'mcp'] };
    const first = installDshMcp(server, { home, dryRun: true });
    assert.equal(first.status, 'installed');
    assert.match(first.preview, /@deepseek-ai\/dsh-mcp-client/);
    const file = path.join(home, '.dsh', 'cordis.patch.yml');
    assert.equal(fs.existsSync(file), false);
    assert.equal(installDshMcp(server, { home }).status, 'installed');
    assert.equal(installDshMcp(server, { home }).status, 'already');
    assert.equal(installDshMcp({ command: 'other', args: ['x'] }, { home }).status, 'updated');
    assert.match(fs.readFileSync(file, 'utf8'), /"other"/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('YAML 客户端只在顶层 key 缺失时追加', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-yaml-'));
  try {
    const server = { command: 'node', args: ['bridge.mjs', 'mcp'] };
    const first = installYamlMcp('hermes', server, { home, dryRun: true });
    assert.equal(first.status, 'installed');
    assert.match(first.preview, /mcp_servers:/);
    const written = installYamlMcp('hermes', server, { home });
    assert.equal(written.status, 'installed');
    assert.match(fs.readFileSync(written.path, 'utf8'), /browser-bridge:/);
    assert.equal(installYamlMcp('hermes', server, { home }).status, 'already');
    const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-yaml-conflict-'));
    try {
      const otherFile = path.join(otherHome, '.hermes', 'config.yaml');
      fs.mkdirSync(path.dirname(otherFile), { recursive: true });
      fs.writeFileSync(otherFile, 'mcp_servers:\n  other:\n    command: x\n');
      const merged = installYamlMcp('hermes', server, { home: otherHome });
      assert.equal(merged.status, 'installed');
      const text = fs.readFileSync(otherFile, 'utf8');
      assert.match(text, /other:/);
      assert.match(text, /browser-bridge:/);
    } finally {
      fs.rmSync(otherHome, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
