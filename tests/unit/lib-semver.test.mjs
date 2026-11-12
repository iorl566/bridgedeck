import test from 'node:test';
import assert from 'node:assert/strict';
import { compareProtocol, parseProtocolMajor } from '../../extension/src/lib/semver.js';
import { POPUP_PORT_NAME } from '../../extension/src/lib/popup-bridge.js';

test('parseProtocolMajor accepts ASCII digits only', () => {
  assert.equal(parseProtocolMajor('1.9'), 1);
  assert.equal(parseProtocolMajor('0'), 0);
  assert.equal(parseProtocolMajor('+1.0'), null);
  assert.equal(parseProtocolMajor('1x'), null);
  assert.equal(parseProtocolMajor('1e3'), null);
  assert.equal(parseProtocolMajor(' 1'), null);
  assert.equal(parseProtocolMajor(''), null);
});

test('compareProtocol compares major then minor', () => {
  assert.equal(compareProtocol('1.9', '1.8'), 1);
  assert.equal(compareProtocol('2.0', '1.9'), 1);
  assert.equal(compareProtocol('1.3', '1.3'), 0);
  assert.equal(compareProtocol('1', '1.0'), 0);
  assert.equal(compareProtocol('1.2.3', '1.2'), 0);
  assert.equal(compareProtocol('bad', '1.2'), null);
});

test('popup port name is stable', () => {
  assert.equal(POPUP_PORT_NAME, 'popup');
});
