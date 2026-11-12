import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RecordOverlay } from '../../extension/src/content/RecordOverlay.js';

test('RecordOverlay renders pill with intro label and finish button', () => {
  const html = renderToStaticMarkup(React.createElement(RecordOverlay, {
    request: { id: 'r1', startedAtMs: Date.now() - 2000, onFinish: () => {} },
  }));
  assert.match(html, /data-slot="record-overlay-pill"/);
  assert.match(html, /正在录制/);
  assert.match(html, /data-slot="record-overlay-finish"/);
});

test('RecordOverlay renders nothing without request', () => {
  assert.equal(renderToStaticMarkup(React.createElement(RecordOverlay, { request: null })), '');
});
