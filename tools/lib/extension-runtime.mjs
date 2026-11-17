// tools/lib/extension-runtime.mjs —— 计算扩展运行时可执行模块，守住发布边界。
//
// 运行时入口来自：manifest（background/content scripts/popup/options）、所有 HTML 的
// module script、page-hooks 的 files: 注入、new URL(..., import.meta.url) 等。
// 参考镜像已物理移到 reference/extension-mirror/；extension/ 里若再出现不可达 JS，
// 构建/测试会失败，要求先接运行时或移出 extension/。
import fs from 'node:fs';
import path from 'node:path';

export const REPO_ROOT = process.cwd();
export const EXTENSION_ROOT = path.join(REPO_ROOT, 'extension');

const posix = (value) => value.split(path.sep).join('/');

/** 递归列出扩展目录下的文件（相对 extension/ 的 POSIX 路径）。 */
export function listExtensionFiles(root = EXTENSION_ROOT) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(posix(path.relative(root, full)));
    }
  };
  walk(root);
  return files.sort();
}

export function listExtensionJs(root = EXTENSION_ROOT) {
  return listExtensionFiles(root).filter((file) => file.endsWith('.js'));
}

function readText(root, rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function resolveRelative(fromRel, spec) {
  if (!spec.startsWith('.')) return null;
  let target = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  if (!path.posix.extname(target)) target += '.js';
  return target;
}

function addTarget(set, root, target) {
  if (!target) return;
  const full = path.join(root, target);
  if (fs.existsSync(full) && fs.statSync(full).isFile()) set.add(posix(target));
}

/**
 * daemon/CLI/MCP 等非扩展入口也会 import extension/src 下的共享模块
 * （例如 daemon 用 controller-info）。这些文件必须留在 extension 源码里，
 * 不能当成"扩展运行时不可达"移走。
 */
function collectCrossRuntimeImports() {
  const dirs = ['daemon', 'lib', 'cli', 'mcp', 'dsh-plugin', 'sdk', 'tools', 'bin', 'skill'];
  const found = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|mjs)$/.test(entry.name)) {
        const source = fs.readFileSync(full, 'utf8');
        for (const match of source.matchAll(/['"]([^'"]*extension\/src\/[^'"]+\.js)['"]/g)) {
          const rel = match[1].replace(/^.*?extension\//, 'extension/');
          found.add(rel.slice('extension/'.length));
        }
      }
    }
  };
  for (const dir of dirs) {
    const full = path.join(REPO_ROOT, dir);
    if (fs.existsSync(full) && fs.statSync(full).isDirectory()) walk(full);
  }
  return found;
}

/** 从入口出发，收集运行时可执行 JS（不含非 JS 资源）。 */
export function collectRuntimeFiles(root = EXTENSION_ROOT) {
  const manifestPath = path.join(root, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const roots = new Set();
  const addRoot = (target) => addTarget(roots, root, target);

  if (manifest.background?.service_worker) addRoot(manifest.background.service_worker);
  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) addRoot(file);
  }
  if (manifest.action?.default_popup) addRoot(manifest.action.default_popup);
  if (manifest.options_ui?.page) addRoot(manifest.options_ui.page);

  // 所有 HTML 都是入口：HTML 里的 module script 以及 offscreen 等文档。
  for (const file of listExtensionFiles(root)) {
    if (!file.endsWith('.html')) continue;
    addRoot(file);
    const html = readText(root, file);
    for (const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
      addTarget(roots, root, path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
    }
    for (const match of html.matchAll(/<link\b[^>]*\bhref=["']([^"']+\.js)["']/gi)) {
      addTarget(roots, root, path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
    }
  }

  // 跨入口共享模块：daemon/CLI 直接 import 的 extension/src 文件。
  for (const rel of collectCrossRuntimeImports()) addTarget(roots, root, rel);

  // 动态注入的脚本：files: ['injected/page-lib.js']。
  // 这些文件不一定被 import，但会随扩展发布。
  const runtime = new Set();
  const queue = [...roots].filter((file) => file.endsWith('.js'));
  while (queue.length) {
    const file = queue.pop();
    if (runtime.has(file)) continue;
    runtime.add(file);
    const source = readText(root, file);
    const constants = new Map();
    for (const match of source.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*['"]([^'"]+)['"]/g)) {
      constants.set(match[1], match[2]);
    }
    const specs = [];
    for (const match of source.matchAll(/(?:import|export)\s+[^'";]*?from\s+['"]([^'"]+)['"]/g)) specs.push(match[1]);
    for (const match of source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)) specs.push(match[1]);
    for (const match of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(match[1]);
    for (const match of source.matchAll(/new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) specs.push(match[1]);
    for (const match of source.matchAll(/files:\s*\[([^\]]*)\]/g)) {
      for (const token of match[1].matchAll(/['"]([^'"]+)['"]|\b([A-Za-z_$][\w$]*)\b/g)) {
        if (token[1]) specs.push(token[1]);
        else if (constants.has(token[2])) specs.push(constants.get(token[2]));
      }
    }
    for (const match of source.matchAll(/getURL\(\s*['"]([^'"]+\.js)['"]\s*\)/g)) specs.push(match[1]);
    for (const spec of specs) {
      const target = spec.startsWith('.') ? resolveRelative(file, spec) : path.posix.normalize(spec);
      if (!target) continue;
      if (fs.existsSync(path.join(root, target)) && fs.statSync(path.join(root, target)).isFile()) {
        if (target.endsWith('.js')) queue.push(target);
        // HTML 入口（offscreen.html 等）的脚本已在 HTML 扫描阶段加入。
      }
    }
  }
  return runtime;
}

/** 读取参考镜像声明；返回 { path: group }。 */
export function readReferenceOnly(root = EXTENSION_ROOT) {
  const file = path.join(root, 'reference-only.json');
  if (!fs.existsSync(file)) return {};
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const modules = data && typeof data.modules === 'object' && data.modules ? data.modules : {};
  return modules;
}

/**
 * 校验发布分类：每个 JS 要么运行时可执行，要么显式声明为 reference-only；
 * 两边不能重叠，声明必须存在。返回问题列表（空表示通过）。
 */
export function checkRuntimeClassification(root = EXTENSION_ROOT) {
  const runtime = collectRuntimeFiles(root);
  const all = listExtensionJs(root);
  const reference = readReferenceOnly(root);
  const problems = [];
  for (const file of runtime) {
    if (reference[file]) problems.push('runtime file also declared reference-only: ' + file);
  }
  for (const file of all) {
    if (runtime.has(file)) continue;
    if (!reference[file]) problems.push('unclassified JS (not runtime, not reference-only): ' + file);
  }
  for (const file of Object.keys(reference)) {
    if (!fs.existsSync(path.join(root, file))) problems.push('reference-only file missing: ' + file);
  }
  return { runtime, reference, all, problems };
}
