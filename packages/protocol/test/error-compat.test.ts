// packages/protocol/test/error-compat.test.ts —— 协议错误数据的形状契约（W4-C 兼容别名）。
//
// 背景：daemon 的 feature gate 拒绝时 data 里带历史兼容码（legacyCode / aliasCodes），
// 旧调用方按 E_UNSUPPORTED_CAPABILITY 分支时仍能识别。本文件固化三件事：
// 1. `ProtocolErrorData` 的 legacyCode/aliasCodes 是**可选**字段 —— 调用点（daemon 载荷、
//    旧对端、测试夹具）可以不带；gate.ts 拒绝时一定填；
// 2. 错误码判定对主码与历史别名都成立，且与 lib/protocol-features.mjs 的语义一致；
// 3. 常量名单/顺序稳定（主码在前），供 CLI/MCP/插件恢复映射共用。

import test from 'node:test';
import assert from 'node:assert/strict';

import * as ts from '../src/index.ts';
import type { ProtocolErrorData } from '../src/index.ts';

const js: any = await import('../../../lib/protocol-features.mjs');

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 最小合法的协议拒绝数据：刻意不带 legacyCode/aliasCodes，验证可选性。 */
function minimalData(): ProtocolErrorData {
  return {
    code: ts.PROTOCOL_UNSUPPORTED,
    method: 'video.start',
    feature: 'video',
    features: ['video'],
    missing: [{ feature: 'video', required: '1.9', actual: '1.8' }],
    required: '1.9',
    actual: '1.8',
  };
}

test('ProtocolErrorData 的兼容字段可选：最小数据可构造并可交给 ProtocolError', () => {
  const data = minimalData();
  assert.equal(data.legacyCode, undefined);
  assert.equal(data.aliasCodes, undefined);
  const error = new ts.ProtocolError('协议版本过低', data);
  assert.equal(error.code, ts.PROTOCOL_UNSUPPORTED);
  assert.equal(ts.isProtocolError(error), true);
  assert.deepEqual(clone(ts.protocolErrorDataOf(error)), clone(data));
  // 带兼容字段的完整数据同样合法（gate.ts 的实际输出形状）。
  const full: ProtocolErrorData = { ...data, legacyCode: ts.LEGACY_CAPABILITY_UNSUPPORTED, aliasCodes: ts.PROTOCOL_UNSUPPORTED_ALIASES };
  assert.equal(ts.isProtocolError({ name: 'ProtocolError', code: full.code }), true);
  assert.equal(ts.protocolErrorDataOf({ code: full.code, data: full })?.legacyCode, ts.LEGACY_CAPABILITY_UNSUPPORTED);
});

test('错误码判定：主码与历史别名都识别，其它码拒绝', () => {
  for (const code of [ts.PROTOCOL_UNSUPPORTED, ts.LEGACY_CAPABILITY_UNSUPPORTED, ' E_OTHER ']) {
    assert.equal(ts.isProtocolUnsupportedCode(code), js.isProtocolUnsupportedCode(code), 'code=' + code);
  }
  assert.equal(ts.isProtocolUnsupportedCode(ts.LEGACY_CAPABILITY_UNSUPPORTED), true);
  assert.equal(ts.isProtocolUnsupportedCode('E_OTHER'), false);
  assert.equal(ts.isProtocolUnsupportedCode(null), false);
  assert.equal(ts.isProtocolUnsupportedCode(42), false);
  assert.equal(ts.isProtocolUnsupportedError({ code: ts.LEGACY_CAPABILITY_UNSUPPORTED }), true);
  assert.equal(ts.isProtocolUnsupportedError({ code: 'E_OTHER' }), false);
  assert.equal(ts.isProtocolError({ code: 'E_UNSUPPORTED_CAPABILITY' }), false, '非 ProtocolError 形态不带 name 不认');
});

test('常量名单与 JS 单一源一致（主码在前）', () => {
  assert.equal(ts.LEGACY_CAPABILITY_UNSUPPORTED, js.LEGACY_CAPABILITY_UNSUPPORTED);
  assert.deepEqual([...ts.PROTOCOL_UNSUPPORTED_ALIASES], [...js.PROTOCOL_UNSUPPORTED_ALIASES]);
  assert.deepEqual([...ts.PROTOCOL_UNSUPPORTED_ALIASES], [ts.PROTOCOL_UNSUPPORTED, ts.LEGACY_CAPABILITY_UNSUPPORTED]);
  assert.equal(Object.isFrozen(ts.PROTOCOL_UNSUPPORTED_ALIASES), true);
  assert.equal(ts.PROTOCOL_UNSUPPORTED, 'E_PROTOCOL_UNSUPPORTED');
  assert.equal(ts.LEGACY_CAPABILITY_UNSUPPORTED, 'E_UNSUPPORTED_CAPABILITY');
});

test('gate.ts 拒绝时填满兼容字段，且与 JS data 逐字段一致', () => {
  const decision = ts.protocolGate({ protocol: '1.8' }, 'video.start');
  assert.equal(decision.ok, false);
  if (decision.ok) throw new Error('unreachable');
  assert.equal(decision.data.legacyCode, ts.LEGACY_CAPABILITY_UNSUPPORTED);
  assert.deepEqual([...(decision.data.aliasCodes ?? [])], [...ts.PROTOCOL_UNSUPPORTED_ALIASES]);
  assert.deepEqual(clone(decision.data), clone(js.protocolGate({ protocol: '1.8' }, 'video.start').data));
  // 通过分支没有 data 字段（决策形态不变）。
  const pass = ts.protocolGate({ protocol: '1.9' }, 'video.start');
  assert.equal(pass.ok, true);
  assert.equal('data' in pass, false);
});

test('daemon 载荷形态：缺兼容字段的 data 仍可被还原（向前兼容）', () => {
  const legacyPayload = minimalData();
  assert.equal(ts.protocolErrorDataOf({ code: ts.PROTOCOL_UNSUPPORTED, data: legacyPayload })?.method, 'video.start');
  // 只有旧码的载荷（历史 daemon 行为）也能被类型守卫识别。
  assert.equal(ts.isProtocolUnsupportedError({ code: ts.LEGACY_CAPABILITY_UNSUPPORTED }), true);
});
