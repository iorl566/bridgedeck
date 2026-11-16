// tools/gen-error-codes.mjs —— 从 lib/error-codes.mjs 生成错误码清单到文档与 SDK。
// 幂等：只替换 begin/end 标记之间的内容。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES } from '../lib/error-codes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const codes = Object.keys(ERROR_CODES);

function replaceBlock(file, begin, end, body) {
  const target = path.join(ROOT, file);
  const text = fs.readFileSync(target, 'utf8');
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (start < 0 || stop < 0 || stop < start) throw new Error('缺少标记：' + file);
  const next = text.slice(0, start + begin.length) + '\n' + body + '\n' + text.slice(stop);
  fs.writeFileSync(target, next, 'utf8');
  return next.length - text.length;
}

// 1) 协议文档：完整清单表
const docBody = ['| code | 含义 |', '| --- | --- |']
  .concat(codes.map((code) => '| `' + code + '` | ' + ERROR_CODES[code] + ' |'))
  .join('\n');
replaceBlock('docs/PROTOCOL.md', '<!-- error-codes:begin -->', '<!-- error-codes:end -->', docBody);

// 2) Node SDK：常量表（与协议清单同源，避免客户端只认一部分码）
const sdkBody = [
  '/** 协议错误码清单；调用方按码分支，不要依赖文案。 */',
  'export const ERROR_CODES = Object.freeze({',
  ...codes.map((code) => '  ' + code + ': ' + JSON.stringify(ERROR_CODES[code]) + ','),
  '});',
].join('\n');
replaceBlock('sdk/index.mjs', '// error-codes:begin', '// error-codes:end', sdkBody);

// 3) TypeScript 类型：联合类型
const dtsBody = [
  '/** 协议错误码；未知码在传输层归一为 E_INTERNAL。 */',
  'export type BridgeErrorCode =',
  codes.map((code) => "  | '" + code + "'").join('\n') + ';',
].join('\n');
replaceBlock('sdk/index.d.ts', '// error-codes:begin', '// error-codes:end', dtsBody);

// 4) Python SDK：常量集合
const pyBody = [
  '# 协议错误码；未知码在传输层归一为 E_INTERNAL。',
  'ERROR_CODES = frozenset({',
  ...codes.map((code) => "    '" + code + "',"),
  '})',
].join('\n');
replaceBlock('sdk/python/browser_bridge.py', '# error-codes:begin', '# error-codes:end', pyBody);

console.log('error codes', codes.length, '→ docs/PROTOCOL.md, sdk/index.mjs, sdk/index.d.ts, sdk/python/browser_bridge.py');
