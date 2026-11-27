// tools/longtail/lib/tmpdir.mjs —— 大夹具的临时工作区（只写 tmpdir，绝不写仓库）。
//
// 长尾预算会生成 ≥5MB HAR、≥1000 refs 的页面图、≥200 步的 record program、≥100 分片的
// 视频 manifest。这些都不该进仓库（也不该进 git），所以统一写到 os.tmpdir() 下的独立目录：
//   - 目录名带固定前缀 + label + seed，方便人工排查；
//   - 每次写入都记录字节数并做上限护栏（默认 256MB，防止生成器 bug 打爆磁盘）；
//   - 写入路径强制 resolve 到工作区内：绝对路径、`..` 逃逸、指向仓库的路径一律拒绝；
//   - 默认在 finally 里清理；--keep-tmp / keep:true 时保留并回报目录路径。
//
// 另外提供仓库边界判定（isInsideRepo）：门禁用它证明"大文件只写 tmpdir"。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const TMP_WORKSPACE_VERSION = 1;

/** tmp 目录固定前缀（清理遗留目录时按它匹配）。 */
export const TMP_PREFIX = 'bridge-longtail';

/** 单个工作区默认字节上限：256MB（真实夹具 ~10MB 量级，留给生成器 bug 的余量）。 */
export const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;

/** 单个工作区默认文件数上限。 */
export const DEFAULT_MAX_FILES = 4096;

export class LongtailWorkspaceError extends Error {
  constructor(message, code = 'E_LONGTAIL_TMP') {
    super(message);
    this.name = 'LongtailWorkspaceError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 路径判定
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根（tools/longtail/lib → 仓库根）。 */
export function projectRoot() {
  return path.resolve(HERE, '..', '..', '..');
}

function normalizeForCompare(target) {
  const resolved = path.resolve(String(target || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** target 是否落在仓库内（含仓库根本身）。 */
export function isInsideRepo(target, root = projectRoot()) {
  const left = normalizeForCompare(target);
  const right = normalizeForCompare(root);
  return left === right || left.startsWith(right + path.sep);
}

/** target 是否落在系统 tmp 根内（防止误写用户目录）。 */
export function isInsideTmpRoot(target, root = os.tmpdir()) {
  const left = normalizeForCompare(target);
  const right = normalizeForCompare(root);
  return left !== right && left.startsWith(right + path.sep);
}

/** label 归一：只保留安全字符，避免生成非法目录名（点/斜杆一律折叠成 -）。 */
export function sanitizeLabel(label) {
  const text = String(label == null ? '' : label).trim().toLowerCase();
  const cleaned = text
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 48) || 'fixture';
}

function byteLength(value) {
  if (value == null) return 0;
  if (Buffer.isBuffer(value)) return value.length;
  if (value instanceof Uint8Array) return value.byteLength;
  return Buffer.byteLength(String(value), 'utf8');
}

function ensureRelative(rel) {
  const text = String(rel == null ? '' : rel);
  if (!text) throw new LongtailWorkspaceError('工作区路径不能为空', 'E_LONGTAIL_TMP_PATH');
  if (path.isAbsolute(text)) throw new LongtailWorkspaceError('工作区路径必须是相对路径：' + text, 'E_LONGTAIL_TMP_PATH');
  const normalized = path.normalize(text);
  if (normalized.startsWith('..') || normalized.includes(path.sep + '..' + path.sep)) {
    throw new LongtailWorkspaceError('工作区路径不能逃逸（包含 ..）：' + text, 'E_LONGTAIL_TMP_PATH');
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// 工作区
// ---------------------------------------------------------------------------

/**
 * 创建临时工作区。
 * @param {{label?:string, seed?:string|number, root?:string, keep?:boolean,
 *          maxBytes?:number, maxFiles?:number}} [options]
 */
export function createWorkspace(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const label = sanitizeLabel(opts.label || 'fixture');
  const root = path.resolve(opts.root || os.tmpdir());
  if (isInsideRepo(root)) {
    throw new LongtailWorkspaceError('tmp 工作区根不能是仓库目录：' + root, 'E_LONGTAIL_TMP_REPO');
  }
  const seedPart = opts.seed == null ? 'noseed' : String(opts.seed).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 24);
  const prefix = TMP_PREFIX + '-' + label + '-' + seedPart + '-';
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, prefix));
  if (!isInsideTmpRoot(dir, root)) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new LongtailWorkspaceError('mkdtemp 产出目录不在 tmp 根内：' + dir, 'E_LONGTAIL_TMP_REPO');
  }
  const maxBytes = Math.max(1, Math.floor(Number(opts.maxBytes) || DEFAULT_MAX_BYTES));
  const maxFiles = Math.max(1, Math.floor(Number(opts.maxFiles) || DEFAULT_MAX_FILES));
  const entries = new Map();
  let totalBytes = 0;
  let cleaned = false;

  function targetOf(rel) {
    const relative = ensureRelative(rel);
    const absolute = path.resolve(dir, relative);
    const inside = normalizeForCompare(absolute).startsWith(normalizeForCompare(dir) + path.sep);
    if (!inside) throw new LongtailWorkspaceError('工作区路径解析后越界：' + rel, 'E_LONGTAIL_TMP_PATH');
    if (isInsideRepo(absolute)) throw new LongtailWorkspaceError('拒绝写仓库路径：' + absolute, 'E_LONGTAIL_TMP_REPO');
    return { relative, absolute };
  }

  function record(relative, bytes) {
    const existing = entries.get(relative);
    const previous = existing ? existing.bytes : 0;
    const nextTotal = totalBytes - previous + bytes;
    if (nextTotal > maxBytes) {
      throw new LongtailWorkspaceError(
        'tmp 工作区超过字节上限：' + nextTotal + ' > ' + maxBytes + '（' + relative + '）',
        'E_LONGTAIL_TMP_BUDGET',
      );
    }
    if (!existing && entries.size + 1 > maxFiles) {
      throw new LongtailWorkspaceError('tmp 工作区超过文件数上限：' + maxFiles, 'E_LONGTAIL_TMP_BUDGET');
    }
    if (!existing) entries.set(relative, { path: relative, bytes, digest: '' });
    else entries.set(relative, { ...existing, bytes, digest: '' });
    totalBytes = nextTotal;
  }

  function writeBytes(rel, value) {
    if (cleaned) throw new LongtailWorkspaceError('工作区已清理，不能继续写：' + rel, 'E_LONGTAIL_TMP_CLEANED');
    const { relative, absolute } = targetOf(rel);
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value instanceof Uint8Array ? value : String(value), 'utf8');
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, buffer);
    record(relative, buffer.length);
    return { path: relative, bytes: buffer.length };
  }

  function writeText(rel, text) {
    return writeBytes(rel, String(text == null ? '' : text));
  }

  function writeJson(rel, value, { pretty = false } = {}) {
    const text = JSON.stringify(value, null, pretty ? 2 : 0) + '\n';
    return writeBytes(rel, text);
  }

  function readText(rel) {
    const { absolute } = targetOf(rel);
    return fs.readFileSync(absolute, 'utf8');
  }

  /** 读原始字节（二进制分片用；不要用 readText 读二进制，UTF-8 解码会损坏内容）。 */
  function readBytes(rel) {
    const { absolute } = targetOf(rel);
    return fs.readFileSync(absolute);
  }

  function readJson(rel) {
    return JSON.parse(readText(rel));
  }

  function exists(rel) {
    try {
      return fs.existsSync(targetOf(rel).absolute);
    } catch {
      return false;
    }
  }

  function remove(rel) {
    const { relative, absolute } = targetOf(rel);
    if (!fs.existsSync(absolute)) return false;
    fs.rmSync(absolute, { force: true, recursive: false });
    const existing = entries.get(relative);
    if (existing) {
      totalBytes -= existing.bytes;
      entries.delete(relative);
    }
    return true;
  }

  function listFiles(rel = '.') {
    const isRoot = rel == null || rel === '' || rel === '.';
    const base = isRoot ? dir : targetOf(rel).absolute;
    if (!fs.existsSync(base)) return [];
    const out = [];
    const walk = (current, prefix) => {
      for (const item of fs.readdirSync(current, { withFileTypes: true })) {
        const absolute = path.join(current, item.name);
        const relative = prefix ? prefix + '/' + item.name : item.name;
        if (item.isDirectory()) walk(absolute, relative);
        else out.push({ path: relative, bytes: fs.statSync(absolute).size });
      }
    };
    walk(base, isRoot ? '' : String(rel));
    return out.sort((left, right) => left.path.localeCompare(right.path));
  }

  function stats() {
    return {
      files: entries.size,
      bytes: totalBytes,
      maxBytes,
      maxFiles,
      label,
      seed: opts.seed == null ? null : String(opts.seed),
      dir,
      usedRatio: Math.round((totalBytes / maxBytes) * 10000) / 100,
    };
  }

  /** 文件完整性摘要（由小到大排序后逐文件 sha256 组合；不把大内容放进内存两次）。 */
  async function digest() {
    const files = listFiles().sort((left, right) => left.path.localeCompare(right.path));
    const hash = createHash('sha256');
    const manifest = [];
    for (const file of files) {
      const { absolute } = targetOf(file.path);
      const content = fs.readFileSync(absolute);
      const fileHash = createHash('sha256').update(content).digest('hex');
      hash.update(file.path + '\u0000' + fileHash + '\n');
      manifest.push({ path: file.path, bytes: file.bytes, sha256: fileHash });
    }
    return { sha256: hash.digest('hex'), files: manifest.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), manifest };
  }

  /** 断言工作区仍是安全的 tmp 目录（清理前/测试里调用）。 */
  function assertSafe() {
    const resolved = path.resolve(dir);
    if (isInsideRepo(resolved)) throw new LongtailWorkspaceError('工作区意外落在仓库内：' + resolved, 'E_LONGTAIL_TMP_REPO');
    if (!isInsideTmpRoot(resolved, root)) throw new LongtailWorkspaceError('工作区不在 tmp 根内：' + resolved, 'E_LONGTAIL_TMP_REPO');
    return true;
  }

  function cleanup() {
    if (cleaned) return false;
    assertSafe();
    fs.rmSync(dir, { recursive: true, force: true });
    cleaned = true;
    return true;
  }

  const workspace = {
    version: TMP_WORKSPACE_VERSION,
    dir,
    root,
    label,
    keep: opts.keep === true,
    path: (rel) => targetOf(rel).absolute,
    mkdir(rel) {
      const { absolute } = targetOf(rel);
      fs.mkdirSync(absolute, { recursive: true });
      return absolute;
    },
    writeBytes,
    writeText,
    writeJson,
    readText,
    readBytes,
    readJson,
    exists,
    remove,
    listFiles,
    stats,
    digest,
    assertSafe,
    cleanup,
    isCleaned: () => cleaned,
    /** 是否只写了 tmp（恒为 true，除非被篡改；门禁证据用）。 */
    isTmpOnly() {
      return isInsideTmpRoot(dir, root) && !isInsideRepo(dir);
    },
  };
  assertSafe();
  return workspace;
}

/**
 * 包一层生命周期：默认 finally 清理，keep=true 时保留。
 * @template T
 * @param {object} options
 * @param {(workspace:object)=>Promise<T>|T} run
 */
export async function withWorkspace(options, run) {
  const workspace = createWorkspace(options);
  try {
    return await run(workspace);
  } finally {
    if (!workspace.keep) workspace.cleanup();
  }
}

// ---------------------------------------------------------------------------
// 遗留目录清理（只清理固定前缀；不递归猜测用户目录）
// ---------------------------------------------------------------------------

/** 列出 tmp 根下匹配前缀的遗留目录（排查/测试用）。 */
export function listLeftoverWorkspaces({ root = os.tmpdir(), prefix = TMP_PREFIX } = {}) {
  const base = path.resolve(root);
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((item) => item.isDirectory() && item.name.startsWith(prefix + '-'))
    .map((item) => path.join(base, item.name));
}

/** 清理超过 maxAgeMs 的遗留工作区；返回被删目录列表。 */
export function pruneLeftoverWorkspaces({ root = os.tmpdir(), prefix = TMP_PREFIX, maxAgeMs = 6 * 60 * 60 * 1000 } = {}) {
  const now = Date.now();
  const removed = [];
  for (const dir of listLeftoverWorkspaces({ root, prefix })) {
    try {
      const stats = fs.statSync(dir);
      if (maxAgeMs > 0 && now - stats.mtimeMs < maxAgeMs) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // 忽略竞态（其他进程已删/无权限）：清理是 best-effort。
    }
  }
  return removed;
}

export { byteLength as tmpByteLength };
