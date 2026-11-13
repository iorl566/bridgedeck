#!/usr/bin/env node
// tools/install-update.mjs —— 独立更新执行器（不依赖 cli/lib，可复制到临时目录运行）。
//
// 流程：解包 → 停旧 daemon → 备份 → 覆盖 → 原端口启动 → 健康检查/版本校验 → 失败回滚。
//
// 用法：
//   node install-update.mjs --archive <zip|tar.gz> --dest <dir> [--port N] [--no-restart] [--json]
//   node install-update.mjs --rollback <backupDir> [--json]
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const jsonMode = flag('--json');
const dryRun = flag('--dry-run');
const noRestart = flag('--no-restart');

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write([
    'Usage:',
    '  node install-update.mjs --archive <zip|tar.gz> --dest <dir> [--port N] [--no-restart] [--dry-run] [--json]',
    '  node install-update.mjs --rollback <backupDir> [--port N] [--json]',
    '',
  ].join('\n'));
  process.exit(0);
}

const MANAGED_DIRS = ['cli', 'daemon', 'lib', 'mcp', 'skill', 'extension', 'sdk'];
const MANAGED_FILES = ['package.json', 'README.md', 'LICENSE', 'install.sh', 'install.ps1', 'uninstall.sh', 'uninstall.ps1', 'tools/install-update.mjs', 'tools/make-cert.ps1'];
const WRAPPERS = ['bridge', 'bridge.cmd'];

function log(message) {
  process.stderr.write(`[update] ${message}\n`);
}

function fail(message, extra = {}) {
  const error = new Error(message);
  error.details = extra;
  throw error;
}

function homeDir() {
  const fromEnv = process.env.BB_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), '.browser-bridge');
}

function readDaemonInfo() {
  const file = path.join(homeDir(), 'daemon.json');
  try {
    const info = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(info.port)) return null;
    return { port: info.port, token: typeof info.token === 'string' ? info.token : '', tls: info.tls === true };
  } catch {
    return null;
  }
}

function requestJson({ port, tls, token, method, body, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const transport = tls ? https : http;
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = transport.request({
      host: '127.0.0.1',
      port,
      path: method === 'GET' ? '/health' : '/rpc',
      method: method === 'GET' ? 'GET' : 'POST',
      headers: {
        ...(token ? { 'x-bridge-token': token } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
      rejectUnauthorized: false,
      timeout: timeoutMs,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }); }
        catch { reject(new Error(`invalid JSON from daemon (${res.statusCode})`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('daemon request timed out')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitHealthy({ port, tls }, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await requestJson({ port, tls, method: 'GET', timeoutMs: 1500 });
      if (res.status === 200 && res.body && res.body.ok !== false) return res.body;
    } catch { /* not ready yet */ }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function stopDaemon(info) {
  if (!info) return;
  try {
    await requestJson({ ...info, method: 'POST', body: { method: 'daemon.stop', params: {} }, timeoutMs: 4000 });
  } catch { /* already gone */ }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (!(await waitHealthy(info, 400))) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  log('旧 daemon 未在 8s 内退出，继续尝试覆盖');
}

function startDaemon(dest, port) {
  const server = path.join(dest, 'daemon', 'server.mjs');
  if (!fs.existsSync(server)) fail('目标目录缺少 daemon/server.mjs：' + server);
  const runtime = process.platform === 'win32'
    ? path.join(dest, 'bin', 'node.exe')
    : path.join(dest, 'bin', 'node');
  const node = fs.existsSync(runtime) ? runtime : process.execPath;
  const args = [server, '--foreground'];
  if (Number.isInteger(port)) args.push('--port', String(port));
  const child = spawn(node, args, {
    cwd: dest,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, BB_HOME: homeDir() },
  });
  child.unref();
  return child.pid;
}

async function waitVersion({ port, tls }, version, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    const health = await waitHealthy({ port, tls }, 1000);
    if (health) {
      const info = readDaemonInfo();
      try {
        const res = await requestJson({
          port,
          tls,
          token: info && info.token,
          method: 'POST',
          body: { method: 'status', params: {} },
          timeoutMs: 2500,
        });
        const status = res.body && res.body.ok !== false ? res.body.result : null;
        if (status && status.version === version) return status;
        if (status && status.version) lastError = `daemon 版本 ${status.version} != 期望 ${version}`;
      } catch (error) {
        lastError = String(error && error.message ? error.message : error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  fail('新版本启动后未通过版本校验' + (lastError ? '：' + lastError : ''));
}

function extract(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  let result = spawnSync('tar', ['-xf', archive, '-C', destination], { encoding: 'utf8' });
  if (result.status === 0) return;
  if (process.platform !== 'win32' && /\.zip$/i.test(archive)) {
    result = spawnSync('unzip', ['-q', '-o', archive, '-d', destination], { encoding: 'utf8' });
    if (result.status === 0) return;
  }
  fail('解压更新包失败：' + (result.error?.message || result.stderr || result.stdout));
}

export function findRoot(dir) {
  if (fs.existsSync(path.join(dir, 'cli', 'bridge.mjs'))) return dir;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const entry of entries) {
    const candidate = path.join(dir, entry.name);
    if (fs.existsSync(path.join(candidate, 'cli', 'bridge.mjs'))) return candidate;
  }
  return null;
}

export function readVersion(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || null; }
  catch { return null; }
}

function verifyArchive(archive, manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const name = path.basename(archive);
  const artifact = (Array.isArray(manifest.artifacts) ? manifest.artifacts : [])
    .find((item) => item && (item.name === name || path.basename(String(item.file || '')) === name));
  if (!artifact || !artifact.sha256) fail('发布清单里没有该更新包：' + name);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  if (hash !== String(artifact.sha256).toLowerCase()) fail('更新包 sha256 与发布清单不一致');
  return { version: manifest.version || null, sha256: hash };
}

function stamp() {
  return new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + crypto.randomBytes(3).toString('hex');
}

export function backupAndSwap(newRoot, dest, backupDir) {
  fs.mkdirSync(backupDir, { recursive: true });
  const entries = [];
  const managed = [...MANAGED_DIRS, ...MANAGED_FILES];
  for (const rel of managed) {
    const target = path.join(dest, rel);
    const source = path.join(newRoot, rel);
    const existed = fs.existsSync(target);
    if (existed) {
      const backupTarget = path.join(backupDir, rel);
      fs.mkdirSync(path.dirname(backupTarget), { recursive: true });
      fs.cpSync(target, backupTarget, { recursive: true });
    }
    if (fs.existsSync(source)) {
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(source, target, { recursive: true });
    } else if (existed) {
      fs.rmSync(target, { recursive: true, force: true });
    }
    entries.push({ rel, existed });
  }
  // bin: 只替换启动器，保留正在使用的 node 运行时。
  fs.mkdirSync(path.join(dest, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(backupDir, 'bin'), { recursive: true });
  for (const name of WRAPPERS) {
    const target = path.join(dest, 'bin', name);
    const source = path.join(newRoot, 'bin', name);
    const existed = fs.existsSync(target);
    if (existed) fs.copyFileSync(target, path.join(backupDir, 'bin', name));
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, target);
      if (process.platform !== 'win32' && name === 'bridge') fs.chmodSync(target, 0o755);
    } else if (existed) {
      fs.rmSync(target, { force: true });
    }
    entries.push({ rel: path.join('bin', name), existed });
  }
  fs.writeFileSync(path.join(backupDir, 'install.json'), JSON.stringify({
    version: readVersion(newRoot),
    dest,
    entries,
    createdAt: new Date().toISOString(),
  }, null, 2) + '\n');
  return entries;
}

export function restore(backupDir) {
  const recordPath = path.join(backupDir, 'install.json');
  if (!fs.existsSync(recordPath)) fail('回滚目录缺少 install.json：' + recordPath);
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  const dest = path.resolve(String(record.dest || ''));
  for (const entry of Array.isArray(record.entries) ? record.entries : []) {
    const target = path.join(dest, entry.rel);
    const backup = path.join(backupDir, entry.rel);
    fs.rmSync(target, { recursive: true, force: true });
    if (entry.existed && fs.existsSync(backup)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(backup, target, { recursive: true });
    }
  }
  return record;
}

async function waitForDaemonInfo(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = readDaemonInfo();
    if (info) return info;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

function pruneBackups(dest, keep = 3) {
  const root = path.join(dest, '.rollback');
  if (!fs.existsSync(root)) return;
  const items = fs.readdirSync(root).map((name) => ({ name, at: fs.statSync(path.join(root, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const item of items.slice(keep)) fs.rmSync(path.join(root, item.name), { recursive: true, force: true });
}

function writeState(details) {
  const file = path.join(homeDir(), 'update-state.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new state */ }
  state.lastInstall = { ...details, at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

export async function apply() {
  const archive = path.resolve(option('--archive'));
  const dest = path.resolve(option('--dest', process.cwd()));
  if (!fs.existsSync(archive)) fail('更新包不存在：' + archive);
  if (!fs.existsSync(path.join(dest, 'cli', 'bridge.mjs'))) fail('目标目录不是 BridgeDeck 安装：' + dest);
  const manifestPath = option('--manifest');
  if (manifestPath) verifyArchive(archive, path.resolve(manifestPath));

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-update-'));
  try {
    extract(archive, temp);
    const newRoot = findRoot(temp);
    if (!newRoot) fail('更新包里找不到 cli/bridge.mjs');
    const version = readVersion(newRoot);
    const oldInfo = readDaemonInfo();
    const portArg = option('--port', '');
    const wantedPort = portArg && Number.isInteger(Number(portArg)) ? Number(portArg) : null;
    const port = wantedPort || (oldInfo ? oldInfo.port : null);
    const tls = oldInfo ? oldInfo.tls : false;

    if (dryRun) {
      return { ok: true, dryRun: true, version, dest, port, restart: !noRestart };
    }

    if (!noRestart && oldInfo) await stopDaemon(oldInfo);
    const backupDir = path.join(dest, '.rollback', stamp());
    backupAndSwap(newRoot, dest, backupDir);

    if (!noRestart) {
      let started = null;
      try {
        startDaemon(dest, port);
        started = port ? { port, tls } : await waitForDaemonInfo(10_000);
        if (!started) throw new Error('daemon 未发布 daemon.json');
      } catch (error) {
        log('新版本启动失败，回滚：' + (error.message || error));
        await stopDaemon(readDaemonInfo());
        restore(backupDir);
        if (oldInfo) {
          startDaemon(dest, oldInfo.port);
          await waitHealthy(oldInfo, 15_000);
        }
        writeState({ ok: false, version, dest, port, backupDir, error: String(error.message || error) });
        throw error;
      }
      try {
        await waitVersion(started, version, 25_000);
      } catch (error) {
        log('新版本校验失败，回滚：' + (error.message || error));
        await stopDaemon(readDaemonInfo());
        restore(backupDir);
        if (oldInfo) {
          startDaemon(dest, oldInfo.port);
          const health = await waitHealthy(oldInfo, 15_000);
          if (!health) log('回滚后旧 daemon 未恢复，请手动执行 bridge daemon restart');
        }
        writeState({ ok: false, version, dest, port: started.port, backupDir, error: String(error.message || error) });
        throw error;
      }
    }

    pruneBackups(dest);
    writeState({ ok: true, version, dest, port, backupDir, restart: !noRestart });
    return { ok: true, version, dest, port, backupDir, restart: !noRestart };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

export async function rollback() {
  const backupDir = path.resolve(option('--rollback'));
  const current = readDaemonInfo();
  if (!noRestart) await stopDaemon(current);
  const record = restore(backupDir);
  const portArg = option('--port', '');
  const wantedPort = portArg && Number.isInteger(Number(portArg)) ? Number(portArg) : null;
  const port = wantedPort || (current ? current.port : null);
  if (!noRestart) {
    startDaemon(record.dest, port);
    const started = port ? { port, tls: current ? current.tls : false } : await waitForDaemonInfo(10_000);
    const health = started ? await waitHealthy(started, 15_000) : null;
    if (!health) log('回滚后 daemon 未就绪，请手动执行 bridge daemon restart');
  }
  return { ok: true, restored: record.version || null, dest: record.dest, backupDir };
}

export async function main() {
  const result = option('--rollback') ? await rollback() : await apply();
  if (jsonMode) console.log(JSON.stringify(result));
  else log(JSON.stringify(result));
}

const invokedDirectly = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    if (jsonMode) {
      console.log(JSON.stringify({ ok: false, error: { message: String(error && error.message ? error.message : error) } }));
    } else {
      process.stderr.write(`[update] 失败：${error && error.message ? error.message : error}\n`);
    }
    process.exit(1);
  });
}
