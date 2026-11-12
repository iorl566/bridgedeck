import test from 'node:test';
import assert from 'node:assert/strict';
import { VIDEO_OVERLAY, VideoOverlayGate } from '../../extension/src/video/overlay.js';

function harness(recordingId = null) {
  const sent = [];
  let renders = 0;
  let paints = 0;
  const gate = new VideoOverlayGate(
    async (action) => { sent.push(action); return { recording_id: recordingId }; },
    () => { renders += 1; },
    async () => { paints += 1; },
  );
  return { gate, sent, renders: () => renders, paints: () => paints };
}

test('initialize discovers recording state', async () => {
  const { gate, sent, renders } = harness('rec1');
  await gate.initialize();
  assert.equal(gate.id, 'rec1');
  assert.equal(gate.canRenderControl(), false);
  assert(sent.includes('query'));
  assert(renders() >= 2);
  assert.equal(gate.needsDiscovery(), false);
  assert.equal(VIDEO_OVERLAY, 'bb/video-overlay');
});

test('interactive handshake allows overlay after ack', async () => {
  const { gate } = harness('rec1');
  await gate.initialize();
  assert.equal(gate.canRenderInteractive(true), false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(gate.canRenderInteractive(true), true);
  assert.equal(gate.canRenderInteractive(false), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test('clean sends clean when idle with recording', async () => {
  const { gate, sent } = harness('rec1');
  await gate.initialize();
  await gate.clean();
  assert(sent.includes('clean'));
  gate.dispose();
  assert.equal(gate.disposed, true);
});
