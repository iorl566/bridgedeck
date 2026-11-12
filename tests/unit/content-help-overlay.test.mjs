import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HelpRequestOverlay } from '../../extension/src/content/HelpRequestOverlay.js';

const base = { id: 'h1', prompt: 'Please log in', title: 'Help', selectors: [], onContinue: () => {}, onCancel: () => {} };

test('full help renders banner, prompt, note and actions', () => {
  const html = renderToStaticMarkup(React.createElement(HelpRequestOverlay, {
    request: { ...base, rects: [{ top: 10, left: 20, width: 100, height: 30 }] },
  }));
  assert.match(html, /data-slot="help-request-banner"/);
  assert.match(html, /Please log in/);
  assert.match(html, /help-note-input/);
  assert.match(html, /data-display-mode="full"/);
});

test('compact help hides body and shows status', () => {
  const html = renderToStaticMarkup(React.createElement(HelpRequestOverlay, {
    request: { ...base, displayMode: 'compact' },
  }));
  assert.match(html, /data-display-mode="compact"/);
  assert.match(html, /另一个标签页需要帮助/);
  assert.doesNotMatch(html, /<input/);
});

test('no request renders nothing', () => {
  assert.equal(renderToStaticMarkup(React.createElement(HelpRequestOverlay, { request: null })), '');
});
