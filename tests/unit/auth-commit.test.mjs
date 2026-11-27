import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthCommit } from '../../daemon/auth-commit.js';

function makeHandler(trust) {
  const messages = [];
  const handler = createAuthCommit({
    deviceStore: {},
    getLocalTrust: () => trust,
    saveLocalTrust: () => {},
    commitProofFor: (token, txn) => 'proof:' + token + ':' + txn,
    log: () => {},
  });
  const conn = { sendJson: (message) => messages.push(message) };
  return { handler, messages, conn };
}

test('auth-commit 接受合法本机证明并清空 commitTxn', () => {
  const trust = { token: 'tok', commitTxn: 'txn1', commitUntil: Date.now() + 10000 };
  const { handler, messages, conn } = makeHandler(trust);
  handler({ remote: false, pairToken: 'tok' }, conn, { txn: 'txn1', proof: 'proof:tok:txn1' });
  assert.equal(messages[0].type, 'commit-ack');
  assert.equal(trust.commitTxn, '');
  assert.equal(trust.commitUntil, 0);
});

test('auth-commit 拒绝错误证明', () => {
  const trust = { token: 'tok', commitTxn: 'txn1' };
  const { handler, messages, conn } = makeHandler(trust);
  handler({ remote: false, pairToken: 'tok' }, conn, { txn: 'txn1', proof: 'bad' });
  assert.equal(messages[0].type, 'commit-error');
  assert.equal(messages[0].code, 'E_AUTH_PROOF');
  assert.equal(trust.commitTxn, 'txn1');
});
