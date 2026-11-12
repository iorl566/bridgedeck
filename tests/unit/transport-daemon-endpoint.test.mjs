import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDaemonEndpoint, DEFAULT_DAEMON_PORT, normalizeDaemonPort, parseDaemonPortInput, resolveDaemonWsUrl,
} from '../../extension/src/transport/daemon-endpoint.js';

test('default endpoint composes ws URL', () => {
  assert.equal(DEFAULT_DAEMON_PORT, 52800);
  assert.equal(resolveDaemonWsUrl(53907), 'ws://127.0.0.1:53907');
});

test('parseDaemonPortInput handles empty/invalid/range', () => {
  assert.equal(parseDaemonPortInput(''), 52800);
  assert.equal(parseDaemonPortInput('53907'), 53907);
  assert.equal(parseDaemonPortInput('abc'), null);
  assert.equal(parseDaemonPortInput('0'), null);
  assert.equal(parseDaemonPortInput('70000'), null);
});

test('normalizeDaemonPort handles numbers/strings/unset and custom base', () => {
  assert.equal(normalizeDaemonPort(1234), 1234);
  assert.equal(normalizeDaemonPort('  '), 52800);
  assert.equal(normalizeDaemonPort('bad'), 52800);
  const custom = createDaemonEndpoint('ws://localhost:6000/ws');
  assert.equal(custom.defaultPort, 6000);
  assert.equal(custom.resolveDaemonWsUrl(7000), 'ws://localhost:7000/ws');
  assert.equal(custom.normalizeDaemonPort(''), 6000);
});
