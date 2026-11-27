// tools/bsk-diff/lib/text.mjs —— 确定性文本工具：读文件、定位证据行、稳定排序。
//
// 设计约束（见 docs/上游-DIFF-MATRIX.md「生成方式」）：
// - 只读仓库内相对路径，证据统一记成 `<repo 相对路径>:<1 基行号>`；
// - 不写绝对路径（Windows/Unix 结果一致）；
// - 不做任何时间戳 / 随机 / 环境相关输出，保证二次运行逐字节一致。

import fs from 'node:fs';
import path from 'node:path';

/** 规范化换行，避免 CRLF 仓库/文件影响解析与行号。 */
export function normalizeText(text) {
  return String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/** 读取 UTF-8 文本并返回行数组（1 基访问由 lineAt 负责）。 */
export function readLines(absPath) {
  const text = normalizeText(fs.readFileSync(absPath, 'utf8'));
  return { text, lines: text.split('\n') };
}

/** repo 相对路径（正斜杠），用于证据与快照，绝不出现绝对路径。 */
export function repoPath(root, absPath) {
  const rel = path.relative(root, absPath);
  return rel.split(path.sep).join('/');
}

/**
 * 在文件中按字面量/正则定位第一处（或第 nth 处）出现，返回 1 基行号。
 * 找不到返回 0 —— 上层必须把 0 当作「证据缺失」处理，不得伪造。
 */
export function lineOf(lines, matcher) {
  const test = typeof matcher === 'string'
    ? (line) => line.includes(matcher)
    : (line) => matcher.test(line);
  for (let i = 0; i < lines.length; i += 1) {
    if (test(lines[i])) return i + 1;
  }
  return 0;
}

/** 同上，但返回全部匹配行号（升序）。 */
export function linesOf(lines, matcher) {
  const test = typeof matcher === 'string'
    ? (line) => line.includes(matcher)
    : (line) => matcher.test(line);
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (test(lines[i])) out.push(i + 1);
  }
  return out;
}

/**
 * 定位一个「锚点」：{ file, needle } → 证据字符串 `<file>:<line>`。
 * needle 支持字符串（字面量）或 RegExp。找不到时抛错（错在生成期就暴露，
 * 而不是把过期证据写进报告）。
 */
export function anchorFrom(fileLines, file, needle) {
  const line = lineOf(fileLines, needle);
  if (line === 0) {
    const label = typeof needle === 'string' ? needle : String(needle);
    throw new Error(`证据锚点未命中：${file} 中找不到 ${label}`);
  }
  return `${file}:${line}`;
}

/** 稳定排序：按给定 key 列表比较（同为数字时按数值，其余按字典序），不依赖 locale。 */
export function stableSortBy(items, keys) {
  return [...items].sort((a, b) => {
    for (const key of keys) {
      const av = a == null ? '' : a[key];
      const bv = b == null ? '' : b[key];
      if (typeof av === 'number' && typeof bv === 'number') {
        if (av !== bv) return av - bv;
        continue;
      }
      const as = String(av ?? '');
      const bs = String(bv ?? '');
      if (as < bs) return -1;
      if (as > bs) return 1;
    }
    return 0;
  });
}

/** snake_case → kebab-case（flags / CLI 词形）。 */
export function toKebab(value) {
  return String(value).trim().replace(/_/g, '-').toLowerCase();
}

/** camelCase / snake_case → snake_case（协议字段名）。 */
export function toSnake(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
}

/** 文本包含的十进制百分比，保留 1 位（确定性，避免 0.30000000000000004）。 */
export function percent(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}

/** 唯一化并升序排序字符串数组。 */
export function uniqSorted(values) {
  return [...new Set(values)].sort();
}

/** 数组差集（a - b），保持 a 的原始顺序。 */
export function diff(a, b) {
  const set = new Set(b);
  return a.filter((item) => !set.has(item));
}
