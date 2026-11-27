#!/usr/bin/env node
// tools/source-guard.mjs —— 防止大文件被写成占位符、语法损坏、或编码损坏进入发布。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
}
for (const dir of ['extension', 'cli', 'daemon', 'lib', 'dsh-plugin']) {
  const full = path.join(ROOT, dir);
  if (fs.existsSync(full)) walk(full);
}

const problems = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  if (text.trim().length <= 20 || text.trim() === 'utf8') {
    problems.push(path.relative(ROOT, file) + ': 内容异常（占位符/编码字符串）');
    continue;
  }
  const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (check.status !== 0) {
    problems.push(path.relative(ROOT, file) + ': 语法错误 ' + String(check.stderr || '').split('\n')[0]);
  }
}
if (problems.length) {
  console.error('SOURCE GUARD FAILED:');
  for (const problem of problems) console.error('  - ' + problem);
  process.exit(1);
}
console.log('source guard: clean (' + files.length + ' files)');

// ---------------------------------------------------------------------------
// 协议生成物同步守卫（W4-C）：docs/PROTOCOL-METHODS.md 的方法索引/特性门表/状态机表
// 只能由 tools/gen-protocol.mjs 从 lib/method-catalog.mjs 生成；“docs 更新只允许该生成表”。
// 这里调用生成器的 --check（只比对、不写文件）：任何手改/漏生成/生成器漂移 → fail。
// ---------------------------------------------------------------------------
const protocolSync = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'gen-protocol.mjs'), '--check'], { cwd: ROOT, encoding: 'utf8' });
if (protocolSync.status !== 0) {
  const detail = String(protocolSync.stderr || protocolSync.stdout || '').trim().split(/\r?\n/).filter(Boolean).join('；');
  console.error('PROTOCOL DOCS SYNC FAILED: 协议生成物漂移（docs/PROTOCOL-METHODS.md 方法索引/特性门表/状态机表只能由生成器产出）：' + detail);
  process.exit(1);
}
console.log('protocol docs sync: clean（方法索引/特性门表/状态机表由 tools/gen-protocol.mjs 生成）');

// ---------------------------------------------------------------------------
// 焦点守卫：运行时（extension/src）不允许再出现 Page.bringToFront。
// 默认后台执行靠 Emulation.setFocusEmulationEnabled；真正置前只允许在显式 --focus
// 或人工交接（borrow/help/通知点击）路径里，通过 windows.update 完成。
// 这样“普通动作/截图/闭 shadow 点击”永远不会把用户窗口抬到最前。
// ---------------------------------------------------------------------------
const focusProblems = [];
for (const file of files) {
  if (!file.includes(path.join('extension', 'src'))) continue;
  const code = fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  if (/Page\.bringToFront/.test(code)) focusProblems.push(path.relative(ROOT, file));
}
if (focusProblems.length) {
  console.error('FOCUS GUARD FAILED: 运行时不应调用 Page.bringToFront（默认后台，见 docs/PROTOCOL.md §12.2.3）：');
  for (const problem of focusProblems) console.error('  - ' + problem);
  process.exit(1);
}
console.log('focus guard: clean (no Page.bringToFront in extension/src)');

// ---------------------------------------------------------------------------
// 编码守卫：文档/源码必须是合法 UTF-8，且不出现替换字符 U+FFFD。
// 背景：PowerShell 5.1 的 Get-Content/Set-Content 走系统 ANSI（GBK）编码，
// 回写 UTF-8 文档时会把中文替换成 U+FFFD/'?'，肉眼不易发现但内容已损坏。
// 这里按文本扩展名全量扫描，坏一个字节就 fail，避免损坏进发布树。
// ---------------------------------------------------------------------------
const TEXT_ROOTS = ['docs', 'skill', 'extension', 'cli', 'daemon', 'lib', 'tests', 'tools', 'sdk', 'mcp', 'dsh-plugin'];
const TEXT_FILES = ['README.md', 'AGENT_INSTALL.md', 'package.json', 'install.ps1', 'install.sh', 'uninstall.ps1', 'uninstall.sh'];
const TEXT_EXT = /\.(md|mjs|js|cjs|json|html|css|txt|sh|ps1)$/;
const textFiles = [];
function walkText(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkText(full);
    else if (TEXT_EXT.test(entry.name)) textFiles.push(full);
  }
}
for (const dir of TEXT_ROOTS) {
  const full = path.join(ROOT, dir);
  if (fs.existsSync(full)) walkText(full);
}
for (const name of TEXT_FILES) {
  const full = path.join(ROOT, name);
  if (fs.existsSync(full)) textFiles.push(full);
}
// Round 63 (task-164): the 0.4 product documentation is a shipped surface too, so it
// joins the same UTF-8/U+FFFD scan. Only the product docs are added: 0.3.0 is frozen,
// `dist/` and `ref/` are out of scope, and 0.4/STATUS.md & friends are working notes
// that legitimately quote mojibake examples, so they are not in the mojibake set below.
const DOCS_04 = ['0.4/README.md'];
const DOC_ROOTS_04 = ['0.4/bench', '0.4/dashboard', '0.4/extension-ingress'];
const docFiles04 = [];
function walkDocs04(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkDocs04(full);
    else if (entry.name.endsWith('.md')) docFiles04.push(full);
  }
}
for (const name of DOCS_04) {
  const full = path.join(ROOT, name);
  if (fs.existsSync(full)) docFiles04.push(full);
}
for (const dir of DOC_ROOTS_04) {
  const full = path.join(ROOT, dir);
  if (fs.existsSync(full)) walkDocs04(full);
}
textFiles.push(...docFiles04);

// Round 63 (task-166): 0.4 的 `*.test.mjs` 也是发布树的一部分，但 `TEXT_ROOTS` 不含 `0.4/`，
// 所以 `0.4/packages/browser-adapter/test/fill.test.mjs` 的一个测试名被 GBK 回写后（非法 UTF-8）
// 门禁完全抓不到。这里把 0.4 下所有 `*.test.mjs` 加进同一个严格 UTF-8 / U+FFFD 扫描集。
// 只做编码检查，不加 mojibake 启发式：测试文件里可能有**有意**引用乱码/损坏字节的夹具。
// 0.3.0 冻结区、`dist/`、`ref/` 仍不在范围内；跳过 `node_modules` 以免把依赖算进来。
const TEST_FILES_04 = [];
function walkTests04(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walkTests04(full);
    } else if (entry.name.endsWith('.test.mjs')) {
      TEST_FILES_04.push(full);
    }
  }
}
const tests04Root = path.join(ROOT, '0.4');
if (fs.existsSync(tests04Root)) walkTests04(tests04Root);
textFiles.push(...TEST_FILES_04);

const encodingProblems = [];
for (const file of textFiles) {
  const buffer = fs.readFileSync(file);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    encodingProblems.push(path.relative(ROOT, file) + ': 不是合法 UTF-8（疑似被 ANSI/GBK 回写）');
    continue;
  }
  const replacement = text.indexOf('\uFFFD');
  if (replacement >= 0) {
    const line = text.slice(0, replacement).split('\n').length;
    encodingProblems.push(path.relative(ROOT, file) + ':' + line + ': 含替换字符 U+FFFD（编码损坏）');
  }
}
if (encodingProblems.length) {
  console.error('ENCODING GUARD FAILED:');
  for (const problem of encodingProblems) console.error('  - ' + problem);
  process.exit(1);
}
console.log('encoding guard: clean (' + textFiles.length + ' files)');

// ---------------------------------------------------------------------------
// 0.4 文档 mojibake 守卫：GBK 双重编码（UTF-8 字节被按 GBK 解码后再存成 UTF-8）
// 产物仍是**合法** UTF-8，上面的 UTF-8/U+FFFD 检查抓不到，例如
// `鈥?`（—/–/…）、`鈮?`（≥/≤/≈）、`鈫?`（→）、`脳`（×）、`搂`（§），以及被按
// 两个 GBK 字节吞掉一个字的中文（`已恢复默认顺序` 之类）。
// 只扫 0.4 产品文档（docFiles04），0.3/dist/ref 与 0.4 工作笔记不在范围内，
// 避免把「有意引用 mojibake 的说明文字」误判成损坏。
// ---------------------------------------------------------------------------
const MOJIBAKE_SIGNATURE = /[\u9225\u922e\u922b\u8133\u6402]|[\u4e00-\u9fff]\?/;
const mojibakeProblems = [];
for (const file of docFiles04) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = MOJIBAKE_SIGNATURE.exec(lines[index]);
    if (!match) continue;
    mojibakeProblems.push(path.relative(ROOT, file) + ':' + (index + 1) + ': mojibake 片段 ' + JSON.stringify(match[0]));
  }
}
if (mojibakeProblems.length) {
  console.error('MOJIBAKE GUARD FAILED: 0.4 产品文档含 GBK 双重编码片段（请按严格 UTF-8 重写该行，保留数字/阈值/命令语义）：');
  for (const problem of mojibakeProblems) console.error('  - ' + problem);
  process.exit(1);
}
console.log('mojibake guard: clean (' + docFiles04.length + ' 0.4 doc files)');
