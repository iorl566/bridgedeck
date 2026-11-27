import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutoUpdate } from '../../daemon/auto-update.js';

test('auto 未启用时 checkAutoUpdate 不写状态', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-auto-'));
  let writes = 0;
  const auto = createAutoUpdate({
    HOME_DIR: home,
    VERSION: '0.3.0',
    fs,
    path,
    crypto: {},
    spawnSync: () => ({ status: 0 }),
    fetchManifest: async () => ({}),
    fetchArtifact: async () => Buffer.alloc(0),
    verifyReleaseSignature: () => true,
    RELEASE_PUBLIC_KEY: '',
    readUpdateState: () => ({}),
    writeUpdateState: () => { writes += 1; },
    log: () => {},
  });
  await auto.checkAutoUpdate();
  assert.equal(writes, 0);
});
