import test from 'node:test';
import assert from 'node:assert/strict';
import { DebugNetworkControl } from '../../extension/src/debug/network-control.js';

function harness() {
  const calls = [];
  const annotations = [];
  const cdp = {
    sendAttached: async (_target, method, params) => { calls.push({ method, params }); return {}; },
  };
  const network = {
    annotate: (_target, id, value) => annotations.push({ id, value }),
    list: () => [],
  };
  let seq = 0;
  const control = new DebugNetworkControl('run', 1, cdp, network, () => { seq += 1; }, () => true, () => 1000);
  return { control, calls, annotations, changed: () => seq };
}

const target = { tabId: 1, sessionId: 'root' };
const paused = (url = 'https://site.test/api') => ({
  requestId: 'r1',
  networkId: 'n1',
  resourceType: 'Fetch',
  request: { url, method: 'GET', headers: {} },
});

test('adds rule and enables Fetch interception', async () => {
  const { control, calls } = harness();
  await control.target(target);
  await control.add({ match: { url: 'https://site.test/api*' }, effect: { type: 'block' } });
  assert.equal(control.activeCount, 1);
  assert(calls.some((call) => call.method === 'Fetch.enable'));
  assert.equal(control.list()[0].state, 'enabled');
});

test('block rule fails request and annotates intervention', async () => {
  const { control, calls, annotations } = harness();
  await control.target(target);
  await control.add({ match: { url: 'https://site.test/api*' }, effect: { type: 'block' } });
  control.onEvent(target, 'Fetch.requestPaused', paused());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert(calls.some((call) => call.method === 'Fetch.failRequest' && call.params.errorReason === 'BlockedByClient'));
  assert(annotations.some((item) => item.value.intervention && item.value.intervention.type === 'block'));
});

test('modify and mock rules call continue/fulfill with redacted annotations', async () => {
  const { control, calls } = harness();
  await control.target(target);
  await control.add({ match: { url: 'https://site.test/api*' }, effect: { type: 'mock', status: 201, body: 'hi' } });
  control.onEvent(target, 'Fetch.requestPaused', paused());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert(calls.some((call) => call.method === 'Fetch.fulfillRequest' && call.params.responseCode === 201));
  assert.equal(control.list()[0].hits, 1);
});

test('update disables/removes rules and close stops intercept', async () => {
  const { control, calls } = harness();
  await control.target(target);
  await control.add({ match: { url: 'https://site.test/api*' }, effect: { type: 'block' } });
  const id = control.list()[0].id;
  await control.update(id, 'rule_disable');
  assert.equal(control.list()[0].state, 'disabled');
  await control.update(id, 'rule_remove');
  assert.equal(control.list()[0].state, 'removed');
  await control.close('done');
  assert(calls.some((call) => call.method === 'Fetch.disable'));
  assert.equal(control.alive, false);
});
