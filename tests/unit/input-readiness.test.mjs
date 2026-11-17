import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
globalThis.chrome = {
  scripting: {
    async executeScript({ func }) {
      return [{ result: await func() }];
    },
  },
};

const { waitForPaint } = await import('../../extension/src/inject.js');

test('input readiness waits for two animation frames', async () => {
  let frames = 0;
  const old = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => {
    frames += 1;
    setTimeout(callback, 0);
  };
  try {
    assert.equal(await waitForPaint(7), true);
    assert.equal(frames, 2);
  } finally {
    globalThis.requestAnimationFrame = old;
  }
});
