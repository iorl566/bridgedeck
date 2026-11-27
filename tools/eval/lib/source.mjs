/**
 * tools/eval/lib/source.mjs -- resolve a runtime consumption point to a real
 * `file:line` in the frozen tree.
 *
 * The property corpus declares which product modules it consumes:
 *
 *   consumes: [
 *     { file: 'lib/session-queue.mjs', symbol: 'createSessionQueue' },
 *   ]
 *
 * This module turns each declaration into `{file, symbol, line, location}` by
 * scanning the real source. If the file or the symbol disappeared, resolution
 * throws, so the gate fails instead of printing a stale location. Reports and
 * `--check` therefore always cite a line that actually exists at run time.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (tools/eval/lib -> repo root). */
export const ROOT = path.resolve(HERE, '..', '..', '..');

export const SOURCE_MISSING = 'E_EVAL_SOURCE_MISSING';
export const SOURCE_SYMBOL = 'E_EVAL_SOURCE_SYMBOL';
export const SOURCE_ESCAPE = 'E_EVAL_SOURCE_ESCAPE';

const sourceCache = new Map();

/** Convert an absolute path to a posix-style path relative to the repo root. */
export function relativePosix(root, absolute) {
  const rel = path.relative(root, absolute);
  return rel.split(path.sep).join('/');
}

/** Resolve a repo-relative file against the root and refuse path escapes. */
export function resolveRepoFile(file, { root = ROOT } = {}) {
  const absolute = path.resolve(root, String(file));
  const rel = relativePosix(root, absolute);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const error = new Error('eval 消费点越出仓库根：' + String(file));
    error.code = SOURCE_ESCAPE;
    throw error;
  }
  return absolute;
}

/** Read a source file as UTF-8 (cached). Throws E_EVAL_SOURCE_MISSING. */
export function readSource(file, { root = ROOT } = {}) {
  const absolute = resolveRepoFile(file, { root });
  if (sourceCache.has(absolute)) return sourceCache.get(absolute);
  let text;
  try {
    text = fs.readFileSync(absolute, 'utf8');
  } catch (error) {
    const missing = new Error('eval 消费点不存在：' + relativePosix(root, absolute));
    missing.code = SOURCE_MISSING;
    missing.cause = String(error && error.code);
    throw missing;
  }
  sourceCache.set(absolute, text);
  return text;
}

/** Drop the source cache (tests mutate temp trees). */
export function clearSourceCache() {
  sourceCache.clear();
}

/** Escape a symbol name for use inside a regular expression. */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Ordered patterns from strongest (definition) to weakest (mention). */
function patternsFor(symbol) {
  const name = escapeRegExp(symbol);
  return [
    new RegExp('^export\\s+(?:async\\s+)?function\\s+' + name + '\\b'),
    new RegExp('^export\\s+class\\s+' + name + '\\b'),
    new RegExp('^export\\s+const\\s+' + name + '\\s*='),
    new RegExp('^export\\s+let\\s+' + name + '\\b'),
    new RegExp('^export\\s+var\\s+' + name + '\\b'),
    new RegExp('^export\\s*\\{[^}]*\\b' + name + '\\b[^}]*\\}'),
    new RegExp('^(?:async\\s+)?function\\s+' + name + '\\b'),
    new RegExp('^class\\s+' + name + '\\b'),
    new RegExp('^const\\s+' + name + '\\s*='),
    new RegExp('^\\s+(?:async\\s+)?' + name + '\\s*\\('),
    new RegExp('^\\s+' + name + '\\s*:'),
    new RegExp('\\b' + name + '\\b'),
  ];
}

/**
 * Find the best declaration line for `symbol` in `text`.
 * @returns {{line: number, text: string, strength: number}|null} 1-based line.
 */
export function findSymbolLine(text, symbol) {
  const lines = String(text).split(/\r?\n/);
  const patterns = patternsFor(symbol);
  for (let strength = 0; strength < patterns.length; strength += 1) {
    const pattern = patterns[strength];
    for (let index = 0; index < lines.length; index += 1) {
      if (pattern.test(lines[index])) {
        return { line: index + 1, text: lines[index].trim(), strength };
      }
    }
  }
  return null;
}

/**
 * Resolve `{file, symbol}` to a real line.
 * @returns {{file: string, symbol: string, line: number, location: string, text: string, absolute: string}}
 */
export function locateSymbol(file, symbol, { root = ROOT } = {}) {
  const text = readSource(file, { root });
  const match = findSymbolLine(text, symbol);
  if (!match) {
    const error = new Error('在 ' + relativePosix(root, resolveRepoFile(file, { root })) + ' 找不到符号：' + symbol);
    error.code = SOURCE_SYMBOL;
    throw error;
  }
  const rel = relativePosix(root, resolveRepoFile(file, { root }));
  return Object.freeze({
    file: rel,
    symbol: String(symbol),
    line: match.line,
    location: rel + ':' + match.line,
    text: match.text.slice(0, 160),
    absolute: resolveRepoFile(file, { root }),
  });
}

/** List exported value/function/class names with their declaration lines. */
export function listExports(file, { root = ROOT } = {}) {
  const text = readSource(file, { root });
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let match = /^export\s+(?:async\s+)?(function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (match) {
      out.push({ kind: match[1], name: match[2], line: index + 1 });
      continue;
    }
    match = /^export\s*\{([^}]*)\}/.exec(line);
    if (match) {
      for (const part of match[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(name)) out.push({ kind: 're-export', name, line: index + 1 });
      }
    }
  }
  return out;
}

/**
 * Resolve a `consumes` declaration list.
 *
 * @param {Array<{file: string, symbol: string, note?: string}>} consumes
 * @param {{root?: string, strict?: boolean}} [options]
 * @returns {Array<{file:string, symbol:string, line:number, location:string, text:string, note:string|null}>}
 */
export function resolveConsumes(consumes, { root = ROOT, strict = true } = {}) {
  const list = Array.isArray(consumes) ? consumes : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      if (strict) throw new Error('eval consumes 项必须是 {file, symbol}');
      continue;
    }
    const file = String(item.file || '');
    const symbol = String(item.symbol || '');
    if (!file || !symbol) {
      if (strict) throw new Error('eval consumes 项缺少 file/symbol：' + JSON.stringify(item));
      continue;
    }
    const key = file + '#' + symbol;
    if (seen.has(key)) continue;
    seen.add(key);
    const located = locateSymbol(file, symbol, { root });
    out.push(Object.freeze({
      file: located.file,
      symbol: located.symbol,
      line: located.line,
      location: located.location,
      text: located.text,
      note: item.note ? String(item.note) : null,
    }));
  }
  return out;
}

/** Group resolved consumption points by file, preserving first-seen order. */
export function groupConsumes(resolved) {
  const byFile = new Map();
  for (const item of Array.isArray(resolved) ? resolved : []) {
    if (!byFile.has(item.file)) byFile.set(item.file, []);
    byFile.get(item.file).push(item);
  }
  return [...byFile.entries()].map(([file, items]) => Object.freeze({
    file,
    count: items.length,
    symbols: Object.freeze(items.map((item) => Object.freeze({ symbol: item.symbol, line: item.line, location: item.location }))),
  }));
}

/** Read a trimmed source line (1-based) for report evidence. */
export function sourceLineAt(file, line, { root = ROOT } = {}) {
  const text = readSource(file, { root });
  const lines = text.split(/\r?\n/);
  const index = Math.trunc(Number(line)) - 1;
  if (index < 0 || index >= lines.length) return '';
  return lines[index].trim().slice(0, 160);
}

/** Locate the declaration of a property id inside a corpus module (`id: 'x'`). */
export function locatePropertySource(file, propertyId, { root = ROOT } = {}) {
  const text = readSource(file, { root });
  const lines = text.split(/\r?\n/);
  const exact = new RegExp("^\\s*id:\\s*['\"]" + escapeRegExp(propertyId) + "['\"]");
  for (let index = 0; index < lines.length; index += 1) {
    if (exact.test(lines[index])) {
      const rel = relativePosix(root, resolveRepoFile(file, { root }));
      return Object.freeze({ file: rel, line: index + 1, location: rel + ':' + (index + 1), text: lines[index].trim() });
    }
  }
  return null;
}
