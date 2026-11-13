// tools/protocol-check.mjs —— 协议一致性门禁：METHOD_EFFECT 为唯一方法清单，lib/methods.mjs 为分类来源
import fs from 'node:fs';
import { METHOD_EFFECT } from '../lib/protocol.mjs';
import { EXT_METHODS, LOCAL_METHODS, validateMethodRegistry } from '../lib/methods.mjs';
import { METHOD_SCHEMAS } from '../lib/schemas.mjs';
import { TOOLS } from '../mcp/server.mjs';

const read = (p) => fs.readFileSync(p, 'utf8');
const ext = read('extension/src/dispatch.js');
const daemon = read('daemon/server.mjs');

const canonical = new Set(Object.keys(METHOD_EFFECT));
const handlerBlockMatch = ext.match(/const HANDLERS = \{([\s\S]*?)\n\};/);
const handlerBlock = handlerBlockMatch ? handlerBlockMatch[1] : '';
// 方法名允许大写与下划线（window.ensureAgent / debug.rule_add），
// 且不能吞掉行尾换行，否则简写属性（navigate, / reload,）会隔行漏报。
const handlers = new Set([...handlerBlock.matchAll(/^\s*'?([A-Za-z][A-Za-z0-9._-]*)'?\s*(?::|,)/gm)].map((m) => m[1]));

const handlersNotInProtocol = [...handlers].filter((m) => !canonical.has(m)).sort();
const protocolWithoutHandler = [...canonical].filter((m) => !handlers.has(m)).sort();
const extensionWithoutHandler = [...EXT_METHODS].filter((m) => !handlers.has(m)).sort();
const protocolUnclassified = [...canonical]
  .filter((m) => !EXT_METHODS.has(m) && !LOCAL_METHODS.has(m))
  .sort();
const daemonCases = new Set([
  ...[...daemon.matchAll(/case '([A-Za-z0-9._-]+)':/g)].map((match) => match[1]),
  ...[...daemon.matchAll(/method === '([A-Za-z0-9._-]+)'/g)].map((match) => match[1]),
]);
const localWithoutRoute = [...LOCAL_METHODS].filter((m) => !daemonCases.has(m)).sort();
const registryErrors = validateMethodRegistry();
const schemaMissing = [...EXT_METHODS].filter((method) => !METHOD_SCHEMAS[method]).sort();
const mcpMethodsNotInProtocol = [...new Set(TOOLS.flatMap((tool) => tool.methods || []))]
  .filter((method) => !canonical.has(method))
  .sort();
const mcpToolsMissingMapping = TOOLS.filter((tool) => !Array.isArray(tool.methods)).map((tool) => tool.name).sort();

const result = {
  canonicalMethods: canonical.size,
  extensionHandlers: handlers.size,
  mcpTools: TOOLS.length,
  mcpMethodsNotInProtocol,
  mcpToolsMissingMapping,
  handlersNotInProtocol,
  protocolWithoutHandler,
  extensionWithoutHandler,
  protocolUnclassified,
  localWithoutRoute,
  registryErrors,
  schemaMissing,
};
console.log(JSON.stringify(result, null, 2));
process.exit(
  handlersNotInProtocol.length
  || extensionWithoutHandler.length
  || protocolUnclassified.length
  || localWithoutRoute.length
  || registryErrors.length
  || schemaMissing.length
  || mcpMethodsNotInProtocol.length
  || mcpToolsMissingMapping.length
    ? 1
    : 0,
);
