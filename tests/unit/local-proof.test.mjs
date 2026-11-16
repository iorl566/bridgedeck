import test from 'node:test';
import assert from 'node:assert/strict';
import { clientProof, proofMatches, serverProof } from '../../lib/local-proof.mjs';
import { createAuthSession } from '../../lib/auth-session.mjs';

test('双向证明用不同域、可复算', () => {
  const token = '0123456789abcdef';
  const challenge = 'challenge-1';
  const client = clientProof(token, challenge);
  const server = serverProof(token, challenge);
  assert.equal(client.length, 64);
  assert.equal(server.length, 64);
  assert.notEqual(client, server);
  // 同输入可复算；换 token / challenge 都不同。
  assert.equal(clientProof(token, challenge), client);
  assert.notEqual(clientProof(token, 'challenge-2'), client);
  assert.notEqual(clientProof('another-token', challenge), client);
  assert.equal(proofMatches(server, serverProof(token, challenge)), true);
  assert.equal(proofMatches(server, client), false);
  assert.equal(proofMatches('', ''), false);
});

test('auth session 校验通过后把 secret/challenge 交回 daemon 用于服务端证明', () => {
  const session = createAuthSession({ now: () => 1000 });
  const hello = { protocol: '1.9', instanceId: 'abcd1234' };
  assert.equal(session.begin(hello, 'tok', 'chal'), true);
  const proof = clientProof('tok', 'chal');
  const result = session.verify('chal', proof);
  assert.equal(result.ok, true);
  assert.equal(result.secret, 'tok');
  assert.equal(result.challenge, 'chal');
  assert.equal(serverProof(result.secret, result.challenge), serverProof('tok', 'chal'));
  // 错误 proof 不放行
  const second = createAuthSession({ now: () => 1000 });
  second.begin(hello, 'tok', 'chal');
  assert.equal(second.verify('chal', 'bad').ok, false);
});
