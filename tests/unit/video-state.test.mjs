import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VIDEO_EVENTS,
  VIDEO_STATES,
  VIDEO_STATE_ERRORS,
  allowedEventsFor,
  canTransition,
  createVideoStateMachine,
  isActiveState,
  isTerminalState,
  nextStateFor,
  recordingStateOf,
  restoreVideoStateMachine,
  stateEvidenceOf,
  summarizeStateMachine,
  transitionTable,
} from '../../extension/src/lib/video-state.js';

function clocked(start = 1000) {
  let current = start;
  return {
    now: () => current,
    set(value) { current = value; },
    advance(delta) { current += delta; },
  };
}

test('迁移表：recording→paused→finalizing→sealed 主链路与终态', () => {
  assert.deepEqual([...VIDEO_STATES], ['idle', 'recording', 'paused', 'finalizing', 'sealed', 'recovered', 'failed']);
  assert.equal(nextStateFor('idle', 'start'), 'recording');
  assert.equal(nextStateFor('recording', 'pause'), 'paused');
  assert.equal(nextStateFor('paused', 'resume'), 'recording');
  assert.equal(nextStateFor('recording', 'stop'), 'finalizing');
  assert.equal(nextStateFor('paused', 'stop'), 'finalizing');
  assert.equal(nextStateFor('finalizing', 'seal'), 'sealed');
  assert.equal(nextStateFor('recording', 'recover'), 'recovered');
  assert.equal(nextStateFor('recording', 'fail'), 'failed');
  assert.equal(nextStateFor('sealed', 'stop'), '');
  assert.equal(canTransition('idle', 'pause'), false);
  assert.deepEqual(allowedEventsFor('idle'), ['start', 'recover', 'fail', 'reset']);
  assert.deepEqual(allowedEventsFor('sealed'), ['start', 'reset']);
  assert.equal(isTerminalState('sealed'), true);
  assert.equal(isTerminalState('recording'), false);
  assert.equal(isActiveState('paused'), true);
  for (const event of VIDEO_EVENTS) {
    assert.equal(typeof transitionTable()[event], 'object');
  }
  // transitionTable 是副本，外部修改不影响内部迁移
  transitionTable().pause.recording = 'sealed';
  assert.equal(nextStateFor('recording', 'pause'), 'paused');
});

test('状态机主链路：开始→暂停→恢复→停止→封存，暂停时长不计入 duration', () => {
  const clock = clocked(1000);
  const machine = createVideoStateMachine({ id: 'rec-1', now: clock.now });
  assert.equal(machine.state, 'idle');
  assert.equal(machine.send('start', { mode: 'tabCapture' }).ok, true);
  assert.equal(machine.state, 'recording');
  clock.set(1500);
  assert.equal(machine.send('pause').ok, true);
  assert.equal(machine.state, 'paused');
  clock.set(2500);
  assert.equal(machine.elapsedMs(), 500); // 暂停期间不计时
  assert.equal(machine.pausedMs(), 1000);
  assert.equal(machine.send('resume').ok, true);
  assert.equal(machine.state, 'recording');
  clock.set(3000);
  assert.equal(machine.elapsedMs(), 1000);
  const stopped = machine.send('stop', { reason: 'user' });
  assert.equal(stopped.ok, true);
  assert.equal(machine.state, 'finalizing');
  const sealed = machine.send('seal', { reason: 'complete-finalize' });
  assert.equal(sealed.ok, true);
  assert.equal(machine.state, 'sealed');
  const snapshot = machine.snapshot();
  assert.equal(snapshot.duration_ms, 1000);
  assert.equal(snapshot.paused_ms, 1000);
  assert.equal(snapshot.pauseCount, 1);
  assert.equal(snapshot.resumeCount, 1);
  assert.equal(snapshot.terminal, true);
  assert.deepEqual(snapshot.transitions.map((entry) => entry.event), ['start', 'pause', 'resume', 'stop', 'seal']);
  assert.deepEqual(snapshot.transitions.map((entry) => entry.from), ['idle', 'recording', 'paused', 'recording', 'finalizing']);
});

test('非法迁移被拒绝并留证据，不改变状态', () => {
  const clock = clocked(1000);
  const machine = createVideoStateMachine({ id: 'rec-2', now: clock.now });
  const paused = machine.send('pause');
  assert.equal(paused.ok, false);
  assert.equal(paused.code, VIDEO_STATE_ERRORS.ILLEGAL_TRANSITION);
  assert.equal(paused.from, 'idle');
  assert.equal(paused.to, null);
  assert.deepEqual(paused.allowed_events, ['start', 'recover', 'fail', 'reset']);
  assert.equal(paused.evidence.code, VIDEO_STATE_ERRORS.ILLEGAL_TRANSITION);
  assert.equal(machine.state, 'idle');
  machine.send('start');
  const sealedEarly = machine.send('seal');
  assert.equal(sealedEarly.ok, false);
  assert.deepEqual(sealedEarly.allowed_events, ['pause', 'stop', 'recover', 'fail']);
  const unknown = machine.send('teleport');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, VIDEO_STATE_ERRORS.UNKNOWN_EVENT);
  const snapshot = machine.snapshot();
  assert.equal(snapshot.rejected.length, 3);
  assert.equal(snapshot.transitions.length, 1);
});

test('终态语义：sealed 可重新 start，reset 回到 idle', () => {
  const machine = createVideoStateMachine({ now: clocked(10).now });
  machine.send('start');
  machine.send('stop');
  machine.send('seal');
  assert.equal(machine.state, 'sealed');
  assert.equal(machine.send('start').ok, true);
  assert.equal(machine.state, 'recording');
  assert.equal(machine.send('fail', { error: 'encoder' }).ok, true);
  assert.equal(machine.state, 'failed');
  assert.equal(machine.snapshot().lastError, 'encoder');
  assert.equal(machine.send('reset').ok, true);
  assert.equal(machine.state, 'idle');
  // recover 在 fresh idle 上合法（SW 重启后的崩溃恢复入口）
  assert.equal(machine.send('recover', { recordingId: 'r-x' }).ok, true);
  assert.equal(machine.state, 'recovered');
});

test('失败与恢复：detail 被清洗成 JSON 安全字段', () => {
  const clock = clocked(100);
  const machine = createVideoStateMachine({ now: clock.now });
  machine.send('start');
  clock.set(200);
  const failed = machine.send('fail', { reason: 'capture_failed', error: new Error('boom'), dropped: [1, 2], nested: { a: 1 } });
  assert.equal(failed.ok, true);
  assert.equal(machine.state, 'failed');
  const detail = failed.snapshot.transitions.at(-1).detail;
  assert.equal(detail.reason, 'capture_failed');
  assert.equal(detail.error, '[object]'); // Error 对象被清洗成占位符，避免持久化爆掉
  assert.equal(machine.snapshot().lastError, 'Error: boom');
  assert.deepEqual(detail.dropped, [1, 2]);
  assert.equal(detail.nested, '[object]');
  assert.equal(machine.snapshot().duration_ms, 100);
});

test('onTransition 观察者异常不影响状态机', () => {
  const seen = [];
  const machine = createVideoStateMachine({
    now: clocked().now,
    onTransition: (entry) => {
      seen.push(entry.event);
      throw new Error('observer boom');
    },
  });
  assert.equal(machine.send('start').ok, true);
  assert.equal(machine.send('stop').ok, true);
  assert.deepEqual(seen, ['start', 'stop']);
  assert.equal(machine.state, 'finalizing');
});

test('快照持久化→恢复：状态/时间/证据一致；坏快照回退 idle', () => {
  const clock = clocked(5000);
  const machine = createVideoStateMachine({ id: 'rec-3', now: clock.now });
  machine.send('start');
  clock.set(7000);
  machine.send('pause');
  const snapshot = machine.snapshot();
  assert.equal(snapshot.state, 'paused');
  assert.equal(snapshot.startedAt, 5000);

  const restored = restoreVideoStateMachine(snapshot, { now: () => 9000 });
  assert.equal(restored.ok, true);
  assert.equal(restored.restored, true);
  assert.equal(restored.machine.state, 'paused');
  assert.equal(restored.machine.id, 'rec-3');
  assert.equal(restored.machine.elapsedMs(), 2000); // 9000-5000-2000(暂停)
  assert.equal(restored.machine.send('resume').ok, true);
  assert.equal(restored.machine.state, 'recording');

  const missing = restoreVideoStateMachine(null, { now: () => 1 });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, VIDEO_STATE_ERRORS.BAD_SNAPSHOT);
  assert.equal(missing.machine.state, 'idle');
  assert.equal(missing.evidence.reason, 'missing_snapshot');

  const unknown = restoreVideoStateMachine({ state: 'zombie' }, { now: () => 1 });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.evidence.reason, 'unknown_state');
  assert.equal(unknown.machine.state, 'idle');
});

test('toRecordFields / 证据截断 / summarizeStateMachine', () => {
  const clock = clocked(0);
  const machine = createVideoStateMachine({ id: 'rec-4', now: clock.now, historyLimit: 4 });
  machine.send('start');
  for (let i = 0; i < 6; i += 1) {
    clock.advance(10);
    machine.send('pause');
    machine.send('resume');
  }
  machine.send('stop', { reason: 'duration' });
  const fields = machine.toRecordFields();
  assert.equal(fields.recording_state, 'finalizing');
  assert.equal(fields.recording_stop_reason, 'duration');
  assert.equal(fields.recording_state_version, 1);
  assert.equal(fields.recording_state_evidence.length, 4);
  assert.equal(fields.pause_count, 6);
  assert.equal(fields.resume_count, 6);
  const summary = summarizeStateMachine(machine);
  assert.equal(summary.state, 'finalizing');
  assert.equal(summary.transitions, 4);
  assert.equal(summary.terminal, false);
  assert.equal(summarizeStateMachine(null), null);
});

test('recordingStateOf 兼容旧记录并推断状态', () => {
  assert.equal(recordingStateOf(null), 'idle');
  assert.equal(recordingStateOf({ recording_state: 'paused' }), 'paused');
  assert.equal(recordingStateOf({ completeness: 'complete' }), 'sealed');
  assert.equal(recordingStateOf({ completeness: 'partial' }), 'recovered');
  assert.equal(recordingStateOf({ recovered: true }), 'recovered');
  assert.equal(recordingStateOf({ failed: true }), 'failed');
  assert.equal(recordingStateOf({ bytes: 10 }), 'sealed');
  assert.equal(recordingStateOf({}), 'failed');
  assert.deepEqual(stateEvidenceOf({ recording_state_evidence: [{ event: 'start' }, { event: 'stop' }] }), [{ event: 'start' }, { event: 'stop' }]);
  assert.deepEqual(stateEvidenceOf(null), []);
});
