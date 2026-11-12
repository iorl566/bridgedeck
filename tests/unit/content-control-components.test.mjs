import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ControlGlow } from '../../extension/src/content/ControlGlow.js';
import { ControlInputBlocker } from '../../extension/src/content/ControlInputBlocker.js';

test('ControlGlow renders both shadow layers', () => {
  const html = renderToStaticMarkup(React.createElement(ControlGlow));
  assert.match(html, /data-slot="control-overlay"/);
  assert.match(html, /data-slot="control-overlay-pulse"/);
  assert.match(html, /bb-breathe/);
});

test('ControlInputBlocker toggles pointer events', () => {
  const blocked = renderToStaticMarkup(React.createElement(ControlInputBlocker, { automationBypass: false }));
  const bypassed = renderToStaticMarkup(React.createElement(ControlInputBlocker, { automationBypass: true }));
  assert.match(blocked, /pointer-events:auto/);
  assert.match(bypassed, /pointer-events:none/);
});
