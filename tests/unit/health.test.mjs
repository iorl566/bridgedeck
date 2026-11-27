import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthPayload } from '../../daemon/health.js';

test('healthPayload 返回服务/端口/浏览器/会话数', () => {
  const { healthPayload } = createHealthPayload({
    SERVICE: 'bridge-daemon',
    PROTOCOL_VERSION: 1.17,
    VERSION: '0.3.0',
    startedAt: Date.now() - 1000,
    getCurrentPort: () => 1234,
    TLS_ENABLED: false,
    BIND_ADDRESS: '127.0.0.1',
    PUBLIC_URL: null,
    instances: new Map([['i', {}]]),
    sessions: new Map([['s', {}]]),
  });
  const payload = healthPayload();
  assert.equal(payload.ok, true);
  assert.equal(payload.service, 'bridge-daemon');
  assert.equal(payload.port, 1234);
  assert.equal(payload.browsers, 1);
  assert.equal(payload.sessions, 1);
  assert.ok(payload.uptimeMs >= 0);
});
