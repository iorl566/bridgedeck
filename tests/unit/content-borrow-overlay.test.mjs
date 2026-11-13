import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BorrowConfirmationOverlay } from '../../extension/src/content/BorrowConfirmationOverlay.js';

const base = { id: 'b1', isActiveTab: true, tabTitle: 'Example', timeoutMs: 5000, onAllow: () => {}, onDeny: () => {} };

test('active borrow renders modal with countdown and actions', () => {
  const html = renderToStaticMarkup(React.createElement(BorrowConfirmationOverlay, { requests: [base] }));
  assert.match(html, /borrow-confirmation-modal/);
  assert.match(html, /allow-button/);
  assert.match(html, /deny-button/);
  assert.match(html, /5 秒后自动拒绝/);
});

test('inactive borrow renders toast stack and truncates title', () => {
  const html = renderToStaticMarkup(React.createElement(BorrowConfirmationOverlay, {
    requests: [{ ...base, id: 'b2', isActiveTab: false, tabTitle: 'x'.repeat(40) }],
  }));
  assert.match(html, /borrow-confirmation-toast/);
  assert.match(html, /x{30}…/);
});
