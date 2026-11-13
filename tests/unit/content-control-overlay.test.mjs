import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ControlOverlay } from '../../extension/src/content/ControlOverlay.js';

test('ControlOverlay renders toolbar with session and actions', () => {
  const html = renderToStaticMarkup(React.createElement(ControlOverlay, {
    sessionId: 's1',
    controller: { name: 'Agent', project: 'P' },
    visible: true,
    state: { revision: 1, mode: 'acting', editing: false, target: { x: 1, y: 2, expires: Date.now() + 10000 } },
    interrupting: false,
    automationBypass: false,
    onInterrupt: () => {},
  }));
  assert.match(html, /data-slot="cooperation-toolbar"/);
  assert.match(html, /bb-cooperation-session|会话/);
  assert.match(html, /Agent/);
  assert.match(html, /control-overlay-stop-all/);
});

test('ControlOverlay hides when not visible and shows blocker without state', () => {
  const hidden = renderToStaticMarkup(React.createElement(ControlOverlay, { visible: false, interrupting: false, automationBypass: false, onInterrupt: () => {} }));
  assert.equal(hidden, '');
  const idle = renderToStaticMarkup(React.createElement(ControlOverlay, { visible: true, interrupting: false, automationBypass: false, onInterrupt: () => {} }));
  assert.match(idle, /control-overlay-blocker/);
  assert.match(idle, /control-overlay-card/);
});
