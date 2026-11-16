// tools/gen-protocol.mjs —— 从 lib/ 的协议元数据生成扩展侧传输常量与参数归一化。
// 用法：
//   node tools/gen-protocol.mjs           # 写入 extension/src/generated/protocol.js
//   node tools/gen-protocol.mjs --check   # 只校验，不写入（CI/门禁用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { METHOD_EFFECT } from '../lib/protocol.mjs';
import {
  EXT_METHODS,
  INSTANCE_METHODS,
  LOCAL_METHODS,
  SESSION_METHODS,
  isMutating,
} from '../lib/methods.mjs';
import { METHOD_SCHEMAS } from '../lib/schemas.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'extension', 'src', 'generated', 'protocol.js');

const methods = Object.keys(METHOD_EFFECT).sort();
const mutating = methods.filter((method) => {
  try { return isMutating(method) === true; } catch { return false; }
});

const schemas = {};
for (const [method, schema] of Object.entries(METHOD_SCHEMAS)) {
  const properties = schema && schema.properties ? Object.keys(schema.properties).sort() : [];
  schemas[method] = {
    required: Array.isArray(schema && schema.required) ? [...schema.required].sort() : [],
    properties,
  };
}

const aliases = {};
for (const [method, info] of Object.entries(schemas)) {
  const map = {};
  for (const key of info.properties) {
    const snake = key.replace(/[A-Z]/g, (char) => '_' + char.toLowerCase());
    if (snake !== key) map[snake] = key;
  }
  if (Object.keys(map).length) aliases[method] = map;
}

const banner = '// 由 tools/gen-protocol.mjs 生成，请勿手改；运行 node tools/gen-protocol.mjs 重新生成。';
const content = [
  banner,
  'export const GENERATED_PROTOCOL = true;',
  'export const METHOD_EFFECT = ' + JSON.stringify(METHOD_EFFECT, null, 2) + ';',
  'export const METHODS = ' + JSON.stringify(methods, null, 2) + ';',
  'export const MUTATING_METHODS = new Set(' + JSON.stringify(mutating, null, 2) + ');',
  'export const LOCAL_METHODS = new Set(' + JSON.stringify([...LOCAL_METHODS].sort(), null, 2) + ');',
  'export const SESSION_METHODS = new Set(' + JSON.stringify([...SESSION_METHODS].sort(), null, 2) + ');',
  'export const INSTANCE_METHODS = new Set(' + JSON.stringify([...INSTANCE_METHODS].sort(), null, 2) + ');',
  'export const EXT_METHODS = new Set(' + JSON.stringify([...EXT_METHODS].sort(), null, 2) + ');',
  'export const METHOD_SCHEMA_KEYS = ' + JSON.stringify(schemas, null, 2) + ';',
  'export const PARAM_ALIASES = ' + JSON.stringify(aliases, null, 2) + ';',
  '',
  'export function methodEffect(method) { return METHOD_EFFECT[method] || null; }',
  'export function isKnownMethod(method) { return Object.prototype.hasOwnProperty.call(METHOD_EFFECT, method); }',
  '',
  '/** 把 snake_case 别名归一化为协议 camelCase；未知方法/未知键原样返回。 */',
  'export function normalizeParams(method, params) {',
  '  if (!params || typeof params !== "object" || Array.isArray(params)) return params;',
  '  const map = PARAM_ALIASES[method];',
  '  if (!map) return params;',
  '  let changed = false;',
  '  const out = { ...params };',
  '  for (const [snake, camel] of Object.entries(map)) {',
  '    if (out[camel] === undefined && out[snake] !== undefined) {',
  '      out[camel] = out[snake];',
  '      delete out[snake];',
  '      changed = true;',
  '    }',
  '  }',
  '  return changed ? out : params;',
  '}',
  '',
].join('\n');

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== content) {
    console.error('generated protocol is stale: ' + path.relative(ROOT, OUT));
    process.exit(1);
  }
  console.log('protocol generated file is up to date');
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, content);
  console.log(JSON.stringify({ ok: true, out: path.relative(ROOT, OUT), methods: methods.length, schemas: Object.keys(schemas).length }, null, 2));
}
