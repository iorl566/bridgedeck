import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundExecution } from '../../extension/src/browser-driver/background-execution.js';

function harness() {
  let attachment = 'a1';
  const toggles = [];
  const exec = new BackgroundExecution(() => attachment, async (tabId, enabled) => { toggles.push([tabId, enabled]); });
  return { exec, toggles, setAttachment: (value) => { attachment = value; } };
}

test('retain enables and release disables', async () => {
  const { exec, toggles } = harness();
  exec.retain('s1', 7);
  await exec.synchronize(7);
  assert.deepEqual(toggles, [[7, true]]);
  exec.release('s1', 7);
  await exec.synchronize(7);
  assert.deepEqual(toggles, [[7, true], [7, false]]);
});

test('serializes toggles and avoids duplicates', async () => {
  const { exec, toggles } = harness();
  exec.retain('s1', 7);
  await Promise.all([exec.synchronize(7), exec.synchronize(7), exec.reapply(7)]);
  assert.deepEqual(toggles, [[7, true], [7, true]]);
});

test('attachment change during setup throws', async () => {
  let attachment = 'a1';
  const exec = new BackgroundExecution(() => attachment, async () => { attachment = 'a2'; });
  exec.retain('s1', 7);
  await assert.rejects(() => exec.synchronize(7), /attachment changed/);
});
