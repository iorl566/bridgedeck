import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('mcp-install --dry-run 输出 30 个客户端且不落盘', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-mcp-'));
  try {
    const env = {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: path.join(home, '.config'),
    };
    const result = spawnSync(process.execPath, [path.join(process.cwd(), 'cli', 'bridge.mjs'), 'mcp-install', '--dry-run', '--json'], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.ok, true);
    const clients = body.result.clients.map((row) => row.client).sort();
    assert.deepEqual(clients, ['amp', 'augment', 'claude', 'claude-desktop', 'cline', 'codebuddy', 'codex', 'copilot', 'cortex', 'cursor', 'dsh', 'goose', 'grok', 'hermes', 'junie', 'kilo', 'kimi', 'kiro', 'lm-studio', 'opencode', 'pi', 'qoder', 'qwen', 'roo-cline', 'trae', 'trae-cn', 'vscode', 'vscode-insiders', 'warp', 'windsurf']);
    assert(clients.every((client) => body.result.clients.find((row) => row.client === client).status !== 'error'));
    assert.equal(fs.existsSync(path.join(home, '.claude.json')), false);
    assert.equal(fs.existsSync(path.join(home, '.config', 'opencode', 'opencode.json')), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
