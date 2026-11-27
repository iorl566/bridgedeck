import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateOps } from '../../cli/commands/update-ops.mjs';
import { ArgError } from '../../cli/lib/args.mjs';

class TestBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function makeOps() {
  const printed = [];
  const state = [];
  return {
    printed,
    state,
    ops: createUpdateOps({
      REPO_ROOT: '.',
      HOME_DIR: '.',
      UPDATE_STATE_PATH: 'state.json',
      emitJson: () => 0,
      isJson: () => false,
      print: (line) => printed.push(line),
      loadUpdate: async () => ({
        writeUpdateState: (file, patch) => state.push(patch),
        verifyReleaseSignature: () => true,
      }),
      releaseVerifyKey: async () => null,
      writeFileAtomic: () => {},
      assertInside: (base, target) => target,
      sha256File: () => 'h',
      BridgeError: TestBridgeError,
    }),
  };
}

test('update install 缺 --from/--rollback 抛 ArgError', () => {
  const { ops } = makeOps();
  assert.throws(() => ops.cmdUpdateInstall({}), ArgError);
});

test('update apply 缺 --staging/--target 抛 ArgError', async () => {
  const { ops } = makeOps();
  await assert.rejects(() => ops.cmdUpdateApply({}), ArgError);
  await assert.rejects(() => ops.cmdUpdateApply({ staging: 'x' }), ArgError);
});

test('update rollback 缺 --backup 抛 ArgError', async () => {
  const { ops } = makeOps();
  await assert.rejects(() => ops.cmdUpdateRollback({}), ArgError);
});
