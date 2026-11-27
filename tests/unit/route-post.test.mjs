import test from 'node:test';
import assert from 'node:assert/strict';
import { postProcessRoute } from '../../daemon/route-post.js';

function make() {
  const calls = [];
  const aliases = { register: (sid, kind, id) => kind[0] + id.slice(-2) };
  return {
    calls,
    aliases,
    crypto: { randomBytes: () => Buffer.from('001122334455', 'hex') },
    sendCommand: async (...args) => { calls.push(args); return { ok: true }; },
  };
}

test('observe unchanged 用缓存补文本', async () => {
  const { calls, aliases, crypto, sendCommand } = make();
  const route = { session: { observation: { text: 'cached', at: 1 }, url: '', title: '' } };
  const result = await postProcessRoute({ route, method: 'observe', result: { unchanged: true }, timeoutMs: 1000, sendCommand, aliases, crypto });
  assert.equal(result.observation, 'cached');
  assert.equal(result.cachedFrom, 1);
  assert.equal(calls.length, 0);
});

test('observe 结果写缓存并注册别名', async () => {
  const { aliases, crypto, sendCommand } = make();
  const route = { session: { url: 'u', title: 't' } };
  const result = await postProcessRoute({ route, method: 'observe', result: { observation: 'text', refs: 2, url: 'u2' }, timeoutMs: 1000, sendCommand, aliases, crypto });
  assert.equal(route.session.observation.text, 'text');
  assert.equal(route.session.observation.refs, 2);
  assert.ok(result.observationId);
  assert.ok(result.observationAlias);
});

test('navigate 补 control-hint', async () => {
  const { calls, aliases, crypto, sendCommand } = make();
  const route = { instance: {}, session: { tabId: 9, url: '', title: '' } };
  await postProcessRoute({ route, method: 'navigate', result: { url: 'u' }, timeoutMs: 1000, sendCommand, aliases, crypto });
  assert.ok(calls.some(([instance, method]) => method === 'control-hint'));
});
