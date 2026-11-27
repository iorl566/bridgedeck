// mcp/schema-audit.mjs —— MCP 92 工具 schema 与协议方法目录的双向硬审计。
//
// 目标（W4-A 第 1 项）：tool → method 的参数映射、必填项、枚举、默认值、取值范围，
// 任何一边有漂移都必须让审计失败，而不是让模型在运行时踩到一个「静默丢参数」的工具。
//
// 输入是“运行时事实”（createBrowserTools 产出的 TOOLS + mcp/tool-methods.mjs 映射）与
// lib/schemas.mjs 的规范参数 schema；契约声明（mcp/tool-contracts.mjs）只解释**差量**：
// 哪些入参是 bridge 本地参数、哪些协议参数刻意不暴露、哪些方法保留映射但没有分发。
//
// 审计维度（每个错误都有稳定 code，测试可直接断言）：
//   1. 集合双向：工具 ↔ 契约 ↔ TOOL_METHODS；方法必须存在于 canonical 目录；
//   2. schema 形状：closed object、required 必须是已声明属性；
//   3. 入参 → 协议参数：逐属性反解 snake→camel，必须命中工具声明的某个方法的参数，
//      否则必须在 local 里写明类别；类型/枚举/默认值/取值范围逐项比对；
//   4. 必填：MCP required 必须被协议 schema 要求（或用 requiredAdds 写明理由），
//      协议 required 必须由 MCP required 满足（否则调用方会漏传）；
//   5. 双向覆盖：协议方法的每个参数要么被覆盖，要么在 unexposed 里给出理由；
//   6. 动作分发：枚举 ↔ 分发表 ↔ methods 并集一致（含兼容性保留的 unrouted）；
//   7. 运行时代码：run() 源码读取的 args.X 必须全部在 schema 里（抓死参数），
//      源码里 rpc('<method>') 必须已登记（抓未登记调用）；
//   8. 特性门：方法引用的 feature 必须在 FEATURE_FLOORS 里且能解析出 floor。
//
// 消费点：
//   - mcp/server.mjs 模块加载时 assertToolContracts()：漂移则 server 直接启动失败；
//   - tests/unit/mcp-schema-audit.test.mjs 对每个维度注入坏数据，确认能抓到；
//   - tests/unit/mcp-tools.test.mjs 之外的 MCP 门禁可直接复用 auditToolContracts()。

import { METHOD_SCHEMAS } from '../lib/schemas.mjs';
import { METHOD_EFFECT } from '../lib/protocol.mjs';
import { FEATURE_FLOORS, METHOD_FEATURE, floorOf } from '../lib/method-catalog.mjs';
import {
  AUDIT_CODES,
  CONTRACT_TOOL_NAMES,
  ENVELOPE_ARGS,
  ENVELOPE_PROTOCOL_PARAMS,
  LOCAL_ARG_KINDS,
  LOCAL_ONLY_TOOLS,
  PARAM_ALIASES,
  SCHEMALESS_METHODS,
  TOOL_CONTRACTS,
} from './tool-contracts.mjs';

const MCP_NAME = /^browser_[a-z_]+$/;
const SCHEMA_BACKED = new Set(Object.keys(METHOD_SCHEMAS));

/** MCP snake_case → 协议 camelCase。 */
export function protocolParamName(arg) {
  const name = String(arg || '');
  if (PARAM_ALIASES[name]) return PARAM_ALIASES[name];
  return name.replace(/_([a-z0-9])/g, (_match, letter) => letter.toUpperCase());
}

/** 审计口径的“信封入参”：session/session_id/tab_id 由工具统一注入或透传。 */
export const ENVELOPE_MCP_ARGS = Object.freeze(['session', 'session_id', 'tab_id']);

export function isEnvelopeArg(arg) {
  return ENVELOPE_MCP_ARGS.includes(arg);
}

/** 从 run() 源码里抽取所有 args.<name> 读取（不解析动态 args[key]）。 */
export function collectRuntimeArgs(tool) {
  const source = String((tool && tool.run) || '');
  return [...new Set([...source.matchAll(/\bargs\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]))].sort();
}

/** 从 run() 源码里抽取字面量 rpc('<method>') 调用；动态 rpc(x+action) 不在此列。 */
export function collectRuntimeMethods(tool) {
  const source = String((tool && tool.run) || '');
  return [...new Set([...source.matchAll(/rpc\(\s*'([^']+)'\s*[,)]/g)].map((match) => match[1]))].sort();
}

function pushError(errors, code, tool, message) {
  if (!AUDIT_CODES.includes(code)) throw new Error('未登记审计错误码：' + code);
  errors.push(Object.freeze({ code, tool, message }));
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function sameSet(a, b) {
  return JSON.stringify(sortedUnique(a)) === JSON.stringify(sortedUnique(b));
}

function sameJSON(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mcpTypes(target) {
  return Array.isArray(target.type) ? target.type : [target.type];
}

function protocolTypes(def) {
  return Array.isArray(def.type) ? def.type : [def.type];
}

function singleTypeCompatible(targetType, protocolType) {
  if (targetType === protocolType) return true;
  if (targetType === undefined) return false;
  // integer 的取值集合是 number 的子集：MCP 收 integer 一定满足协议 number；
  // 反过来 number → integer 会放过 1.5，必须显式声明 typeWiden。
  if (protocolType === 'number' && targetType === 'integer') return true;
  if (protocolType === 'integer' && targetType === 'number') return false;
  return false;
}

function typeCompatible(target, def) {
  const targets = mcpTypes(target);
  return protocolTypes(def).every((protocolType) => targets.some((targetType) => singleTypeCompatible(targetType, protocolType)));
}

function rangeProblem(target, def) {
  const problems = [];
  if (def.minimum !== undefined) {
    if (target.minimum === undefined) problems.push('缺少 minimum=' + def.minimum);
    else if (target.minimum < def.minimum) problems.push('minimum ' + target.minimum + ' 小于协议 ' + def.minimum);
  }
  if (def.maximum !== undefined) {
    if (target.maximum === undefined) problems.push('缺少 maximum=' + def.maximum);
    else if (target.maximum > def.maximum) problems.push('maximum ' + target.maximum + ' 大于协议 ' + def.maximum);
  }
  return problems;
}

/**
 * 审计一个工具集合。
 * @param {{ tools: Array<{name:string, inputSchema:object, run:Function, methods?:string[]}>,
 *           toolMethods: Record<string,string[]>, contracts?: Record<string,object> }} input
 * @returns {{ ok:boolean, errors:Array<{code:string,tool:string,message:string}>,
 *             stats:object, tools:Array<object>, methodParams:Record<string,string[]> }}
 */
export function auditToolContracts({ tools, toolMethods, contracts = TOOL_CONTRACTS } = {}) {
  if (!Array.isArray(tools)) throw new Error('auditToolContracts 需要 tools 数组');
  if (!toolMethods || typeof toolMethods !== 'object') throw new Error('auditToolContracts 需要 toolMethods 映射');

  const errors = [];
  const rows = [];
  const toolNames = tools.map((tool) => tool && tool.name);
  const seen = new Set();
  const stats = {
    tools: tools.length,
    contractEntries: CONTRACT_TOOL_NAMES.length,
    methods: 0,
    mappedArgs: 0,
    localArgs: 0,
    unexposedParams: 0,
    dispatchedMethods: 0,
    schemaLessMethods: 0,
    gatedMethods: 0,
  };

  // 1) 集合双向：契约 ↔ 工具 ↔ 方法映射。
  for (const name of Object.keys(contracts)) {
    if (!toolNames.includes(name)) {
      pushError(errors, 'contract-orphan', name, '契约声明了不存在的工具');
    }
  }
  for (const name of Object.keys(toolMethods)) {
    if (!toolNames.includes(name)) pushError(errors, 'tool-set', name, 'TOOL_METHODS 声明了不存在的工具');
  }

  const byName = new Map();
  for (const tool of tools) {
    const name = tool && tool.name ? tool.name : '<unnamed>';
    if (!MCP_NAME.test(String(name))) pushError(errors, 'schema-shape', name, '工具名不符合 browser_[a-z_]+');
    if (seen.has(name)) pushError(errors, 'tool-set', name, '工具名重复');
    seen.add(name);
    byName.set(name, tool);
  }

  for (const tool of tools) {
    const name = tool.name;
    const contract = contracts[name] || {};
    const row = {
      name,
      methods: [],
      mapped: {},
      local: Object.keys(contract.local || {}),
      unexposed: {},
      actions: contract.actions ? Object.keys(contract.actions.map) : [],
      risk: null,
    };
    rows.push(row);

    const methods = toolMethods[name];
    if (!Array.isArray(methods)) {
      pushError(errors, 'method-map', name, '缺少 TOOL_METHODS 方法映射');
      continue;
    }
    row.methods = [...methods];
    stats.methods += methods.length;
    if (methods.length === 0 && !LOCAL_ONLY_TOOLS[name]) {
      pushError(errors, 'local-only', name, '方法映射为空但未登记为本地工具（LOCAL_ONLY_TOOLS）');
    }
    if (methods.length > 0 && LOCAL_ONLY_TOOLS[name]) {
      pushError(errors, 'local-only', name, '本地工具不该声明协议方法');
    }
    for (const method of methods) {
      if (!METHOD_EFFECT[method]) pushError(errors, 'method-unknown', name, '映射了 canonical 目录外的方法 ' + method);
      if (!SCHEMA_BACKED.has(method)) {
        stats.schemaLessMethods += 1;
        if (!SCHEMALESS_METHODS[method]) {
          pushError(errors, 'method-schemaless', name, '方法 ' + method + ' 没有规范 schema，但未在 SCHEMALESS_METHODS 登记');
        }
      }
      if (METHOD_FEATURE[method]) {
        stats.gatedMethods += 1;
        if (!FEATURE_FLOORS[METHOD_FEATURE[method]]) {
          pushError(errors, 'feature-floor', name, '方法 ' + method + ' 的特性门 ' + METHOD_FEATURE[method] + ' 缺少 floor');
        }
        if (!floorOf(method)) pushError(errors, 'feature-floor', name, '方法 ' + method + ' 解析不出协议 floor');
      }
    }

    // 2) schema 形状。
    const schema = tool.inputSchema;
    if (!schema || schema.type !== 'object' || schema.additionalProperties !== false || typeof schema.properties !== 'object' || schema.properties === null) {
      pushError(errors, 'schema-shape', name, 'inputSchema 必须是 additionalProperties=false 的 object');
      continue;
    }
    const props = schema.properties;
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const arg of required) {
      if (!(arg in props)) pushError(errors, 'required-missing-prop', name, 'required 引用了未声明属性 ' + arg);
    }

    // 3) 入参分类：envelope / local / mapped。
    const local = contract.local || {};
    const mapped = {};
    for (const [arg, kind] of Object.entries(local)) {
      if (!(arg in props)) {
        pushError(errors, 'local-unknown', name, '本地参数声明了不存在的属性 ' + arg);
        continue;
      }
      if (!LOCAL_ARG_KINDS[kind]) pushError(errors, 'local-unknown', name, '本地参数 ' + arg + ' 类别非法：' + kind);
    }
    for (const arg of Object.keys(props)) {
      if (isEnvelopeArg(arg)) continue;
      if (Object.hasOwn(local, arg)) {
        stats.localArgs += 1;
        continue;
      }
      const protocolParam = (contract.paramOverrides && contract.paramOverrides[arg]) || protocolParamName(arg);
      const owners = methods.filter((method) => SCHEMA_BACKED.has(method) && METHOD_SCHEMAS[method].properties && protocolParam in METHOD_SCHEMAS[method].properties);
      if (owners.length === 0) {
        pushError(errors, 'arg-undeclared', name, '入参 ' + arg + ' 无法映射到任何已声明方法的协议参数，也不是登记过的本地参数');
        continue;
      }
      mapped[arg] = protocolParam;
      row.mapped[arg] = protocolParam;
      stats.mappedArgs += 1;

      // 4) 类型 / 枚举 / 默认值 / 范围：与每个拥有该参数的方法 schema 比对。
      for (const method of owners) {
        const def = METHOD_SCHEMAS[method].properties[protocolParam];
        const target = props[arg];
        const widen = contract.typeWiden && contract.typeWiden[arg];
        if (!typeCompatible(target, def) && !widen) {
          pushError(errors, 'type-mismatch', name, arg + ' → ' + method + '.' + protocolParam + ' 类型不兼容：MCP ' + JSON.stringify(target.type) + ' vs 协议 ' + JSON.stringify(def.type));
        }
        if (def.enum || target.enum) {
          if (!def.enum || !target.enum) {
            pushError(errors, 'enum-mismatch', name, arg + ' → ' + method + '.' + protocolParam + ' 枚举缺失：MCP=' + JSON.stringify(target.enum || null) + ' 协议=' + JSON.stringify(def.enum || null));
          } else if (!sameSet(target.enum, def.enum)) {
            pushError(errors, 'enum-mismatch', name, arg + ' → ' + method + '.' + protocolParam + ' 枚举不一致：MCP=' + JSON.stringify(target.enum) + ' 协议=' + JSON.stringify(def.enum));
          }
        }
        const targetDefault = Object.hasOwn(target, 'default') ? target.default : undefined;
        const defDefault = Object.hasOwn(def, 'default') ? def.default : undefined;
        if (targetDefault !== undefined || defDefault !== undefined) {
          if (!sameJSON(targetDefault, defDefault)) {
            pushError(errors, 'default-mismatch', name, arg + ' → ' + method + '.' + protocolParam + ' 默认值不一致：MCP=' + JSON.stringify(targetDefault) + ' 协议=' + JSON.stringify(defDefault));
          }
        }
        const ranges = rangeProblem(target, def);
        if (ranges.length) {
          pushError(errors, 'range-mismatch', name, arg + ' → ' + method + '.' + protocolParam + ' 取值约束收窄失败：' + ranges.join('；'));
        }
      }
    }

    // 5) 必填双向。
    const requiredAdds = contract.requiredAdds || {};
    for (const arg of required) {
      if (isEnvelopeArg(arg)) continue;
      if (Object.hasOwn(local, arg)) continue; // 本地必需参数（路径/动作）由工具自己消费
      const protocolParam = mapped[arg];
      if (!protocolParam) continue; // 上面已报 arg-undeclared
      const protocolRequired = methods.some((method) => SCHEMA_BACKED.has(method)
        && (METHOD_SCHEMAS[method].required || []).includes(protocolParam));
      if (!protocolRequired && !requiredAdds[arg]) {
        pushError(errors, 'required-extra', name, 'required 参数 ' + arg + ' 并非协议必填，需在 requiredAdds 写明理由');
      }
    }
    for (const method of methods) {
      if (!SCHEMA_BACKED.has(method)) continue;
      const methodSchema = METHOD_SCHEMAS[method];
      for (const protocolParam of methodSchema.required || []) {
        if (ENVELOPE_PROTOCOL_PARAMS.includes(protocolParam)) continue;
        const arg = Object.keys(mapped).find((candidate) => mapped[candidate] === protocolParam);
        if (!arg) continue; // 覆盖检查统一在 unexposed 里报告
        if (!required.includes(arg)) {
          pushError(errors, 'required-protocol', name, '协议方法 ' + method + ' 必填参数 ' + protocolParam + ' 对应入参 ' + arg + ' 在 MCP 侧不是 required，调用方会漏传');
        }
      }
    }

    // 6) 双向覆盖：协议参数要么被覆盖，要么在 unexposed 写明理由。
    const unexposed = contract.unexposed || {};
    const covered = new Set([...Object.values(mapped), 'session']);
    for (const [method, declaration] of Object.entries(unexposed)) {
      if (!methods.includes(method)) {
        pushError(errors, 'unexposed-stale', name, 'unexposed 声明了未映射的方法 ' + method);
        continue;
      }
      if (!declaration || !Array.isArray(declaration.params) || typeof declaration.reason !== 'string' || declaration.reason.trim().length < 8) {
        pushError(errors, 'unexposed-declaration', name, method + ' 的 unexposed 必须含 params 数组与 reason');
        continue;
      }
      if (!SCHEMA_BACKED.has(method)) {
        pushError(errors, 'unexposed-stale', name, method + ' 没有规范 schema，不能声明 unexposed');
        continue;
      }
      const schemaProps = METHOD_SCHEMAS[method].properties || {};
      for (const protocolParam of declaration.params) {
        if (!(protocolParam in schemaProps)) pushError(errors, 'unexposed-stale', name, method + '.' + protocolParam + ' 不在协议 schema 里');
        if (covered.has(protocolParam)) pushError(errors, 'unexposed-stale', name, method + '.' + protocolParam + ' 已被入参覆盖，却又声明为不暴露');
        if (ENVELOPE_PROTOCOL_PARAMS.includes(protocolParam)) pushError(errors, 'unexposed-stale', name, method + '.' + protocolParam + ' 是信封字段，不需要 unexposed');
      }
      stats.unexposedParams += declaration.params.length;
      row.unexposed[method] = [...declaration.params];
    }
    for (const method of methods) {
      if (!SCHEMA_BACKED.has(method)) continue;
      const declared = new Set(((unexposed[method] || {}).params) || []);
      for (const protocolParam of Object.keys(METHOD_SCHEMAS[method].properties || {})) {
        if (ENVELOPE_PROTOCOL_PARAMS.includes(protocolParam)) continue;
        if (covered.has(protocolParam)) continue;
        if (declared.has(protocolParam)) continue;
        pushError(errors, 'unexposed-undeclared', name, method + '.' + protocolParam + ' 既没被入参覆盖，也没在 unexposed 写明理由');
      }
    }

    // 7) 动作分发一致。
    if (contract.actions) {
      const { arg, map } = contract.actions;
      if (!(arg in props)) pushError(errors, 'dispatch-arg', name, '动作分发参数 ' + arg + ' 不在 schema 里');
      const declaredActions = Object.keys(map);
      const enumValues = props[arg] && props[arg].enum;
      if (!Array.isArray(enumValues)) {
        pushError(errors, 'dispatch-enum', name, '动作分发参数 ' + arg + ' 必须有 enum 声明，实际没有');
      } else if (!sameSet(enumValues, declaredActions)) {
        pushError(errors, 'dispatch-enum', name, '动作枚举与分发表不一致：enum=' + JSON.stringify(enumValues) + ' 分发表=' + JSON.stringify(declaredActions));
      }
      const dispatched = new Set();
      for (const actionMethods of Object.values(map)) {
        if (!Array.isArray(actionMethods)) {
          pushError(errors, 'dispatch-methods', name, '动作分发表的值必须是方法数组');
          continue;
        }
        for (const method of actionMethods) {
          if (!methods.includes(method)) pushError(errors, 'dispatch-methods', name, '动作分发调用了未映射的方法 ' + method);
          dispatched.add(method);
        }
      }
      const unrouted = new Set(Object.keys(contract.unrouted || {}));
      for (const method of unrouted) {
        if (!methods.includes(method)) pushError(errors, 'dispatch-unrouted', name, 'unrouted 声明了未映射的方法 ' + method);
      }
      const expected = new Set([...dispatched, ...unrouted]);
      if (!sameSet([...expected], methods)) {
        pushError(errors, 'dispatch-methods', name, '动作分发+unrouted 的方法并集与 TOOL_METHODS 不一致：分发=' + JSON.stringify(sortedUnique([...expected])) + ' 映射=' + JSON.stringify(sortedUnique(methods)));
      }
      stats.dispatchedMethods += dispatched.size;
    }

    // 8) 运行时代码：死参数与未登记 RPC。
    const runtimeOnly = contract.runtimeOnlyMethods || {};
    const runtimeMethods = collectRuntimeMethods(tool);
    const declaredMethods = new Set(methods);
    for (const method of runtimeMethods) {
      if (!declaredMethods.has(method) && !runtimeOnly[method]) {
        pushError(errors, 'runtime-method', name, "run() 调用了未登记的方法 rpc('" + method + "')");
      }
    }
    for (const method of Object.keys(runtimeOnly)) {
      if (declaredMethods.has(method)) pushError(errors, 'runtime-method', name, 'runtimeOnlyMethods 里的 ' + method + ' 已经登记在 TOOL_METHODS，属重复声明');
    }
    for (const arg of collectRuntimeArgs(tool)) {
      if (!(arg in props)) pushError(errors, 'runtime-arg', name, 'run() 读取了 schema 未声明的参数 args.' + arg + '（死参数）');
    }
  }

  // 9) 双向：每个工具都必须在 TOOL_METHODS 里；契约里每个工具都必须真实存在（上面已查）。
  for (const tool of tools) {
    if (!Object.hasOwn(toolMethods, tool.name)) pushError(errors, 'method-map', tool.name, 'TOOL_METHODS 缺少该工具');
  }

  return Object.freeze({
    ok: errors.length === 0,
    errors: Object.freeze(errors),
    stats: Object.freeze(stats),
    tools: Object.freeze(rows),
    contractVersion: TOOL_CONTRACTS === contracts ? 1 : 0,
  });
}

/** strict 包装：有错误直接抛出（server 启动路径使用）。 */
export function assertToolContracts(input) {
  const report = auditToolContracts(input);
  if (!report.ok) {
    const detail = report.errors.map((error) => '  - [' + error.code + '] ' + error.tool + ': ' + error.message).join('\n');
    const error = new Error('MCP 工具契约审计失败（' + report.errors.length + ' 项）：\n' + detail);
    error.code = 'E_PROTOCOL_UNSUPPORTED';
    error.report = report;
    throw error;
  }
  return report;
}

/** 单工具的契约视图（给文档/测试/排查用；纯派生）。 */
export function describeToolContract(tool, { toolMethods, contracts = TOOL_CONTRACTS } = {}) {
  if (!tool || !tool.name) throw new Error('describeToolContract 需要工具对象');
  const contract = contracts[tool.name] || {};
  const methods = (toolMethods && toolMethods[tool.name]) || [];
  const local = contract.local || {};
  const params = {};
  for (const [arg, definition] of Object.entries(tool.inputSchema.properties || {})) {
    if (isEnvelopeArg(arg)) {
      params[arg] = { kind: 'envelope', protocol: protocolParamName(arg) };
    } else if (Object.hasOwn(local, arg)) {
      params[arg] = { kind: 'local', localKind: local[arg], reason: LOCAL_ARG_KINDS[local[arg]] || null };
    } else {
      params[arg] = { kind: 'protocol', protocol: protocolParamName(arg) };
    }
  }
  return Object.freeze({
    name: tool.name,
    methods: Object.freeze([...methods]),
    params: Object.freeze(params),
    required: Object.freeze([...(tool.inputSchema.required || [])]),
    actions: contract.actions ? Object.freeze({ arg: contract.actions.arg, actions: Object.freeze(Object.keys(contract.actions.map)) }) : null,
    unexposed: Object.freeze(contract.unexposed || {}),
    localOnly: methods.length === 0,
  });
}
