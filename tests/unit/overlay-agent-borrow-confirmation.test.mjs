import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BorrowConfirmationOverlay } from '../../extension/src/content/BorrowConfirmationOverlay.js';

const noop = () => {};
const base = {
  id: 'borrow-1',
  isActiveTab: true,
  tabTitle: 'Example tab',
  timeoutMs: 5000,
  onAllow: noop,
  onDeny: noop,
};

const render = (requests) => renderToStaticMarkup(React.createElement(BorrowConfirmationOverlay, { requests }));
const count = (html, pattern) => (html.match(pattern) ?? []).length;

test('active request renders modal, countdown ring and both actions', () => {
  const html = render([base]);
  assert.match(html, /data-slot="borrow-confirmation-modal-backdrop"/);
  assert.match(html, /data-slot="borrow-confirmation-modal"/);
  assert.match(html, /浏览器借用请求/);
  assert.match(html, /一个 Agent 请求临时接管当前标签页以完成任务。/);
  assert.match(html, /stroke-dasharray="175\.929/);
  assert.match(html, /stroke-dashoffset="0"/);
  assert.match(html, />5<\/text>/);
  assert.match(html, /5 秒后自动拒绝/);
  assert.match(html, /data-slot="borrow-confirmation-allow-button"/);
  assert.match(html, /data-slot="borrow-confirmation-deny-button"/);
  assert.match(html, /transition-opacity duration-150 ease-out opacity-100/);
  assert.equal(count(html, /data-slot="borrow-confirmation-toast"/g), 0);
});

test('countdown seconds round up from the timeout budget', () => {
  const html = render([{ ...base, timeoutMs: 4201 }]);
  assert.match(html, />5<\/text>/);
  assert.match(html, /5 秒后自动拒绝/);
  const short = render([{ ...base, timeoutMs: 1 }]);
  assert.match(short, />1<\/text>/);
  assert.match(short, /1 秒后自动拒绝/);
});

test('inactive request renders toast with truncated title and progress bar', () => {
  const title = 'x'.repeat(40);
  const html = render([{ ...base, id: 'borrow-2', isActiveTab: false, tabTitle: title }]);
  assert.match(html, /data-slot="borrow-confirmation-toast-stack"/);
  assert.equal(count(html, /data-slot="borrow-confirmation-toast"/g), 1);
  assert.match(html, /另一个标签页请求借用/);
  assert.match(html, /目标标签页：/);
  assert.ok(html.includes(`&quot;${'x'.repeat(30)}…&quot;`));
  assert.match(html, /style="width:100%"/);
  assert.match(html, /transition-\[width\] duration-1000 ease-linear/);
  assert.equal(count(html, /data-slot="borrow-confirmation-deny-button"/g), 2);
  assert.equal(count(html, /data-slot="borrow-confirmation-modal"/g), 0);
});

test('titles at the truncation boundary keep every character', () => {
  const title = 'y'.repeat(30);
  const html = render([{ ...base, id: 'borrow-3', isActiveTab: false, tabTitle: title }]);
  assert.ok(html.includes(`&quot;${title}&quot;`));
  assert.ok(!html.includes(`${'y'.repeat(30)}…`));
});

test('active modal and inactive toasts render together', () => {
  const html = render([
    base,
    { ...base, id: 'borrow-4', isActiveTab: false, tabTitle: 'One' },
    { ...base, id: 'borrow-5', isActiveTab: false, tabTitle: 'Two' },
  ]);
  assert.equal(count(html, /data-slot="borrow-confirmation-modal"/g), 1);
  assert.equal(count(html, /data-slot="borrow-confirmation-toast"/g), 2);
  assert.equal(count(html, /data-slot="borrow-confirmation-toast-stack"/g), 1);
  assert.match(html, /&quot;One&quot;/);
  assert.match(html, /&quot;Two&quot;/);
});

test('toast close control is labelled and uses the deny slot', () => {
  const html = render([{ ...base, id: 'borrow-6', isActiveTab: false }]);
  assert.match(html, /aria-label="拒绝"/);
  assert.match(html, /class="cursor-pointer border-0 bg-transparent p-0\.5 text-gray-500"/);
});

test('no requests renders nothing', () => {
  assert.equal(render([]), '');
});
