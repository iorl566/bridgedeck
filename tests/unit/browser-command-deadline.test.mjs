import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CdpReadGate, CdpReadTimeoutError, isRendererRead, readTimeoutDetails, runCdpCommand,
} from '../../extension/src/browser-driver/command-deadline.js';

const target = { tabId: 7, sessionId: 's1' };

test('isRendererRead classifies guarded methods', () => {
  assert.equal(isRendererRead('Accessibility.getFullAXTree'), true);
  assert.equal(isRendererRead('Page.getFrameTree'), true);
  assert.equal(isRendererRead('Runtime.evaluate'), false);
});

test('runCdpCommand times out and reports details', async () => {
  await assert.rejects(
    () => runCdpCommand(target, 'DOM.getDocument', () => new Promise(() => {}), 5),
    (error) => error instanceof CdpReadTimeoutError && error.method === 'DOM.getDocument' && error.tabId === 7,
  );
  const details = readTimeoutDetails(new CdpReadTimeoutError('Runtime.evaluate', 7, 10));
  assert.equal(details.data.reason, 'renderer_read_timeout');
  assert.equal(details.data.phase, 'deadline');
});

test('CdpReadGate blocks guarded reads after timeout and reset clears', async () => {
  const gate = new CdpReadGate();
  await assert.rejects(() => gate.run(target, 'DOM.getDocument', () => new Promise(() => {}), 5));
  await assert.rejects(() => gate.run(target, 'Runtime.evaluate', () => Promise.resolve(1)), (error) => error.phase === 'blocked');
  gate.reset(7);
  assert.equal(await gate.run(target, 'Runtime.evaluate', () => Promise.resolve(1)), 1);
});

test('CdpReadGate aborts waiting without cancelling the command', async () => {
  const gate = new CdpReadGate();
  const controller = new AbortController();
  const pending = gate.run(target, 'DOM.getDocument', () => new Promise(() => {}), 1000, controller.signal);
  controller.abort();
  await assert.rejects(() => pending, (error) => error.name === 'AbortError');
});
