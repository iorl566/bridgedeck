// lib/trace-v3.mjs —— 把扩展录制的扁平事件转换成兼容的 TraceV3。
//
// 参考结构：version=3、entry.start_url、recorder{cli,vom}、states[]、
// steps[]（op/state/result.state + 目标描述）。我们保留原始事件语义，
// 同时生成 agent 可回放的 before/after 状态引用。
//
// W3-A 深度扩展（全部是加法字段，旧字段语义不变）：
//   * frames[]：跨 frame 注册表（frameId/parentFrameId/url/depth/stepCount/stateCount），
//     step.frame 指向所属 frame；
//   * causalChains[] + step.causedBy：显式因果（事件 causedBy/cause）优先，否则给出
//     `inferred:true` 的时间线性链，不把推断伪装成事实；
//   * 录制带 traceEvents 时挂 spanSummary / criticalPath / spans（供 trace viewer 渲染），
//     复用 lib/trace-spans.mjs 的 span 树与关键路径。
//
// W9-C 深度扩展（同样是加法）：
//   * traceEvents 超过 maxTraceEvents 时先做结构安全采样（lib/trace-budget.mjs），
//     采样统计挂 `trace.sampling`（total/kept/dropped/strategy，绝不伪装完整）；
//   * `trace.spanExport`：导出时 span 选择计划（关键路径/未完成/root 优先 + 父链闭包）；
//   * `trace.exportBudget`：planTraceExport 的预算决策；估算体积超 maxExportBytes 时
//     自动 compact/minimal（record export 写 trace.json 的路径直接受益）。
//   消费点：cli/commands/record.mjs `record export`（buildTraceV3）。
import { buildSpanTree, summarizeSpans, criticalPath, querySpans } from './trace-spans.mjs';
import {
  compactTrace,
  planSpanExport,
  planTraceExport,
  sampleTraceEvents,
  summarizeTraceSampling,
} from './trace-budget.mjs';

export const TRACE_VERSION = 3;
export const VOM_FORMAT_VERSION = 1;

function iso(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return new Date().toISOString();
  return new Date(n).toISOString();
}

function targetOf(event) {
  const target = {};
  if (event.ref) target.ref = String(event.ref);
  if (event.role) target.role = String(event.role);
  else if (event.tag) target.role = String(event.tag).toLowerCase();
  if (event.name) target.name = String(event.name);
  else if (event.text) target.name = String(event.text).slice(0, 120);
  else if (event.selector) target.name = String(event.selector).slice(0, 120);
  if (event.ctx) target.ctx = String(event.ctx);
  return target;
}

function opFor(kind) {
  if (kind === 'input') return 'fill';
  if (kind === 'tab-switch' || kind === 'window-switch') return 'switch_tab';
  if (kind === 'click' || kind === 'hover' || kind === 'select') return kind;
  return null;
}

function frameIdOf(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/** 从录制/事件/状态里收集 frame 注册表（跨 frame 关联的事实来源）。 */
function collectFrames(recording, events, states) {
  const frames = new Map();
  const ensure = (frameId) => {
    const id = frameIdOf(frameId);
    if (id == null) return null;
    if (!frames.has(id)) {
      frames.set(id, {
        frameId: id,
        parentFrameId: null,
        url: '',
        depth: 0,
        stepCount: 0,
        stateCount: 0,
      });
    }
    return frames.get(id);
  };
  const sourceFrames = Array.isArray(recording.frames) ? recording.frames : [];
  for (const raw of sourceFrames) {
    const frame = ensure(raw && (raw.frameId ?? raw.id));
    if (!frame) continue;
    if (raw.parentFrameId != null) frame.parentFrameId = Number(raw.parentFrameId);
    if (raw.url) frame.url = String(raw.url);
    if (Number.isFinite(Number(raw.depth))) frame.depth = Number(raw.depth);
  }
  for (const event of events) {
    for (const candidate of [event.frameId, event.frame && event.frame.frameId]) {
      const frame = ensure(candidate);
      if (!frame) continue;
      if (event.frame && event.frame.url && !frame.url) frame.url = String(event.frame.url);
      if (event.frame && event.frame.parentFrameId != null) frame.parentFrameId = Number(event.frame.parentFrameId);
      frame.stepCount += 1;
    }
  }
  for (const state of states) {
    const frame = ensure(state.frameId);
    if (frame) frame.stateCount += 1;
  }
  // depth 用 parent 链推导（parent 缺失时保持 0）
  for (const frame of frames.values()) {
    let depth = 0;
    let cursor = frame;
    const seen = new Set([frame.frameId]);
    while (cursor && cursor.parentFrameId != null) {
      const parent = frames.get(Number(cursor.parentFrameId));
      if (!parent || seen.has(parent.frameId)) break;
      seen.add(parent.frameId);
      depth += 1;
      cursor = parent;
    }
    frame.depth = depth;
  }
  return frames;
}

/** 因果链：显式 causedBy 优先；没有显式因果时给出标注 inferred 的时间线性链。 */
function buildCausalChains(steps) {
  const byStepId = new Map(steps.map((step) => [step.id, step]));
  const edges = [];
  for (const step of steps) {
    if (!Array.isArray(step.causedBy) || step.causedBy.length === 0) continue;
    for (const causeId of step.causedBy) {
      if (byStepId.has(causeId)) edges.push({ from: causeId, to: step.id });
    }
  }
  if (edges.length === 0) {
    if (steps.length === 0) return [];
    return [{
      id: 'chain-linear',
      steps: steps.map((step) => step.id),
      inferred: true,
      reason: 'no-explicit-causality',
    }];
  }
  // 把共享节点的边合并成链：1->2、2->3 得到 [1,2,3]。
  const merged = [];
  const consumed = new Set();
  for (const edge of edges) {
    if (consumed.has(edge.from + '->' + edge.to)) continue;
    consumed.add(edge.from + '->' + edge.to);
    const chain = [edge.from, edge.to];
    let extended = true;
    while (extended) {
      extended = false;
      const tail = chain[chain.length - 1];
      for (const candidate of edges) {
        if (consumed.has(candidate.from + '->' + candidate.to)) continue;
        if (candidate.from !== tail) continue;
        consumed.add(candidate.from + '->' + candidate.to);
        chain.push(candidate.to);
        extended = true;
      }
    }
    merged.push({ id: 'chain-' + (merged.length + 1), steps: chain, inferred: false });
  }
  return merged;
}

export function buildTraceV3(recording, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const cli = opts.cli || '0.1.1';
  const events = (Array.isArray(recording.events) ? recording.events : [])
    .filter((event) => event && event.kind !== 'state');
  const states = [];
  let stateSeq = 0;
  const addState = (event) => {
    stateSeq += 1;
    const id = 's' + stateSeq;
    states.push({
      id,
      at: iso(event.at || event.ts),
      url: String(event.stateUrl || event.url || recording.url || ''),
      title: event.title === undefined ? undefined : String(event.title),
      body: String(event.observation || ''),
      truncated: false,
      ...(frameIdOf(event.frameId) == null ? {} : { frameId: frameIdOf(event.frameId) }),
    });
    return id;
  };

  let initialId = null;
  if (recording.initialObservation && recording.initialObservation.text) {
    initialId = addState({ url: recording.url, title: recording.title, observation: recording.initialObservation.text, at: recording.startedAt });
  } else {
    stateSeq += 1;
    initialId = 's1';
    states.push({ id: initialId, at: iso(recording.startedAt), url: String(recording.url || ''), title: recording.title || undefined, body: '', truncated: false });
  }

  let current = initialId;
  const steps = [];
  let stepId = 0;
  for (const event of events) {
    const op = opFor(event.kind);
    if (!op) continue;
    const before = current;
    const after = event.observation ? addState(event) : current;
    current = after;
    stepId += 1;
    const common = { id: stepId, at: iso(event.ts), state: before, result: { state: after } };
    if (typeof event.screenshot === 'string' && /^data:image\//.test(event.screenshot)) common.screenshot = event.screenshot;
    if (Number(event.frameId) > 0) common.frameId = Number(event.frameId);
    if (op === 'click' || op === 'hover' || op === 'select') {
      steps.push({ op, ...common, target: targetOf(event) });
      if (op === 'select') steps[steps.length - 1].selection = [{ value: String(event.value || ''), label: event.label === undefined ? undefined : String(event.label) }];
    } else if (op === 'fill') {
      steps.push({
        op,
        ...common,
        target: targetOf(event),
        value: String(event.value === undefined ? '' : event.value),
        commit: event.commit === 'enter' ? 'enter' : 'blur',
        redacted: event.sensitive === true,
      });
    } else if (op === 'switch_tab') {
      steps.push({ op, ...common });
    }
    // 显式因果：录制方可以给事件带 causedBy（seq 列表/单值），映射成 step id。
    const explicit = event.causedBy ?? event.cause ?? event.causedBySeq;
    if (explicit !== undefined && explicit !== null) {
      const list = Array.isArray(explicit) ? explicit : [explicit];
      const mapped = [];
      for (const cause of list) {
        const numeric = Number(cause);
        if (!Number.isInteger(numeric)) continue;
        const found = steps.find((step) => Number(step.seq) === numeric);
        if (found) mapped.push(found.id);
        else if (numeric > 0 && numeric < stepId) mapped.push(numeric);
      }
      if (mapped.length) steps[steps.length - 1].causedBy = [...new Set(mapped)];
    }
  }

  if (recording.finalObservation && recording.finalObservation.text) {
    const last = steps[steps.length - 1];
    const finalId = addState({
      url: recording.finalObservation.url,
      title: recording.finalObservation.title,
      observation: recording.finalObservation.text,
      at: recording.finalObservation.at || recording.endedAt,
      frameId: recording.finalObservation.frameId,
    });
    if (last) last.result = { state: finalId };
  }

  const frames = collectFrames(recording, events, states);
  for (const step of steps) {
    if (Number(step.frameId) > 0 && frames.has(Number(step.frameId))) {
      step.frame = { ...frames.get(Number(step.frameId)) };
    }
  }
  const trace = {
    version: TRACE_VERSION,
    purpose: recording.purpose || recording.name || undefined,
    started_at: iso(recording.startedAt),
    recorded_at: iso(recording.endedAt || Date.now()),
    stopped_by: recording.stoppedBy === 'user_finish' ? 'user_finish' : 'cli_stop',
    entry: {
      start_url: String(recording.url || ''),
      ...(frames.size ? { frames: [...frames.values()] } : {}),
    },
    recorder: { cli, vom: VOM_FORMAT_VERSION },
    states,
    steps,
    ...(frames.size ? { frames: [...frames.values()] } : {}),
    causalChains: buildCausalChains(steps),
  };
  // 录制若包含 CDP traceEvents（debug/trace 采集），顺带给出 span 深度视图。
  const traceEvents = Array.isArray(recording.traceEvents) ? recording.traceEvents : null;
  if (traceEvents && traceEvents.length) {
    // 结构安全采样：B/E、S/F、b/e 单元整体保留，元数据与孤立事件不丢。
    const sampling = sampleTraceEvents(traceEvents, {
      maxEvents: opts.maxTraceEvents,
      strategy: opts.samplingStrategy,
      seed: opts.samplingSeed,
    });
    const tree = buildSpanTree({ traceEvents: sampling.events }, { maxSpans: opts.maxSpanNodes });
    const summary = summarizeSpans(tree, { top: 10 });
    trace.spanSummary = {
      spans: summary.spans,
      roots: summary.roots,
      unfinished: summary.unfinished,
      truncated: summary.truncated,
      dropped: summary.dropped,
      selfTotalMs: summary.selfTotalMs,
      durationMs: summary.durationMs,
      byPhase: summary.byPhase,
      byFrame: summary.byFrame,
      criticalPath: summary.criticalPath,
    };
    trace.criticalPath = criticalPath(tree);
    trace.spans = querySpans(tree, { order: 'duration', limit: 100 }).spans;
    trace.frames = [...frames.values(), ...(trace.frames || [])].filter((frame, index, list) => (
      list.findIndex((candidate) => candidate.frameId === frame.frameId) === index
    ));
    // 采样证据 + 导出选择计划：即使没有触发降级，也让调用方知道"导出会保留什么"。
    trace.sampling = summarizeTraceSampling(sampling);
    trace.spanExport = planSpanExport(tree, {
      maxSpans: opts.maxExportSpans,
    });
  }
  // 导出体积预算：默认只在超过 maxExportBytes 时真正降级（不改变小 trace 的默认输出）。
  const budgetOptions = {
    ...(opts.maxTraceEvents === undefined ? {} : { maxEvents: opts.maxTraceEvents }),
    ...(opts.maxExportSpans === undefined ? {} : { maxSpans: opts.maxExportSpans }),
    ...(opts.maxExportBytes === undefined ? {} : { maxBytes: opts.maxExportBytes }),
    ...(opts.maxExportSteps === undefined ? {} : { maxSteps: opts.maxExportSteps }),
    ...(opts.samplingStrategy === undefined ? {} : { strategy: opts.samplingStrategy }),
  };
  const planned = planTraceExport(trace, budgetOptions);
  if (planned.degraded) {
    const compacted = compactTrace(trace, budgetOptions);
    compacted.trace.exportBudget = compacted.plan;
    return compacted.trace;
  }
  trace.exportBudget = planned;
  return trace;
}
