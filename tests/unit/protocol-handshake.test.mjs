// tests/unit/protocol-handshake.test.mjs —— 版本层握手报告（negotiateHandshake）单测。
//
// 与 feature floor 的分工：
//   - 握手层只决定“连不连、谁旧谁新、是否 major 偏斜”；
//   - 连上之后，每个方法/参数由 lib/protocol-features.mjs 的 feature floor 逐调用判定。
// 本测试把两者交叉，确保“握手 accept”不会被误读成“所有特性可用”。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
} from '../../lib/method-catalog.mjs';
import {
  handshakeMatrix,
  negotiateHandshake,
  protocolBand,
  protocolSkew,
} from '../../lib/protocol.mjs';
import { protocolGate } from '../../lib/protocol-features.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('握手决策：当前/更高 minor accept；低于基线 reject-with-upgrade；major 不同/不可解析 reject', () => {
  const current = negotiateHandshake(PROTOCOL_CURRENT);
  assert.equal(current.decision, 'accept');
  assert.equal(current.severity, 'none');
  assert.equal(current.sameMajor, true);
  assert.equal(current.order, 0);
  assert.match(current.reason, /协议一致/);
  assert.ok(current.steps.length >= 1);

  const baseline = negotiateHandshake(PROTOCOL_BASELINE);
  assert.equal(baseline.decision, 'accept', '1.8 仍在兼容基线内');
  assert.equal(baseline.severity, 'warn');
  assert.equal(baseline.peerBand, 'baseline');
  assert.match(baseline.reason, /feature floor/);
  assert.ok(baseline.steps.some((step) => step.includes(PROTOCOL_CURRENT)));

  const ahead = negotiateHandshake('1.10');
  assert.equal(ahead.decision, 'accept');
  assert.equal(ahead.severity, 'info');
  assert.match(ahead.reason, /未知字段|忽略/);

  for (const old of ['1.0', '1.7']) {
    const result = negotiateHandshake(old);
    assert.equal(result.decision, 'reject-with-upgrade', old);
    assert.equal(result.severity, 'fatal');
    assert.equal(result.known, true);
    assert.equal(result.sameMajor, true);
    assert.match(result.reason, /低于兼容基线/);
    assert.ok(result.steps.some((step) => step.includes('1.8')));
  }

  for (const version of ['2.0', '3.1', '', 'x', null, undefined]) {
    const result = negotiateHandshake(version);
    assert.equal(result.decision, 'reject', String(version));
    assert.equal(result.severity, 'fatal');
  }
  assert.equal(negotiateHandshake('').known, false);
  assert.equal(negotiateHandshake('2.0').sameMajor, false);
});

test('握手报告与 protocolSkew/protocolBand 交叉一致', () => {
  for (const version of [PROTOCOL_BASELINE, PROTOCOL_CURRENT, '1.7', '1.10', '2.0', 'x', '']) {
    const report = negotiateHandshake(version);
    const skew = protocolSkew(String(version == null ? '' : version), PROTOCOL_CURRENT);
    assert.equal(report.skew.relation, skew.relation, String(version));
    assert.equal(report.skew.severity, skew.severity, String(version));
    assert.equal(report.peerBand, protocolBand(version), String(version));
    assert.equal(report.daemonBand, 'current');
    assert.equal(report.daemon, PROTOCOL_CURRENT);
  }
});

test('握手决策的严重度分级：none / warn / info / fatal 四档都被覆盖', () => {
  const decisions = ['1.9', '1.8', '1.10', '2.0', '1.7', 'x'].map((version) => negotiateHandshake(version));
  const severities = new Set(decisions.map((item) => item.severity));
  assert.deepEqual([...severities].sort(), ['fatal', 'info', 'none', 'warn']);
  const accepts = decisions.filter((item) => item.decision === 'accept');
  assert.equal(accepts.length, 3);
  assert.equal(decisions.filter((item) => item.decision === 'reject').length, 2);
  assert.equal(decisions.filter((item) => item.decision === 'reject-with-upgrade').length, 1);
});

test('握手通过 ≠ 所有特性可用：1.8 accept 但新特性被 feature floor 拒绝', () => {
  const old = negotiateHandshake(PROTOCOL_BASELINE);
  assert.equal(old.decision, 'accept');
  // 同一次握手 accept 之后，新旧能力仍然由 floor 分流：
  assert.equal(protocolGate({ protocol: PROTOCOL_BASELINE }, 'click', {}).ok, true);
  assert.equal(protocolGate({ protocol: PROTOCOL_BASELINE }, 'video.start', {}).ok, false);
  assert.equal(protocolGate({ protocol: PROTOCOL_BASELINE }, 'read', {}).ok, false);
  assert.equal(protocolGate({ protocol: PROTOCOL_BASELINE }, 'screenshot', { stream: true }).ok, false);
  // 当前协议握手 accept 之后，gated 调用才全部放行。
  assert.equal(negotiateHandshake(PROTOCOL_CURRENT).decision, 'accept');
  assert.equal(protocolGate({ protocol: PROTOCOL_CURRENT }, 'video.start', {}).ok, true);
});

test('自定义 daemon 版本：对端 1.9 对 daemon 2.0 属于 major 偏斜，必须 reject', () => {
  const report = negotiateHandshake('1.9', '2.0');
  assert.equal(report.decision, 'reject');
  assert.equal(report.sameMajor, false);
  assert.equal(report.severity, 'fatal');
  assert.equal(report.daemon, '2.0');
  assert.match(report.reason, /major 不同/);
  // 对端等于 daemon 版本时 accept（握手只比较两者）
  assert.equal(negotiateHandshake('2.0', '2.0').decision, 'accept');
});

test('handshakeMatrix：默认探针的决策计数与逐行结果一致', () => {
  const matrix = handshakeMatrix();
  assert.equal(matrix.daemon, PROTOCOL_CURRENT);
  assert.equal(matrix.rows.length, 6);
  assert.deepEqual(matrix.counts, { accept: 3, 'reject-with-upgrade': 1, reject: 2 });
  for (const row of matrix.rows) {
    assert.equal(row.daemon, PROTOCOL_CURRENT);
    assert.equal(row.decision, negotiateHandshake(row.peer).decision, row.peer);
    assert.ok(Array.isArray(row.steps) && row.steps.length >= 1, row.peer);
  }
  const peers = matrix.rows.map((row) => row.peer);
  assert.deepEqual(peers, [PROTOCOL_BASELINE, PROTOCOL_CURRENT, '1.7', '1.10', '2.0', 'x']);
});

test('handshakeMatrix：可传自定义对端列表，冻结且可 JSON 序列化', () => {
  const matrix = handshakeMatrix(['1.8', '1.9'], '1.9');
  assert.equal(matrix.rows.length, 2);
  assert.deepEqual(matrix.counts, { accept: 2 });
  const wire = JSON.parse(JSON.stringify(matrix));
  assert.equal(wire.rows[0].decision, 'accept');
  assert.equal(wire.rows[1].peer, '1.9');
  assert.ok(Object.isFrozen(matrix));
  assert.ok(Object.isFrozen(matrix.rows));
});

test('握手报告的步骤可执行：reject 给升级 major，reject-with-upgrade 给升级协议', () => {
  const major = negotiateHandshake('2.0');
  assert.ok(major.steps.some((step) => step.includes('major')));
  const legacy = negotiateHandshake('1.0');
  assert.ok(legacy.steps.some((step) => step.includes('升级浏览器扩展')));
  assert.ok(legacy.steps.some((step) => step.includes('feature floor')));
  const current = negotiateHandshake(PROTOCOL_CURRENT);
  assert.ok(current.steps.some((step) => step.includes('继续')));
});

test('依赖方向：版本层不 import 特性层（避免循环）', () => {
  const protocolSource = fs.readFileSync(path.join(ROOT, 'lib', 'protocol.mjs'), 'utf8');
  assert.equal(/from '\.\/protocol-features\.mjs'/.test(protocolSource), false, 'protocol.mjs 不得依赖 protocol-features.mjs');
  assert.match(protocolSource, /from '\.\/method-catalog\.mjs'/);
  const base = fs.readFileSync(path.join(ROOT, 'lib', 'protocol-features.mjs'), 'utf8');
  assert.match(base, /from '\.\/protocol\.mjs'/);
});

test('握手层无副作用：同一输入重复调用结果深度相等', () => {
  for (const version of [PROTOCOL_BASELINE, PROTOCOL_CURRENT, '1.0', '2.0', 'x']) {
    const first = negotiateHandshake(version);
    const second = negotiateHandshake(version);
    assert.deepEqual(first, second, version);
    for (const value of Object.values(first)) assert.notEqual(value, undefined);
  }
});
