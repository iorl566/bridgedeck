import test from 'node:test';
import assert from 'node:assert/strict';
import { compareProtocol, parseProtocol, protocolSkew } from '../../extension/src/protocol-version.js';

test('parse/compare protocol versions', () => {
  assert.deepEqual(parseProtocol('1.8'), { major: 1, minor: 8 });
  assert.deepEqual(parseProtocol('2'), { major: 2, minor: 0 });
  assert.equal(compareProtocol('1.8', '1.7'), 1);
  assert.equal(compareProtocol('x', '1.0'), null);
});

test('protocol skew detects missing, major and newer daemon', () => {
  assert.equal(protocolSkew('1.8'), null);
  assert.equal(protocolSkew('1.7'), null);
  assert.equal(protocolSkew('1.9'), 'daemon_newer');
  assert.equal(protocolSkew('2.0'), 'major');
  assert.equal(protocolSkew(''), 'missing');
});
