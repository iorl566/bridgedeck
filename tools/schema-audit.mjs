#!/usr/bin/env node
// 协议参数 schema 覆盖审计：所有扩展方法必须有 object schema，属性必须是对象。
import { EXT_METHODS } from '../lib/methods.mjs';
import { METHOD_SCHEMAS } from '../lib/schemas.mjs';

const problems = [];
const rows = [];
for (const method of [...EXT_METHODS].sort()) {
  const schema = METHOD_SCHEMAS[method];
  if (!schema) { problems.push(method + ' 缺少 METHOD_SCHEMAS 条目'); continue; }
  if (schema.type !== 'object') problems.push(method + ' schema.type 不是 object');
  for (const [key, value] of Object.entries(schema.properties || {})) {
    if (!value || typeof value !== 'object') problems.push(method + '.' + key + ' 属性不是对象');
  }
  rows.push({ method, properties: Object.keys(schema.properties || {}).length });
}
const unknown = Object.keys(METHOD_SCHEMAS).filter((method) => !EXT_METHODS.has(method) && !['status', 'browsers'].includes(method));
const ok = problems.length === 0;
console.log(JSON.stringify({ ok, methods: EXT_METHODS.size, schemas: Object.keys(METHOD_SCHEMAS).length, checked: rows.length, problems, unknownSchemas: unknown }, null, 2));
if (!ok && process.argv.includes('--check')) process.exit(1);
