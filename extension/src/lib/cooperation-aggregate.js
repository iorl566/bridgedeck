// 多 frame 协作快照聚合：隐藏 frame 记为 gap，不参与计数与活动合并。
import { appendTextChange } from './text-change-log.js';
function pickFrameState(state) {
  const fs = state && state.frameState ? state.frameState : {};
  return {
    ...fs,
    revision: Number.isInteger(fs.revision) ? fs.revision : 0,
    inputClock: Number(fs.inputClock) || 0,
    human: Number(fs.human) || 0,
    pointer: Number(fs.pointer) || 0,
    keyboard: Number(fs.keyboard) || 0,
    humanAttributed: Number(fs.humanAttributed) || 0,
    agentAttributed: Number(fs.agentAttributed) || 0,
    agentAttributedByTimestamp: Number(fs.agentAttributedByTimestamp) || 0,
    agentAttributedByCoordinate: Number(fs.agentAttributedByCoordinate) || 0,
    editing: fs.editing === true,
    busy: fs.busy === true,
    expectationPending: fs.expectationPending === true,
    ...(fs.timeToleranceMs != null ? { timeToleranceMs: fs.timeToleranceMs } : {}),
    ...(fs.attribution ? { attribution: fs.attribution } : {}),
    lastHumanAt: Number(fs.lastHumanAt) || 0,
    lastAgentAt: Number(fs.lastAgentAt) || 0,
    lastInput: Number(fs.lastInput) || 0,
    structure: Number(fs.structure) || 0,
    textual: Number(fs.textual) || 0,
    pending: fs.pending === true,
    focusIsDocument: fs.focusIsDocument !== false,
    focusNeutral: fs.focusNeutral !== false,
    selection: typeof fs.selection === 'string' ? fs.selection : '',
    media: Array.isArray(fs.media) ? fs.media : [],
    mediaComplete: fs.mediaComplete !== false,
    fieldsComplete: fs.fieldsComplete !== false,
    scrolling: fs.scrolling === true,
    texts: Array.isArray(fs.texts) ? fs.texts : [],
    textsComplete: fs.textsComplete !== false,
    document: String(fs.document || ''),
    events: Array.isArray(fs.events) ? fs.events : [],
    textFloor: Number(fs.textFloor) || 0,
  };
}

function sum(frames, key) {
  return frames.reduce((total, frame) => total + (Number(frame.frameState[key]) || 0), 0);
}

export function mergeCooperationFrames(frames = [], options = {}) {
  const topFrameId = Number.isInteger(options.topFrameId) ? options.topFrameId : 0;
  const entries = (Array.isArray(frames) ? frames : [])
    .filter((frame) => frame && Number.isInteger(frame.frameId) && frame.state)
    .map((frame) => ({
      frameId: frame.frameId,
      url: String(frame.url || ''),
      hidden: frame.hidden === true,
      state: frame.state,
    }));
  const visible = entries.filter((frame) => !frame.hidden);
  const hidden = entries.filter((frame) => frame.hidden);
  const top = visible.find((frame) => frame.frameId === topFrameId) || visible[0] || null;
  const frameStates = visible.map((frame) => ({ ...frame, frameState: pickFrameState(frame.state) }));
  const aggregate = {
    revision: Math.max(0, ...frameStates.map((frame) => frame.frameState.revision)),
    inputClock: sum(frameStates, 'inputClock'),
    human: sum(frameStates, 'human'),
    pointer: sum(frameStates, 'pointer'),
    keyboard: sum(frameStates, 'keyboard'),
    humanAttributed: sum(frameStates, 'humanAttributed'),
    agentAttributed: sum(frameStates, 'agentAttributed'),
    agentAttributedByTimestamp: sum(frameStates, 'agentAttributedByTimestamp'),
    agentAttributedByCoordinate: sum(frameStates, 'agentAttributedByCoordinate'),
    editing: frameStates.some((frame) => frame.frameState.editing),
    busy: frameStates.some((frame) => frame.frameState.busy),
    expectationPending: frameStates.some((frame) => frame.frameState.expectationPending),
    lastHumanAt: Math.max(0, ...frameStates.map((frame) => frame.frameState.lastHumanAt)),
    lastAgentAt: Math.max(0, ...frameStates.map((frame) => frame.frameState.lastAgentAt)),
    lastInput: Math.max(0, ...frameStates.map((frame) => frame.frameState.lastInput)),
    structure: sum(frameStates, 'structure'),
    textual: sum(frameStates, 'textual'),
    pending: frameStates.some((frame) => frame.frameState.pending),
    // 归因证据取顶层 frame 的最近一次归因（内容脚本按事件 timeStamp 判定，见 frameState.attribution）。
    ...(top && top.state.frameState && top.state.frameState.attribution
      ? { attribution: top.state.frameState.attribution }
      : {}),
    focusIsDocument: frameStates.length > 0 ? frameStates.every((frame) => frame.frameState.focusIsDocument !== false) : true,
    focusNeutral: frameStates.every((frame) => frame.frameState.focusNeutral !== false),
    selection: (frameStates.find((frame) => typeof frame.frameState.selection === 'string' && frame.frameState.selection) || { frameState: {} }).frameState.selection || '',
    media: frameStates.flatMap((frame) => (Array.isArray(frame.frameState.media) ? frame.frameState.media : [])).slice(0, 10),
    mediaComplete: frameStates.every((frame) => frame.frameState.mediaComplete !== false),
    textsComplete: frameStates.every((frame) => frame.frameState.textsComplete !== false),
    fieldsComplete: frameStates.every((frame) => frame.frameState.fieldsComplete !== false),
    eventsComplete: frameStates.every((frame) => frame.frameState.eventsComplete !== false),
    scrolling: frameStates.some((frame) => frame.frameState.scrolling === true),
    ...(top && top.state.frameState && top.state.frameState.timeToleranceMs != null
      ? { timeToleranceMs: top.state.frameState.timeToleranceMs }
      : {}),
  };
  const states = visible.map((frame) => frame.state);
  const control = {
    inputLocked: states.some((state) => state.control && state.control.inputLocked === true),
    shared: states.some((state) => state.control && state.control.shared === true),
    humanActive: states.some((state) => state.control && state.control.humanActive === true),
    agentActive: states.some((state) => state.control && state.control.agentActive === true),
    agentGraceMs: states.reduce((max, state) => Math.max(max, Number(state.control && state.control.agentGraceMs) || 0), 0),
  };
  const frameEvents = frameStates
    .flatMap((frame) => (frame.frameState.events || []).map((event) => ({ ...event, frameId: frame.frameId })))
    .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))
    .slice(-20);
  let textLog = [];
  let textDropped = 0;
  for (const frame of frameStates) {
    for (const entry of frame.frameState.texts || []) {
      const next = appendTextChange(textLog, { ...entry, frameId: frame.frameId }, { limit: 20 });
      textLog = next.texts;
      textDropped += next.dropped;
    }
  }
  const recent = visible
    .flatMap((frame) => (Array.isArray(frame.state.activity && frame.state.activity.recent) ? frame.state.activity.recent : []).map((event) => ({ ...event, frameId: frame.frameId })))
    .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))
    .slice(-10);
  return {
    frames: frameStates.map((frame) => ({ frameId: frame.frameId, url: frame.url, frameState: frame.frameState })),
    frameGaps: hidden.map((frame) => ({ frameId: frame.frameId, url: frame.url, reason: 'hidden_frame' })),
    frameCount: entries.length,
    visibleFrames: visible.length,
    hiddenFrames: hidden.length,
    frameState: top ? pickFrameState(top.state) : pickFrameState(null),
    aggregateFrameState: aggregate,
    texts: textLog,
    events: frameEvents,
    textFloor: frameStates.reduce((sum, frame) => sum + (frame.frameState.textFloor || 0), 0) + textDropped,
    control,
    activity: {
      lastHumanAt: states.reduce((max, state) => Math.max(max, Number(state.activity && state.activity.lastHumanAt) || 0), 0),
      editing: states.some((state) => state.activity && state.activity.editing === true),
      recent,
    },
  };
}
