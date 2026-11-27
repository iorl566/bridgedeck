import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUpdateCommand } from '../../cli/commands/update.mjs';
import { ArgError } from '../../cli/lib/args.mjs';

class TestBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function makeCommand({ state = {}, verify = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-update-cmd-'));
  const printed = [];
  const emitted = [];
  const cmd = createUpdateCommand({
    REPO_ROOT: dir,
    UPDATE_STATE_PATH: path.join(dir, 'update-state.json'),
    VERSION: '0.3.0',
    emitJson: (payload) => emitted.push(payload),
    isJson: () => false,
    print: (line) => printed.push(line),
    loadUpdate: async () => ({
      readUpdateState: () => state,
      writeUpdateState: (file, patch) => fs.writeFileSync(file, JSON.stringify(patch)),
      verifyReleaseSignature: () => null,
    }),
    verifyRelease: () => verify || { artifacts: [], verified: false, result: {} },
    releaseVerifyKey: async () => null,
    sha256File: () => '',
    cmdUpdateInstall: () => 0,
    cmdUpdateFetch: () => 0,
    cmdUpdateApply: () => 0,
    cmdUpdateRollback: () => 0,
    BridgeError: TestBridgeError,
  });
  return { cmd, printed, emitted, dir };
}

test('update 未知子命令抛 ArgError', async () => {
  const { cmd } = makeCommand();
  await assert.rejects(() => cmd({}, ['update', 'nope']), ArgError);
});

test('update state 输出状态', async () => {
  const { cmd, printed } = makeCommand({ state: { lastCheck: { version: '0.3.0' } } });
  assert.equal(await cmd({}, ['update', 'state']), 0);
  assert.match(printed.join('\n'), /lastCheck/);
});

test('update check 缺清单时给出 note 且 verified=false', async () => {
  const { cmd, printed } = makeCommand();
  assert.equal(await cmd({ manifest: 'nope.json' }, ['update', 'check']), 0);
  assert.match(printed.join('\n'), /未找到发布清单/);
});

test('update auto --disable 写状态', async () => {
  const { cmd, printed, dir } = makeCommand({ state: { auto: { enabled: true } } });
  assert.equal(await cmd({ disable: true }, ['update', 'auto']), 0);
  assert.match(printed.join('\n'), /自动更新检查已关闭/);
  assert.ok(fs.existsSync(path.join(dir, 'update-state.json')));
});
