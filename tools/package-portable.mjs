#!/usr/bin/env node
// tools/package-portable.mjs —— 跨平台 CLI 便携包（Windows zip / macOS+Linux tar.gz）。
//
// 用法：
//   node tools/package-portable.mjs                         # 当前平台/架构
//   node tools/package-portable.mjs --platform linux --arch arm64
//   node tools/package-portable.mjs --stage-only --json     # 只生成目录，供签名后再打包
//   node tools/package-portable.mjs --pack-dir <dir> --out dist/x.tar.gz
//
// 目标平台与宿主不一致时会下载对应 Node.js 官方运行时（缓存在 dist/.node-cache）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const platform = option('--platform', process.platform);
const arch = option('--arch', process.arch);
const withNode = !flag('--no-node');
const stageOnly = flag('--stage-only');
const keepStage = flag('--keep-stage');
const packDirArg = option('--pack-dir');
const cacheDir = path.resolve(ROOT, option('--cache-dir', path.join('dist', '.node-cache')));
const jsonMode = flag('--json');

const LABEL = `${platform}-${arch}`;
const EXT = platform === 'win32' ? 'zip' : 'tar.gz';
const DEFAULT_OUT = path.join(ROOT, 'dist', `BridgeDeck-cli-${pkg.version}-${LABEL}.${EXT}`);
const out = path.resolve(ROOT, option('--out', DEFAULT_OUT));

const DIRS = ['bin', 'cli', 'daemon', 'lib', 'mcp', 'skill', 'extension', 'sdk'];
const FILES = [
  'package.json',
  'README.md',
  'LICENSE',
  'install.sh',
  'install.ps1',
  'uninstall.sh',
  'uninstall.ps1',
];

function fail(message) {
  throw new Error(message);
}

function ensureExecutable(file) {
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o755); } catch { /* best effort */ }
  }
}

function nodeDistribution() {
  const version = process.versions.node;
  const osName = platform === 'win32' ? 'win' : platform;
  const ext = platform === 'win32' ? 'zip' : 'tar.gz';
  const base = `node-v${version}-${osName}-${arch}`;
  return {
    version,
    base,
    archive: path.join(cacheDir, `${base}.${ext}`),
    extractDir: path.join(cacheDir, base),
    url: `https://nodejs.org/dist/v${version}/${base}.${ext}`,
  };
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok) fail(`下载 Node.js 失败：${response.status} ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, buffer);
}

function extract(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const result = spawnSync('tar', ['-xf', archive, '-C', destination], { encoding: 'utf8' });
  if (result.status !== 0) fail(`解压失败：${archive}\n${result.stderr || result.stdout}`);
}

async function installRuntime(stage) {
  if (!withNode) return { mode: 'external' };
  const hostMatch = platform === process.platform && arch === process.arch;
  const target = path.join(stage, 'bin', platform === 'win32' ? 'node.exe' : 'node');
  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (hostMatch) {
    fs.copyFileSync(process.execPath, target);
    ensureExecutable(target);
    return { mode: 'host', version: process.versions.node, file: path.relative(stage, target) };
  }

  const node = nodeDistribution();
  if (!fs.existsSync(node.archive)) await download(node.url, node.archive);
  const binary = platform === 'win32'
    ? path.join(node.extractDir, 'node.exe')
    : path.join(node.extractDir, 'bin', 'node');
  if (!fs.existsSync(binary)) {
    extract(node.archive, path.dirname(node.extractDir));
  }
  if (!fs.existsSync(binary)) fail(`Node.js 运行时解压后缺少二进制：${binary}`);
  fs.copyFileSync(binary, target);
  ensureExecutable(target);
  return { mode: 'downloaded', version: node.version, file: path.relative(stage, target) };
}

function createArchive(stage, destination, ext) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.rmSync(destination, { force: true });
  if (ext === 'zip') {
    const result = spawnSync('tar', ['-a', '-cf', destination, '-C', stage, '.'], { encoding: 'utf8' });
    if (result.status === 0) return;
    if (process.platform === 'win32') {
      const psPath = (value) => String(value).replace(/'/g, "''");
      const script = `Compress-Archive -Path '${psPath(path.join(stage, '*'))}' -DestinationPath '${psPath(destination)}' -Force`;
      const packed = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
      if (packed.status !== 0) fail('创建 zip 失败：' + (packed.error?.message || packed.stderr || packed.stdout || result.error?.message || result.stderr || result.stdout));
      return;
    }
    fail('创建 zip 失败：' + (result.error?.message || result.stderr || result.stdout));
  }
  const result = spawnSync('tar', ['-czf', destination, '-C', stage, '.'], { encoding: 'utf8' });
  if (result.status !== 0) fail('创建 tar.gz 失败：' + (result.error?.message || result.stderr || result.stdout));
}

function assertStage(stage) {
  const required = ['cli/bridge.mjs', 'daemon/server.mjs', 'package.json'];
  for (const item of required) {
    if (!fs.existsSync(path.join(stage, item))) fail(`便携包缺少文件：${item}`);
  }
  const wrapper = platform === 'win32' ? 'bin/bridge.cmd' : 'bin/bridge';
  if (!fs.existsSync(path.join(stage, wrapper))) fail(`便携包缺少启动器：${wrapper}`);
}

function buildStage() {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), `bb-${LABEL}-`));
  for (const dir of DIRS) {
    const from = path.join(ROOT, dir);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(stage, dir), { recursive: true });
  }
  for (const file of FILES) {
    const from = path.join(ROOT, file);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(stage, file));
  }
  const toolFiles = ['install-update.mjs', 'make-cert.ps1'];
  for (const name of toolFiles) {
    const from = path.join(ROOT, 'tools', name);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.join(stage, 'tools'), { recursive: true });
    fs.copyFileSync(from, path.join(stage, 'tools', name));
  }
  // Drop the Windows launcher from Unix packages and vice versa.
  const foreign = platform === 'win32' ? 'bridge' : 'bridge.cmd';
  fs.rmSync(path.join(stage, 'bin', foreign), { force: true });
  ensureExecutable(path.join(stage, 'bin', platform === 'win32' ? 'bridge.cmd' : 'bridge'));
  return stage;
}

async function main() {
  if (packDirArg) {
    const stage = path.resolve(ROOT, packDirArg);
    assertStage(stage);
    createArchive(stage, out, EXT);
    return report({ mode: 'pack-only', stage, out });
  }

  const stage = buildStage();
  try {
    const runtime = await installRuntime(stage);
    assertStage(stage);
    if (stageOnly) return report({ mode: 'stage-only', stage, runtime, out: null });
    createArchive(stage, out, EXT);
    return report({ mode: 'packaged', stage, runtime, out });
  } finally {
    if (!stageOnly && !keepStage) fs.rmSync(stage, { recursive: true, force: true });
  }
}

function report({ mode, stage, runtime = null, out: archive }) {
  const bytes = archive && fs.existsSync(archive) ? fs.statSync(archive).size : 0;
  const sha256 = archive && fs.existsSync(archive)
    ? crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
    : null;
  const result = {
    ok: true,
    mode,
    version: pkg.version,
    platform,
    arch,
    stage,
    archive: archive || null,
    bytes,
    sha256,
    runtime,
  };
  if (jsonMode) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (archive) {
      console.log(`portable package: ${archive}`);
      console.log(`  bytes  ${bytes}`);
      console.log(`  sha256 ${sha256}`);
    }
    if (stageOnly || keepStage) console.log(`  stage  ${stage}`);
    console.log(`  node   ${runtime ? runtime.mode : 'external'}`);
  }
  return result;
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
