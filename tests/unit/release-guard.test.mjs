import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertReleaseWritable, isSignedRelease, parseBuildArgs } from '../../tools/lib/release-guard.mjs';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-release-guard-'));
}

test('已签名 release.json 拒绝普通构建覆盖', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ version: '0.3.0', signature: 'sig' }));
  assert.equal(isSignedRelease(dir), true);
  assert.throws(() => assertReleaseWritable(dir), /已签名发布目录/);
  assert.doesNotThrow(() => assertReleaseWritable(dir, { force: true }));
});

test('未签名目录允许构建', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify({ version: '0.3.0' }));
  assert.equal(isSignedRelease(dir), false);
  assert.doesNotThrow(() => assertReleaseWritable(dir));
});

test('parseBuildArgs 支持 --out/--force/--dry-run', () => {
  assert.deepEqual(parseBuildArgs(['--out', 'tmp-dist', '--force', '--dry-run']), {
    out: 'tmp-dist', force: true, dryRun: true,
  });
  assert.deepEqual(parseBuildArgs(['--out=tmp']), { out: 'tmp', force: false, dryRun: false });
  assert.throws(() => parseBuildArgs(['--out']), /--out 需要目录/);
  assert.throws(() => parseBuildArgs(['--nope']), /未知参数/);
});
