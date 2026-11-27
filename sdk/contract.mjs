// sdk/contract.mjs —— Node SDK 的协议契约快照与能力门禁。
//
// 目标（W4-A 第 5 项）：SDK 不能只“会调 RPC”，还要能像 MCP server 一样在本地判断
//   - 这份扩展协议版本支持哪些 feature floor（1.8 客户端会缺 1.9 能力）；
//   - 某个工具/方法在当前协议下是否可用（工具级 featureGates 并集）；
//   - 错误码清单、恢复建议、可分页方法、未知态/收敛策略。
//
// 所有内容都从 lib/method-catalog.mjs、lib/error-codes.mjs、lib/protocol-features.mjs
// 与 sdk/tool-catalog.mjs 派生（不手抄），供 SDK 调用方与契约测试共用。
//
// 调用点：
//   - sdk/index.mjs 导出 SDK_CONTRACT / toolProtocolGate / protocolGateFor；
//   - tests/unit/sdk-contract.test.mjs 断言 SDK 契约与 lib/ 单源、Python SDK、MCP 完全一致。

import {
  ERROR_CODES,
  ERROR_CODE_LIST,
  ERROR_RECOVERY,
} from '../lib/error-codes.mjs';
import {
  FEATURE_FLOORS,
  FEATURE_META,
  FEATURE_NAMES,
  METHOD_CATALOG,
  METHOD_EFFECT_TABLE,
  METHOD_FEATURE,
  METHOD_NAMES,
  METHOD_PARTIAL,
  METHOD_RECONCILE,
  METHOD_STATE,
  METHOD_UNKNOWN,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
  floorOf,
} from '../lib/method-catalog.mjs';
import { featureShortfall, featuresForCall, PROTOCOL_UNSUPPORTED } from '../lib/protocol-features.mjs';
import { TOOL_NAMES, paginationOf, toolTierSummary } from './tool-catalog.mjs';

/** 每个工具的分页标记表（供 SDK 调用方在循环里判断是否续读）。 */
export const TOOL_PAGINATION = Object.freeze(Object.fromEntries(
  TOOL_NAMES.map((name) => [name, paginationOf(name)]),
));

/** SDK ↔ 协议契约快照：版本 / 错误码 / feature floor / 方法状态机 / 工具分档分页。 */
export const SDK_CONTRACT = Object.freeze({
  protocol: Object.freeze({ current: PROTOCOL_CURRENT, baseline: PROTOCOL_BASELINE }),
  errors: Object.freeze({
    codes: Object.freeze([...ERROR_CODE_LIST]),
    details: ERROR_CODES,
    recovery: ERROR_RECOVERY,
    unsupportedCode: PROTOCOL_UNSUPPORTED,
  }),
  features: Object.freeze({
    names: Object.freeze([...FEATURE_NAMES]),
    floors: FEATURE_FLOORS,
    meta: FEATURE_META,
  }),
  methods: Object.freeze({
    total: METHOD_NAMES.length,
    names: Object.freeze([...METHOD_NAMES]),
    effects: METHOD_EFFECT_TABLE,
    feature: METHOD_FEATURE,
    floors: Object.freeze(Object.fromEntries(METHOD_NAMES.filter((method) => floorOf(method)).map((method) => [method, floorOf(method)]))),
    partial: Object.freeze([...METHOD_PARTIAL]),
    unknown: Object.freeze([...METHOD_UNKNOWN]),
    reconcile: METHOD_RECONCILE,
    states: METHOD_STATE,
  }),
  tools: Object.freeze({
    names: Object.freeze([...TOOL_NAMES]),
    tiers: toolTierSummary(),
    pagination: TOOL_PAGINATION,
  }),
  catalog: Object.freeze(METHOD_CATALOG),
});

function compareVersion(a, b) {
  const parse = (value) => String(value || '').split('.').map((part) => Number(part) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** 协议版本是否支持某 feature floor。 */
export function protocolSupports(feature, version = PROTOCOL_CURRENT) {
  const floor = FEATURE_FLOORS[String(feature || '')];
  if (!floor) return false;
  return compareVersion(version, floor) >= 0;
}

/**
 * 单方法在给定对端协议版本下的门禁（参数级 feature 也会算进去）。
 * @returns {{ ok:boolean, features:Array<string>, missing:Array<{feature:string,required:string}>, code:string|null }}
 */
export function methodProtocolGate(method, params = {}, peerVersion = PROTOCOL_CURRENT) {
  const features = [...featuresForCall(method, params || {})];
  const peer = { protocol: String(peerVersion || '') };
  const missing = featureShortfall(peer, features, (a, b) => {
    const order = compareVersion(a, b);
    return order === 0 ? 0 : order;
  });
  return {
    ok: missing.length === 0,
    features,
    missing,
    code: missing.length ? PROTOCOL_UNSUPPORTED : null,
    floor: features.reduce((max, feature) => {
      const floor = FEATURE_FLOORS[feature];
      if (!floor) return max;
      return !max || compareVersion(floor, max) > 0 ? floor : max;
    }, null),
  };
}

/**
 * 单工具在给定对端协议版本下的门禁：工具的 featureGates 并集 + 调用参数触发的参数级 feature。
 * @param {string} name MCP 工具名
 * @param {{methods?:string[], params?:object, featureGates?:string[]}} input
 */
export function toolProtocolGate(name, { methods = [], featureGates = [], params = {} } = {}, peerVersion = PROTOCOL_CURRENT) {
  const features = new Set(featureGates);
  for (const method of methods) {
    for (const feature of featuresForCall(method, params || {})) features.add(feature);
  }
  const missing = featureShortfall({ protocol: String(peerVersion || '') }, [...features], (a, b) => compareVersion(a, b));
  return {
    ok: missing.length === 0,
    features: [...features].sort(),
    missing,
    code: missing.length ? PROTOCOL_UNSUPPORTED : null,
  };
}

/** 错误码是否属于“协议不兼容”家族（daemon 用两个别名）。 */
export function isProtocolUnsupportedCode(code) {
  return String(code || '') === PROTOCOL_UNSUPPORTED || String(code || '') === 'E_UNSUPPORTED_CAPABILITY';
}
