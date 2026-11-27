// src/lib/attribution-evidence.js —— 人类输入归因证据（谁在动 / 动在哪 / ±1.5ms 时间戳归因）。
//
// 归因判定本身在内容脚本（content/cooperation.js）：Agent 派发输入前登记
// expectation，事件 timeStamp（performance 时基）与 expectation.perfAt 相差 ≤1.5ms
// 就判 Agent；否则按人工（deny-by-default）。但后台一直缺少一份“可读证据”：
//   - 谁在动：Agent（时间戳/坐标/宽限）还是人类（真实 isTrusted 输入）；
//   - 动在哪：哪个 frame、哪个控件、什么类型的事件、什么坐标；
//   - 时间证据：skewMs、容差、是否落在容差内、证据新鲜度；
//   - 冲突：Agent 输入窗口与人工活动同时出现时如何裁决。
// 本模块把内容脚本 frameState + 后台 human-state + Agent 输入窗口合成一份证据，
// 供 CLI（cooperate sync / 状态快照）与 toolbar 读取。纯函数，便于单测。

export const ATTRIBUTION_TIME_TOLERANCE_MS = 1.5;
const ATTRIBUTION_FRESH_MS = 5000;
const HUMAN_ACTIVE_MS = 2500;
const AGENT_GRACE_MS = 1500;

function num(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function pickCounts(frameState) {
  const source = frameState && typeof frameState === 'object' ? frameState : {};
  return {
    human: num(source.human),
    humanAttributed: num(source.humanAttributed),
    agentAttributed: num(source.agentAttributed),
    agentAttributedByTimestamp: num(source.agentAttributedByTimestamp),
    agentAttributedByCoordinate: num(source.agentAttributedByCoordinate),
    pointer: num(source.pointer),
    keyboard: num(source.keyboard),
    inputClock: num(source.inputClock),
  };
}

function pickWhere(frameState, humanState, expectation) {
  const events = frameState && Array.isArray(frameState.events) ? frameState.events : [];
  const last = events.length ? events[events.length - 1] : null;
  const attribution = frameState && frameState.attribution && typeof frameState.attribution === 'object' ? frameState.attribution : null;
  const kind = (attribution && attribution.kind) || (last && last.kind) || '';
  const label = (last && last.label) || (humanState && humanState.focus) || '';
  const frameId = Number.isInteger(humanState && humanState.frameId)
    ? humanState.frameId
    : (last && Number.isInteger(last.frameId) ? last.frameId : 0);
  return {
    frameId,
    kind: String(kind || ''),
    label: String(label || '').slice(0, 120),
    editing: Boolean(humanState && humanState.editing),
    focus: humanState && humanState.focus ? String(humanState.focus).slice(0, 120) : null,
    x: expectation && Number.isFinite(Number(expectation.x)) ? Number(expectation.x) : null,
    y: expectation && Number.isFinite(Number(expectation.y)) ? Number(expectation.y) : null,
  };
}

/**
 * 判定一条归因记录归属谁。
 * @param {{attribution?: object, humanState?: object, agentWindow?: {start:number,end:number}|null,
 *          now?: number, toleranceMs?: number}} input
 */
export function classifyAttribution(input = {}) {
  const now = num(input.now) || Date.now();
  const toleranceMs = Number.isFinite(Number(input.toleranceMs)) ? Number(input.toleranceMs) : ATTRIBUTION_TIME_TOLERANCE_MS;
  const attribution = input.attribution && typeof input.attribution === 'object' ? input.attribution : null;
  const humanState = input.humanState && typeof input.humanState === 'object' ? input.humanState : null;
  const agentWindow = input.agentWindow || null;
  const humanAt = num(humanState && humanState.at);
  const windowActive = Boolean(agentWindow)
    && now >= num(agentWindow.start) - 50
    && now <= (agentWindow.end === Infinity ? now : num(agentWindow.end) + 500);
  // 1) 内容脚本给出的最近归因（最权威：它拿到了真实事件 timeStamp）。
  if (attribution && num(attribution.at) > 0 && now - num(attribution.at) <= ATTRIBUTION_FRESH_MS) {
    const owner = attribution.owner === 'agent' ? 'agent' : attribution.owner === 'human' ? 'human' : 'unknown';
    const reason = String(attribution.reason || '');
    const skewMs = attribution.skewMs == null ? null : Number(attribution.skewMs);
    const withinTolerance = Number.isFinite(skewMs) ? Math.abs(skewMs) <= toleranceMs : null;
    return {
      who: owner,
      basis: reason || (owner === 'agent' ? 'content' : 'input'),
      confidence: owner === 'agent'
        ? (reason === 'timestamp' ? 0.99 : reason === 'coordinate' ? 0.9 : 0.6)
        : 0.95,
      at: num(attribution.at),
      ageMs: Math.max(0, now - num(attribution.at)),
      kind: String(attribution.kind || ''),
      skewMs,
      toleranceMs,
      withinTolerance,
      conflicting: Boolean(windowActive && owner === 'human' && humanAt > 0 && now - humanAt <= HUMAN_ACTIVE_MS),
      source: 'content',
    };
  }
  // 2) 后台 human-state（页面 human-watch 的 isTrusted 输入快照）：没有内容脚本归因时的兜底。
  if (humanAt > 0 && now - humanAt <= HUMAN_ACTIVE_MS) {
    return {
      who: 'human',
      basis: windowActive ? 'background-watch-conflict' : 'background-watch',
      confidence: windowActive ? 0.5 : 0.8,
      at: humanAt,
      ageMs: Math.max(0, now - humanAt),
      kind: String((humanState && (humanState.lastKind || humanState.kind)) || ''),
      skewMs: null,
      toleranceMs,
      withinTolerance: null,
      conflicting: windowActive,
      source: 'human-state',
    };
  }
  // 3) Agent 输入窗口内、既没有内容归因也没有人工活动：按 Agent 宽限。
  if (windowActive) {
    return {
      who: 'agent',
      basis: 'agent-window',
      confidence: 0.55,
      at: now,
      ageMs: 0,
      kind: '',
      skewMs: null,
      toleranceMs,
      withinTolerance: null,
      conflicting: false,
      source: 'agent-window',
    };
  }
  return {
    who: 'unknown',
    basis: 'none',
    confidence: 0,
    at: 0,
    ageMs: null,
    kind: '',
    skewMs: null,
    toleranceMs,
    withinTolerance: null,
    conflicting: false,
    source: 'none',
  };
}

/**
 * 合成一份可直接输出的归因证据。
 * @param {{frameState?: object, frames?: Array<{frameId:number, url:string, frameState:object}>,
 *          humanState?: object, expectation?: object, agentWindow?: object, now?: number,
 *          toleranceMs?: number}} input
 */
export function buildHumanInputEvidence(input = {}) {
  const now = num(input.now) || Date.now();
  const toleranceMs = Number.isFinite(Number(input.toleranceMs)) ? Number(input.toleranceMs) : ATTRIBUTION_TIME_TOLERANCE_MS;
  const frameState = input.frameState && typeof input.frameState === 'object' ? input.frameState : {};
  const humanState = input.humanState && typeof input.humanState === 'object' ? input.humanState : null;
  const classification = classifyAttribution({
    attribution: frameState.attribution,
    humanState,
    agentWindow: input.agentWindow,
    now,
    toleranceMs,
  });
  const perFrame = (Array.isArray(input.frames) ? input.frames : [])
    .filter((frame) => frame && frame.frameState)
    .map((frame) => ({
      frameId: Number.isInteger(frame.frameId) ? frame.frameId : 0,
      url: String(frame.url || ''),
      attribution: frame.frameState.attribution || null,
      counts: pickCounts(frame.frameState),
    }));
  const counts = pickCounts(frameState);
  const events = Array.isArray(frameState.events) ? frameState.events : [];
  const recentKinds = [...new Set(events.map((event) => String(event && event.kind || '')).filter(Boolean))];
  return {
    who: classification.who,
    basis: classification.basis,
    confidence: classification.confidence,
    where: pickWhere(frameState, humanState, input.expectation),
    when: {
      at: classification.at,
      ageMs: classification.ageMs,
      skewMs: classification.skewMs,
      toleranceMs,
      withinTolerance: classification.withinTolerance,
      lastHumanAt: num(frameState.lastHumanAt),
      lastAgentAt: num(frameState.lastAgentAt),
      lastInputAt: num(frameState.lastInput),
    },
    counts: {
      ...counts,
      byTimestamp: counts.agentAttributedByTimestamp,
      byCoordinate: counts.agentAttributedByCoordinate,
    },
    frame: {
      revision: num(frameState.revision),
      inputClock: counts.inputClock,
      expectationPending: frameState.expectationPending === true,
      editing: frameState.editing === true,
      busy: frameState.busy === true,
      document: String(frameState.document || ''),
      events: events.slice(-5),
      recentKinds,
    },
    conflict: {
      conflicting: classification.conflicting,
      agentWindowActive: Boolean(input.agentWindow),
      humanRecent: num(humanState && humanState.at) > 0 && now - num(humanState.at) <= HUMAN_ACTIVE_MS,
      graceMs: AGENT_GRACE_MS,
    },
    perFrame,
    evidence: {
      source: classification.source,
      at: now,
      toleranceMs,
      attributionSeen: Boolean(frameState.attribution),
      frames: perFrame.length,
      rule: classification.who === 'agent'
        ? (classification.basis === 'timestamp'
          ? '事件 timeStamp 与 expectation.perfAt 相差 ≤ ' + toleranceMs + 'ms：判 Agent'
          : classification.basis === 'coordinate' ? '坐标/按键命中 expectation：判 Agent' : 'Agent 输入窗口宽限内：判 Agent')
        : classification.who === 'human'
          ? 'isTrusted 真实输入且未命中 Agent expectation：判人工（deny-by-default）'
          : '没有新鲜的输入证据：归因未知',
    },
  };
}

/**
 * 多 frame 归因摘要：取最新归因所在 frame 作为主证据，并保留每 frame 计数。
 * @param {Array<{frameId:number, url:string, hidden?:boolean, state:object}>} frames
 */
export function summarizeAttributionFrames(frames = [], options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const toleranceMs = Number.isFinite(Number(options.toleranceMs)) ? Number(options.toleranceMs) : ATTRIBUTION_TIME_TOLERANCE_MS;
  const visible = (Array.isArray(frames) ? frames : [])
    .filter((frame) => frame && frame.state && frame.hidden !== true)
    .map((frame) => ({
      frameId: Number.isInteger(frame.frameId) ? frame.frameId : 0,
      url: String(frame.url || ''),
      frameState: frame.state.frameState && typeof frame.state.frameState === 'object' ? frame.state.frameState : {},
    }));
  const latest = visible
    .map((frame) => ({ frame, at: num(frame.frameState.attribution && frame.frameState.attribution.at) }))
    .filter((entry) => entry.at > 0)
    .sort((a, b) => b.at - a.at)[0] || null;
  const totals = visible.reduce((sum, frame) => {
    const counts = pickCounts(frame.frameState);
    for (const key of ['human', 'humanAttributed', 'agentAttributed', 'agentAttributedByTimestamp', 'agentAttributedByCoordinate', 'pointer', 'keyboard', 'inputClock']) {
      sum[key] = (sum[key] || 0) + counts[key];
    }
    return sum;
  }, {});
  const evidence = buildHumanInputEvidence({
    frameState: latest ? latest.frame.frameState : (visible[0] ? visible[0].frameState : {}),
    frames: visible,
    humanState: options.humanState || null,
    expectation: options.expectation || null,
    agentWindow: options.agentWindow || null,
    now,
    toleranceMs,
  });
  return {
    ...evidence,
    where: {
      ...evidence.where,
      frameId: latest ? latest.frame.frameId : evidence.where.frameId,
      url: latest ? latest.frame.url : '',
    },
    counts: { ...totals, byTimestamp: totals.agentAttributedByTimestamp || 0, byCoordinate: totals.agentAttributedByCoordinate || 0 },
    frames: visible.map((frame) => ({ frameId: frame.frameId, url: frame.url, attribution: frame.frameState.attribution || null })),
  };
}

/** 一行可读结论，进日志/CLI 摘要不占版面。 */
export function describeHumanInput(evidence) {
  if (!evidence || typeof evidence !== 'object') return '归因：无证据';
  const who = evidence.who === 'agent' ? 'Agent' : evidence.who === 'human' ? '人工' : '未知';
  const where = evidence.where || {};
  const when = evidence.when || {};
  const coords = where.x != null && where.y != null ? ' @' + Math.round(where.x) + ',' + Math.round(where.y) : '';
  const skew = when.skewMs == null ? '' : ' skew=' + when.skewMs + 'ms';
  return '归因：' + who + '（' + (evidence.basis || '?') + '）frame=' + (where.frameId != null ? where.frameId : '?') +
    (where.kind ? ' kind=' + where.kind : '') + (where.label ? ' 目标=' + where.label : '') + coords + skew +
    ' 容差=' + (when.toleranceMs != null ? when.toleranceMs : ATTRIBUTION_TIME_TOLERANCE_MS) + 'ms';
}
