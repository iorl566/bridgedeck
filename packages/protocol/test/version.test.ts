// packages/protocol/test/version.test.ts —— 协议版本解析/比较的差分与边界测试。
//
// 对拍 lib/protocol.mjs 的 parseProtocol / compareProtocol / protocolAtLeast。
// 边界重点：数字形式、小数、负数、NaN、两段以上的字符串（1.9.1 不合法）、空白、
// 前导零、超大 major、null/undefined/对象/数组。

import test from 'node:test';
import assert from 'node:assert/strict';

import { compareProtocol, formatProtocol, isSkewedProtocol, lowestProtocol, parseProtocol, protocolAtLeast, protocolLabel } from '../src/version.ts';

const jsProtocol: any = await import('../../../lib/protocol.mjs');

const PARSED_INPUTS: readonly unknown[] = [
  '1.9',
  '1.8',
  '1',
  ' 2 ',
  '0.0',
  '01.09',
  '1.10',
  '1.9.1',
  'v1.9',
  '',
  ' ',
  'abc',
  1.9,
  1,
  0,
  2.05,
  1.999,
  0.5,
  -1,
  -0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  null,
  undefined,
  true,
  false,
  {},
  [],
];

test('parseProtocol：合法输入解析出 major/minor，非法输入一律 null（与 JS 一致）', () => {
  for (const input of PARSED_INPUTS) {
    assert.deepEqual(
      parseProtocol(input),
      jsProtocol.parseProtocol(input),
      'parseProtocol(' + String(input) + ') 不一致',
    );
  }
  assert.deepEqual(parseProtocol('1.9'), { major: 1, minor: 9 });
  assert.deepEqual(parseProtocol(' 2 '), { major: 2, minor: 0 });
  assert.deepEqual(parseProtocol(1.9), { major: 1, minor: 9 });
  assert.deepEqual(parseProtocol('1.9.1'), null, '两段以上不合法');
  assert.deepEqual(parseProtocol(-1), null, '负数不合法');
  assert.deepEqual(parseProtocol(Number.NaN), null);
});

test('compareProtocol：major 优先，minor 次之，不可解析返回 null', () => {
  const PAIRS: readonly [unknown, unknown][] = [
    ['1.9', '1.8'],
    ['1.8', '1.9'],
    ['1.9', '1.9'],
    ['2.0', '1.9'],
    ['1.10', '1.9'],
    ['1', '1.0'],
    [' 1.8 ', '1.8'],
    [1.9, '1.9'],
    ['abc', '1.9'],
    ['1.9', 'abc'],
    [null, '1.9'],
    [undefined, undefined],
  ];
  for (const [left, right] of PAIRS) {
    assert.equal(
      compareProtocol(left, right),
      jsProtocol.compareProtocol(left, right),
      'compareProtocol(' + String(left) + ', ' + String(right) + ') 不一致',
    );
  }
  assert.equal(compareProtocol('1.9', '1.8'), 1);
  assert.equal(compareProtocol('1.8', '1.9'), -1);
  assert.equal(compareProtocol('1.8', '1.8'), 0);
  assert.equal(compareProtocol('2', '1.99'), 1, 'major 差优先');
  assert.equal(compareProtocol('1.9.1', '1.9'), null);
});

test('protocolAtLeast：不可比较返回 null（调用方按拒绝处理）', () => {
  const PAIRS: readonly [unknown, unknown][] = [
    ['1.9', '1.9'],
    ['1.8', '1.9'],
    ['2.0', '1.9'],
    ['abc', '1.9'],
    ['1.9', 'abc'],
    [null, '1.9'],
  ];
  for (const [actual, required] of PAIRS) {
    assert.equal(
      protocolAtLeast(actual, required),
      jsProtocol.protocolAtLeast(actual, required),
      'protocolAtLeast(' + String(actual) + ', ' + String(required) + ') 不一致',
    );
  }
  assert.equal(protocolAtLeast('1.9', '1.9'), true);
  assert.equal(protocolAtLeast('1.8', '1.9'), false);
  assert.equal(protocolAtLeast('1.8', 'abc'), null);
});

test('formatProtocol / protocolLabel：可读标签稳定', () => {
  assert.equal(formatProtocol({ major: 1, minor: 9 }), '1.9');
  assert.equal(formatProtocol({ major: 0, minor: 0 }), '0.0');
  assert.equal(protocolLabel('1.9'), '1.9');
  assert.equal(protocolLabel(1.9), '1.9');
  assert.equal(protocolLabel(' 1.8 '), '1.8');
  assert.equal(protocolLabel('abc'), 'abc', '无法解析但非空时保留原文，便于诊断');
  assert.equal(protocolLabel(''), 'unknown');
  assert.equal(protocolLabel(null), 'unknown');
  assert.equal(protocolLabel(undefined), 'unknown');
});

test('lowestProtocol：取最低可解析版本，跳过非法输入', () => {
  assert.equal(lowestProtocol(['1.9', '1.8', '2.0']), '1.8');
  assert.equal(lowestProtocol(['1.9', 'abc', '1.10']), '1.9');
  assert.equal(lowestProtocol(['1.10', '1.9']), '1.9', 'minor 按数值比较');
  assert.equal(lowestProtocol([]), null);
  assert.equal(lowestProtocol(['abc', null]), null);
  assert.equal(lowestProtocol([1.8, '2']), '1.8');
});

test('isSkewedProtocol：同 major 且 baseline <= v < current 才算偏斜', () => {
  assert.equal(isSkewedProtocol('1.8', '1.9', '1.8'), true);
  assert.equal(isSkewedProtocol(1.8, '1.9', '1.8'), true);
  assert.equal(isSkewedProtocol('1.9', '1.9', '1.8'), false, '当前版本不是偏斜');
  assert.equal(isSkewedProtocol('1.7', '1.9', '1.8'), false, '低于 baseline 不算偏斜');
  assert.equal(isSkewedProtocol('2.0', '1.9', '1.8'), false, '跨 major 不算偏斜');
  assert.equal(isSkewedProtocol('abc', '1.9', '1.8'), false);
  assert.equal(isSkewedProtocol('1.8', 'bad', '1.8'), false);
});
