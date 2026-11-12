#!/usr/bin/env node
// tools/plugin-profile-check.mjs —— 在临时 DSH profile 里安装 dsh-plugin，验证它能组合进配置
//
// 做的事：建临时 profile（web 模板）→ dsh plugin add link:<repo>/dsh-plugin
//        → --dump-config 断言出现 browser-bridge-tools → 删掉临时 profile
// 用法：node tools/plugin-profile-check.mjs [--keep]
// 退出码：0 通过，1 失败。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_DIR = path.join(ROOT, 'dsh-plugin');
const PROFILE = 'bridge-plugin-check';
const HOME = path.join(os.homedir(), '.dsh');
const PROFILE_DIR = path.join(HOME, 'profiles', PROFILE);
const KEEP = process.argv.includes('--keep');

function findDsh() {
  const candidates = [
    process.env.DSH_CLI,
    'D:\\Programs\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd',
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'dsh', 'dsh.cmd'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // 忽略
    }
  }
  return null;
}

/** Windows 上的 dsh.cmd 是薄壳：直接按它的内容拉起 Electron 的 node 模式，避免 cmd 引号地狱。 */
function dshCommand(dsh) {
  if (!/\.cmd$/i.test(dsh)) return { exe: dsh, args: [], env: {} };
  const binDir = path.dirname(dsh);
  const exe = path.resolve(binDir, '..', '..', '..', '..', 'DeepSeek Harness.exe');
  const cliJs = path.resolve(binDir, '..', '..', '..', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  return { exe, args: ['--expose-internals', cliJs], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

function runDsh(dsh, args, timeoutMs) {
  const base = dshCommand(dsh);
  return new Promise((resolve) => {
    const child = spawn(base.exe, base.args.concat(args), {
      cwd: ROOT,
      env: { ...process.env, ...base.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 忽略 */ }
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + String((error && error.message) || error) });
    });
  });
}

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed += 1;
    console.log('  PASS  ' + name + (detail ? ' — ' + detail : ''));
  } else {
    failed += 1;
    console.log('  FAIL  ' + name + (detail ? ' — ' + detail : ''));
  }
}

console.log('BridgeDeck DSH 插件 · profile 安装检查');
const dsh = findDsh();
if (!dsh) {
  console.log('  FAIL  找不到 dsh CLI（可用 DSH_CLI 指定路径）');
  process.exit(1);
}
console.log('  dsh       ' + dsh);
console.log('  plugin    ' + PLUGIN_DIR);
console.log('  profile   ' + PROFILE_DIR + '\n');

try {
  if (fs.existsSync(PROFILE_DIR)) fs.rmSync(PROFILE_DIR, { recursive: true, force: true });

  const created = await runDsh(dsh, ['--profile', PROFILE, '--from-default-profile', 'web', '--dump-config'], 120000);
  check('创建临时 profile 并 dump 配置', created.code === 0 && fs.existsSync(path.join(PROFILE_DIR, 'package.json')), 'exit=' + created.code);

  const added = await runDsh(dsh, ['plugin', '--profile', PROFILE, 'add', 'link:' + PLUGIN_DIR], 180000);
  check('dsh plugin add link:<repo>/dsh-plugin', added.code === 0, (added.stdout.split(/\r?\n/).filter((line) => /dsh-browser-bridge|Done in/.test(line)).join(' | ') || added.stderr).slice(0, 200));

  const dumped = await runDsh(dsh, ['--profile', PROFILE, '--dump-config'], 120000);
  const ok = dumped.code === 0;
  check('dump-config 退出码 0', ok, 'exit=' + dumped.code);
  check('组合结果里有 browser-bridge-tools', ok && dumped.stdout.includes('browser-bridge-tools'));
  check('组合结果里有 dsh-browser-bridge', ok && dumped.stdout.includes('dsh-browser-bridge'));
  check('配置项 bridgeCli/timeoutMs 已展开', ok && dumped.stdout.includes('bridgeCli') && dumped.stdout.includes('timeoutMs'));

  const pkg = fs.existsSync(path.join(PROFILE_DIR, 'package.json'))
    ? JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, 'package.json'), 'utf8'))
    : null;
  check('profile package.json 依赖已写入', Boolean(pkg && pkg.dependencies && pkg.dependencies['dsh-browser-bridge']));
} finally {
  if (!KEEP) {
    try {
      fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
      console.log('\n  已清理临时 profile');
    } catch (error) {
      console.log('\n  清理临时 profile 失败：' + ((error && error.message) || error));
    }
  } else {
    console.log('\n  保留临时 profile：' + PROFILE_DIR);
  }
}

console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
if (failed) process.exit(1);
console.log('PLUGIN PROFILE CHECK PASS');
