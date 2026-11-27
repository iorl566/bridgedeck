// tools/protocol-check.mjs —— 协议一致性门禁：METHOD_EFFECT 为唯一方法清单，lib/methods.mjs 为分类来源，
// lib/method-catalog.mjs 为 owner/effect/feature floor/五维状态的单一目录。
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  FEATURE_FLOORS,
  METHOD_FEATURE,
  METHOD_PARTIAL,
  METHOD_STATE,
  METHOD_UNKNOWN,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
} from '../lib/method-catalog.mjs';
import { METHOD_EFFECT } from '../lib/protocol.mjs';
import { EXT_METHODS, LOCAL_METHODS, validateMethodRegistry } from '../lib/methods.mjs';
import { METHOD_SCHEMAS, schemaDriftReport } from '../lib/schemas.mjs';
import { TOOLS } from '../mcp/server.mjs';
import { auditSingleSource, collectSingleSourceInputs } from './protocol-single-source.mjs';

const read = (p) => fs.readFileSync(p, 'utf8');
const ext = read('extension/src/dispatch.js');
const daemon = read('daemon/server.mjs');
// 本地/控制面方法已从 server.mjs 拆到 daemon/local-dispatch.js（case 表）；两处一起作为路由证据。
const localDispatch = fs.existsSync('daemon/local-dispatch.js') ? read('daemon/local-dispatch.js') : '';

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
  ...[...localDispatch.matchAll(/case '([A-Za-z0-9._-]+)':/g)].map((match) => match[1]),
  ...[...localDispatch.matchAll(/method === '([A-Za-z0-9._-]+)'/g)].map((match) => match[1]),
]);
const localWithoutRoute = [...LOCAL_METHODS].filter((m) => !daemonCases.has(m)).sort();
const registryErrors = validateMethodRegistry();
const schemaMissing = [...EXT_METHODS].filter((method) => !METHOD_SCHEMAS[method]).sort();
const schemaDrift = schemaDriftReport();
const mcpMethodsNotInProtocol = [...new Set(TOOLS.flatMap((tool) => tool.methods || []))]
  .filter((method) => !canonical.has(method))
  .sort();
const mcpToolsMissingMapping = TOOLS.filter((tool) => !Array.isArray(tool.methods)).map((tool) => tool.name).sort();
let generatedProtocol = 'ok';
try {
  // 同时校验 generated/protocol.js 与 docs/PROTOCOL-METHODS.md（都由 gen-protocol 渲染）。
  execFileSync(process.execPath, ['tools/gen-protocol.mjs', '--check'], { cwd: process.cwd(), stdio: 'pipe' });
} catch {
  generatedProtocol = 'stale';
}

// 单一目录硬审计：手工表/生成物/文档/MCP 映射/五维状态/schema 派生/兼容策略必须与目录一致。
const singleSource = auditSingleSource(await collectSingleSourceInputs());

const result = {
  canonicalMethods: canonical.size,
  extensionHandlers: handlers.size,
  mcpTools: TOOLS.length,
  featureFloors: Object.keys(FEATURE_FLOORS).length,
  gatedMethods: Object.keys(METHOD_FEATURE).length,
  methodStates: Object.keys(METHOD_STATE).length,
  partialMethods: METHOD_PARTIAL.length,
  unknownMethods: METHOD_UNKNOWN.length,
  protocolBaseline: PROTOCOL_BASELINE,
  protocolCurrent: PROTOCOL_CURRENT,
  mcpMethodsNotInProtocol,
  mcpToolsMissingMapping,
  handlersNotInProtocol,
  protocolWithoutHandler,
  extensionWithoutHandler,
  protocolUnclassified,
  localWithoutRoute,
  registryErrors,
  schemaMissing,
  schemaDerived: {
    ok: schemaDrift.ok,
    checked: schemaDrift.checked,
    schemaKeys: schemaDrift.derived.schemaKeys,
    paramAliases: schemaDrift.derived.paramAliases,
    problems: schemaDrift.problems,
  },
  generatedProtocol,
  singleSource: singleSource.ok ? 'ok' : singleSource.differences.slice(0, 20),
};
console.log(JSON.stringify(result, null, 2));
process.exit(
  handlersNotInProtocol.length
  || extensionWithoutHandler.length
  || protocolUnclassified.length
  || localWithoutRoute.length
  || registryErrors.length
  || schemaMissing.length
  || !schemaDrift.ok
  || mcpMethodsNotInProtocol.length
  || mcpToolsMissingMapping.length
  || !singleSource.ok
  || generatedProtocol !== 'ok'
    ? 1
    : 0,
);
