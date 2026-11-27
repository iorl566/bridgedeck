// src/video/state.ts —— 录制状态机（idle → recording → finalizing → ready/failed）。
//
// 与 extension/src/lib/video-state.js 同口径，但收敛成可序列化快照 + 显式迁移表：
// - 只有合法迁移才改变状态；非法迁移返回 {ok:false, evidence}，由服务层按“状态拒绝”上报（不静默忽略）；
// - snapshot() 可直接放 chrome.storage.local，SW 重启后 restoreVideoStateMachine 还原；
// - 单测用假时钟驱动，不触达任何 chrome API。

import type { RecordingEvent, RecordingPhase } from './types.ts';

export interface StateTransition {
  from: RecordingPhase;
  to: RecordingPhase;
  event: RecordingEvent;
  at: number;
  reason: string | null;
  bytes: number | null;
}

export interface StateSnapshot {
  id: string;
  state: RecordingPhase;
  startedAt: number;
  endedAt: number | null;
  transitions: StateTransition[];
}

export interface StateMachineResult {
  ok: boolean;
  state: RecordingPhase;
  transition: StateTransition | null;
  evidence: Record<string, unknown>;
}

export interface VideoStateMachine {
  readonly id: string;
  readonly state: RecordingPhase;
  readonly startedAt: number;
  send(event: RecordingEvent, detail?: { reason?: string; bytes?: number; error?: string }): StateMachineResult;
  elapsedMs(): number;
  snapshot(): StateSnapshot;
  toRecordFields(): Record<string, unknown>;
}

const ALLOWED: Record<RecordingPhase, Partial<Record<RecordingEvent, RecordingPhase>>> = {
  idle: { start: 'recording', recover: 'recovered' },
  recording: { stop: 'finalizing', seal: 'ready', fail: 'failed', recover: 'recovered', pause: 'recording', resume: 'recording' },
  finalizing: { seal: 'ready', fail: 'failed', recover: 'recovered' },
  ready: { start: 'recording', recover: 'recovered' },
  failed: { start: 'recording', recover: 'recovered' },
  recovered: { start: 'recording', recover: 'recovered' },
};

const MAX_TRANSITIONS = 40;

export interface CreateStateMachineOptions {
  id: string;
  initial?: RecordingPhase;
  startedAt?: number;
  now?: () => number;
  transitions?: StateTransition[];
}

/** 建一个录制状态机；initial 只用于恢复（默认 idle）。 */
export function createVideoStateMachine(options: CreateStateMachineOptions): VideoStateMachine {
  const now = options.now ?? (() => Date.now());
  let state: RecordingPhase = options.initial ?? 'idle';
  let startedAt = Number(options.startedAt) > 0 ? Number(options.startedAt) : now();
  let endedAt: number | null = state === 'ready' || state === 'recovered' ? startedAt : null;
  const transitions: StateTransition[] = Array.isArray(options.transitions) ? [...options.transitions].slice(-MAX_TRANSITIONS) : [];

  const recordField = (): Record<string, unknown> => ({
    id: options.id,
    recording_state: state,
    startedAt,
    ...(endedAt !== null ? { endedAt } : {}),
  });

  return {
    id: options.id,
    get state() { return state; },
    get startedAt() { return startedAt; },
    send(event, detail) {
      const next = ALLOWED[state]?.[event];
      const evidenceBase: Record<string, unknown> = {
        id: options.id,
        from: state,
        event,
        at: now(),
        ...(detail?.reason ? { reason: detail.reason } : {}),
      };
      if (!next) {
        return {
          ok: false,
          state,
          transition: null,
          evidence: { ...evidenceBase, rejection: 'illegal_transition', allowed: Object.keys(ALLOWED[state] ?? {}) },
        };
      }
      const transition: StateTransition = {
        from: state,
        to: next,
        event,
        at: now(),
        reason: detail?.reason ?? null,
        bytes: Number.isFinite(Number(detail?.bytes)) ? Number(detail?.bytes) : null,
      };
      state = next;
      if (next === 'recording') {
        startedAt = transition.at;
        endedAt = null;
      }
      if (next === 'ready' || next === 'recovered' || next === 'failed') endedAt = transition.at;
      transitions.push(transition);
      if (transitions.length > MAX_TRANSITIONS) transitions.splice(0, transitions.length - MAX_TRANSITIONS);
      return { ok: true, state, transition, evidence: { ...evidenceBase, to: next } };
    },
    elapsedMs() {
      const end = endedAt !== null ? endedAt : now();
      return Math.max(0, end - startedAt);
    },
    snapshot() {
      return { id: options.id, state, startedAt, endedAt, transitions: transitions.map((item) => ({ ...item })) };
    },
    toRecordFields() {
      return { ...recordField(), state_transitions: transitions.slice(-8).map((item) => ({ ...item })) };
    },
  };
}

/** 从 chrome.storage.local 的快照还原；坏快照不抛错，返回 idle 并给出证据。 */
export function restoreVideoStateMachine(
  snapshot: unknown,
  options: { now?: () => number; id?: string } = {},
): { machine: VideoStateMachine; restored: boolean; evidence: Record<string, unknown> | null } {
  const bag = snapshot && typeof snapshot === 'object' ? snapshot as Partial<StateSnapshot> : null;
  const now = options.now ?? (() => Date.now());
  if (!bag || typeof bag.id !== 'string' || !bag.state) {
    return {
      machine: createVideoStateMachine({ id: options.id ?? 'video', now }),
      restored: false,
      evidence: bag ? { reason: 'bad_snapshot' } : null,
    };
  }
  const validStates: RecordingPhase[] = ['idle', 'recording', 'finalizing', 'ready', 'failed', 'recovered'];
  if (!validStates.includes(bag.state)) {
    return {
      machine: createVideoStateMachine({ id: bag.id, now }),
      restored: false,
      evidence: { reason: 'bad_state', state: bag.state },
    };
  }
  const transitions = Array.isArray(bag.transitions)
    ? bag.transitions.filter((item): item is StateTransition => Boolean(item) && typeof item === 'object' && typeof item.from === 'string' && typeof item.to === 'string' && typeof item.event === 'string')
    : [];
  return {
    machine: createVideoStateMachine({
      id: bag.id,
      initial: bag.state,
      startedAt: Number(bag.startedAt) > 0 ? Number(bag.startedAt) : now(),
      now,
      transitions,
    }),
    restored: true,
    evidence: null,
  };
}
