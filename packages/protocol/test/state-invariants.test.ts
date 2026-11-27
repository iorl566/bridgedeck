// packages/protocol/test/state-invariants.test.ts —— 五维状态语义的硬断言（不依赖差分）。
//
// 差分测试证明 TS 与 JS 相同，本文件证明“相同的那份数据本身满足状态机不变量”：
// - partial 只出现在只读方法上，unknown 只出现在需要回执的变异上；
// - 变异方法必须有收敛策略，非变异方法必须是 none，status 收敛目标必须是只读方法；
// - 关键方法的期望状态（手写预期值，防止源被悄悄改成“都合法但错”的形状）；
// - 分桶覆盖与 daemon/extension 方法面拆分正确。

import test from 'node:test';
import assert from 'node:assert/strict';

import * as ts from '../src/index.ts';
import type { MethodEffect, MethodName } from '../src/index.ts';

const READ_EFFECTS = new Set<MethodEffect>(['passive_read', 'read']);
const MUTATING_EFFECTS = new Set<MethodEffect>(['transient_input', 'browser_mutation']);

test('目录规模与分桶覆盖（硬编码口径，防止源被悄悄改小）', () => {
  assert.equal(ts.METHOD_COUNT, 165);
  assert.equal(ts.FEATURE_NAMES.length, 9);
  assert.deepEqual([...ts.FEATURE_NAMES], [
    'unverified', 'expect', 'read', 'observe-delta', 'plan', 'video', 'capture.stream', 'debug.journal', 'har',
  ]);
  assert.equal(ts.METHOD_PARTIAL.length, 12);
  assert.equal(ts.METHOD_UNKNOWN.length, 75);
  assert.equal(ts.receiptMethodNames().length, 69);
  const buckets = ts.ownerBuckets();
  assert.equal(buckets.local.length, 39);
  assert.equal(buckets.session.length, 109);
  assert.equal(buckets.instance.length, 17);
  assert.equal(buckets.local.length + buckets.session.length + buckets.instance.length, ts.METHOD_COUNT);
  assert.equal(ts.DAEMON_METHODS.length, buckets.local.length + ts.DAEMON_ONLY_METHODS.length);
  assert.equal(ts.EXTENSION_METHODS.length, buckets.session.length + buckets.instance.length);
});

test('partial 只出现在只读方法，unknown 只出现在需要回执的变异（全量逐方法）', () => {
  for (const method of ts.METHOD_NAMES) {
    const state = ts.requireCatalogRow(method);
    if (state.partial) {
      assert.ok(READ_EFFECTS.has(state.effect), method + ' partial 必须是只读（effect=' + state.effect + '）');
      assert.equal(state.unknown, false, method + ' partial 方法不应同时 unknown');
    }
    if (state.unknown) {
      assert.ok(MUTATING_EFFECTS.has(state.effect) || ts.MUTATING_OVERRIDES.includes(method),
        method + ' unknown 必须来自需要回执的变异（effect=' + state.effect + '）');
    }
    if (MUTATING_EFFECTS.has(state.effect)) {
      assert.equal(state.receipt, true, method + ' 变异方法必须有回执');
    }
    if (state.reconcile.strategy === 'none') {
      assert.equal(state.unknown, false, method + ' 有 unknown 风险的必须给收敛策略');
    } else {
      assert.equal(state.unknown, true, method + ' 有收敛策略的方法必须是 unknown 语义');
    }
    if (state.reconcile.strategy === 'status') {
      const targetName = state.reconcile.method;
      assert.ok(targetName, method + ' status 收敛必须给目标方法');
      const target = ts.requireCatalogRow(targetName);
      // 目录口径：收敛目标不得是变异/瞬时输入方法（只读或控制面只读均可）。
      assert.ok(!MUTATING_EFFECTS.has(target.effect), method + ' 的收敛目标不得是变异方法');
    }
  }
});

test('关键方法期望状态（手写预期，防止“合法但语义错”）', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(ts.methodState('video.start'))), {
    owner: 'session',
    effect: 'browser_mutation',
    partial: false,
    unknown: true,
    reconcile: { strategy: 'status', method: 'video.status' },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(ts.methodState('observe'))), {
    owner: 'session',
    effect: 'passive_read',
    partial: true,
    unknown: false,
    reconcile: { strategy: 'none', method: null },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(ts.methodState('click'))), {
    owner: 'session',
    effect: 'browser_mutation',
    partial: false,
    unknown: true,
    reconcile: { strategy: 'observe', method: null },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(ts.methodState('session.start'))), {
    owner: 'local',
    effect: 'control_plane',
    partial: false,
    unknown: true,
    reconcile: { strategy: 'ledger', method: null },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(ts.methodState('read'))), {
    owner: 'session',
    effect: 'passive_read',
    partial: false,
    unknown: false,
    reconcile: { strategy: 'none', method: null },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(ts.methodState('tab.new'))), {
    owner: 'instance',
    effect: 'browser_mutation',
    partial: false,
    unknown: true,
    reconcile: { strategy: 'status', method: 'tab.list' },
  });
  assert.equal(ts.floorOf('video.start'), '1.9');
  assert.equal(ts.floorOf('read'), '1.9');
  assert.equal(ts.floorOf('click'), null, 'click 没有方法级特性门');
  assert.equal(ts.ownerOf('tab.list'), 'instance');
  assert.equal(ts.ownerOf('session.list'), 'local');
});

test('特性门方法级反向表：read/plan/video/capture.stream/debug.journal/har 闭合', () => {
  assert.deepEqual([...ts.methodsGatedBy('read')], ['read']);
  assert.deepEqual([...ts.methodsGatedBy('plan')], ['plan']);
  assert.deepEqual([...ts.methodsGatedBy('video')], [
    'video.start', 'video.stop', 'video.status', 'video.list', 'video.fetch',
    'video.discard', 'video.prune', 'video.recover', 'video.verify',
  ]);
  assert.deepEqual([...ts.methodsGatedBy('capture.stream')], [
    'screenshot.read', 'screenshot.release', 'longshot.recover',
  ]);
  assert.deepEqual([...ts.methodsGatedBy('debug.journal')], [
    'debug.history', 'debug.delete', 'debug.pin', 'debug.pinned',
  ]);
  assert.deepEqual([...ts.methodsGatedBy('har')], ['network.replay']);
  assert.equal(ts.gatedMethodNames().length, 1 + 1 + 9 + 3 + 4 + 1);
  for (const method of ts.gatedMethodNames() as MethodName[]) {
    assert.equal(ts.floorOf(method), '1.9', method + ' 的方法级门 floor 必须是 1.9');
  }
});

test('参数级门只作用于声明的作用域方法', () => {
  assert.deepEqual([...ts.featuresForCall('click', { unverified: true })], ['unverified']);
  assert.deepEqual([...ts.featuresForCall('click', { expect: ['#a'] })], ['expect']);
  assert.deepEqual([...ts.featuresForCall('click', { expect: [] })], [], '空 expect 不触发');
  assert.deepEqual([...ts.featuresForCall('observe', { delta: true })], ['observe-delta']);
  assert.deepEqual([...ts.featuresForCall('screenshot', { stream: true })], ['capture.stream']);
  assert.deepEqual([...ts.featuresForCall('screenshot', { staleAttempts: 0 })], ['capture.stream'], '显式 0 也算 defined');
  assert.deepEqual([...ts.featuresForCall('click', { stream: true })], [], 'stream 只作用于 screenshot');
  assert.deepEqual([...ts.featuresForCall('video.start', { stream: true })], ['video'], '非参数作用域方法只有方法级门');
  // 方法级门 + 参数级门组合，顺序稳定：方法级在前。
  assert.deepEqual([...ts.featuresForCall('read', { unverified: true })], ['read', 'unverified']);
});

test('不变量校验对全量目录干净，错误信息可定位', () => {
  const errors = ts.stateInvariantErrors();
  assert.deepEqual(errors, []);
  assert.doesNotThrow(() => ts.assertCatalogInvariants());
  const bad = ts.stateInvariantErrors([
    { method: 'observe', owner: 'session', effect: 'passive_read', partial: true, unknown: true, reconcile: { strategy: 'status', method: null } },
  ]);
  assert.ok(bad.some((message) => message.includes('observe')));
  assert.ok(bad.some((message) => message.includes('status 收敛必须给出目标方法')));
});
