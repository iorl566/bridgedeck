import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePage, sameLayout, sliceForFrame } from '../../extension/src/long-screenshot/capture.js';

function metrics(y = 0) {
  return { x: 0, y, width: 800, height: 100, viewportWidth: 800, viewportHeight: 100, innerWidth: 800, innerHeight: 100, dpr: 1, bottomOverlayHeight: 0, bottomReady: true };
}

function bitmap() {
  return { width: 800, height: 100, pixels: new Uint8ClampedArray(800 * 100 * 4), closed: false, close() { this.closed = true; } };
}

test('sliceForFrame covers viewport and footer overlap', () => {
  assert.deepEqual(sliceForFrame(metrics(0), 0, 1), { sourceY: 0, targetY: 0, height: 100, end: 100 });
  const footer = { ...metrics(900), height: 1000, bottomOverlayHeight: 80 };
  assert.deepEqual(sliceForFrame(footer, 900, 1), { sourceY: 0, targetY: 900, height: 100, end: 1000 });
  assert.throws(() => sliceForFrame(metrics(10), 0, 1), /changed/);
});

test('sameLayout ignores position when requested', () => {
  assert.equal(sameLayout(metrics(0), metrics(0)), true);
  assert.equal(sameLayout(metrics(0), metrics(1)), false);
  assert.equal(sameLayout(metrics(0), metrics(1), false), true);
});

test('capturePage writes one frame and finishes the page task', async () => {
  const calls = [];
  const writes = [];
  const page = async (command) => {
    calls.push(command.action);
    return metrics(0);
  };
  const result = await capturePage({
    page,
    screenshot: async () => bitmap(),
    write: async (...args) => writes.push(args),
    signal: new AbortController().signal,
    progress: () => {},
    label: 'capture',
    cancelLabel: 'cancel',
  });
  assert.deepEqual(result, { width: 800, height: 100 });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1], 800);
  assert.equal(calls.at(-1), 'finish');
  assert(calls.includes('begin'));
  assert(calls.includes('inspect'));
});
