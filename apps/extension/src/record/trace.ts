// src/record/trace.ts —— 录制 → Trace v3 导出结构（纯函数，无 chrome/node 依赖）。
//
// 与 lib/trace-v3.mjs（CLI/MCP 共用的导出器）保持同一对外形状：
//   version=3、started_at/recorded_at、entry.start_url、recorder{cli,vom}、
//   states[]（before/after 页面状态）、steps[]（op/state/result.state + 目标描述）、
//   causalChains[]（没有显式因果时给 inferred 的线性链，不把推断伪装成事实）。
//
// 与 CLI 的分工：CLI 负责把 trace.json/states/*.txt 落盘（Node 才能写文件），
// 本模块只产出可 JSON 序列化的对象；`stateFiles()` 给出 states 文件投影，
// 页面/服务层需要“导出计划”时也能直接复用。
//
// 截图引用有两种粒度：
//   - trace.steps[].screenshot（录制期间每步缩略图，dataUrl）；
//   - trace.screenshots[]（导出时补拍的一张页面图，见 service.export）。
// E2E 20d2 断言 trace.screenshots.length === 1 且为 data:image/。

import {
  TRACE_VERSION,
  VOM_FORMAT_VERSION,
  type RecordEvent,
  type RecordFrameInfo,
  type Recording,
  type TraceCausalChain,
  type TraceScreenshot,
  type TraceState,
  type TraceStep,
  type TraceStepTarget,
  type TraceV3,
} from './types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function iso(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return new Date().toISOString();
  return new Date(n).toISOString();
}

function frameIdOf(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/** 事件 → trace step 的 op（不认识的事件不产生 step，与 CLI 导出器一致）。 */
export function traceOpFor(kind: unknown): string | null {
  if (kind === 'input') return 'fill';
  if (kind === 'tab-switch' || kind === 'window-switch') return 'switch_tab';
  if (kind === 'click' || kind === 'hover' || kind === 'select') return String(kind);
  return null;
}

function targetOf(event: RecordEvent): TraceStepTarget {
  const target: TraceStepTarget = {};
  if (event.ref) target.ref = String(event.ref);
  if (event.role) target.role = String(event.role);
  else if (event.tag) target.role = String(event.tag).toLowerCase();
  if (event.name) target.name = String(event.name);
  else if (event.text) target.name = String(event.text).slice(0, 120);
  else if (event.selector) target.name = String(event.selector).slice(0, 120);
  if (event.ctx) target.ctx = String(event.ctx);
  return target;
}

/** 从录制/事件/状态里收集 frame 注册表（跨 frame 关联的事实来源）。 */
function collectFrames(recording: Recording, events: RecordEvent[], states: TraceState[]): Map<number, RecordFrameInfo> {
  const frames = new Map<number, RecordFrameInfo>();
  const ensure = (frameId: unknown): RecordFrameInfo | null => {
    const id = frameIdOf(frameId);
    if (id == null) return null;
    let frame = frames.get(id);
    if (!frame) {
      frame = { frameId: id, parentFrameId: null, url: '', depth: 0, stepCount: 0, stateCount: 0 };
      frames.set(id, frame);
    }
    return frame;
  };
  for (const raw of Array.isArray(recording.frames) ? recording.frames : []) {
    if (!isRecord(raw)) continue;
    const frame = ensure(raw.frameId ?? raw.id);
    if (!frame) continue;
    if (raw.parentFrameId != null) frame.parentFrameId = Number(raw.parentFrameId);
    if (typeof raw.url === 'string' && raw.url) frame.url = raw.url;
    if (Number.isFinite(Number(raw.depth))) frame.depth = Number(raw.depth);
  }
  for (const event of events) {
    const frame = ensure(event.frameId);
    if (!frame) continue;
    if (typeof event.frameUrl === 'string' && event.frameUrl && !frame.url) frame.url = event.frameUrl;
    frame.stepCount = (frame.stepCount ?? 0) + 1;
  }
  for (const state of states) {
    const frame = ensure(state.frameId);
    if (frame) frame.stateCount = (frame.stateCount ?? 0) + 1;
  }
  for (const frame of frames.values()) {
    let depth = 0;
    let cursor: RecordFrameInfo | undefined = frame;
    const seen = new Set<number>([frame.frameId]);
    while (cursor && cursor.parentFrameId != null) {
      const parent: RecordFrameInfo | undefined = frames.get(Number(cursor.parentFrameId));
      if (!parent || seen.has(parent.frameId)) break;
      seen.add(parent.frameId);
      depth += 1;
      cursor = parent;
    }
    frame.depth = depth;
  }
  return frames;
}

/** 因果链：显式 causedBy 优先；没有显式因果时给出标注 inferred 的线性链。 */
export function buildCausalChains(steps: TraceStep[]): TraceCausalChain[] {
  const byStepId = new Map<number, TraceStep>(steps.map((step) => [step.id, step]));
  const edges: Array<{ from: number; to: number }> = [];
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
  const merged: TraceCausalChain[] = [];
  const consumed = new Set<string>();
  for (const edge of edges) {
    if (consumed.has(edge.from + '->' + edge.to)) continue;
    consumed.add(edge.from + '->' + edge.to);
    const chain: number[] = [edge.from, edge.to];
    let extended = true;
    while (extended) {
      extended = false;
      const tail = chain[chain.length - 1];
      if (tail === undefined) break;
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

/**
 * 录制 → Trace v3。
 *
 * @param recording 已结束的录制（落库形状）
 * @param options.cli 导出器版本号（写入 recorder.cli；CLI 导出会传真实版本）
 */
export function buildTraceV3(recording: Recording, options: { cli?: string } = {}): TraceV3 {
  const events = (Array.isArray(recording.events) ? recording.events : []).filter((event) => event && event.kind !== 'state');
  const states: TraceState[] = [];
  let stateSeq = 0;
  const addState = (event: Partial<RecordEvent> & { url?: string; observation?: string }): string => {
    stateSeq += 1;
    const id = 's' + stateSeq;
    const at = iso(event.at ?? event.ts);
    const frame = frameIdOf(event.frameId);
    states.push({
      id,
      at,
      url: String(event.stateUrl || event.url || recording.url || ''),
      ...(event.title === undefined ? {} : { title: String(event.title) }),
      body: String(event.observation || ''),
      truncated: false,
      ...(frame == null ? {} : { frameId: frame }),
    });
    return id;
  };

  let initialId: string;
  if (recording.initialObservation && recording.initialObservation.text) {
    initialId = addState({
      url: recording.url,
      title: recording.title,
      observation: recording.initialObservation.text,
      at: recording.startedAt,
    });
  } else {
    stateSeq += 1;
    initialId = 's1';
    states.push({
      id: initialId,
      at: iso(recording.startedAt),
      url: String(recording.url || ''),
      ...(recording.title ? { title: recording.title } : {}),
      body: '',
      truncated: false,
    });
  }

  let current = initialId;
  const steps: TraceStep[] = [];
  let stepId = 0;
  for (const event of events) {
    const op = traceOpFor(event.kind);
    if (!op) continue;
    const before = current;
    const after = event.observation ? addState(event) : current;
    current = after;
    stepId += 1;
    const step: TraceStep = { id: stepId, at: iso(event.ts), state: before, result: { state: after }, op };
    if (typeof event.screenshot === 'string' && /^data:image\//.test(event.screenshot)) step.screenshot = event.screenshot;
    if (Number(event.frameId) > 0) step.frameId = Number(event.frameId);
    if (op === 'click' || op === 'hover' || op === 'select') {
      step.target = targetOf(event);
      if (op === 'select') {
        step.selection = [{
          value: String(event.value ?? ''),
          ...(event.label === undefined ? {} : { label: String(event.label) }),
        }];
      }
    } else if (op === 'fill') {
      step.target = targetOf(event);
      step.value = String(event.value === undefined ? '' : event.value);
      step.commit = event.commit === 'enter' ? 'enter' : 'blur';
      step.redacted = event.sensitive === true;
    }
    // 显式因果：录制方可以给事件带 causedBy（seq 列表/单值），映射成 step id。
    const explicit = event.causedBy ?? event.cause ?? event.causedBySeq;
    if (explicit !== undefined && explicit !== null) {
      const list = Array.isArray(explicit) ? explicit : [explicit];
      const mapped: number[] = [];
      for (const cause of list) {
        const numeric = Number(cause);
        if (!Number.isInteger(numeric)) continue;
        const found = steps.find((candidate) => candidate.id === numeric);
        if (found) mapped.push(found.id);
        else if (numeric > 0 && numeric < stepId) mapped.push(numeric);
      }
      if (mapped.length) step.causedBy = [...new Set(mapped)];
    }
    steps.push(step);
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
    if (step.frameId != null && step.frameId > 0) {
      const frame = frames.get(step.frameId);
      if (frame) step.frame = { ...frame };
    }
  }
  return {
    version: TRACE_VERSION,
    ...(recording.purpose || recording.name ? { purpose: recording.purpose || recording.name } : {}),
    started_at: iso(recording.startedAt),
    recorded_at: iso(recording.endedAt || Date.now()),
    stopped_by: recording.stoppedBy === 'user_finish' ? 'user_finish' : 'cli_stop',
    entry: {
      start_url: String(recording.url || ''),
      ...(frames.size ? { frames: [...frames.values()] } : {}),
    },
    recorder: { cli: String(options.cli || recording.cli || '0.3.0'), vom: VOM_FORMAT_VERSION },
    states,
    steps,
    ...(frames.size ? { frames: [...frames.values()] } : {}),
    causalChains: buildCausalChains(steps),
  };
}

/** states 落盘投影（CLI 写 states/<id>.txt；返回顺序与 trace.states 一致）。 */
export function traceStateFiles(trace: TraceV3): Array<{ id: string; body: string }> {
  const states = Array.isArray(trace?.states) ? trace.states : [];
  return states.map((state) => ({ id: String(state.id), body: String(state.body ?? '') }));
}

/**
 * trace.json 的序列化内容（落盘由调用方负责：浏览器侧不能写文件系统，
 * background 把字符串交给 CLI/下载；CLI 导出则直接写 Node 文件）。
 */
export function serializeTrace(trace: TraceV3): string {
  return JSON.stringify(trace, null, 2) + '\n';
}

/** trace 摘要（record.export 回包 / 页面显示用；不把整份 trace 算进 steps 计数）。 */
export interface TraceSummary {
  traceVersion: number;
  steps: number;
  states: number;
  screenshots: number;
  frames: number;
  events: number;
}

export function summarizeTrace(trace: TraceV3): TraceSummary {
  const steps = Array.isArray(trace.steps) ? trace.steps.length : 0;
  const states = Array.isArray(trace.states) ? trace.states.length : 0;
  const screenshots = Array.isArray(trace.screenshots) ? trace.screenshots.length : 0;
  const frames = Array.isArray(trace.frames) ? trace.frames.length : 0;
  return { traceVersion: Number(trace.version) || TRACE_VERSION, steps, states, screenshots, frames, events: steps };
}

/** 导出时补拍的截图对象（service.export 用；CLI 走 screenshot RPC，不经过这里）。 */
export function makeTraceScreenshot(shot: { dataUrl: string; width?: number | null; height?: number | null }, label = '导出时页面'): TraceScreenshot {
  return {
    id: 'shot-1',
    at: new Date().toISOString(),
    label,
    width: Number.isInteger(Number(shot.width)) ? Number(shot.width) : null,
    height: Number.isInteger(Number(shot.height)) ? Number(shot.height) : null,
    dataUrl: String(shot.dataUrl),
  };
}
