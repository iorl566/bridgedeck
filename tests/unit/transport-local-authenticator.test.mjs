import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalAuthenticator } from '../../extension/src/transport/local-auth.js';
import { setSkipLocalVerification } from '../../extension/src/transport/local-credentials.js';

test('createLocalAuthenticator honors the skip-verification policy', async () => {
  const statuses = [];
  setSkipLocalVerification(true);
  try {
    const authenticate = createLocalAuthenticator({
      instanceId: async () => 'instance',
      origin: 'chrome-extension://test',
      status: (status) => statuses.push(status),
    });
    await authenticate({ url: 'ws://127.0.0.1:1/ws' }, new AbortController().signal);
    assert.deepEqual(statuses, [{ state: 'unverified_local', reason: 'skip' }]);
  } finally {
    setSkipLocalVerification(false);
  }
});
