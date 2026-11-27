// lib/protocol-features.mjs —— 协议特性兼容表、派发前 preflight 与兼容矩阵。
//
// 同一 major 内允许 minor 偏斜（1.8 扩展仍可连接），但新参数/新能力在新版本才被理解：
// 旧扩展会静默忽略 `unverified`、`expect`、视频/流式截图等字段，等于"看着调用成功、
// 实际没生效"。所以 daemon 派发前按特性表检查对端协议版本，缺特性就明确报
// E_PROTOCOL_UNSUPPORTED，而不是放行。
//
// 本文件的特性门全部从 lib/method-catalog.mjs 派生（FEATURE_FLOORS / FEATURE_META /
// FEATURE_PARAM_RULES），不再另存一份手工表；这里只负责“怎么判定、怎么报错”。

import {
  FEATURE_FALLBACKS,
  FEATURE_FLOORS,
  FEATURE_META,
  FEATURE_MIGRATION,
  FEATURE_NAMES,
  FEATURE_PARAM_RULES,
  METHOD_FEATURE,
  METHOD_NAMES,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
  PROTOCOL_MIGRATION_STEPS,
  proofOf,
} from './method-catalog.mjs';
import { compareProtocol, protocolBand, protocolSkew } from './protocol.mjs';
import { describeMethodProof, recoveryPlan } from './method-state-machine.mjs';
// 第二轮深度：可执行 proof obligations（六面）与兼容矩阵 runner / 迁移规划器。
// 依赖方向单向：本文件 → {protocol-proof, protocol-compat-runner, protocol-migration-planner}，
// 这三个模块都不 import 本文件，因此不会形成循环。新增字段只做加法。
import {
  deniedObligations,
  featureObligations,
  featureObligationMatrix,
  obligationDimensionSummary,
  obligationRiskSummary,
  obligationSummary,
  runCallObligations,
  verificationPlan,
} from './protocol-proof.mjs';
import { compatibilitySnapshot, featureSupportProfile, runCompatibilityMatrix } from './protocol-compat-runner.mjs';
import { planUpgradeFrom } from './protocol-migration-planner.mjs';

/** 特性 → 对端扩展至少需要的协议版本（目录别名的稳定导出名）。 */
export const FEATURE_MIN_PROTOCOL = FEATURE_FLOORS;
/** 特性门名称（目录顺序）。 */
export const FEATURE_NAMES_IN_ORDER = FEATURE_NAMES;
/** 旧客户端被 feature gate 拒绝时使用的错误码（与 lib/error-codes.mjs 登记一致）。 */
export const PROTOCOL_UNSUPPORTED = 'E_PROTOCOL_UNSUPPORTED';

/**
 * 历史错误码兼容别名。
 *
 * 0.3.0 早期版本把“扩展缺特性”也报成 E_UNSUPPORTED_CAPABILITY，调用方已有按该码
 * 分支的逻辑（CLI 恢复提示、DSH 插件恢复映射、外部脚本）。W4 起协议特性门改用更精确的
 * E_PROTOCOL_UNSUPPORTED，但**不删除旧语义**：
 * - 能力位缺失（caps 不含 frames/video/...）仍由 daemon 的 requireCapability 报旧码；
 * - 特性门拒绝的错误 data 里带 legacyCode / aliasCodes，调用方可无缝识别旧码；
 * - 旧码仍登记在 lib/error-codes.mjs，恢复提示不变。
 */
export const LEGACY_CAPABILITY_UNSUPPORTED = 'E_UNSUPPORTED_CAPABILITY';

/** 特性门拒绝时可识别的错误码：首个是主码，其余是兼容别名（顺序稳定，供文档/诊断展示）。 */
export const PROTOCOL_UNSUPPORTED_ALIASES = Object.freeze([PROTOCOL_UNSUPPORTED, LEGACY_CAPABILITY_UNSUPPORTED]);

/** 兼容矩阵默认探测的协议版本：1.8 旧客户端 / 1.9 当前客户端。 */
export const COMPAT_PROBE_VERSIONS = Object.freeze([PROTOCOL_BASELINE, PROTOCOL_CURRENT]);

const RULE_METHODS = new Map(FEATURE_PARAM_RULES.map((rule) => [rule, rule.methods ? new Set(rule.methods) : null]));

function ruleMatches(rule, method, params) {
  const scoped = RULE_METHODS.get(rule);
  if (scoped && !scoped.has(method)) return false;
  const value = params[rule.param];
  if (rule.kind === 'true') return value === true;
  if (rule.kind === 'defined') return value !== undefined && value !== null;
  if (rule.kind === 'non-empty-array') return Array.isArray(value) && value.length > 0;
  // 兼容目标 的 FeatureWhen::Equals / ControlPolicy：只有显式取到目标值才要求该 floor。
  if (rule.kind === 'equals') return typeof value === 'string' && value === rule.value;
  return false;
}

/** 方法级特性门（方法名字符串化后查表；未知方法返回 null）。 */
export function methodFeature(method) {
  return METHOD_FEATURE[String(method || '')] || null;
}

/** 根据方法 + 参数推导这次调用依赖哪些新特性（顺序稳定：方法级在前，参数级按规则表）。 */
export function featuresForCall(method, params = {}) {
  const features = new Set();
  const gated = methodFeature(method);
  if (gated) features.add(gated);
  const bag = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  for (const rule of FEATURE_PARAM_RULES) {
    if (!FEATURE_FLOORS[rule.feature]) continue;
    if (ruleMatches(rule, String(method || ''), bag)) features.add(rule.feature);
  }
  return [...features];
}

/**
 * 对端协议缺口：返回缺失特性及两边版本。
 * compare 省略时使用 lib/protocol.mjs 的 compareProtocol。
 * @param {{ protocol?: string }} peer
 * @param {string[]} features
 * @param {(a: string, b: string) => number|null} [compare]
 * @returns {Array<{feature: string, required: string, actual: string}>}
 */
export function featureShortfall(peer, features, compare = compareProtocol) {
  const protocol = peer && peer.protocol ? String(peer.protocol) : '';
  const missing = [];
  for (const feature of features) {
    const required = FEATURE_MIN_PROTOCOL[feature];
    if (!required) continue;
    const order = typeof compare === 'function' ? compare(protocol, required) : null;
    if (order === null || order < 0) {
      const fallback = FEATURE_FALLBACKS[feature] || null;
      // 只加字段：missing 项自带降级/迁移说明，SDK 的 methodProtocolGate 原样把
      // missing 数组交给调用方（sdk/contract.mjs:102-110），因此这几项能一路到达 SDK。
      missing.push({
        feature,
        required,
        actual: protocol || 'unknown',
        label: (FEATURE_META[feature] && FEATURE_META[feature].label) || feature,
        fallback,
        migration: FEATURE_MIGRATION[feature] || null,
        degradable: Boolean(fallback && fallback.kind !== 'none'),
      });
    }
  }
  return missing;
}

/** 一组特性里最高的最低版本（用于错误信息里的“需要升级到”）。 */
export function requiredFloorFor(features, compare = compareProtocol) {
  let required = null;
  for (const feature of features) {
    const floor = FEATURE_MIN_PROTOCOL[feature];
    if (!floor) continue;
    if (required === null || (typeof compare === 'function' && (compare(floor, required) || 0) > 0)) required = floor;
  }
  return required;
}

/** 每个特性的可用性快照；供 status/doctor 在派发前展示，不靠猜。 */
export function featureMatrix(peer, compare = compareProtocol) {
  const protocol = peer && peer.protocol ? String(peer.protocol) : '';
  const out = {};
  for (const [feature, required] of Object.entries(FEATURE_MIN_PROTOCOL)) {
    const order = typeof compare === 'function' ? compare(protocol, required) : null;
    const available = order !== null && order >= 0;
    out[feature] = {
      required,
      actual: protocol || 'unknown',
      available,
      label: (FEATURE_META[feature] && FEATURE_META[feature].label) || feature,
      // 不可用时的可执行降级（kind=none 表示只能升级）；可用时也带上，便于诊断解释。
      fallback: FEATURE_FALLBACKS[feature] || null,
      // 缺该特性时的升级建议（与 docs 的恢复顺序一致）。
      migration: FEATURE_MIGRATION[feature] || null,
      // 特性门是阻塞式（不是 hint）：缺了就拒绝，必须降级或升级。
      blocking: true,
      severity: available ? 'none' : 'needs-user',
      // 第二轮只加字段：该特性被拒时，哪些义务会失去执行条件（六面聚合）。
      // 经 daemon/health.js:37/41 进入 /health 与 daemon.status，并被 MCP browser_status 透传。
      obligations: featureObligations(feature),
      // 版本支持画像（baseline/current/首版/单调性），来自兼容矩阵 runner。
      support: featureSupportProfile(feature, compare),
    };
  }
  return out;
}

/**
 * floor 判定（可解释版）：返回“这次调用为什么需要这个最低版本”。
 * 与 protocolGate 共用同一组 features，但保留每个 floor 的来源（方法级门/参数级规则），
 * 便于状态输出与错误解释展示“是哪个参数/方法触发的”。纯函数。
 */
export function floorDecision(method, params = {}, compare = compareProtocol) {
  const name = String(method || '');
  const bag = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const sources = [];
  const gated = methodFeature(name);
  if (gated && FEATURE_MIN_PROTOCOL[gated]) {
    sources.push(Object.freeze({ kind: 'method', feature: gated, param: null, required: FEATURE_MIN_PROTOCOL[gated] }));
  }
  for (const rule of FEATURE_PARAM_RULES) {
    if (!FEATURE_MIN_PROTOCOL[rule.feature]) continue;
    if (!ruleMatches(rule, name, bag)) continue;
    sources.push(Object.freeze({ kind: 'param', feature: rule.feature, param: rule.param, required: FEATURE_MIN_PROTOCOL[rule.feature] }));
  }
  const features = [...new Set(sources.map((source) => source.feature))];
  let floor = null;
  for (const source of sources) {
    if (floor === null || (typeof compare === 'function' && (compare(source.required, floor) || 0) > 0)) floor = source.required;
  }
  return Object.freeze({
    method: name,
    features: Object.freeze(features),
    floor,
    sources: Object.freeze(sources),
    gated: Boolean(gated),
  });
}

// ===========================================================================
// 协商失败解释 / 兼容性降级 / 迁移建议
//
// 兼容矩阵回答“能不能用”；这一层回答“不能用时到底缺什么、还能怎么完成目标、
// 需要谁升级到什么版本”。降级只返回**真实可执行**的替代调用（并用同一个
// featureShortfall 复核它在旧客户端上确实放行），绝不把语义不等价的方法说成降级。
// ===========================================================================

/** 单个特性的降级说明（目录别名 + floor）。 */
export function degradationForFeature(feature) {
  const key = String(feature || '');
  const fallback = FEATURE_FALLBACKS[key] || null;
  const floor = FEATURE_MIN_PROTOCOL[key] || null;
  return Object.freeze({
    feature: key,
    floor,
    label: (FEATURE_META[key] && FEATURE_META[key].label) || key,
    fallback,
    kind: fallback ? fallback.kind : 'none',
    degradable: Boolean(fallback && fallback.kind !== 'none'),
    migration: FEATURE_MIGRATION[key] || null,
  });
}

/** 一组缺失特性的可读原因（用于错误 info/message 与诊断）。 */
export function explainFeatureGap(missing, peer) {
  const items = Array.isArray(missing) ? missing : [];
  const actual = peer && peer.protocol ? String(peer.protocol) : 'unknown';
  if (!items.length) {
    return Object.freeze({ summary: '没有缺失特性', actual, details: Object.freeze([]), severity: 'none' });
  }
  const details = items.map((item) => Object.freeze({
    feature: item.feature,
    label: (FEATURE_META[item.feature] && FEATURE_META[item.feature].label) || item.feature,
    required: item.required,
    actual: item.actual || actual,
    fallback: FEATURE_FALLBACKS[item.feature] || null,
    migration: FEATURE_MIGRATION[item.feature] || null,
  }));
  return Object.freeze({
    actual,
    details: Object.freeze(details),
    summary: '对端协议 ' + actual + ' 缺少 ' + items.length + ' 个特性：' + details.map((item) => item.feature + '（需要 ' + item.required + '）').join('、'),
    severity: 'needs-user',
  });
}

/**
 * 为一次单方法调用计算降级方案。
 * @returns {{
 *   ok:boolean, method:string, features:string[], missing:Array,
 *   degradable:boolean, degraded:null|{method:string, params:object, kind:string, droppedParams:string[], verification:object|null},
 *   degradedOk:boolean, unresolved:string[], note:string, items:Array,
 * }}
 */
export function degradationOfCall(peer, method, params = {}, compare = compareProtocol) {
  const name = String(method || '');
  const bag = params && typeof params === 'object' && !Array.isArray(params) ? { ...params } : {};
  const features = featuresForCall(name, bag);
  const missing = featureShortfall(peer, features, compare);
  if (!missing.length) {
    return Object.freeze({
      ok: true, method: name, features: Object.freeze(features), missing: Object.freeze([]),
      degradable: false, degraded: null, degradedOk: false, unresolved: Object.freeze([]),
      note: '无需降级：对端满足全部特性门', items: Object.freeze([]),
    });
  }
  const items = [];
  const unresolved = [];
  let candidateMethod = name;
  const candidateParams = { ...bag };
  const droppedParams = [];
  const verification = { method: null, params: null };
  let decompose = false;
  for (const entry of missing) {
    const fallback = FEATURE_FALLBACKS[entry.feature] || { kind: 'none' };
    items.push(Object.freeze({
      feature: entry.feature, required: entry.required, actual: entry.actual,
      kind: fallback.kind, fallback, resolved: fallback.kind !== 'none',
    }));
    switch (fallback.kind) {
      case 'omit-param':
        if (fallback.param && own2(candidateParams, fallback.param)) { delete candidateParams[fallback.param]; droppedParams.push(fallback.param); }
        else if (fallback.param) droppedParams.push(fallback.param + '(absent)');
        break;
      case 'omit-params':
        for (const param of fallback.params || []) {
          if (own2(candidateParams, param)) { delete candidateParams[param]; droppedParams.push(param); }
        }
        break;
      case 'param+verify':
        if (fallback.param && own2(candidateParams, fallback.param)) { delete candidateParams[fallback.param]; droppedParams.push(fallback.param); }
        if (fallback.method) verification.method = fallback.method;
        break;
      case 'method':
        if (fallback.method) candidateMethod = fallback.method;
        break;
      case 'decompose':
        decompose = true;
        candidateMethod = null;
        break;
      default:
        unresolved.push(entry.feature);
        break;
    }
  }
  if (decompose || !candidateMethod || unresolved.length) {
    return Object.freeze({
      ok: false, method: name, features: Object.freeze(features), missing: Object.freeze(missing),
      degradable: false, degraded: null, degradedOk: false, decomposable: decompose,
      unresolved: Object.freeze(unresolved),
      note: decompose
        ? '该方法需要 daemon 计划执行器（plan）；旧协议只能由调用方按步骤逐条调用'
        : '缺失特性没有可执行降级（只能升级扩展）：' + unresolved.join(', '),
      items: Object.freeze(items),
    });
  }
  // 复核降级调用本身在旧客户端上确实放行（否则不是降级，是另一种拒绝）。
  const candidateFeatures = featuresForCall(candidateMethod, candidateParams);
  const candidateMissing = featureShortfall(peer, candidateFeatures, compare);
  if (candidateMissing.length) {
    return Object.freeze({
      ok: false, method: name, features: Object.freeze(features), missing: Object.freeze(missing),
      degradable: false, degraded: null, degradedOk: false,
      unresolved: Object.freeze(candidateMissing.map((item) => item.feature)),
      note: '降级候选仍被拒绝，不能作为可用降级：' + candidateMissing.map((item) => item.feature).join(', '),
      items: Object.freeze(items),
    });
  }
  return Object.freeze({
    ok: false,
    method: name,
    features: Object.freeze(features),
    missing: Object.freeze(missing),
    degradable: true,
    degraded: Object.freeze({
      method: candidateMethod,
      params: Object.freeze(candidateParams),
      kind: candidateMethod === name ? (droppedParams.length ? 'omit-parameter' : 'rewrite') : 'method',
      droppedParams: Object.freeze([...new Set(droppedParams)]),
      verification: verification.method ? Object.freeze({ method: verification.method, params: Object.freeze({}) }) : null,
    }),
    degradedOk: true,
    unresolved: Object.freeze([]),
    note: '已用同一 featureShortfall 复核：降级调用在 ' + ((peer && peer.protocol) ? String(peer.protocol) : 'unknown') + ' 上放行',
    items: Object.freeze(items),
  });
}

function own2(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

/** 批量降级计划：request 可为 {method,params} 或 {calls:[{method,params}]}。 */
export function degradationPlan(peer, request = {}, compare = compareProtocol) {
  const calls = Array.isArray(request && request.calls)
    ? request.calls
    : (request && request.method ? [request] : []);
  const items = calls.map((call) => {
    const plan = degradationOfCall(peer, call.method, call.params || {}, compare);
    return Object.freeze({ call: Object.freeze({ method: String(call.method || ''), params: Object.freeze({ ...(call.params || {}) }) }), plan });
  });
  const degradable = items.filter((item) => item.plan.degradable);
  const blocked = items.filter((item) => !item.plan.ok && !item.plan.degradable);
  return Object.freeze({
    ok: items.every((item) => item.plan.ok),
    satisfiable: blocked.length === 0,
    peer: peer && peer.protocol ? String(peer.protocol) : 'unknown',
    calls: Object.freeze(items),
    degradable: Object.freeze(degradable),
    blocked: Object.freeze(blocked),
    counts: Object.freeze({ total: items.length, blocked: blocked.length, degradable: degradable.length, allowed: items.filter((item) => item.plan.ok).length }),
  });
}

/**
 * 迁移建议：从对端协议升级到当前协议需要做什么。
 * features 省略时按全部 9 个特性评估（“整体升级建议”）；给出 features 时只解释这些特性。
 */
export function migrationAdvice(peer, options = {}) {
  const protocol = peer && peer.protocol ? String(peer.protocol) : '';
  const scope = Array.isArray(options.features) && options.features.length ? [...new Set(options.features)] : [...FEATURE_NAMES];
  const missing = featureShortfall(peer, scope);
  const skew = protocolSkew(protocol || 'unknown', PROTOCOL_CURRENT);
  const steps = [];
  for (const item of missing) {
    const migration = FEATURE_MIGRATION[item.feature];
    if (migration && !steps.includes(migration)) steps.push(migration);
  }
  const uniqueSteps = [...new Set([...steps, ...PROTOCOL_MIGRATION_STEPS])];
  return Object.freeze({
    peer: protocol || 'unknown',
    band: protocolBand(protocol || 'unknown'),
    skew,
    upgradeTo: PROTOCOL_CURRENT,
    upgradeRequired: missing.length > 0,
    missingCount: missing.length,
    features: Object.freeze(missing.map((item) => Object.freeze({
      feature: item.feature,
      required: item.required,
      actual: item.actual,
      migration: FEATURE_MIGRATION[item.feature] || null,
      fallback: FEATURE_FALLBACKS[item.feature] || null,
    }))),
    steps: Object.freeze(uniqueSteps),
  });
}

/**
 * 协商失败解释（纯数据）：把决策翻译成“原因 / 细节 / 补救”，供 CLI/MCP 原样展示。
 * 不改变错误码，只在既有 decision/data 上补充解释字段。
 */
export function explainNegotiation(decision) {
  if (!decision || decision.ok) {
    return Object.freeze({
      ok: true, code: null, severity: 'none',
      summary: '协议协商通过',
      cause: null,
      details: Object.freeze([]),
      remediation: Object.freeze([]),
    });
  }
  const gap = explainFeatureGap(decision.missing, { protocol: decision.data && decision.data.actual });
  const migration = migrationAdvice({ protocol: decision.data && decision.data.actual }, { features: decision.features });
  const remediation = [];
  for (const detail of gap.details) {
    if (detail.fallback && detail.fallback.kind !== 'none') remediation.push('降级：' + detail.fallback.note);
    else remediation.push('升级扩展/CLI：' + (detail.migration || ('需要协议 ' + detail.required)));
  }
  for (const step of migration.steps) if (!remediation.includes(step)) remediation.push(step);
  return Object.freeze({
    ok: false,
    code: decision.code || PROTOCOL_UNSUPPORTED,
    severity: 'needs-user',
    actual: decision.data ? decision.data.actual : 'unknown',
    floor: decision.floor || null,
    summary: decision.message || ('协议版本不足：需要 ' + (decision.floor || PROTOCOL_CURRENT)),
    cause: '对端协议 ' + ((decision.data && decision.data.actual) || 'unknown') + ' 低于特性门 ' + (decision.floor || PROTOCOL_CURRENT),
    details: gap.details,
    remediation: Object.freeze([...new Set(remediation)]),
    migration,
    degradations: Object.freeze(decision.degradation ? [decision.degradation] : []),
  });
}

/**
 * 综合协商：对单方法、多方法或纯特性请求给出兼容结论 + 降级 + 迁移建议。
 * 这是协议面的“一个入口回答所有问题”，但所有事实仍来自 floor/特性目录。
 */
export function negotiate(peer, request = {}, compare = compareProtocol) {
  const calls = Array.isArray(request && request.calls)
    ? request.calls
    : (request && request.method ? [request] : []);
  const explicitFeatures = Array.isArray(request && request.features) ? [...new Set(request.features)] : [];
  const protocol = peer && peer.protocol ? String(peer.protocol) : '';
  const evaluated = calls.map((call) => {
    const decision = protocolGate(peer, call.method, call.params || {}, compare);
    const degradation = decision.ok ? null : degradationOfCall(peer, call.method, call.params || {}, compare);
    return Object.freeze({
      method: String(call.method || ''),
      ok: decision.ok,
      decision,
      features: decision.features,
      floor: decision.floor,
      degradation,
      proof: call.method ? describeMethodProof(call.method) : null,
    });
  });
  const missingFeatures = [...new Set([
    ...evaluated.flatMap((item) => item.decision.missing.map((entry) => entry.feature)),
    ...(explicitFeatures.length ? featureShortfall(peer, explicitFeatures, compare).map((entry) => entry.feature) : []),
  ])];
  const requiredFloor = calls.length
    ? evaluated.reduce((max, item) => (item.floor && (!max || (compare(item.floor, max) || 0) > 0) ? item.floor : max), null)
    : requiredFloorFor(explicitFeatures, compare);
  const allOk = calls.length ? evaluated.every((item) => item.ok) : missingFeatures.length === 0;
  const allDegradable = !allOk && evaluated.length > 0
    && evaluated.every((item) => item.ok || (item.degradation && item.degradation.degradable));
  const verdict = allOk ? 'compatible' : allDegradable ? 'degraded' : 'incompatible';
  const migration = migrationAdvice(peer, { features: missingFeatures.length ? missingFeatures : explicitFeatures });
  const explanation = allOk
    ? explainNegotiation({ ok: true })
    : explainNegotiation({
      ok: false,
      code: PROTOCOL_UNSUPPORTED,
      floor: requiredFloor,
      features: missingFeatures,
      missing: featureShortfall(peer, missingFeatures, compare),
      message: '缺少特性：' + missingFeatures.join('、') + '（对端 ' + (protocol || 'unknown') + '）',
      data: { actual: protocol || 'unknown' },
      degradation: evaluated.find((item) => item.degradation && item.degradation.degraded)?.degradation.degraded || null,
    });
  return Object.freeze({
    ok: allOk,
    verdict,
    peer: Object.freeze({ protocol: protocol || 'unknown', band: protocolBand(protocol || 'unknown'), skew: protocolSkew(protocol || 'unknown', PROTOCOL_CURRENT) }),
    floor: requiredFloor,
    features: Object.freeze(calls.length ? [...new Set(evaluated.flatMap((item) => item.features))] : explicitFeatures),
    missing: Object.freeze(missingFeatures),
    calls: Object.freeze(evaluated),
    degradations: Object.freeze(evaluated.filter((item) => item.degradation && item.degradation.degraded).map((item) => Object.freeze({ method: item.method, degraded: item.degradation.degraded, note: item.degradation.note }))),
    migration,
    explanation,
  });
}

/** 对端协议兼容性总报告（featureMatrix + 协商结论；供 status/doctor 消费）。 */
export function compatibilityReport(peer, compare = compareProtocol) {
  const protocol = peer && peer.protocol ? String(peer.protocol) : '';
  const matrix = featureMatrix(peer, compare);
  const features = Object.keys(matrix);
  const available = features.filter((feature) => matrix[feature].available);
  const denied = features.filter((feature) => !matrix[feature].available);
  const degradable = denied.filter((feature) => matrix[feature].fallback && matrix[feature].fallback.kind !== 'none');
  return Object.freeze({
    protocol: protocol || 'unknown',
    band: protocolBand(protocol || 'unknown'),
    skew: protocolSkew(protocol || 'unknown', PROTOCOL_CURRENT),
    baseline: PROTOCOL_BASELINE,
    current: PROTOCOL_CURRENT,
    features: Object.freeze(matrix),
    counts: Object.freeze({ total: features.length, available: available.length, denied: denied.length, degradable: degradable.length }),
    available: Object.freeze(available),
    denied: Object.freeze(denied),
    degradable: Object.freeze(degradable),
    verdict: denied.length === 0 ? 'compatible' : degradable.length === denied.length ? 'degraded' : 'incompatible',
    migration: migrationAdvice(peer),
    // 第二轮只加字段：义务聚合 / 可执行升级计划 / 兼容矩阵 runner 快照。
    obligations: Object.freeze({
      dimensions: obligationDimensionSummary(),
      risks: obligationRiskSummary(),
      features: featureObligationMatrix(),
    }),
    upgradePlan: planUpgradeFrom(peer),
    matrix: compatibilitySnapshot(),
  });
}

/**
 * 派发前兼容闸门（纯函数，便于构造 1.8 客户端做负例）。
 * 通过：{ok:true, code:null, features, missing:[], floor, floorDecision, severity:'none', degradation:[], migration:null, proof}
 * 拒绝：{ok:false, code:'E_PROTOCOL_UNSUPPORTED', message, missing, features, floor, explanation, degradation, migration, proof, data}
 * data 固定含 method/feature/features/missing/required/actual，外加 legacyCode/aliasCodes
 * 兼容别名（E_UNSUPPORTED_CAPABILITY），见 LEGACY_CAPABILITY_UNSUPPORTED。
 * 新增字段只做加法：既有字段名/语义/错误码全部不变。
 */
export function protocolGate(peer, method, params = {}, compare = compareProtocol) {
  const features = featuresForCall(method, params);
  const missing = featureShortfall(peer, features, compare);
  const feature = methodFeature(method);
  const floorInfo = floorDecision(method, params, compare);
  const floor = requiredFloorFor(features, compare) || (feature ? FEATURE_MIN_PROTOCOL[feature] : null);
  const proof = proofOf(method) ? describeMethodProof(method) : null;
  // 第二轮只加字段：调用义务摘要（静态，无证据）。拒绝时还会额外带 deniedObligations。
  const obligations = obligationSummary(String(method || ''));
  if (!missing.length) {
    return Object.freeze({
      ok: true,
      code: null,
      method: String(method || ''),
      features,
      missing: [],
      floor,
      floorSources: floorInfo.sources,
      severity: 'none',
      degradation: Object.freeze([]),
      migration: null,
      proof,
      obligations,
    });
  }
  const actual = (peer && peer.protocol) ? String(peer.protocol) : 'unknown';
  const detail = missing.map((item) => item.feature + '（需要 ' + item.required + '，当前 ' + item.actual + '）').join('、');
  const degradation = degradationOfCall(peer, method, params, compare);
  const migration = migrationAdvice(peer, { features });
  const missingFeatures = missing.map((item) => item.feature);
  // 迁移计划：把“缺什么”变成按 floor 排序的升级批次（与 migrationAdvice 同源，但可执行）。
  const upgradePlan = planUpgradeFrom(peer, { features: missingFeatures });
  const obligationGap = deniedObligations(String(method || ''), missingFeatures);
  const explanation = explainNegotiation({
    ok: false,
    code: PROTOCOL_UNSUPPORTED,
    message: '浏览器扩展协议版本过低，缺少特性：' + detail + '。' + FEATURE_RECOVERY,
    missing,
    features,
    floor,
    data: { actual },
    degradation: degradation.degraded,
  });
  const recovery = recoveryPlan(String(method || ''), PROTOCOL_UNSUPPORTED);
  return Object.freeze({
    ok: false,
    code: PROTOCOL_UNSUPPORTED,
    method: String(method || ''),
    features,
    missing,
    floor,
    floorSources: floorInfo.sources,
    severity: explanation.severity,
    message: '浏览器扩展协议版本过低，缺少特性：' + detail + '。' + FEATURE_RECOVERY,
    explanation,
    degradation,
    migration,
    proof,
    recovery,
    obligations,
    upgradePlan,
    data: Object.freeze({
      code: PROTOCOL_UNSUPPORTED,
      method: String(method || ''),
      feature: missing[0].feature,
      features,
      missing,
      required: floor,
      actual,
      // 兼容别名：旧调用方按 E_UNSUPPORTED_CAPABILITY 分支时仍能识别（见 LEGACY_CAPABILITY_UNSUPPORTED）。
      legacyCode: LEGACY_CAPABILITY_UNSUPPORTED,
      aliasCodes: PROTOCOL_UNSUPPORTED_ALIASES,
      // 只加字段：解释、降级、迁移、六面可证明性与恢复计划（调用方可直接展示/执行）。
      severity: explanation.severity,
      explanation,
      degradation: degradation.degraded,
      degradable: degradation.degradable,
      migration,
      proof,
      recovery,
      // 第二轮只加字段：可执行义务（该方法在旧协议下哪些义务无法被执行）与升级计划。
      // daemon/server.mjs:1424-1431 把 error.data 原样 spread 进 BridgeError，因此这两个
      // 字段会随 RPC 错误帧到达 CLI / SDK / MCP 调用方。
      obligations: obligationGap,
      upgradePlan,
    }),
  });
}

/**
 * 同上，但拒绝时抛错（错误对象带 code/data，可直接交给 daemon/MCP 的错误序列化）。
 * 供需要“硬拒绝”的调用方使用；协议闸门本身保持纯函数，测试不需要连 daemon。
 */
export function assertProtocolCompatible(peer, method, params = {}, compare = compareProtocol) {
  const decision = protocolGate(peer, method, params, compare);
  if (decision.ok) return decision;
  const error = new Error(decision.message);
  error.code = decision.code;
  error.data = decision.data;
  throw error;
}

/** 错误码是否属于特性门拒绝（主码 E_PROTOCOL_UNSUPPORTED 或兼容别名 E_UNSUPPORTED_CAPABILITY）。 */
export function isProtocolUnsupportedCode(code) {
  return PROTOCOL_UNSUPPORTED_ALIASES.includes(String(code || ''));
}

/**
 * 1.8 / 1.9 客户端 × 全量特性门的允许/拒绝矩阵（纯数据，供测试与文档/诊断复用）。
 * @returns {{
 *   versions: string[], baseline: string, current: string,
 *   features: Array<{feature: string, label: string, floor: string, allowed: Object<string, boolean>}>,
 *   matrix: Object<string, Object<string, boolean>>,
 *   counts: Object<string, {allowed: number, denied: number}>,
 *   ok: boolean,
 * }}
 */
export function compatibilityMatrix(compare = compareProtocol, versions = COMPAT_PROBE_VERSIONS) {
  const probes = [...versions].map((version) => String(version));
  const matrix = {};
  for (const version of probes) matrix[version] = {};
  const features = FEATURE_NAMES.map((feature) => {
    const floor = FEATURE_MIN_PROTOCOL[feature];
    const allowed = {};
    for (const version of probes) {
      const order = typeof compare === 'function' ? compare(version, floor) : null;
      allowed[version] = order !== null && order >= 0;
      matrix[version][feature] = allowed[version];
    }
    return { feature, label: (FEATURE_META[feature] && FEATURE_META[feature].label) || feature, floor, allowed };
  });
  const counts = {};
  let ok = true;
  for (const version of probes) {
    const values = Object.values(matrix[version]);
    const allowed = values.filter(Boolean).length;
    counts[version] = { allowed, denied: values.length - allowed };
    if (version === PROTOCOL_BASELINE && allowed !== 0) ok = false;
    if (version === PROTOCOL_CURRENT && allowed !== values.length) ok = false;
  }
  return { versions: probes, baseline: PROTOCOL_BASELINE, current: PROTOCOL_CURRENT, features, matrix, counts, ok };
}

export const FEATURE_RECOVERY = '升级浏览器扩展后重试（当前协议 ' + PROTOCOL_CURRENT + '）；旧扩展会静默忽略这些参数，'
  + '所以 daemon 会在派发前用 ' + PROTOCOL_UNSUPPORTED + ' 明确拒绝。';

// ===========================================================================
// 第二轮单入口：可执行义务 / 核验计划 / 兼容矩阵 runner / 升级计划
//
// 这四个函数是纯增量别名：把新模块的能力挂到协议面既有入口旁边，调用方（daemon 闸门、
// CLI、SDK、MCP）不需要额外 import 就能拿到可执行结论；既有导出与语义逐项不变。
// ===========================================================================

/**
 * 执行一次调用的六面义务（pre/post/effect_state/幂等/可重放/恢复）。
 * @param {string} method
 * @param {{context?:object, result?:*, error?:*, effectState?:string, dispatched?:boolean, retryRequested?:boolean}} [evidence]
 */
export function protocolCallObligations(method, evidence = {}) {
  return runCallObligations(method, evidence);
}

/** 成功路径的后置核验计划（哪些事实 RPC 结果能证明、哪些要继续 observe）。 */
export function protocolVerificationPlan(method) {
  return verificationPlan(method);
}

/**
 * 跑兼容矩阵（版本 × 方法 × feature floor）并附单调性报告。
 * @param {object} [options] runCompatibilityMatrix 的输入
 */
export function compatibilityRunner(options = {}) {
  return runCompatibilityMatrix(options);
}

/**
 * 生成升级计划（拒绝路径 data.upgradePlan 的单入口版本）。
 * @param {{protocol?:string}|string|number} peer
 * @param {{features?:string[], calls?:Array, featuresForCall?:Function, to?:string}} [options]
 */
export function protocolUpgradePlan(peer, options = {}) {
  return planUpgradeFrom(peer, options);
}

// ===========================================================================
// 批量视图：闸门矩阵与可执行协商计划
//
// 这两个函数是“只读汇总”，不引入新事实：
//   - gateMatrix：版本 × 方法 的放行矩阵 + 单调性（更高协议不应丢失能力）；
//   - negotiationPlan：把 negotiate() 的结论翻译成调用方可以直接执行的计划
//     （直接调用 / 降级调用 / 必须升级），并附上降级后的后置校验。
// ===========================================================================

/**
 * 版本 × 方法的放行矩阵。
 * @param {string[]} [versions]
 * @param {string[]} [methods]
 * @returns {{
 *   versions:string[], methods:string[], rows:Array<{method:string, floor:string|null, cells:Object<string,boolean>}>,
 *   counts:Object<string,{allowed:number,denied:number}>, monotonic:boolean, violations:Array<object>,
 * }}
 */
export function gateMatrix(versions = COMPAT_PROBE_VERSIONS, methods = METHOD_NAMES, compare = compareProtocol) {
  const probes = [...versions].map((version) => String(version));
  const rows = methods.map((method) => {
    const cells = {};
    for (const version of probes) {
      cells[version] = protocolGate({ protocol: version }, method, {}, compare).ok;
    }
    const allowed = Object.values(cells).filter(Boolean).length;
    return Object.freeze({
      method,
      floor: floorDecision(method, {}, compare).floor,
      cells: Object.freeze(cells),
      allowed,
      anyAllowed: allowed > 0,
      allAllowed: allowed === probes.length,
    });
  });
  const counts = {};
  for (const version of probes) {
    const allowed = rows.filter((row) => row.cells[version]).length;
    counts[version] = Object.freeze({ allowed, denied: rows.length - allowed });
  }
  // 单调性：只比较可解析且同 major 的版本；更高 minor 不应丢失已放行的能力。
  const sorted = [...new Set(probes)].filter((version) => compare(version, PROTOCOL_BASELINE) !== null)
    .sort((a, b) => (compare(a, b) || 0));
  const violations = [];
  for (const row of rows) {
    for (let index = 0; index < sorted.length; index += 1) {
      if (!row.cells[sorted[index]]) continue;
      for (let later = index + 1; later < sorted.length; later += 1) {
        if (!row.cells[sorted[later]]) {
          violations.push(Object.freeze({ method: row.method, allowedAt: sorted[index], deniedAt: sorted[later] }));
        }
      }
    }
  }
  return Object.freeze({
    versions: Object.freeze(probes),
    methods: Object.freeze([...methods]),
    rows: Object.freeze(rows),
    counts: Object.freeze(counts),
    monotonic: violations.length === 0,
    violations: Object.freeze(violations),
  });
}

/**
 * 可执行协商计划：对每个调用给出 verdict + 推荐调用 + 步骤 + 后置校验。
 * 这是 CLI/MCP 在“协议不兼容”时可以直接展示/执行的结构（不再自己拼文案）。
 * @returns {{
 *   peer:string, verdict:string, ok:boolean,
 *   plans:Array<{method, verdict:'allowed'|'degraded'|'blocked', recommendedCall, droppedParams,
 *                verification, postconditions, steps, reason, missing}>,
 *   blocked:Array, degraded:Array, steps:Array, summary:string,
 * }}
 */
export function negotiationPlan(peer, request = {}, compare = compareProtocol) {
  const inputCalls = Array.isArray(request && request.calls)
    ? request.calls
    : (request && request.method ? [request] : []);
  const negotiated = negotiate(peer, request, compare);
  const plans = negotiated.calls.map((call, index) => {
    const proof = call.proof;
    const postconditions = proof ? [...proof.post] : [];
    if (call.ok) {
      return Object.freeze({
        method: call.method,
        verdict: 'allowed',
        recommendedCall: Object.freeze({ method: call.method, params: Object.freeze({ ...(inputCalls[index] && inputCalls[index].params || {}) }) }),
        droppedParams: Object.freeze([]),
        verification: null,
        postconditions: Object.freeze(postconditions),
        steps: Object.freeze(['直接调用 ' + call.method + '（对端满足全部特性门）']),
        reason: null,
        missing: Object.freeze([]),
      });
    }
    const degradation = call.degradation;
    if (degradation && degradation.degradable && degradation.degraded) {
      const verification = degradation.degraded.verification;
      const steps = [
        '改用降级调用 ' + degradation.degraded.method
          + (degradation.degraded.droppedParams.length ? '（去掉参数 ' + degradation.degraded.droppedParams.join('/') + '）' : ''),
        '按降级语义接受能力损失：' + (degradation.items.map((item) => item.fallback && item.fallback.note).filter(Boolean).join('；') || degradation.note),
      ];
      if (verification) steps.push('调用后用 ' + verification.method + ' 自行核对结果（旧扩展不会执行新断言）');
      return Object.freeze({
        method: call.method,
        verdict: 'degraded',
        recommendedCall: Object.freeze({ method: degradation.degraded.method, params: degradation.degraded.params }),
        droppedParams: degradation.degraded.droppedParams,
        verification: degradation.degraded.verification,
        postconditions: Object.freeze(postconditions),
        steps: Object.freeze(steps),
        reason: degradation.note,
        missing: Object.freeze(call.decision.missing.map((item) => item.feature)),
      });
    }
    const missing = call.decision.missing.map((item) => item.feature);
    const steps = missing.map((feature) => FEATURE_MIGRATION[feature] || ('需要协议 ' + FEATURE_MIN_PROTOCOL[feature]));
    for (const step of PROTOCOL_MIGRATION_STEPS) if (!steps.includes(step)) steps.push(step);
    return Object.freeze({
      method: call.method,
      verdict: 'blocked',
      recommendedCall: null,
      droppedParams: Object.freeze([]),
      verification: null,
      postconditions: Object.freeze(postconditions),
      steps: Object.freeze(steps),
      reason: degradation ? degradation.note : '缺失特性没有可执行降级',
      missing: Object.freeze(missing),
    });
  });
  const blocked = plans.filter((plan) => plan.verdict === 'blocked');
  const degraded = plans.filter((plan) => plan.verdict === 'degraded');
  const aggregated = [];
  for (const plan of plans) for (const step of plan.steps) if (!aggregated.includes(step)) aggregated.push(step);
  return Object.freeze({
    peer: negotiated.peer,
    verdict: negotiated.verdict,
    ok: negotiated.ok,
    plans: Object.freeze(plans),
    blocked: Object.freeze(blocked),
    degraded: Object.freeze(degraded),
    steps: Object.freeze(aggregated),
    summary: negotiated.ok
      ? '协议兼容：' + plans.length + ' 个调用可直接执行'
      : blocked.length
        ? '协议不兼容：' + blocked.length + ' 个调用无法降级，必须升级组件（缺口 ' + [...new Set(blocked.flatMap((plan) => plan.missing))].join('、') + '）'
        : '协议降级：' + degraded.length + ' 个调用需按降级计划执行',
  });
}
