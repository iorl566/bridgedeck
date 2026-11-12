import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HelpRequestOverlay } from '../../extension/src/content/HelpRequestOverlay.js';

const noop = () => {};
const rect = { top: 10, left: 20, width: 100, height: 30 };
const base = {
  id: 'help-1',
  prompt: 'Please sign in',
  title: 'Sign in',
  selectors: [],
  rects: [],
  onContinue: noop,
  onCancel: noop,
};

const render = (request) => renderToStaticMarkup(React.createElement(HelpRequestOverlay, { request }));
const count = (html, pattern) => (html.match(pattern) ?? []).length;

test('full help request renders draggable banner, note input and footer actions', () => {
  const html = render(base);
  assert.match(html, /data-slot="help-request-banner"/);
  assert.match(html, /data-display-mode="full"/);
  assert.match(html, /data-collapsed="false"/);
  assert.match(html, /data-anchored="false"/);
  assert.match(html, /data-dragging="false"/);
  assert.match(html, /data-slot="help-drag-handle"/);
  assert.match(html, /aria-label="拖动"/);
  assert.match(html, /data-slot="help-collapse-toggle"/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /aria-label="收起"/);
  assert.match(html, /class="bb-help-title">Sign in</);
  assert.match(html, /class="bb-help-prompt">Please sign in</);
  assert.match(html, /<input[^>]*class="bb-help-note-input"/);
  assert.match(html, /aria-label="给 Agent 的说明"/);
  assert.match(html, /placeholder="可选：说明你做了什么"/);
  assert.match(html, /placeholder="可选：说明你做了什么" tabindex="0" value=""/);
  assert.match(html, /data-slot="help-cancel-button"/);
  assert.match(html, /data-slot="help-continue-button"/);
});

test('expanded help keeps header actions out of the tab order and slots', () => {
  const html = render(base);
  assert.equal(count(html, /data-slot="help-cancel-button"/g), 1);
  assert.equal(count(html, /data-slot="help-continue-button"/g), 1);
  assert.equal(count(html, /tabindex="-1"/g), 2);
  assert.equal(count(html, /tabindex="0"/g), 3);
  assert.match(html, /class="bb-help-header-actions" aria-hidden="true"/);
});

test('compact help shows status only and drops drag, note and controls', () => {
  const html = render({ ...base, displayMode: 'compact', rects: [rect] });
  assert.match(html, /data-display-mode="compact"/);
  assert.match(html, /class="bb-help-compact-title">另一个标签页需要帮助</);
  assert.doesNotMatch(html, /data-slot="help-drag-handle"/);
  assert.doesNotMatch(html, /data-slot="help-collapse-toggle"/);
  assert.doesNotMatch(html, /data-slot="help-cancel-button"/);
  assert.doesNotMatch(html, /<input/);
  assert.doesNotMatch(html, /class="bb-help-body"/);
  assert.doesNotMatch(html, /data-slot="help-highlight"/);
});

test('missing title falls back to the localized heading', () => {
  const html = render({ ...base, title: undefined });
  assert.match(html, /class="bb-help-title">需要你的帮助</);
  assert.doesNotMatch(html, /Sign in/);
});

test('no request renders nothing', () => {
  assert.equal(render(null), '');
});

test('help stylesheet restores collapse, drag and motion parity rules', () => {
  const html = render(base);
  assert.match(html, /@keyframes bb-help-flash/);
  assert.match(html, /--bb-help-duration: 320ms/);
  assert.match(html, /transition: padding var\(--bb-help-duration\)/);
  assert.match(html, /\.bb-help-banner\[data-collapsed="true"\] \.bb-help-header-actions/);
  assert.match(html, /max-width: 100%; opacity: 1; pointer-events: auto/);
  assert.match(html, /\.bb-help-banner\[data-collapsed="true"\] \.bb-help-header \{ flex-wrap: wrap; \}/);
  assert.match(html, /\.bb-help-body-inner \{ overflow: hidden/);
  assert.match(html, /\.bb-help-body-content \{[^}]*opacity: 1[^}]*transform: translateY\(0\)/);
  assert.match(html, /\.bb-help-banner\[data-collapsed="true"\] \.bb-help-body-content \{ opacity: 0; transform: translateY\(6px\); \}/);
  assert.match(html, /\.bb-help-drag-strip:hover \.bb-help-drag-pill/);
  assert.match(html, /\.bb-help-banner\[data-dragging="true"\] \.bb-help-drag-pill/);
  assert.match(html, /\.bb-help-banner\[data-collapsed="true"\] \.bb-help-drag-strip \{ top: 4px; \}/);
  assert.match(html, /\.bb-help-banner\[data-display-mode="compact"\] \.bb-help-header-actions \{ display: flex; max-width: none; \}/);
  assert.match(html, /prefers-reduced-motion: reduce/);
  assert.match(html, /\.bb-help-drag-pill \{ transition-duration: 0.01ms !important; \}/);
});

test('collapsed help styles lay the actions out on their own row', () => {
  const html = render(base);
  assert.match(html, /order: 1; flex-basis: 100%; flex-wrap: wrap; justify-content: flex-end/);
  assert.match(html, /\.bb-help-banner\[data-collapsed="true"\] \.bb-help-collapse-toggle \{ margin-left: 0; \}/);
  assert.match(html, /\.bb-help-banner\[data-collapsed="true"\] \.bb-help-body \{ position: absolute/);
});
