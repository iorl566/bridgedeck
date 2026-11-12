import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCooperationFrames, validFrame } from '../../extension/src/cooperation/browser-bridge.js';

const state = { document: 'd', revision: 1, structure: 1, human: 0, busy: false, editing: false, lastInput: 0, fields: [], events: [] };

function withChrome(tabs, extra = {}) {
  const previous = globalThis.chrome;
  globalThis.chrome = { tabs, ...extra };
  return () => { globalThis.chrome = previous; };
}

test('validFrame checks the required state shape', () => {
  assert.equal(validFrame(state), true);
  assert.equal(validFrame({ ...state, busy: 'no' }), false);
  assert.equal(validFrame({ ...state, fields: new Array(65).fill({}) }), false);
});

test('collectCooperationFrames gathers active frames', async () => {
  let repairs = 0;
  const restore = withChrome(
    { sendMessage: async () => state },
    {
      webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId: 'd', url: 'https://x/path?q=1' }] },
      scripting: { executeScript: async () => { repairs += 1; } },
    },
  );
  try {
    const result = await collectCooperationFrames(7, 'cooperation.read', 'lease');
    assert.equal(result.frames.get(0).document, 'd');
    assert.equal(result.gaps.length, 0);
    assert.equal(repairs, 0);
  } finally {
    restore();
  }
});

test('missing receiver repairs the collector once', async () => {
  let calls = 0;
  const restore = withChrome(
    { sendMessage: async () => { calls += 1; if (calls === 1) throw new Error('Receiving end does not exist'); return state; } },
    {
      webNavigation: { getAllFrames: async () => [{ frameId: 0, documentId: 'd', url: 'https://x/' }] },
      scripting: { executeScript: async () => {} },
    },
  );
  try {
    const result = await collectCooperationFrames(7, 'cooperation.read', 'lease');
    assert.equal(result.frames.get(0).document, 'd');
  } finally {
    restore();
  }
});
