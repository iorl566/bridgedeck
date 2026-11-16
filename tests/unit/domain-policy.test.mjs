import test from 'node:test';
import assert from 'node:assert/strict';
import { domainAllowed, normalizeDomains } from '../../lib/domain-policy.mjs';

test('域名归一化与自身/子域匹配', () => {
  assert.deepEqual(normalizeDomains('HTTPS://Example.com/a, *.foo.test:8443, bad host'), ['example.com', 'foo.test']);
  assert.equal(domainAllowed(['example.com'], [], 'https://example.com/x').allowed, true);
  assert.equal(domainAllowed(['example.com'], [], 'https://a.example.com/x').allowed, true);
  assert.equal(domainAllowed(['example.com'], [], 'https://evil.com/x').allowed, false);
});

test('deny 优先，空 allow 不限制', () => {
  assert.equal(domainAllowed([], ['evil.com'], 'https://evil.com/x').allowed, false);
  assert.equal(domainAllowed([], ['evil.com'], 'https://good.com/x').allowed, true);
  assert.equal(domainAllowed(['example.com'], ['blocked.example.com'], 'https://blocked.example.com/x').allowed, false);
  assert.equal(domainAllowed([], [], 'not a url').allowed, true);
});
