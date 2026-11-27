import test from 'node:test';
import assert from 'node:assert/strict';
import { createPairCommand } from '../../cli/commands/pair.mjs';
import { pairProof } from '../../lib/pair-proof.mjs';
import { ArgError } from '../../cli/lib/args.mjs';

class TestBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function makeCommand(handler, { json = false } = {}) {
  const printed = [];
  const cmd = createPairCommand({
    callRpc: async (method, params) => handler(method, params, { json }),
    timeoutOf: () => 5000,
    outputFailure: (body) => { throw new TestBridgeError(body.error.code, body.error.message); },
    outputJsonBody: () => 0,
    isJson: () => json,
    print: (line) => printed.push(line),
    renderTable: (headers, rows) => [headers.join('|'), ...rows.map((row) => row.join('|'))].join('\n'),
    formatTime: () => 'T',
    truncateText: (text) => text,
    BridgeError: TestBridgeError,
  });
  return { cmd, printed };
}

test('pair list 空列表提示绑定地址', async () => {
  const { cmd, printed } = makeCommand(() => ({ ok: true, result: { pairings: [], bind: '127.0.0.1' } }));
  assert.equal(await cmd({}, ['pair', 'list']), 0);
  assert.match(printed.join('\n'), /没有有效配对码/);
});

test('pair create 输出配对码/链接', async () => {
  const { cmd, printed } = makeCommand(() => ({ ok: true, result: { code: 'ABC123', token: 't', url: 'ws://x', link: 'ws://x#t', expiresAt: Date.now() + 60_000 } }));
  assert.equal(await cmd({}, ['pair', 'create']), 0);
  const text = printed.join('\n');
  assert.match(text, /配对码：ABC123/);
  assert.match(text, /配对链接：ws:\/\/x#t/);
});

test('pair redeem 校验证明；错误证明抛 E_PAIR_INVALID', async () => {
  const token = 'a'.repeat(32);
  const endpoint = 'ws://127.0.0.1:52900/ws';
  const clientNonce = 'c'.repeat(32);
  const serverNonce = 's'.repeat(32);
  const proof = pairProof(token, { endpoint, role: 'control', clientNonce, serverNonce });
  const result = { ok: true, result: { token, url: endpoint, proof, endpoint, scope: 'control', clientNonce, serverNonce } };
  const good = makeCommand(() => result);
  assert.equal(await good.cmd({}, ['pair', 'redeem', 'ABC123']), 0);
  assert.match(good.printed.join('\n'), /配对证明：已验证/);
  const bad = makeCommand(() => ({ ok: true, result: { ...result.result, proof: '0'.repeat(64) } }));
  await assert.rejects(() => bad.cmd({}, ['pair', 'redeem', 'ABC123']), (error) => error.code === 'E_PAIR_INVALID');
});

test('pair renew 输出 pending；非法 scope 抛 ArgError', async () => {
  const { cmd, printed } = makeCommand(() => ({ ok: true, result: { deviceId: 'd1', scope: 'control', link: 'ws://x#t' } }));
  assert.equal(await cmd({}, ['pair', 'renew', 'd1']), 0);
  assert.match(printed.join('\n'), /rotation 已开始（pending）/);
  await assert.rejects(() => cmd({ scope: 'bad' }, ['pair', 'renew', 'd1']), ArgError);
});
