import test from 'node:test';
import assert from 'node:assert/strict';
import { auditLicenses, normalizeLicense, vendorDrift, ALLOWED_LICENSES } from '../../lib/deps-audit.mjs';

test('normalizeLicense/auditLicenses 白名单', () => {
  assert.equal(normalizeLicense('(MIT OR Apache-2.0)'), 'MIT');
  assert.equal(normalizeLicense('Apache-2.0'), 'Apache-2.0');
  const result = auditLicenses([
    { name: 'a', license: 'MIT' },
    { name: 'b', license: 'GPL-3.0' },
    { name: 'c', license: '' },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 2);
  assert.ok(ALLOWED_LICENSES.includes('Apache-2.0'));
});

test('vendorDrift 检测副本不一致', () => {
  const result = vendorDrift([
    { path: 'a.mjs', expectedHash: 'x', actualHash: 'x' },
    { path: 'b.mjs', expectedHash: 'x', actualHash: 'y' },
    { path: 'c.mjs', expectedHash: '', actualHash: 'z' },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.problems.length, 2);
  assert.equal(result.rows[0].match, true);
});
