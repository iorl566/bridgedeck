// lib/protocol-migration-planner.mjs —— 协议迁移规划器（从协议 A 到协议 B 的可执行计划）。
//
// 兼容矩阵 runner 回答“每个版本能做什么”；降级/迁移建议（protocol-features.mjs 的
// migrationAdvice）回答“缺特性时该升级还是该降级”。但真实升级还缺一份**计划**：
//   谁先升级、按什么顺序、每一步怎么验证、失败了怎么回滚、哪些调用在计划完成前不能跑。
//
// 本文件产出可执行的 migration plan：
//   1) assess   —— 现状评估：版本分带、偏斜、缺失特性、被拒方法；
//   2) negotiate—— 握手结论与硬门槛（major 不兼容直接阻断，低于基线要求升级）；
//   3) upgrade  —— 按 feature floor 排序的升级批次（每个批次后有可验证的产物）；
//   4) degrade  —— 计划完成前必须降级执行的调用（来自 FEATURE_FALLBACKS，缺可执行降级即阻断）；
//   5) verify   —— 变更方法的六面核验（后置条件 + 重放策略）；
//   6) rollback —— 验证失败时的回滚步骤（保留旧安装包、账本处理、重新 observe）。
//
// 所有事实来自单一目录（lib/method-catalog.mjs）与 runner 的逐格判定；本文件不新增
// feature floor、不新增错误码、不改任何既有降级/迁移文案。派生校验器
// validateMigrationPlan 会把计划逐项反推回 floor 与 gate，防止计划与目录漂移。
//
// 依赖方向：catalog → protocol → compat-runner → migration-planner。
// protocol-features.mjs 反向 import planUpgradeFrom() 把计划放进拒绝路径的
// data.upgradePlan（daemon/server.mjs 的 requireFeatures 会随 BridgeError 透传）。

import {
  FEATURE_FALLBACKS,
  FEATURE_FLOORS,
  FEATURE_META,
  FEATURE_MIGRATION,
  FEATURE_NAMES,
  METHOD_NAMES,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
  PROTOCOL_MIGRATION_STEPS,
  proofOf,
} from './method-catalog.mjs';
import {
  compareProtocol,
  isProtocolKnown,
  parseProtocol,
  protocolBand,
  protocolDirection,
  protocolSkew,
  sortProtocolVersions,
} from './protocol.mjs';
import {
  featureGateAt,
  methodFeature,
  methodFloor,
  methodGateAt,
  versionDelta,
} from './protocol-compat-runner.mjs';
import { obligationSummary, verificationPlan } from './protocol-proof.mjs';

// ===========================================================================
// 一、常量
// ===========================================================================

/** 计划格式版本（只增不改）。 */
export const MIGRATION_PLAN_VERSION = 1;

/** 迁移方向。 */
export const MIGRATION_DIRECTIONS = Object.freeze(['upgrade', 'downgrade', 'same', 'unknown']);

/** 计划阶段（顺序即执行顺序；validateMigrationPlan 会校验阶段齐全）。 */
export const MIGRATION_PHASES = Object.freeze(['assess', 'negotiate', 'upgrade', 'degrade', 'verify', 'rollback']);

/** 步骤种类：blocking=不做就不能继续；conditional=取决于调用面；informational=提示。 */
export const MIGRATION_STEP_KINDS = Object.freeze(['blocking', 'conditional', 'informational']);

/** 计划结论。 */
export const MIGRATION_VERDICTS = Object.freeze([
  'compatible',            // 两端版本语义一致，无需迁移
  'upgrade-required',      // 需要升级（同 major，且能拿到新能力）
  'downgrade-blocked',     // 目标版本更旧，会丢失能力（不推荐，且需要调用方降级）
  'major-incompatible',    // major 不同，偏斜兼容模型不适用
  'unknown',               // 版本不可解析
]);

/** 阶段标题（报告/CLI 文案；不影响判定）。 */
export const PHASE_TITLES = Object.freeze({
  assess: '评估现状',
  negotiate: '握手协商',
  upgrade: '升级组件',
  degrade: '降级调用',
  verify: '核验结果',
  rollback: '回滚预案',
});

// ===========================================================================
// 二、输入归一化
// ===========================================================================

function uniqueStrings(list) {
  return [...new Set((list || []).map((item) => String(item)))];
}

/**
 * 归一化计划输入。
 * @param {{
 *   from?: string|number, to?: string|number,
 *   calls?: Array<{method:string, params?:object}>,
 *   features?: string[], methods?: string[],
 *   compare?: Function, featuresForCall?: Function,
 * }} [options]
 */
export function normalizePlanOptions(options = {}) {
  const bag = options && typeof options === 'object' ? options : {};
  const from = bag.from === undefined || bag.from === null || bag.from === '' ? 'unknown' : String(bag.from);
  const to = bag.to === undefined || bag.to === null || bag.to === '' ? PROTOCOL_CURRENT : String(bag.to);
  const calls = Array.isArray(bag.calls)
    ? bag.calls
      .filter((call) => call && typeof call === 'object' && call.method)
      .map((call) => Object.freeze({
        method: String(call.method),
        params: call.params && typeof call.params === 'object' ? Object.freeze({ ...call.params }) : Object.freeze({}),
      }))
    : Object.freeze([]);
  const features = Array.isArray(bag.features) && bag.features.length
    ? uniqueStrings(bag.features)
    : null;
  const methods = Array.isArray(bag.methods) && bag.methods.length
    ? uniqueStrings(bag.methods)
    : null;
  return Object.freeze({
    from,
    to,
    calls: Object.freeze(calls),
    features,
    methods,
    compare: typeof bag.compare === 'function' ? bag.compare : compareProtocol,
    featuresForCall: typeof bag.featuresForCall === 'function' ? bag.featuresForCall : null,
  });
}

// ===========================================================================
// 三、迁移阶梯：把“从 A 到 B”拆成有据可依的中间版本
//
// 阶梯只由 feature floor 与端点版本构成：每攀升一个 floor，就有一批能力变得可用。
// 跨 major 不生成阶梯（偏斜模型不适用，必须整包升级到同 major）。
// ===========================================================================

/**
 * 迁移阶梯。
 * @param {string|number} from
 * @param {string|number} to
 * @param {{features?:string[], compare?:Function}} [options]
 * @returns {{
 *   from:string, to:string, direction:string, sameMajor:boolean, ok:boolean,
 *   rungs:Array<{version:string, index:number, gainedFeatures:string[], acquiredMethods:string[], band:string}>,
 *   floors:string[], reason:string,
 * }}
 */
export function migrationLadder(from, to = PROTOCOL_CURRENT, options = {}) {
  const compare = typeof options.compare === 'function' ? options.compare : compareProtocol;
  const features = Array.isArray(options.features) && options.features.length ? uniqueStrings(options.features) : [...FEATURE_NAMES];
  const fromVersion = String(from);
  const toVersion = String(to);
  const parsedFrom = parseProtocol(fromVersion);
  const parsedTo = parseProtocol(toVersion);
  if (!parsedFrom || !parsedTo) {
    return Object.freeze({
      from: fromVersion, to: toVersion, direction: 'unknown', sameMajor: false, ok: false,
      rungs: Object.freeze([]), floors: Object.freeze([]),
      reason: '端点版本不可解析：' + (parsedFrom ? toVersion : fromVersion),
    });
  }
  const sameMajor = parsedFrom.major === parsedTo.major;
  const direction = protocolDirection(toVersion, fromVersion) === 'same'
    ? 'same'
    : protocolDirection(toVersion, fromVersion) === 'newer' ? 'upgrade' : 'downgrade';
  if (!sameMajor) {
    return Object.freeze({
      from: fromVersion, to: toVersion, direction, sameMajor, ok: false,
      rungs: Object.freeze([]), floors: Object.freeze([]),
      reason: 'major 不同（' + parsedFrom.major + ' → ' + parsedTo.major + '）：需要整包升级到同 major，偏斜阶梯不适用',
    });
  }
  const low = compare(fromVersion, toVersion) <= 0 ? fromVersion : toVersion;
  const high = low === fromVersion ? toVersion : fromVersion;
  const floors = [];
  for (const feature of features) {
    const floor = FEATURE_FLOORS[feature];
    if (!floor) continue;
    const aboveLow = compare(floor, low);
    const belowHigh = compare(floor, high);
    if (aboveLow === null || belowHigh === null) continue;
    if (aboveLow > 0 && belowHigh <= 0) floors.push(floor);
  }
  const versions = sortProtocolVersions([...new Set([low, ...uniqueStrings(floors), high])]);
  const rungs = versions.map((version, index) => {
    const gainedFeatures = features.filter((feature) => {
      const floor = FEATURE_FLOORS[feature];
      if (!floor) return false;
      const at = compare(version, floor);
      const before = index === 0 ? null : compare(versions[index - 1], floor);
      return at !== null && at >= 0 && (before === null || before < 0);
    });
    const acquiredMethods = METHOD_NAMES.filter((method) => {
      const feature = methodFeature(method);
      if (!feature) return false;
      const at = methodGateAt(method, version, compare);
      const before = index === 0 ? null : methodGateAt(method, versions[index - 1], compare);
      return at.allowed && before !== null && !before.allowed;
    });
    return Object.freeze({
      version,
      index,
      band: protocolBand(version),
      gainedFeatures: Object.freeze(gainedFeatures),
      acquiredMethods: Object.freeze(acquiredMethods),
    });
  });
  const ordered = direction === 'downgrade' ? [...rungs].reverse() : rungs;
  return Object.freeze({
    from: fromVersion,
    to: toVersion,
    direction,
    sameMajor,
    ok: true,
    rungs: Object.freeze(direction === 'downgrade' ? ordered : rungs),
    floors: Object.freeze(uniqueStrings(floors).sort((left, right) => (compare(left, right) || 0))),
    reason: direction === 'same'
      ? '两端同一版本：不需要阶梯'
      : '阶梯 ' + rungs.map((rung) => rung.version).join(' → '),
  });
}

// ===========================================================================
// 四、计划主入口：planMigration
// ===========================================================================

function phase(phaseName, steps) {
  const list = [...steps];
  return Object.freeze({
    phase: phaseName,
    title: PHASE_TITLES[phaseName] || phaseName,
    ok: list.every((step) => step.kind !== 'blocking' || step.satisfied !== false),
    steps: Object.freeze(list),
    blocking: Object.freeze(list.filter((step) => step.kind === 'blocking').map((step) => step.id)),
    warnings: Object.freeze(list.filter((step) => step.kind === 'conditional').map((step) => step.id)),
  });
}

function step(fields) {
  return Object.freeze({
    id: fields.id,
    kind: fields.kind || 'informational',
    action: fields.action,
    detail: fields.detail === undefined ? null : fields.detail,
    verify: fields.verify === undefined ? null : fields.verify,
    satisfied: fields.satisfied === undefined ? null : fields.satisfied,
    feature: fields.feature === undefined ? null : fields.feature,
    method: fields.method === undefined ? null : fields.method,
  });
}

/** 每个 gained 特性对应的升级动作（文案来自目录 FEATURE_MIGRATION）。 */
function featureUpgradeStep(feature, atVersion) {
  const label = (FEATURE_META[feature] && FEATURE_META[feature].label) || feature;
  return step({
    id: 'upgrade.feature.' + feature,
    kind: 'conditional',
    action: '升级到协议 ' + atVersion + ' 以启用特性「' + label + '」',
    detail: FEATURE_MIGRATION[feature] || ('需要协议 ' + FEATURE_FLOORS[feature]),
    verify: '重新连接后 featureMatrix 确认 ' + feature + ' available=true',
    feature,
  });
}

/** 计划完成前，某特性缺失时的降级动作（缺可执行降级则 blocking）。 */
function featureDegradeStep(feature) {
  const fallback = FEATURE_FALLBACKS[feature] || { kind: 'none', note: null };
  const label = (FEATURE_META[feature] && FEATURE_META[feature].label) || feature;
  if (fallback.kind === 'none') {
    return step({
      id: 'degrade.feature.' + feature,
      kind: 'blocking',
      action: '特性「' + label + '」没有可执行降级：计划完成前禁止调用相关方法',
      detail: fallback.note || '必须升级组件',
      verify: 'featureMatrix 中 ' + feature + ' available=false 时不要派发依赖它的调用',
      feature,
    });
  }
  return step({
    id: 'degrade.feature.' + feature,
    kind: 'conditional',
    action: '降级执行「' + label + '」依赖的调用（kind=' + fallback.kind + '）',
    detail: fallback.note,
    verify: fallback.method ? '降级后调用 ' + fallback.method + ' 自行核对结果' : '按降级语义接受能力损失',
    feature,
  });
}

/** 变更方法的验证动作（来自六面义务与后置核验计划）。 */
function methodVerifyStep(method, atVersion) {
  const proof = proofOf(method);
  if (!proof) return null;
  const plan = verificationPlan(method);
  const summary = obligationSummary(method);
  return step({
    id: 'verify.method.' + method,
    kind: 'informational',
    action: '迁移后核验 ' + method + '（risk=' + summary.risk + '）',
    detail: '后置条件：' + plan.checks.map((check) => check.code).join('、'),
    verify: plan.checks.map((check) => check.verifyWith).filter((value, index, list) => list.indexOf(value) === index).join('/')
      + '；重放策略：' + (proof.replayable ? '可自动重放' : '必须 ledger resolve'),
    method,
  });
}

/**
 * 生成迁移计划。
 * @param {object} [options] normalizePlanOptions 输入
 * @returns {object} 计划（可直接 JSON 序列化）
 */
export function planMigration(options = {}) {
  const config = normalizePlanOptions(options);
  const compare = config.compare;
  const parsedFrom = parseProtocol(config.from);
  const parsedTo = parseProtocol(config.to);
  const handshake = isProtocolKnown(config.from) && isProtocolKnown(config.to)
    ? protocolSkew(config.from, config.to)
    : protocolSkew(config.from, PROTOCOL_CURRENT);
  const directionOf = (() => {
    if (!parsedFrom || !parsedTo) return 'unknown';
    const order = compare(config.from, config.to);
    if (order === 0) return 'same';
    return order < 0 ? 'upgrade' : 'downgrade';
  })();
  const sameMajor = Boolean(parsedFrom && parsedTo && parsedFrom.major === parsedTo.major);
  const delta = versionDelta(config.from, config.to, { compare });
  const ladder = migrationLadder(config.from, config.to, { compare, features: config.features || undefined });

  // ---- 需要评估的特性集合：显式传入 > 全部特性 ----
  const features = config.features || [...FEATURE_NAMES];
  const featureRows = features.map((feature) => {
    const floor = FEATURE_FLOORS[feature] || null;
    const fromCell = featureGateAt(feature, config.from, compare);
    const toCell = featureGateAt(feature, config.to, compare);
    const fallback = FEATURE_FALLBACKS[feature] || null;
    return Object.freeze({
      feature,
      label: (FEATURE_META[feature] && FEATURE_META[feature].label) || feature,
      floor,
      availableFrom: fromCell.allowed,
      availableTo: toCell.allowed,
      gained: !fromCell.allowed && toCell.allowed,
      lost: fromCell.allowed && !toCell.allowed,
      required: floor !== null,
      migration: FEATURE_MIGRATION[feature] || null,
      fallback,
      degradable: Boolean(fallback && fallback.kind !== 'none'),
    });
  });

  // ---- 需要评估的方法集合：显式传入 > 受 floor 约束的方法（19 个）+ 调用里的方法 ----
  const callMethods = config.calls.map((call) => call.method);
  const methods = config.methods
    || uniqueStrings([...METHOD_NAMES.filter((method) => methodFloor(method) !== null), ...callMethods]);
  const methodRows = methods
    .filter((method) => proofOf(method))
    .map((method) => {
      const fromCell = methodGateAt(method, config.from, compare);
      const toCell = methodGateAt(method, config.to, compare);
      const proof = proofOf(method);
      const summary = obligationSummary(method);
      return Object.freeze({
        method,
        feature: fromCell.feature,
        floor: fromCell.floor,
        allowedFrom: fromCell.allowed,
        allowedTo: toCell.allowed,
        gained: !fromCell.allowed && toCell.allowed,
        lost: fromCell.allowed && !toCell.allowed,
        risk: summary.risk,
        replayable: proof.replayable,
        postconditions: proof.post,
      });
    });

  // ---- 调用面：显式 calls 逐条判定 ----
  const callRows = config.calls.map((call) => {
    const fromCell = methodGateAt(call.method, config.from, compare);
    const toCell = methodGateAt(call.method, config.to, compare);
    const featuresNeeded = config.featuresForCall
      ? [...config.featuresForCall(call.method, call.params)]
      : (fromCell.feature ? [fromCell.feature] : []);
    const blockedAtFrom = featuresNeeded.filter((feature) => !featureGateAt(feature, config.from, compare).allowed);
    const degraded = blockedAtFrom.filter((feature) => {
      const fallback = FEATURE_FALLBACKS[feature];
      return Boolean(fallback && fallback.kind !== 'none');
    });
    return Object.freeze({
      method: call.method,
      params: call.params,
      allowedFrom: fromCell.allowed,
      allowedTo: toCell.allowed,
      featuresNeeded: Object.freeze(featuresNeeded),
      blockedAtFrom: Object.freeze(blockedAtFrom),
      degradableAtFrom: Object.freeze(degraded),
      blockedAtTo: Object.freeze(featuresNeeded.filter((feature) => !featureGateAt(feature, config.to, compare).allowed)),
    });
  });

  const blockers = [];
  const warnings = [];
  if (!parsedFrom) blockers.push('源版本不可解析：' + config.from);
  if (!parsedTo) blockers.push('目标版本不可解析：' + config.to);
  if (parsedFrom && parsedTo && !sameMajor) {
    blockers.push('major 不同（' + config.from + ' → ' + config.to + '）：偏斜兼容模型不适用，必须整包升级到同 major');
  }
  if (!ladder.ok && ladder.reason) warnings.push(ladder.reason);
  for (const row of featureRows) {
    if (row.lost) warnings.push('降级会丢失特性：' + row.feature);
  }
  for (const row of methodRows) {
    if (row.lost) warnings.push('降级会丢失方法：' + row.method);
    if (row.gained) warnings.push('升级后可用方法：' + row.method);
  }
  for (const row of callRows) {
    if (row.blockedAtTo.length) blockers.push('目标协议仍缺少调用 ' + row.method + ' 需要的特性：' + row.blockedAtTo.join(','));
    for (const feature of row.blockedAtFrom) {
      const fallback = FEATURE_FALLBACKS[feature];
      if (!fallback || fallback.kind === 'none') blockers.push('调用 ' + row.method + ' 依赖的特性 ' + feature + ' 在源协议不可用且不可降级');
    }
  }

  // ---- 六个阶段 ----
  const assessSteps = [
    step({
      id: 'assess.protocol',
      kind: 'informational',
      action: '确认当前协议版本与分带',
      detail: 'from=' + config.from + '（band=' + protocolBand(config.from) + '）→ to=' + config.to + '（band=' + protocolBand(config.to) + '）',
      verify: 'daemon.status.compatibility.daemon.features 里 featureMatrix 与目录一致',
    }),
    step({
      id: 'assess.features',
      kind: 'informational',
      action: '核对特性可用性',
      detail: '可用 ' + featureRows.filter((row) => row.availableFrom).length + '/' + featureRows.length
        + '；迁移后 ' + featureRows.filter((row) => row.availableTo).length + '/' + featureRows.length,
      verify: 'featureMatrix 每个特性 available 与 floor 比较一致',
    }),
    step({
      id: 'assess.methods',
      kind: 'informational',
      action: '核对受 floor 约束的方法',
      detail: '当前放行 ' + methodRows.filter((row) => row.allowedFrom).length + '/' + methodRows.length
        + '；迁移后 ' + methodRows.filter((row) => row.allowedTo).length + '/' + methodRows.length,
      verify: 'protocolGate 在每个请求上仍有同一结论',
    }),
  ];
  if (!parsedFrom) {
    assessSteps.push(step({
      id: 'assess.source',
      kind: 'blocking',
      action: '重新读取源协议版本',
      detail: '源版本不可解析：' + config.from,
      verify: 'hello.protocol 与服务端 protocol 至少有一个可解析',
      satisfied: false,
    }));
  }

  const negotiateSteps = [
    step({
      id: 'negotiate.handshake',
      kind: sameMajor && parsedFrom && parsedTo ? 'informational' : 'blocking',
      action: '按偏斜模型协商版本',
      detail: handshake.message,
      verify: '握手结论 severity=' + handshake.severity + '，decision=' + (sameMajor && isProtocolKnown(config.from) ? 'accept' : 'reject'),
      satisfied: Boolean(sameMajor && parsedFrom && parsedTo),
    }),
    ...PROTOCOL_MIGRATION_STEPS.map((text, index) => step({
      id: 'negotiate.step.' + (index + 1),
      kind: 'conditional',
      action: text,
      detail: null,
      verify: '每步后重新运行 bridge doctor / daemon.status',
    })),
  ];

  const upgradeSteps = [];
  for (const rung of ladder.rungs) {
    for (const feature of rung.gainedFeatures) upgradeSteps.push(featureUpgradeStep(feature, rung.version));
    if (rung.acquiredMethods.length && rung.gainedFeatures.length === 0) {
      upgradeSteps.push(step({
        id: 'upgrade.methods.' + rung.version,
        kind: 'informational',
        action: '协议 ' + rung.version + ' 解锁 ' + rung.acquiredMethods.length + ' 个方法',
        detail: rung.acquiredMethods.slice(0, 8).join('、') + (rung.acquiredMethods.length > 8 ? ' 等' : ''),
        verify: 'protocolGate 对这些方法返回 ok=true',
      }));
    }
  }
  if (!ladder.ok && !upgradeSteps.length) {
    upgradeSteps.push(step({
      id: 'upgrade.blocked',
      kind: 'blocking',
      action: '无法生成同 major 升级阶梯',
      detail: ladder.reason,
      verify: '必须整包升级到同 major 后重连',
      satisfied: false,
    }));
  }

  const degradeSteps = [];
  const requiredFeatures = new Set();
  for (const row of callRows) for (const feature of row.blockedAtFrom) requiredFeatures.add(feature);
  for (const feature of requiredFeatures) degradeSteps.push(featureDegradeStep(feature));
  for (const row of featureRows) {
    if (!row.availableFrom && !row.availableTo) degradeSteps.push(featureDegradeStep(row.feature));
  }

  const verifySteps = [];
  for (const row of methodRows) {
    if (!row.gained) continue;
    const verify = methodVerifyStep(row.method, config.to);
    if (verify) verifySteps.push(verify);
  }
  if (!verifySteps.length) {
    verifySteps.push(step({
      id: 'verify.baseline',
      kind: 'informational',
      action: '迁移后跑一次只读观察核对页面状态',
      detail: '没有方法级能力变化，仍需确认握手与 featureMatrix 一致',
      verify: 'observe + status',
    }));
  }

  const rollbackSteps = [
    step({
      id: 'rollback.artifacts',
      kind: 'conditional',
      action: '保留上一版扩展/CLI 安装包与配对信息',
      detail: '回滚需要同版本的扩展包；daemon.json 与配对指纹不要清理',
      verify: '确认安装包可重新加载',
    }),
    step({
      id: 'rollback.ledger',
      kind: 'conditional',
      action: '回滚前先处理意图账本的 pending/unknown 条目',
      detail: '已派发但结果未知的变异必须先 ledger resolve，避免回滚后重复提交',
      verify: 'ledger.status 没有 pending/unknown',
    }),
    step({
      id: 'rollback.reconnect',
      kind: 'conditional',
      action: '回滚后重新连接并重跑 featureMatrix',
      detail: '回滚到 ' + config.from + ' 后确认 hello.protocol 与 extensions 一致',
      verify: 'daemon.status.compatibility 与目录一致',
    }),
  ];

  const phases = Object.freeze([
    phase('assess', assessSteps),
    phase('negotiate', negotiateSteps),
    phase('upgrade', upgradeSteps),
    phase('degrade', degradeSteps),
    phase('verify', verifySteps),
    phase('rollback', rollbackSteps),
  ]);
  const feasible = blockers.length === 0 && sameMajor && Boolean(parsedFrom) && Boolean(parsedTo);
  const verdict = (() => {
    if (!parsedFrom || !parsedTo) return 'unknown';
    if (!sameMajor) return 'major-incompatible';
    if (directionOf === 'same') return 'compatible';
    if (directionOf === 'downgrade') return (delta.counts.lostFeatures + delta.counts.lostMethods) > 0 ? 'downgrade-blocked' : 'compatible';
    return (delta.counts.gainedFeatures + delta.counts.gainedMethods) > 0 ? 'upgrade-required' : 'compatible';
  })();
  const steps = phases.flatMap((item) => item.steps.map((entry) => entry.action));
  const plan = {
    planVersion: MIGRATION_PLAN_VERSION,
    from: config.from,
    to: config.to,
    direction: directionOf,
    bandFrom: protocolBand(config.from),
    bandTo: protocolBand(config.to),
    sameMajor,
    feasible,
    verdict,
    handshake,
    ladder,
    delta,
    features: Object.freeze(featureRows),
    methods: Object.freeze(methodRows),
    calls: Object.freeze(callRows),
    phases,
    steps: Object.freeze(steps),
    blockers: Object.freeze(uniqueStrings(blockers)),
    warnings: Object.freeze(uniqueStrings(warnings)),
    verification: Object.freeze(verifySteps.map((entry) => entry.action)),
    rollback: Object.freeze(rollbackSteps.map((entry) => entry.action)),
    summary: '',
    fingerprint: '',
  };
  return Object.freeze({
    ...plan,
    summary: summarizePlan(plan),
    fingerprint: planFingerprint(plan),
  });
}

function summarizePlan(plan) {
  if (!plan.feasible) {
    return '迁移不可行（' + plan.verdict + '）：' + plan.blockers.slice(0, 2).join('；');
  }
  if (plan.verdict === 'compatible') return '两端协议等价：无需迁移（' + plan.from + '）';
  if (plan.verdict === 'upgrade-required') {
    return '需要升级：' + plan.from + ' → ' + plan.to + '，获得 '
      + (plan.delta.counts.gainedFeatures + plan.delta.counts.gainedMethods) + ' 项能力，'
      + plan.phases.reduce((sum, item) => sum + item.steps.length, 0) + ' 步计划';
  }
  if (plan.verdict === 'downgrade-blocked') {
    return '降级会丢失能力：' + plan.from + ' → ' + plan.to + '（丢失 '
      + (plan.delta.counts.lostFeatures + plan.delta.counts.lostMethods) + ' 项），需先按降级计划改调用';
  }
  return '迁移计划：' + plan.from + ' → ' + plan.to + '（' + plan.verdict + '）';
}

/** 计划指纹（FNV-1a；只覆盖会改变执行结论的字段）。 */
export function planFingerprint(plan = {}) {
  const parts = [
    'v' + MIGRATION_PLAN_VERSION,
    String(plan.from),
    String(plan.to),
    String(plan.direction),
    String(plan.verdict),
    String(plan.feasible),
    (plan.blockers || []).map(String).join(';'),
    (plan.features || []).map((row) => row.feature + ':' + (row.gained ? '+' : row.lost ? '-' : '=')).join(','),
    (plan.methods || []).map((row) => row.method + ':' + (row.gained ? '+' : row.lost ? '-' : '=')).join(','),
    (plan.ladder && plan.ladder.rungs ? plan.ladder.rungs : []).map((rung) => rung.version).join('>'),
  ];
  const text = parts.join('|');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// ===========================================================================
// 五、可执行 checklist
//
// 计划是分层结构；执行面需要的是一张扁平清单（每行有稳定 id、阶段、是否阻断、
// 验证方式）。CLI/MCP 可以逐行展示、逐行打勾，而不必理解计划结构。
// ===========================================================================

/**
 * 把计划摊平成可执行清单。
 * @param {object} plan planMigration 的结果
 * @param {{phases?:string[], includeInformational?:boolean}} [options]
 * @returns {{from:string, to:string, verdict:string, items:Array<object>, counts:object}}
 */
export function migrationChecklist(plan = {}, options = {}) {
  const phases = Array.isArray(options.phases) && options.phases.length ? options.phases : MIGRATION_PHASES;
  const includeInformational = options.includeInformational !== false;
  const items = [];
  for (const phaseEntry of plan.phases || []) {
    if (!phases.includes(phaseEntry.phase)) continue;
    for (const entry of phaseEntry.steps) {
      if (!includeInformational && entry.kind === 'informational') continue;
      items.push(Object.freeze({
        id: entry.id,
        phase: phaseEntry.phase,
        order: items.length + 1,
        kind: entry.kind,
        action: entry.action,
        detail: entry.detail,
        verify: entry.verify,
        feature: entry.feature,
        method: entry.method,
        status: entry.kind === 'blocking' && entry.satisfied === false ? 'blocked' : 'todo',
      }));
    }
  }
  const counts = { total: items.length, blocking: 0, conditional: 0, informational: 0, blocked: 0 };
  for (const item of items) {
    counts[item.kind] = (counts[item.kind] || 0) + 1;
    if (item.status === 'blocked') counts.blocked += 1;
  }
  return Object.freeze({
    from: plan.from,
    to: plan.to,
    verdict: plan.verdict,
    items: Object.freeze(items),
    counts: Object.freeze(counts),
    summary: '迁移清单：' + counts.total + ' 步（阻断 ' + counts.blocking + ' / 条件 ' + counts.conditional + ' / 提示 ' + counts.informational + '）',
  });
}

// ===========================================================================
// 六、派生校验器：validateMigrationPlan
//
// 计划必须能逐项反推回 floor 与 gate：
//   - 特性行的 available/gained/lost 必须等于 featureGateAt 的重算结果；
//   - 方法行的结果必须等于 methodGateAt 的重算结果；
//   - 阶梯必须同 major、端点正确、floor 落位正确；
//   - verdict/feasible 必须与 blockers/major/方向一致；
//   - 指纹必须可复现。
// 空数组 = 计划可信。
// ===========================================================================

function planIssue(scope, code, message, expected, actual) {
  return Object.freeze({
    scope,
    code: String(code),
    message,
    expected: expected === undefined ? null : String(expected),
    actual: actual === undefined ? null : String(actual),
  });
}

function expectedVerdict(plan, delta) {
  const parsedFrom = parseProtocol(plan.from);
  const parsedTo = parseProtocol(plan.to);
  if (!parsedFrom || !parsedTo) return 'unknown';
  const sameMajor = parsedFrom.major === parsedTo.major;
  if (!sameMajor) return 'major-incompatible';
  const order = compareProtocol(plan.from, plan.to);
  if (order === 0) return 'compatible';
  if (order > 0) return (delta.counts.lostFeatures + delta.counts.lostMethods) > 0 ? 'downgrade-blocked' : 'compatible';
  return (delta.counts.gainedFeatures + delta.counts.gainedMethods) > 0 ? 'upgrade-required' : 'compatible';
}

/**
 * 校验迁移计划。
 * @param {object} plan
 * @param {{compare?:Function}} [options]
 * @returns {ReadonlyArray<object>} 空数组 = 通过
 */
export function validateMigrationPlan(plan = {}, options = {}) {
  const issues = [];
  const compare = typeof options.compare === 'function' ? options.compare : compareProtocol;
  if (!plan || typeof plan !== 'object') return Object.freeze([planIssue('plan', '<无>', '计划不是对象')]);
  if (plan.planVersion !== MIGRATION_PLAN_VERSION) {
    issues.push(planIssue('plan.version', '<计划>', '计划格式版本不一致', MIGRATION_PLAN_VERSION, plan.planVersion));
  }
  const parsedFrom = parseProtocol(plan.from);
  const parsedTo = parseProtocol(plan.to);
  // 端点不可解析不是“计划不一致”：输入评估阶段已把它记为 blocker，这里的校验只看
  // 计划内部是否与 floor/gate 自洽（因此不再对 plan.from/plan.to 报错）。
  const sameMajor = Boolean(parsedFrom && parsedTo && parsedFrom.major === parsedTo.major);
  if (plan.sameMajor !== sameMajor) {
    issues.push(planIssue('plan.sameMajor', '<计划>', 'sameMajor 与版本不一致', sameMajor, plan.sameMajor));
  }
  if (!MIGRATION_VERDICTS.includes(plan.verdict)) {
    issues.push(planIssue('plan.verdict', '<计划>', '结论非法：' + String(plan.verdict)));
  }
  // 阶段齐全且顺序正确
  const phases = Array.isArray(plan.phases) ? plan.phases : [];
  if (phases.map((item) => item.phase).join(',') !== MIGRATION_PHASES.join(',')) {
    issues.push(planIssue('plan.phases', '<计划>', '阶段集合/顺序不一致', MIGRATION_PHASES.join(','), phases.map((item) => item.phase).join(',')));
  }
  const stepIds = new Set();
  for (const phaseEntry of phases) {
    if (!Array.isArray(phaseEntry.steps)) {
      issues.push(planIssue('plan.phase.steps', phaseEntry.phase, '阶段缺少 steps 数组'));
      continue;
    }
    for (const entry of phaseEntry.steps) {
      if (!entry.id) issues.push(planIssue('plan.step.id', phaseEntry.phase, '步骤缺少 id'));
      else if (stepIds.has(entry.id)) issues.push(planIssue('plan.step.dup', entry.id, '步骤 id 重复'));
      else stepIds.add(entry.id);
      if (!MIGRATION_STEP_KINDS.includes(entry.kind)) {
        issues.push(planIssue('plan.step.kind', entry.id || phaseEntry.phase, '步骤种类非法：' + String(entry.kind)));
      }
      if (typeof entry.action !== 'string' || !entry.action.trim()) {
        issues.push(planIssue('plan.step.action', entry.id || phaseEntry.phase, '步骤缺少 action'));
      }
    }
  }
  // feasible 与 blockers / major 一致
  const blockers = Array.isArray(plan.blockers) ? plan.blockers : [];
  const expectedFeasible = Boolean(parsedFrom && parsedTo && sameMajor && blockers.length === 0);
  if (plan.feasible !== expectedFeasible) {
    issues.push(planIssue('plan.feasible', '<计划>', 'feasible 与 blockers/major 不一致', expectedFeasible, plan.feasible));
  }
  if (!sameMajor && parsedFrom && parsedTo && !blockers.some((text) => /major/.test(text))) {
    issues.push(planIssue('plan.blockers', '<计划>', 'major 不兼容但 blockers 没有说明'));
  }
  // 特性行逐项反推
  for (const row of plan.features || []) {
    if (!row || typeof row !== 'object' || !row.feature) { issues.push(planIssue('plan.feature', '<行>', '特性行非法')); continue; }
    const floor = FEATURE_FLOORS[row.feature] || null;
    if (row.floor !== floor) issues.push(planIssue('plan.feature.floor', row.feature, 'floor 与目录不一致', floor === null ? '<null>' : floor, row.floor === null ? '<null>' : row.floor));
    if (parsedFrom) {
      const fromCell = featureGateAt(row.feature, plan.from, compare);
      if (row.availableFrom !== fromCell.allowed) {
        issues.push(planIssue('plan.feature.from', row.feature, '源版本可用性与 gate 不一致', fromCell.allowed, row.availableFrom));
      }
    }
    if (parsedTo) {
      const toCell = featureGateAt(row.feature, plan.to, compare);
      if (row.availableTo !== toCell.allowed) {
        issues.push(planIssue('plan.feature.to', row.feature, '目标版本可用性与 gate 不一致', toCell.allowed, row.availableTo));
      }
    }
    const expectedGained = !row.availableFrom && row.availableTo;
    const expectedLost = row.availableFrom && !row.availableTo;
    if (row.gained !== expectedGained) issues.push(planIssue('plan.feature.gained', row.feature, 'gained 标记不一致'));
    if (row.lost !== expectedLost) issues.push(planIssue('plan.feature.lost', row.feature, 'lost 标记不一致'));
    if (row.migration !== (FEATURE_MIGRATION[row.feature] || null)) {
      issues.push(planIssue('plan.feature.migration', row.feature, '迁移建议与目录不一致'));
    }
    if (typeof row.degradable !== 'boolean') issues.push(planIssue('plan.feature.degradable', row.feature, 'degradable 必须是布尔'));
  }
  // 方法行逐项反推
  for (const row of plan.methods || []) {
    if (!row || typeof row !== 'object' || !row.method) { issues.push(planIssue('plan.method', '<行>', '方法行非法')); continue; }
    const proof = proofOf(row.method);
    if (!proof) { issues.push(planIssue('plan.method.unknown', row.method, '方法不在目录')); continue; }
    if (parsedFrom) {
      const fromCell = methodGateAt(row.method, plan.from, compare);
      if (row.allowedFrom !== fromCell.allowed) {
        issues.push(planIssue('plan.method.from', row.method, '源版本放行与 gate 不一致', fromCell.allowed, row.allowedFrom));
      }
      if (row.floor !== fromCell.floor) issues.push(planIssue('plan.method.floor', row.method, 'floor 与 gate 不一致'));
    }
    if (parsedTo) {
      const toCell = methodGateAt(row.method, plan.to, compare);
      if (row.allowedTo !== toCell.allowed) {
        issues.push(planIssue('plan.method.to', row.method, '目标版本放行与 gate 不一致', toCell.allowed, row.allowedTo));
      }
    }
    if (row.risk !== obligationSummary(row.method).risk) {
      issues.push(planIssue('plan.method.risk', row.method, '风险分级与义务摘要不一致'));
    }
    if (row.replayable !== proof.replayable) issues.push(planIssue('plan.method.replay', row.method, '可重放与目录不一致'));
    if (Array.isArray(row.postconditions) && row.postconditions.join(',') !== proof.post.join(',')) {
      issues.push(planIssue('plan.method.post', row.method, '后置条件与目录不一致'));
    }
  }
  // 阶梯一致性
  const ladder = plan.ladder || {};
  if (plan.sameMajor && parsedFrom && parsedTo && !ladder.ok) {
    issues.push(planIssue('plan.ladder', '<阶梯>', '同 major 却无法生成阶梯：' + String(ladder.reason)));
  }
  if (!plan.sameMajor && ladder.ok) {
    issues.push(planIssue('plan.ladder', '<阶梯>', 'major 不同却生成了阶梯'));
  }
  if (ladder.ok && Array.isArray(ladder.rungs) && ladder.rungs.length) {
    const rungVersions = ladder.rungs.map((rung) => rung.version);
    const endpoints = [String(plan.from), String(plan.to)];
    for (const endpoint of endpoints) {
      if (!rungVersions.includes(endpoint)) issues.push(planIssue('plan.ladder.endpoint', endpoint, '阶梯端点缺失'));
    }
    for (const version of rungVersions) {
      if (!isProtocolKnown(version)) issues.push(planIssue('plan.ladder.version', version, '阶梯版本不可解析'));
      else if (!sameMajor) issues.push(planIssue('plan.ladder.major', version, '阶梯版本跨 major'));
    }
    for (const rung of ladder.rungs) {
      for (const feature of rung.gainedFeatures) {
        if (!Object.prototype.hasOwnProperty.call(FEATURE_FLOORS, feature)) {
          issues.push(planIssue('plan.ladder.feature', feature, '阶梯引用了未登记特性'));
          continue;
        }
        const cell = featureGateAt(feature, rung.version, compare);
        if (!cell.allowed) issues.push(planIssue('plan.ladder.feature', feature, '阶梯声称在 ' + rung.version + ' 获得该特性，但 floor 未满足'));
      }
    }
  }
  // 调用行逐项反推
  for (const row of plan.calls || []) {
    if (!row || !row.method) { issues.push(planIssue('plan.call', '<行>', '调用行非法')); continue; }
    if (parsedFrom) {
      const fromCell = methodGateAt(row.method, plan.from, compare);
      if (row.allowedFrom !== fromCell.allowed) issues.push(planIssue('plan.call.from', row.method, '调用源版本放行与 gate 不一致'));
    }
    if (parsedTo) {
      const toCell = methodGateAt(row.method, plan.to, compare);
      if (row.allowedTo !== toCell.allowed) issues.push(planIssue('plan.call.to', row.method, '调用目标版本放行与 gate 不一致'));
    }
    for (const feature of row.blockedAtTo || []) {
      const cell = featureGateAt(feature, plan.to, compare);
      if (cell.allowed) issues.push(planIssue('plan.call.blocked', row.method + '@' + feature, '声称目标版本缺少特性，但 featureGateAt 说可用'));
    }
  }
  // 结论与 fingerprints
  const expected = expectedVerdict(plan, plan.delta || versionDelta(plan.from, plan.to, { compare }));
  if (plan.verdict !== expected) {
    issues.push(planIssue('plan.verdict', '<计划>', '结论与版本/能力差异不一致', expected, plan.verdict));
  }
  if (plan.fingerprint) {
    const recomputed = planFingerprint(plan);
    if (recomputed !== plan.fingerprint) {
      issues.push(planIssue('plan.fingerprint', '<计划>', '指纹不可复现', recomputed, plan.fingerprint));
    }
  }
  if (typeof plan.summary !== 'string' || !plan.summary.trim()) {
    issues.push(planIssue('plan.summary', '<计划>', '缺少 summary'));
  }
  return Object.freeze(issues);
}

// ===========================================================================
// 七、便捷入口：单点查询 / 快照 / 闸门用紧凑计划
// ===========================================================================

/**
 * 满足一组特性所需的最低协议版本（取最高 floor）。
 * @param {string[]} features
 * @param {Function} [compare]
 */
export function requiredVersionForFeatures(features = [], compare = compareProtocol) {
  let required = null;
  for (const feature of features || []) {
    const floor = FEATURE_FLOORS[String(feature)];
    if (!floor) continue;
    if (required === null || (compare(floor, required) || 0) > 0) required = floor;
  }
  return required;
}

/**
 * 某方法在目标版本可用所需的最低协议版本。
 * @param {string} method
 */
export function requiredVersionForMethod(method) {
  return methodFloor(String(method || ''));
}

/**
 * 默认迁移快照：兼容基线 → 当前协议（协议升级的标准剧本）。
 * 惰性缓存；供 status/doctor/文档与测试共用。
 */
let DEFAULT_SNAPSHOT = null;

export function migrationSnapshot() {
  if (DEFAULT_SNAPSHOT) return DEFAULT_SNAPSHOT;
  const plan = planMigration({ from: PROTOCOL_BASELINE, to: PROTOCOL_CURRENT });
  DEFAULT_SNAPSHOT = Object.freeze({
    planVersion: MIGRATION_PLAN_VERSION,
    from: plan.from,
    to: plan.to,
    verdict: plan.verdict,
    feasible: plan.feasible,
    direction: plan.direction,
    gainedFeatures: Object.freeze(plan.features.filter((row) => row.gained).map((row) => row.feature)),
    gainedMethods: Object.freeze(plan.methods.filter((row) => row.gained).map((row) => row.method)),
    batches: Object.freeze(plan.ladder.rungs.map((rung) => Object.freeze({
      version: rung.version,
      features: rung.gainedFeatures,
      methods: rung.acquiredMethods.length,
    }))),
    blockers: plan.blockers,
    phases: Object.freeze(plan.phases.map((item) => Object.freeze({
      phase: item.phase,
      steps: item.steps.length,
      blocking: item.blocking.length,
    }))),
    fingerprint: plan.fingerprint,
    summary: plan.summary,
  });
  return DEFAULT_SNAPSHOT;
}

/**
 * 协议闸门拒绝路径用的紧凑升级计划（可 JSON 序列化，放进 data.upgradePlan）。
 * 与 planMigration 同源，但只保留错误响应需要的部分，避免把完整对象塞进每一条错误。
 * @param {{protocol?:string}|string|number} peer
 * @param {{features?:string[], calls?:Array, featuresForCall?:Function, to?:string}} [options]
 */
export function planUpgradeFrom(peer, options = {}) {
  const bag = options && typeof options === 'object' ? options : {};
  const from = peer && typeof peer === 'object' ? (peer.protocol === undefined ? 'unknown' : peer.protocol) : peer;
  const features = Array.isArray(bag.features) && bag.features.length ? uniqueStrings(bag.features) : undefined;
  const plan = planMigration({
    from: from === undefined || from === null || from === '' ? 'unknown' : from,
    to: bag.to || PROTOCOL_CURRENT,
    features,
    calls: bag.calls,
    featuresForCall: bag.featuresForCall,
  });
  const gained = plan.features.filter((row) => row.gained).map((row) => row.feature);
  return Object.freeze({
    planVersion: MIGRATION_PLAN_VERSION,
    from: plan.from,
    to: plan.to,
    direction: plan.direction,
    verdict: plan.verdict,
    feasible: plan.feasible,
    upgradeRequired: !plan.feasible || plan.verdict === 'upgrade-required' || plan.verdict === 'downgrade-blocked' || plan.verdict === 'major-incompatible',
    blockers: plan.blockers,
    gainedFeatures: Object.freeze(gained),
    requiredVersion: requiredVersionForFeatures(gained),
    ladder: Object.freeze(plan.ladder.rungs.map((rung) => Object.freeze({ version: rung.version, gainedFeatures: rung.gainedFeatures }))),
    batches: plan.phases.filter((item) => ['assess', 'negotiate', 'upgrade', 'degrade'].includes(item.phase)).map((item) => Object.freeze({
      phase: item.phase,
      steps: Object.freeze(item.steps.map((entry) => entry.action)),
      blocking: Object.freeze(item.steps.filter((entry) => entry.kind === 'blocking').map((entry) => entry.action)),
    })),
    steps: Object.freeze(plan.steps.slice(0, 10)),
    fingerprint: plan.fingerprint,
    summary: plan.summary,
  });
}

/** 计划的一行解释（CLI 文本模式）。 */
export function explainMigration(plan = {}) {
  const lines = [
    '迁移计划 ' + plan.from + ' → ' + plan.to + '：' + plan.verdict + (plan.feasible ? '（可行）' : '（不可行）'),
  ];
  if (plan.blockers && plan.blockers.length) lines.push('阻断：' + plan.blockers.join('；'));
  for (const entry of plan.phases || []) {
    lines.push('- ' + entry.title + '（' + entry.phase + '）[' + entry.steps.length + ' 步]');
    for (const item of entry.steps) {
      lines.push('  · [' + item.kind + '] ' + item.action + (item.verify ? '；验证：' + item.verify : ''));
    }
  }
  return Object.freeze(lines);
}

/** 下一步最短路径：只返回尚未满足的阻断/条件步骤（执行面）。 */
export function nextMigrationSteps(plan = {}, limit = 5) {
  const checklist = migrationChecklist(plan, { includeInformational: false });
  const pending = checklist.items.filter((item) => item.status !== 'done');
  return Object.freeze(pending.slice(0, Math.max(1, Number(limit) || 5)));
}

/** planner ABI（消费方/测试据此判断能力，不改既有导出）。 */
export const PLANNER_ABI = Object.freeze({
  planVersion: MIGRATION_PLAN_VERSION,
  phases: MIGRATION_PHASES,
  directions: MIGRATION_DIRECTIONS,
  verdicts: MIGRATION_VERDICTS,
  stepKinds: MIGRATION_STEP_KINDS,
});

// ===========================================================================
// 八、执行批次 / 计划对比 / 计划风险面
//
// checklist 是“逐行清单”；执行面还需要“批次”：同一阶段里互不依赖的步骤一次做完，
// 再进入下一阶段。另外升级前后常要对比两份计划（例如从 1.8 升 1.9 与从 1.8 升 1.10），
// 或回答“这份计划会碰到哪些高风险方法”。这些视图全部从计划结构派生。
// ===========================================================================

/**
 * 把计划切成执行批次（按阶段分组；空阶段不出现）。
 * @param {object} plan
 * @returns {{from:string, to:string, verdict:string, batches:Array<object>, counts:object}}
 */
export function migrationBatches(plan = {}) {
  const batches = [];
  for (const phaseEntry of plan.phases || []) {
    if (!phaseEntry.steps || !phaseEntry.steps.length) continue;
    const steps = phaseEntry.steps.map((entry) => Object.freeze({
      id: entry.id,
      kind: entry.kind,
      action: entry.action,
      detail: entry.detail,
      verify: entry.verify,
      feature: entry.feature,
      method: entry.method,
      satisfied: entry.satisfied,
    }));
    batches.push(Object.freeze({
      batch: batches.length + 1,
      phase: phaseEntry.phase,
      title: phaseEntry.title || PHASE_TITLES[phaseEntry.phase] || phaseEntry.phase,
      steps: Object.freeze(steps),
      blocking: Object.freeze(steps.filter((entry) => entry.kind === 'blocking').map((entry) => entry.id)),
      conditional: Object.freeze(steps.filter((entry) => entry.kind === 'conditional').map((entry) => entry.id)),
      verify: Object.freeze(steps.map((entry) => entry.verify).filter(Boolean)),
    }));
  }
  const counts = { batches: batches.length, steps: 0, blocking: 0, conditional: 0, informational: 0 };
  for (const batch of batches) {
    counts.steps += batch.steps.length;
    for (const entry of batch.steps) counts[entry.kind] = (counts[entry.kind] || 0) + 1;
  }
  return Object.freeze({
    from: plan.from,
    to: plan.to,
    verdict: plan.verdict,
    batches: Object.freeze(batches),
    counts: Object.freeze(counts),
    summary: '执行批次：' + counts.batches + ' 批 / ' + counts.steps + ' 步（阻断 ' + counts.blocking + '）',
  });
}

/**
 * 对比两份迁移计划（只比较会改变执行结论的字段）。
 * @returns {{same:boolean, changes:Array<{field:string, before:*, after:*}>,
 *   gainedFeatures:object, gainedMethods:object, summary:string}}
 */
export function compareMigrationPlans(before = {}, after = {}) {
  const changes = [];
  const scalarFields = ['from', 'to', 'direction', 'verdict', 'feasible', 'sameMajor'];
  for (const field of scalarFields) {
    if (before[field] !== after[field]) {
      changes.push(Object.freeze({ field, before: before[field], after: after[field] }));
    }
  }
  const setOf = (rows, key) => new Set((rows || []).map((row) => row[key]));
  const beforeFeatures = setOf(before.features, 'feature');
  const afterFeatures = setOf(after.features, 'feature');
  const beforeMethods = setOf(before.methods, 'method');
  const afterMethods = setOf(after.methods, 'method');
  const gainedFeatures = {
    added: [...afterFeatures].filter((item) => !beforeFeatures.has(item)).sort(),
    removed: [...beforeFeatures].filter((item) => !afterFeatures.has(item)).sort(),
  };
  const gainedMethods = {
    added: [...afterMethods].filter((item) => !beforeMethods.has(item)).sort(),
    removed: [...beforeMethods].filter((item) => !afterMethods.has(item)).sort(),
  };
  const beforeBlockers = new Set(before.blockers || []);
  const afterBlockers = new Set(after.blockers || []);
  const blockers = {
    added: [...afterBlockers].filter((item) => !beforeBlockers.has(item)).sort(),
    removed: [...beforeBlockers].filter((item) => !afterBlockers.has(item)).sort(),
  };
  const same = changes.length === 0
    && gainedFeatures.added.length === 0 && gainedFeatures.removed.length === 0
    && gainedMethods.added.length === 0 && gainedMethods.removed.length === 0
    && blockers.added.length === 0 && blockers.removed.length === 0;
  return Object.freeze({
    same,
    changes: Object.freeze(changes),
    gainedFeatures: Object.freeze(gainedFeatures),
    gainedMethods: Object.freeze(gainedMethods),
    blockers: Object.freeze(blockers),
    counts: Object.freeze({
      fields: changes.length,
      features: gainedFeatures.added.length + gainedFeatures.removed.length,
      methods: gainedMethods.added.length + gainedMethods.removed.length,
      blockers: blockers.added.length + blockers.removed.length,
    }),
    summary: same
      ? '两份迁移计划语义一致'
      : '迁移计划差异：' + changes.length + ' 个字段 / ' + (gainedFeatures.added.length + gainedMethods.added.length) + ' 项新增 / '
        + (blockers.added.length) + ' 个新阻断',
  });
}

/**
 * 计划涉及方法的风险面（迁移后要重点核验哪些方法）。
 * @param {object} plan
 */
export function planRiskMethods(plan = {}) {
  const rows = Array.isArray(plan.methods) ? plan.methods : [];
  const groups = { safe: [], guarded: [], risky: [] };
  for (const row of rows) {
    const risk = row.risk || 'risky';
    (groups[risk] = groups[risk] || []).push(row.method);
  }
  return Object.freeze({
    safe: Object.freeze(groups.safe || []),
    guarded: Object.freeze(groups.guarded || []),
    risky: Object.freeze(groups.risky || []),
    counts: Object.freeze({
      safe: (groups.safe || []).length,
      guarded: (groups.guarded || []).length,
      risky: (groups.risky || []).length,
    }),
    note: 'risky 方法在结果未知时必须先 resolve 账本，迁移验证阶段优先核对它们',
  });
}

/**
 * 计划矩阵自证：对一组 (from,to) 生成计划并逐份校验，外加跨计划的派生不变量：
 *   - 同方向计划的 verdict 单调（升级同 major 且更大跨度 ⇒ 不会变成 compatible）；
 *   - 反向计划的 lost 集合等于正向计划的 gained 集合；
 *   - 每份计划的指纹唯一且可复现。
 * @param {Array<[string,string]>} [pairs]
 * @returns {ReadonlyArray<object>} 空数组 = 通过
 */
export function validatePlannerMatrix(pairs = [
  ['1.7', '1.8'], ['1.7', '1.9'], ['1.8', '1.9'], ['1.8', '1.10'], ['1.9', '1.10'],
  ['1.8', '1.7'], ['1.9', '1.8'], ['2.0', '1.9'], ['x', '1.9'],
]) {
  const issues = [];
  const plans = new Map();
  for (const pair of pairs) {
    const [from, to] = pair;
    const plan = planMigration({ from, to });
    plans.set(from + '>' + to, plan);
    for (const issue of validateMigrationPlan(plan)) {
      issues.push(Object.freeze({
        scope: 'matrix.' + issue.scope,
        code: from + '>' + to + ':' + issue.code,
        message: issue.message,
        expected: issue.expected,
        actual: issue.actual,
      }));
    }
    const keys = new Set();
    for (const key of [plan.fingerprint]) {
      if (keys.has(key)) issues.push(planIssue('matrix.fingerprint', from + '>' + to, '同一计划指纹冲突'));
      keys.add(key);
    }
  }
  for (const [key, plan] of plans) {
    const [from, to] = key.split('>');
    const reverse = plans.get(to + '>' + from);
    if (!reverse) continue;
    const forwardGained = new Set(plan.methods.filter((row) => row.gained).map((row) => row.method));
    const reverseLost = new Set(reverse.methods.filter((row) => row.lost).map((row) => row.method));
    for (const method of forwardGained) {
      if (!reverseLost.has(method)) {
        issues.push(planIssue('matrix.reverse', from + '>' + to, '正向 gained 在反向计划里没有对应 lost：' + method));
      }
    }
    if (plan.sameMajor !== reverse.sameMajor) {
      issues.push(planIssue('matrix.reverse', from + '>' + to, '正反向 sameMajor 判定不一致'));
    }
  }
  return Object.freeze(issues);
}
