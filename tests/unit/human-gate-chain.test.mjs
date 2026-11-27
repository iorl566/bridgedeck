// tests/unit/human-gate-chain.test.mjs —— 人机互斥证据链 v2：
//   1) 链条目/封存/校验（逐条重算、篡改定位、空链可校验）；
//   2) 多来源链合并（按时间排序、来源标签、who 统计、上限）；
//   3) 人机冲突证书（字段、digest 可复算、篡改检测）；
//   4) 真实 createHumanGate 接线：noteHuman/noteAgentWindow/state/exclusive/chainEvidence
//      只新增 chain/cooperation/mayAct 字段，互斥判定（allowed/code/state）保持不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HUMAN_CHAIN_CODES,
  HUMAN_CHAIN_LIMITS,
  HUMAN_CHAIN_VERSION,
  compareHumanChain,
  describeHumanChain,
  humanConflictCertificate,
  humanSignalEntry,
  mergeHumanChains,
  normalizeHumanChainSignal,
  sealHumanChain,
  summarizeHumanChain,
  verifyConflictCertificate,
  verifyHumanChain,
} from '../../extension/src/lib/human-gate-chain.js';
import { createHumanGate, HUMAN_GATE_STATES } from '../../extension/src/lib/human-gate.js';
import { verifyMayActChain } from '../../extension/src/lib/cooperate-evidence.js';

function signal(overrides = {}) {
  return { at: 1000, kind: 'input', frameId: 0, source: 'human-state', trusted: true, count: 1, revision: 1, label: '', ...overrides };
}

function chainOf(specs) {
  const entries = [];
  let previous = null;
  for (let index = 0; index < specs.length; index += 1) {
    const normalized = normalizeHumanChainSignal(specs[index].signal, specs[index].attribution || {}, { seq: index + 1, state: specs[index].state || 'human-active' });
    const entry = humanSignalEntry(previous, normalized);
    entries.push(entry);
    previous = entry;
  }
  return entries;
}

test('normalizeHumanChainSignal：默认值/归因白名单/置信度夹紧/非法输入', () => {
  assert.equal(normalizeHumanChainSignal(null), null);
  assert.equal(normalizeHumanChainSignal('nope'), null);
  const normalized = normalizeHumanChainSignal(signal({ at: 1500 }), { who: 'agent', basis: 'agent-window', confidence: 2 }, { seq: 4, state: 'cooling' });
  assert.equal(normalized.seq, 4);
  assert.equal(normalized.at, 1500);
  assert.equal(normalized.who, 'agent');
  assert.equal(normalized.basis, 'agent-window');
  assert.equal(normalized.confidence, 1, '置信度夹紧到 [0,1]');
  assert.equal(normalized.state, 'cooling');
  assert.equal(normalized.count, 1);
  assert.equal(normalized.trusted, true);
  assert.equal(normalized.revision, 1);

  const unknown = normalizeHumanChainSignal(signal(), { who: 'robot' });
  assert.equal(unknown.who, 'unknown');
  assert.equal(unknown.confidence, 0);
  assert.equal(unknown.state, 'idle');
});

test('humanSignalEntry：链式 digest 稳定、prevDigest 链接、字段改动改变 digest', () => {
  const first = humanSignalEntry(null, normalizeHumanChainSignal(signal()));
  assert.equal(first.prevDigest, 'genesis');
  assert.match(first.digest, /^[0-9a-f]{8}$/);
  const second = humanSignalEntry(first, normalizeHumanChainSignal(signal({ at: 1100 }), {}, { seq: 2 }));
  assert.equal(second.prevDigest, first.digest);
  assert.notEqual(second.digest, first.digest);
  const again = humanSignalEntry(null, normalizeHumanChainSignal(signal()));
  assert.equal(again.digest, first.digest);
  const changed = humanSignalEntry(null, normalizeHumanChainSignal(signal({ count: 9 })));
  assert.notEqual(changed.digest, first.digest);
  assert.equal(humanSignalEntry(null, null), null);
});

test('sealHumanChain/verifyHumanChain：已链条目原样封存、裸条目重新链接、空链/篡改/坏参数', () => {
  const entries = chainOf([
    { signal: signal({ at: 1000 }), attribution: { who: 'human', basis: 'human-state', confidence: 0.9 } },
    { signal: signal({ at: 1100, kind: 'click' }), attribution: { who: 'human', basis: 'attributed-count', confidence: 0.95 } },
  ]);
  const sealed = sealHumanChain(entries, { tabId: 7 });
  assert.equal(sealed.version, HUMAN_CHAIN_VERSION);
  assert.equal(sealed.count, 2);
  assert.equal(sealed.firstAt, 1000);
  assert.equal(sealed.lastAt, 1100);
  assert.equal(sealed.digest, entries[1].digest);
  assert.equal(sealed.extra.tabId, 7);
  assert.equal(verifyHumanChain(sealed).ok, true);

  const plain = sealHumanChain([signal({ at: 1000 }), signal({ at: 1200, kind: 'select' })]);
  assert.equal(plain.count, 2);
  assert.equal(plain.entries[0].prevDigest, 'genesis', '裸信号重新链接：首条 prevDigest=genesis');
  assert.match(plain.entries[0].digest, /^[0-9a-f]{8}$/);
  assert.equal(plain.entries[1].prevDigest, plain.entries[0].digest);
  assert.equal(verifyHumanChain(plain).ok, true);

  assert.equal(verifyHumanChain(sealHumanChain([])).ok, true, '空链也能校验');
  const tampered = { ...sealed, entries: sealed.entries.map((entry, index) => (index === 0 ? { ...entry, kind: '被改' } : entry)) };
  const check = verifyHumanChain(tampered);
  assert.equal(check.ok, false);
  assert.equal(check.code, HUMAN_CHAIN_CODES.CHAIN_MISMATCH);
  assert.equal(check.index, 0);
  assert.equal(verifyHumanChain(null).ok, false);
  assert.equal(verifyHumanChain({}).code, HUMAN_CHAIN_CODES.CHAIN_BAD_ARG);
});

test('mergeHumanChains：多链按时间合并、来源标签、who 统计、上限截断', () => {
  const left = sealHumanChain(chainOf([
    { signal: signal({ at: 1000, kind: 'input', source: 'human-state' }), attribution: { who: 'human', basis: 'human-state' } },
    { signal: signal({ at: 1400, kind: 'click', source: 'attributed' }), attribution: { who: 'human', basis: 'attributed-count' } },
  ]), { tabId: 1 });
  const right = sealHumanChain(chainOf([
    { signal: signal({ at: 1200, kind: 'agent-window', source: 'agent-window', count: 0 }), attribution: { who: 'agent', basis: 'agent-window', confidence: 1 } },
  ]), { tabId: 2 });
  const merged = mergeHumanChains([left, right]);
  assert.equal(merged.merged, true);
  assert.equal(merged.count, 3);
  assert.equal(merged.sources.length, 2);
  assert.equal(merged.sources[0].source, 'tab:1');
  assert.equal(merged.sources[1].source, 'tab:2');
  assert.deepEqual(merged.entries.map((entry) => entry.at), [1000, 1200, 1400]);
  assert.equal(merged.byWho.human, 2);
  assert.equal(merged.byWho.agent, 1);
  assert.equal(merged.entries[0].source.includes('@tab:1'), true);
  assert.equal(merged.digest, merged.entries[2].digest);
  assert.equal(merged.sources !== null, true);

  const bounded = mergeHumanChains([left, right], { maxEntries: 2 });
  assert.equal(bounded.count, 2);
  assert.deepEqual(bounded.entries.map((entry) => entry.at), [1200, 1400]);
  assert.equal(mergeHumanChains(null).count, 0);
  assert.ok(HUMAN_CHAIN_LIMITS.maxEntries >= 64);
});

test('humanConflictCertificate/verifyConflictCertificate：字段、digest 回算、篡改与缺失', () => {
  const certificate = humanConflictCertificate({
    tabId: 9,
    at: 5000,
    human: { lastAt: 4900, lastKind: 'input', ageMs: 100, state: 'conflict' },
    leases: [
      { leaseId: 'coop-lease-1', kind: 'native-input', method: 'click', startedAt: 4850, active: true },
      { leaseId: 'coop-lease-2', kind: 'capture', startedAt: 4950, active: false },
    ],
    conflict: { conflicting: true, overlapMs: 50, leaseStart: 4850, evidence: { toleranceMs: 1.5 } },
    decision: { allowed: false, code: 'E_HUMAN_GATE', source: 'human', method: 'click' },
    chainDigest: 'abcd1234',
    toleranceMs: 1.5,
  });
  assert.equal(certificate.version, HUMAN_CHAIN_VERSION);
  assert.equal(certificate.kind, 'human.conflict');
  assert.equal(certificate.tabId, 9);
  assert.equal(certificate.leases.length, 2);
  assert.equal(certificate.conflict.conflicting, true);
  assert.equal(certificate.conflict.overlapMs, 50);
  assert.equal(certificate.decision.allowed, false);
  assert.equal(certificate.decision.code, 'E_HUMAN_GATE');
  assert.equal(certificate.chainDigest, 'abcd1234');
  assert.match(certificate.digest, /^[0-9a-f]{8}$/);
  assert.equal(verifyConflictCertificate(certificate).ok, true);
  assert.equal(verifyConflictCertificate(certificate).conflicting, true);

  const tampered = { ...certificate, tabId: 10 };
  assert.equal(verifyConflictCertificate(tampered).ok, false);
  assert.equal(verifyConflictCertificate(tampered).code, HUMAN_CHAIN_CODES.CERT_MISMATCH);
  assert.equal(verifyConflictCertificate(null).ok, false);
  assert.equal(verifyConflictCertificate(null).code, HUMAN_CHAIN_CODES.CERT_MISSING);
});

test('summarizeHumanChain/describeHumanChain/compareHumanChain：紧凑统计与一致性', () => {
  const entries = chainOf([
    { signal: signal({ at: 1000, kind: 'input' }), attribution: { who: 'human', basis: 'human-state' } },
    { signal: signal({ at: 1100, kind: 'agent-window', source: 'agent-window' }), attribution: { who: 'agent', basis: 'agent-window' } },
    { signal: signal({ at: 1200, kind: 'select' }), attribution: { who: 'unknown', basis: 'untrusted' } },
  ]);
  const summary = summarizeHumanChain(entries);
  assert.equal(summary.version, HUMAN_CHAIN_VERSION);
  assert.equal(summary.count, 3);
  assert.equal(summary.byWho.human, 1);
  assert.equal(summary.byWho.agent, 1);
  assert.equal(summary.byWho.unknown, 1);
  assert.equal(summary.lastAt, 1200);
  assert.equal(summary.lastKind, 'select');
  assert.equal(summary.digest, entries[2].digest);
  assert.equal(summary.kinds.includes('input'), true);
  assert.ok(JSON.stringify(summary).length < 500);
  assert.equal(summarizeHumanChain(null), null);
  assert.equal(summarizeHumanChain({}), null);
  assert.match(describeHumanChain(summary), /^human-chain=3/);
  assert.match(describeHumanChain(summary), /human=1/);
  assert.equal(describeHumanChain(null), 'human-chain: 无链');

  const sealed = sealHumanChain(entries);
  assert.deepEqual(compareHumanChain(entries, sealed), { ok: true, code: null, live: sealed.digest, sealed: sealed.digest, delta: 0 });
  const mismatch = compareHumanChain(entries.slice(0, 2), sealed);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.delta, -1);
  assert.equal(compareHumanChain(entries, null).code, HUMAN_CHAIN_CODES.CERT_MISSING);
});

test('接线：human-gate 的 noteHuman/noteAgentWindow 进链，state().chain 与 chainEvidence 可校验', () => {
  let clock = 10_000;
  const gate = createHumanGate({ now: () => clock, activeMs: 1000, coolingMs: 200, historyLimit: 16 });
  const noted = gate.noteHuman(21, { at: clock, kind: 'click', frameId: 2, label: '#go' });
  assert.equal(noted.ok, true);
  assert.equal(noted.attribution.who, 'human');

  clock += 50;
  const window = gate.noteAgentWindow(21, { start: clock, end: Infinity });
  assert.equal(window.ok, true);

  const state = gate.state(21);
  assert.equal(state.chain.version, HUMAN_CHAIN_VERSION);
  assert.equal(state.chain.count, 2, '人工信号 + agent 窗口各一条');
  assert.equal(state.chain.byWho.human, 1);
  assert.equal(state.chain.byWho.agent, 1);
  assert.equal(state.mayAct.count, 0);

  const evidence = gate.chainEvidence(21);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.chain.count, 2);
  assert.equal(evidence.verified.ok, true);
  assert.equal(evidence.tabId, 21);

  const sealed = sealHumanChain(evidence.chain.entries);
  assert.equal(verifyHumanChain(sealed).ok, true);

  const counters = gate.counters();
  assert.equal(counters.chainEntries >= 2, true);
  assert.equal(counters.mayActDecisions, 0);
  assert.equal(gate.chainEvidence(21, { leases: [] }).ok, true);
  assert.equal(gate.chainEvidence(null).ok, false);
});

test('接线：exclusive() 追加 cooperation + mayAct 链，判定结果与第一轮一致', () => {
  let clock = 20_000;
  const gate = createHumanGate({ now: () => clock, activeMs: 500, coolingMs: 100 });
  clock += 10;
  gate.noteHuman(22, { at: clock, kind: 'input', frameId: 0 });
  clock += 20;

  // 人工仍在活跃窗：判定必须仍然拒绝（与没有新字段时完全相同）。
  const blocked = gate.exclusive(22, { method: 'click' });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.code, 'E_HUMAN_GATE');
  assert.equal(blocked.state, HUMAN_GATE_STATES.HUMAN_ACTIVE);
  assert.equal(blocked.evidence.source, 'human');
  // 新字段：cooperation 证据包 + mayAct 链节。
  assert.equal(blocked.evidence.cooperation.version, 1);
  assert.match(blocked.evidence.cooperation.digest, /^[0-9a-f]{8}$/);
  assert.equal(blocked.evidence.cooperation.flags.humanActive, true);
  assert.equal(blocked.evidence.mayAct.seq, 1);
  assert.match(blocked.evidence.mayAct.chainDigest, /^[0-9a-f]{8}$/);

  // controller 闸门优先：判定来源仍是 controller，附加字段同样存在。
  const controllerBlocked = gate.exclusive(22, { method: 'click', controllerGate: { allowed: false, code: 'E_SESSION_STATE', evidence: { reason: 'paused' } } });
  assert.equal(controllerBlocked.code, 'E_SESSION_STATE');
  assert.equal(controllerBlocked.evidence.source, 'controller');
  assert.equal(controllerBlocked.evidence.cooperation.controller.allowed, false);
  assert.equal(controllerBlocked.evidence.mayAct.seq, 2);

  // 冷却后放行：既有字段不变，evidence 里 mayAct 递增。
  clock += 700;
  const allowed = gate.exclusive(22, { method: 'hover' });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.code, null);
  assert.equal(allowed.evidence.mayAct.seq, 3);
  const state = gate.state(22);
  assert.equal(state.mayAct.count, 3);
  assert.match(state.mayAct.digest, /^[0-9a-f]{8}$/);

  const chainEvidence = gate.chainEvidence(22);
  assert.equal(chainEvidence.mayAct.count, 3);
  assert.equal(chainEvidence.mayAct.verified.ok, true);
  assert.equal(verifyMayActChain(chainEvidence.mayAct.entries).ok, true);
  assert.equal(gate.counters().mayActDecisions, 3);
  gate.clear(22);
});

test('接线：人机冲突时给出可校验的冲突证书（conflictCertificate）', () => {
  let clock = 30_000;
  const gate = createHumanGate({ now: () => clock, activeMs: 2000, coolingMs: 100 });
  gate.noteHuman(23, { at: clock, kind: 'input', frameId: 1 });
  clock += 10;
  const leases = [{ leaseId: 'coop-lease-9', kind: 'native-input', method: 'click', startedAt: clock - 20, active: true }];
  const conflicted = gate.exclusive(23, { method: 'click', leases });
  assert.equal(conflicted.allowed, false);
  assert.equal(conflicted.code, 'E_HUMAN_GATE');
  assert.equal(conflicted.evidence.conflict.conflicting, true);
  assert.ok(conflicted.evidence.conflictCertificate);
  assert.equal(conflicted.evidence.conflictCertificate.kind, 'human.conflict');
  assert.equal(conflicted.evidence.conflictCertificate.conflict.conflicting, true);
  assert.equal(conflicted.evidence.conflictCertificate.leases.length, 1);
  assert.equal(verifyConflictCertificate(conflicted.evidence.conflictCertificate).ok, true);
  // 同一判定重复执行：证书仍可校验（digest 每次按当前时刻重算）。
  const again = gate.exclusive(23, { method: 'click', leases });
  assert.equal(verifyConflictCertificate(again.evidence.conflictCertificate).ok, true);
  gate.reset();
});

test('接线：evidence() 返回封存链 + 校验结论；篡改链条目可定位', () => {
  let clock = 40_000;
  const gate = createHumanGate({ now: () => clock });
  gate.noteHuman(24, { at: clock, kind: 'input' });
  clock += 10;
  const evidence = gate.evidence(24);
  assert.equal(evidence.ok, true);
  assert.equal(evidence.chain.sealed, true);
  assert.equal(evidence.chainVerified, true);
  assert.equal(evidence.mayActChainVerified, true);
  assert.equal(Array.isArray(evidence.mayActChain), true);

  const tampered = { ...evidence.chain, entries: evidence.chain.entries.map((entry) => ({ ...entry, label: 'tampered' })) };
  assert.equal(verifyHumanChain(tampered).ok, false);
  assert.equal(gate.counters().tabs, 1);
  gate.reset();
  assert.equal(gate.counters().tabs, 0);
});

test('接线：noteAttributed/noteAgentWindow/closeAgentWindow 的链条目语义', () => {
  let clock = 50_000;
  const gate = createHumanGate({ now: () => clock });
  const attributed = gate.noteAttributed(25, { humanAttributed: 3, agentAttributed: 1, at: clock, frameId: 0 });
  assert.equal(attributed.ok, true);
  assert.equal(attributed.deltas.human, 3);
  const afterHuman = gate.state(25);
  assert.equal(afterHuman.chain.byWho.human >= 1, true);
  const countBeforeAgent = afterHuman.chain.count;

  // 只报告 agent 计数时：不进人工链（avoid 把 Agent 自产事件当人在动）。
  gate.noteAttributed(25, { humanAttributed: 3, agentAttributed: 5, at: clock });
  assert.equal(gate.state(25).chain.count, countBeforeAgent);

  clock += 10;
  const window = gate.noteAgentWindow(25, { start: clock, end: Infinity });
  assert.equal(window.count, 1);
  assert.equal(gate.state(25).chain.byWho.agent >= 1, true);
  const closed = gate.closeAgentWindow(25, clock + 5);
  assert.equal(closed.closed, 1);
  assert.equal(gate.state(25).chain.count, countBeforeAgent + 1, 'closeAgentWindow 不产生新链条目');

  const chain = gate.chainEvidence(25);
  assert.equal(chain.verified.ok, true);
  const merged = mergeHumanChains([chain.chain, chain.chain]);
  assert.equal(merged.count, chain.chain.count * 2);
  const compared = compareHumanChain(chain.chain.entries, sealHumanChain(chain.chain.entries));
  assert.equal(compared.ok, true);
  gate.clear(25);
});
