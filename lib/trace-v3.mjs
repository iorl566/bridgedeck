// lib/trace-v3.mjs —— 把扩展录制的扁平事件转换成兼容的 TraceV3。
//
// 参考结构：version=3、entry.start_url、recorder{bsk,vom}、states[]、
// steps[]（op/state/result.state + 目标描述）。我们保留原始事件语义，
// 同时生成 agent 可回放的 before/after 状态引用。

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

export function buildTraceV3(recording, { bsk = '0.1.1' } = {}) {
  const events = (Array.isArray(recording.events) ? recording.events : [])
    .filter((event) => event && event.kind !== 'state');
  const states = [];
  let stateSeq = 0;
  const addState = (event) => {
    stateSeq += 1;
    const id = 's' + stateSeq;
    states.push({
      id,
      url: String(event.stateUrl || event.url || recording.url || ''),
      title: event.title === undefined ? undefined : String(event.title),
      body: String(event.observation || ''),
      truncated: false,
    });
    return id;
  };

  let initialId = null;
  if (recording.initialObservation && recording.initialObservation.text) {
    initialId = addState({ url: recording.url, title: recording.title, observation: recording.initialObservation.text });
  } else {
    stateSeq += 1;
    initialId = 's1';
    states.push({ id: initialId, url: String(recording.url || ''), title: recording.title || undefined, body: '', truncated: false });
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
    const common = { id: stepId, state: before, result: { state: after } };
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
  }

  if (recording.finalObservation && recording.finalObservation.text) {
    const last = steps[steps.length - 1];
    const finalId = addState({ url: recording.finalObservation.url, title: recording.finalObservation.title, observation: recording.finalObservation.text });
    if (last) last.result = { state: finalId };
  }

  return {
    version: TRACE_VERSION,
    purpose: recording.purpose || recording.name || undefined,
    started_at: iso(recording.startedAt),
    recorded_at: iso(recording.endedAt || Date.now()),
    stopped_by: recording.stoppedBy === 'user_finish' ? 'user_finish' : 'cli_stop',
    entry: { start_url: String(recording.url || '') },
    recorder: { bsk, vom: VOM_FORMAT_VERSION },
    states,
    steps,
  };
}
