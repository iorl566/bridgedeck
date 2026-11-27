// lib/protocol.mjs —— 方法效果分类与暂停闸门（CLI/daemon/扩展共享的协议事实）。
//
// 收口后 METHOD_EFFECT 不再手写：它直接引用 lib/method-catalog.mjs 的
// METHOD_EFFECT_TABLE（165 个 canonical 方法 → effect 的单一目录）。本文件只负责
// “怎么判定、怎么报错”：暂停闸门、文件传输远程拒绝、协议版本比较。
//
// 依赖方向是单向的：lib/protocol.mjs → lib/method-catalog.mjs。
// 目录不得反向 import 本文件（否则形成循环，tools/protocol-single-source.mjs 会 fail）。
//
// 方法按副作用分成 passive_read / transient_input / browser_mutation /
// control_plane 四类（目录里另有 read 细分类），暂停时只放行读取面和控制面。
// 同一份分类被 daemon 的路由、意图账本和 CLI/MCP 协议门禁共用，避免多处白名单漂移。

import { FILE_TRANSFER_METHODS, METHOD_EFFECT_TABLE, PROTOCOL_BASELINE, PROTOCOL_CURRENT } from './method-catalog.mjs';

/**
 * canonical 方法 → effect 的运行时表。
 * 键序 = 方法目录顺序 = 生成物 `METHOD_EFFECT` 键序（与收口前手工表逐项一致，
 * 差分基线见 tests/unit/protocol-differential-baseline.mjs）。
 * 对象由目录冻结，运行时不得改写；新增/调整方法的唯一入口是 lib/method-catalog.mjs。
 */
export const METHOD_EFFECT = METHOD_EFFECT_TABLE;

/**
 * 方法效果分类。
 * 未知方法按历史行为默认 browser_mutation（保守：暂停/只读作用域下阻断），
 * 未知方法的 isMutating 默认值由 lib/methods.mjs 维护，与本函数解耦。
 */
export function effectOf(method) {
  return METHOD_EFFECT[method] || 'browser_mutation';
}

/** 暂停（takeover/暂停闸门）期间是否放行：只读面与控制面放行。 */
export function isAllowedWhilePaused(method) {
  const effect = effectOf(method);
  return effect === 'passive_read' || effect === 'control_plane';
}

/** 文件传输依赖 daemon 与浏览器同机路径；远程配对实例必须显式拒绝。 */
export function isFileTransferMethod(method) {
  return FILE_TRANSFER_METHODS.includes(method);
}

export function shouldRejectRemoteTransfer(instance, method) {
  return Boolean(instance && instance.remote === true && isFileTransferMethod(method));
}

/** '1.9' / '1' / 1.9 → {major, minor}；无法解析返回 null（旧客户端不带版本按 unknown 处理）。 */
export function parseProtocol(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    const major = Math.trunc(value);
    return { major, minor: Math.round((value - major) * 10) };
  }
  const match = /^(\d+)(?:\.(\d+))?$/.exec(String(value == null ? '' : value).trim());
  return match ? { major: Number(match[1]), minor: Number(match[2] || 0) } : null;
}

/** 协议版本比较：a>b 正数，a<b 负数，相等 0，任一侧无法解析返回 null。 */
export function compareProtocol(a, b) {
  const pa = parseProtocol(a);
  const pb = parseProtocol(b);
  if (!pa || !pb) return null;
  if (pa.major !== pb.major) return pa.major - pb.major;
  return pa.minor - pb.minor;
}

/** 对端协议是否达到 required 最低版本；任一侧无法解析时返回 null（调用方按拒绝处理）。 */
export function protocolAtLeast(actual, required) {
  const order = compareProtocol(actual, required);
  return order === null ? null : order >= 0;
}

// ===========================================================================
// 协议版本分带 / 偏斜 / 协商判定
//
// 兼容矩阵（lib/protocol-features.mjs）只按 feature floor 比较大小；真实握手还要
// 回答“对端处于哪个年代、skew 有多严重、能不能继续、谁该升级”。这些判定只依赖
// 版本数字本身，仍以 lib/method-catalog.mjs 的 baseline/current 为唯一事实。
// ===========================================================================

/** 协议分带：unknown / legacy（低于基线）/ baseline（兼容基线）/ intermediate（基线~当前之间）/ current / ahead-minor / ahead-major。 */
export const PROTOCOL_BANDS = Object.freeze([
  'unknown', 'legacy', 'baseline', 'intermediate', 'current', 'ahead-minor', 'ahead-major',
]);

/** 协议范围常量（目录别名；运行时不再手写 1.8/1.9）。 */
export const PROTOCOL_RANGE = Object.freeze({ baseline: PROTOCOL_BASELINE, current: PROTOCOL_CURRENT });

/** 版本分带：解析失败 → unknown。 */
export function protocolBand(version) {
  const parsed = parseProtocol(version);
  if (!parsed) return 'unknown';
  const order = compareProtocol(version, PROTOCOL_BASELINE);
  const currentOrder = compareProtocol(version, PROTOCOL_CURRENT);
  if (order === null || currentOrder === null) return 'unknown';
  if (order < 0) return 'legacy';
  if (order === 0) return 'baseline';
  if (currentOrder < 0) return 'intermediate';
  if (currentOrder === 0) return 'current';
  return parsed.major === parseProtocol(PROTOCOL_CURRENT).major ? 'ahead-minor' : 'ahead-major';
}

/** 版本是否可比较（等价于 parseProtocol 成功）。 */
export function isProtocolKnown(version) {
  return parseProtocol(version) !== null;
}

/** 两个版本是否同 major（同 major 的 minor 偏斜是兼容模型的前提）。 */
export function isSameProtocolMajor(a, b) {
  const left = parseProtocol(a);
  const right = parseProtocol(b);
  return Boolean(left && right && left.major === right.major);
}

/** 多个版本里最高者；无法解析的候选被忽略，全不可解析返回 null。 */
export function maxProtocol(...versions) {
  let best = null;
  for (const version of versions.flat()) {
    if (parseProtocol(version) === null) continue;
    if (best === null || compareProtocol(version, best) > 0) best = String(version);
  }
  return best;
}

/** 多个版本里最低者；无法解析的候选被忽略，全不可解析返回 null。 */
export function minProtocol(...versions) {
  let best = null;
  for (const version of versions.flat()) {
    if (parseProtocol(version) === null) continue;
    if (best === null || compareProtocol(version, best) < 0) best = String(version);
  }
  return best;
}

/**
 * 握手偏斜判定：actual（对端/客户端）相对 expected（本端/daemon）。
 * @returns {{
 *   actual:string, expected:string, known:boolean, order:number|null,
 *   band:string, relation:'unknown'|'equal'|'actual-older'|'actual-newer'|'major-skew',
 *   severity:'none'|'info'|'warn'|'fatal', message:string,
 * }}
 */
export function protocolSkew(actual, expected = PROTOCOL_CURRENT) {
  const left = String(actual == null ? '' : actual);
  const right = String(expected == null ? '' : expected);
  const order = compareProtocol(left, right);
  const band = protocolBand(left);
  if (order === null) {
    return Object.freeze({
      actual: left || 'unknown', expected: right, known: false, order: null, band: 'unknown',
      relation: 'unknown', severity: 'fatal',
      message: '无法解析对端协议版本（' + (left || 'unknown') + '）：按不兼容处理',
    });
  }
  if (order === 0) {
    return Object.freeze({ actual: left, expected: right, known: true, order: 0, band, relation: 'equal', severity: 'none', message: '协议版本一致（' + left + '）' });
  }
  const sameMajor = isSameProtocolMajor(left, right);
  if (!sameMajor) {
    return Object.freeze({
      actual: left, expected: right, known: true, order, band,
      relation: 'major-skew', severity: 'fatal',
      message: 'major 不兼容：对端 ' + left + '，本端 ' + right + '；minor 偏斜兼容模型不适用',
    });
  }
  return Object.freeze({
    actual: left, expected: right, known: true, order, band,
    relation: order < 0 ? 'actual-older' : 'actual-newer',
    severity: order < 0 ? 'warn' : 'info',
    message: order < 0
      ? '对端协议较旧（' + left + ' < ' + right + '）：新特性会被 feature floor 拒绝，其余方法可用'
      : '对端协议较新（' + left + ' > ' + right + '）：本端可能不认识新字段，按未知字段忽略',
  });
}

/**
 * 单次版本协商：actual 是否满足 required（required 可为 floor/当前协议）。
 * 与 protocolAtLeast 的区别是这里返回可读结论，且区分 major 偏斜。
 */
export function negotiateProtocolVersion(actual, required = PROTOCOL_CURRENT) {
  const order = compareProtocol(actual, required);
  const skew = protocolSkew(actual, PROTOCOL_CURRENT);
  if (order === null) {
    return Object.freeze({ actual: String(actual == null ? '' : actual) || 'unknown', required: String(required), ok: false, known: false, order: null, band: 'unknown', reason: '版本不可解析，按不兼容处理', skew });
  }
  const sameMajor = isSameProtocolMajor(actual, required);
  const ok = sameMajor && order >= 0;
  return Object.freeze({
    actual: String(actual), required: String(required), ok, known: true, order,
    band: protocolBand(actual), sameMajor,
    reason: ok ? '达到要求的协议版本' : sameMajor ? '低于要求的协议版本' : 'major 不同，不属于兼容偏斜',
    skew,
  });
}

/** 协议分带快照（诊断/文档用；与目录单一源一致）。 */
export function protocolBandSnapshot() {
  const probes = [PROTOCOL_BASELINE, PROTOCOL_CURRENT, '1.7', '1.10', '2.0', 'unknown'];
  return Object.freeze({
    baseline: PROTOCOL_BASELINE,
    current: PROTOCOL_CURRENT,
    bands: Object.freeze(Object.fromEntries(probes.map((version) => [version, protocolBand(version)]))),
  });
}

/**
 * 握手报告：daemon 收到 hello.protocol 后，版本层能给出的全部结论。
 * 这一层只回答版本问题（能不能连、谁旧谁新、是否 major 偏斜）；
 * “哪些方法/参数不可用”由 lib/protocol-features.mjs 的 feature floor 继续回答。
 *
 * 决策口径与 daemon/server.mjs 的 hello 处理一致：
 *   - 无法解析或 major 不同 → reject（E_PROTOCOL_UNSUPPORTED，握手失败）；
 *   - 同 major 但低于兼容基线 → reject-with-upgrade（太旧，无法按偏斜模型工作）；
 *   - 同 major 且 >= 基线 → accept（新特性由其后的派发前闸门逐调用拒绝）。
 *
 * @param {string|number} peerProtocol 对端 hello 里的协议版本
 * @param {string|number} [daemonProtocol]
 * @returns {{
 *   peer:string, daemon:string, peerBand:string, daemonBand:string, known:boolean,
 *   sameMajor:boolean, order:number|null, skew:object,
 *   decision:'accept'|'reject'|'reject-with-upgrade',
 *   severity:'none'|'info'|'warn'|'fatal', reason:string, steps:string[],
 * }}
 */
export function negotiateHandshake(peerProtocol, daemonProtocol = PROTOCOL_CURRENT) {
  const peer = String(peerProtocol == null || peerProtocol === '' ? 'unknown' : peerProtocol);
  const daemon = String(daemonProtocol == null ? PROTOCOL_CURRENT : daemonProtocol);
  const skew = protocolSkew(peer, daemon);
  const known = skew.known;
  const sameMajor = isSameProtocolMajor(peer, daemon);
  if (!known || !sameMajor) {
    return Object.freeze({
      peer: peer || 'unknown',
      daemon,
      peerBand: protocolBand(peer),
      daemonBand: protocolBand(daemon),
      known,
      sameMajor,
      order: skew.order,
      skew,
      decision: 'reject',
      severity: 'fatal',
      reason: known
        ? 'major 不同（' + peer + ' vs ' + daemon + '）：偏斜兼容模型不适用'
        : '对端协议不可解析（' + (peer || 'unknown') + '）：按不兼容处理',
      steps: Object.freeze(['升级到与 daemon 相同的 major（当前 ' + daemon + '）后重连']),
    });
  }
  const baselineOrder = compareProtocol(peer, PROTOCOL_BASELINE);
  if (baselineOrder !== null && baselineOrder < 0) {
    return Object.freeze({
      peer,
      daemon,
      peerBand: protocolBand(peer),
      daemonBand: protocolBand(daemon),
      known: true,
      sameMajor: true,
      order: skew.order,
      skew,
      decision: 'reject-with-upgrade',
      severity: 'fatal',
      reason: '对端协议 ' + peer + ' 低于兼容基线 ' + PROTOCOL_BASELINE + '：无法保证任何新特性语义',
      steps: Object.freeze([
        '升级浏览器扩展到协议 ' + PROTOCOL_BASELINE + '+（建议 ' + PROTOCOL_CURRENT + '）',
        '重新连接后由 feature floor 逐调用判定可用能力',
      ]),
    });
  }
  return Object.freeze({
    peer,
    daemon,
    peerBand: protocolBand(peer),
    daemonBand: protocolBand(daemon),
    known: true,
    sameMajor: true,
    order: skew.order,
    skew,
    decision: 'accept',
    severity: skew.severity === 'none' ? 'none' : skew.severity,
    reason: skew.order === 0
      ? '协议一致（' + peer + '）'
      : '同 major 偏斜：' + (skew.order < 0 ? '对端较旧，新特性会被 feature floor 拒绝' : '对端较新，未知字段按忽略处理'),
    steps: Object.freeze(skew.order < 0
      ? ['升级扩展后重连以启用 ' + PROTOCOL_CURRENT + ' 特性', '在此期间按降级/升级建议调用']
      : ['按当前协议继续；未知字段会被忽略']),
  });
}

/** 握手报告矩阵：多个对端版本 × 当前 daemon 的结论（诊断页/单测用）。 */
export function handshakeMatrix(peerVersions = [PROTOCOL_BASELINE, PROTOCOL_CURRENT, '1.7', '1.10', '2.0', 'x'], daemonProtocol = PROTOCOL_CURRENT) {
  const peers = [...peerVersions].map((version) => String(version));
  return Object.freeze({
    daemon: String(daemonProtocol),
    baseline: PROTOCOL_BASELINE,
    current: PROTOCOL_CURRENT,
    rows: Object.freeze(peers.map((peer) => negotiateHandshake(peer, daemonProtocol))),
    counts: Object.freeze(peers.reduce((counts, peer) => {
      const decision = negotiateHandshake(peer, daemonProtocol).decision;
      counts[decision] = (counts[decision] || 0) + 1;
      return counts;
    }, {})),
  });
}

// ===========================================================================
// 版本排序 / 区间 / 相邻探针
//
// 兼容矩阵 runner（lib/protocol-compat-runner.mjs）与迁移规划器
// （lib/protocol-migration-planner.mjs）需要“按版本序排列、取区间、算相邻版本”。
// 这些仍然只依赖 parseProtocol/compareProtocol，不引入第二份版本事实：
//   - 可解析版本按 (major, minor) 升序在前；不可解析版本排在最后（按字符串序）；
//   - 区间判定任一侧不可解析返回 null（调用方按“不能证明”处理，而不是当成 true）；
//   - 相邻探针全部从目录的 baseline/current 派生（不手写 1.8/1.9）。
// ===========================================================================

/** 版本方向：a 相对 b 是 'older' / 'same' / 'newer'；任一侧不可解析返回 'unknown'。 */
export function protocolDirection(a, b) {
  const order = compareProtocol(a, b);
  if (order === null) return 'unknown';
  return order < 0 ? 'older' : order > 0 ? 'newer' : 'same';
}

/**
 * 版本是否在闭区间 [lower, upper] 内。
 * 任一侧不可解析返回 null：调用方必须显式处理“无法证明”，不要当成 false 或 true。
 */
export function isProtocolWithin(version, lower, upper) {
  const low = compareProtocol(version, lower);
  const high = compareProtocol(version, upper);
  if (low === null || high === null) return null;
  return low >= 0 && high <= 0;
}

/** 版本数值序（major/minor 编码）；不可解析返回 null。 */
export function protocolOrdinal(version) {
  const parsed = parseProtocol(version);
  return parsed ? parsed.major * 1000 + parsed.minor : null;
}

/**
 * 升序排序（纯函数，不修改入参）。
 * 可解析版本按 (major, minor) 升序在前；不可解析版本按字符串序排在最后。
 */
export function sortProtocolVersions(versions = []) {
  const items = [...versions].map((version) => String(version));
  return Object.freeze(items.sort((left, right) => {
    const leftOrdinal = protocolOrdinal(left);
    const rightOrdinal = protocolOrdinal(right);
    if (leftOrdinal === null && rightOrdinal === null) return left < right ? -1 : left > right ? 1 : 0;
    if (leftOrdinal === null) return 1;
    if (rightOrdinal === null) return -1;
    return leftOrdinal - rightOrdinal;
  }));
}

/** 同一 major 内下一个 minor（不可解析返回 null）：迁移阶梯用。 */
export function nextProtocolMinor(version) {
  const parsed = parseProtocol(version);
  if (!parsed) return null;
  return parsed.major + '.' + (parsed.minor + 1);
}

/** 同一 major 内上一个 minor（minor=0 时退到上一 major 的 99，保守返回 null）：迁移阶梯用。 */
export function previousProtocolMinor(version) {
  const parsed = parseProtocol(version);
  if (!parsed || parsed.minor === 0) return null;
  return parsed.major + '.' + (parsed.minor - 1);
}

/**
 * 相邻版本探针（全部从目录派生，不手写版本号）：
 *   legacy    = baseline 的上一个 minor（低于兼容基线的老客户端）
 *   baseline  = 目录兼容基线
 *   current   = 目录当前协议
 *   ahead     = current 的下一个 minor（更新的同 major 客户端）
 *   aheadMajor= 下一个 major（不兼容）
 * 派生失败时对应字段为 null（例如 baseline 是 x.0），runner 会跳过 null 探针。
 */
export function protocolProbes() {
  const currentParsed = parseProtocol(PROTOCOL_CURRENT);
  return Object.freeze({
    legacy: previousProtocolMinor(PROTOCOL_BASELINE),
    baseline: PROTOCOL_BASELINE,
    current: PROTOCOL_CURRENT,
    ahead: nextProtocolMinor(PROTOCOL_CURRENT),
    aheadMajor: currentParsed ? (currentParsed.major + 1) + '.0' : null,
  });
}
