import test from 'node:test';
import assert from 'node:assert/strict';
import { ArgError, intFlag, requirePos, parseDurationMs, parseOnOff } from '../../cli/lib/args.mjs';

test('intFlag 解析整数并校验下限', () => {
  assert.equal(intFlag({}, 'n'), undefined);
  assert.equal(intFlag({ n: '3' }, 'n'), 3);
  assert.equal(intFlag({ n: '-1' }, 'n', { min: -5 }), -1);
  assert.throws(() => intFlag({ n: 'x' }, 'n'), ArgError);
  assert.throws(() => intFlag({ n: '-2' }, 'n', { min: 0 }), ArgError);
});

test('requirePos 缺参抛 ArgError', () => {
  assert.equal(requirePos(['a', 'b'], 1, '<x>'), 'b');
  assert.throws(() => requirePos(['a'], 1, '<x>'), ArgError);
});

test('parseDurationMs 单位与 fallback', () => {
  assert.equal(parseDurationMs(undefined, 42), 42);
  assert.equal(parseDurationMs('500ms', 0), 500);
  assert.equal(parseDurationMs('20s', 0), 20_000);
  assert.equal(parseDurationMs('2m', 0), 120_000);
  assert.equal(parseDurationMs('1h', 0), 3_600_000);
  assert.equal(parseDurationMs('30d', 0), 2_592_000_000);
  assert.equal(parseDurationMs('1.5s', 0), 1500);
  assert.throws(() => parseDurationMs('soon', 0), ArgError);
});

test('parseOnOff 接受 on/off 与布尔别名', () => {
  assert.equal(parseOnOff('on', 'x'), true);
  assert.equal(parseOnOff('true', 'x'), true);
  assert.equal(parseOnOff('off', 'x'), false);
  assert.equal(parseOnOff('0', 'x'), false);
  assert.throws(() => parseOnOff('maybe', 'x'), ArgError);
});
