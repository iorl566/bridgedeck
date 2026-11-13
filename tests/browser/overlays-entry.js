import React from 'react';
import { createRoot } from 'react-dom/client';
import { HelpRequestOverlay } from '../../extension/src/content/HelpRequestOverlay.js';
import { BorrowConfirmationOverlay } from '../../extension/src/content/BorrowConfirmationOverlay.js';
import { ControlOverlay } from '../../extension/src/content/ControlOverlay.js';
import { RecordOverlay } from '../../extension/src/content/RecordOverlay.js';

window.chrome = {
  runtime: {
    id: 'ext',
    getURL: (path) => location.origin + '/' + path,
    sendMessage: async () => ({}),
  },
};

let borrowAllows = 0;
let borrowDenies = 0;
let autoDenies = 0;
let recordFinishes = 0;
let minimizeCalls = 0;

function mount(element) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  createRoot(root).render(element);
}

mount(React.createElement(HelpRequestOverlay, {
  request: {
    id: 'overlay-test',
    title: 'Overlay test',
    prompt: 'Please approve this step',
    selectors: [],
    rects: [{ top: 10, left: 10, width: 20, height: 20 }],
    refreshRects: async () => [{ top: 120, left: 80, width: 30, height: 30 }],
    onContinue() {},
    onCancel() {},
  },
}));
mount(React.createElement(BorrowConfirmationOverlay, {
  requests: [{
    id: 'borrow-test',
    isActiveTab: true,
    tabTitle: 'Example tab',
    timeoutMs: 30_000,
    onAllow() { borrowAllows += 1; },
    onDeny() { borrowDenies += 1; },
  }],
}));
mount(React.createElement(BorrowConfirmationOverlay, {
  requests: [{
    id: 'borrow-toast',
    isActiveTab: false,
    tabTitle: 'Other tab',
    timeoutMs: 30_000,
    onAllow() { borrowAllows += 1; },
    onDeny() { borrowDenies += 1; },
  }],
}));
mount(React.createElement(BorrowConfirmationOverlay, {
  requests: [{
    id: 'borrow-auto',
    isActiveTab: true,
    tabTitle: 'Auto tab',
    timeoutMs: 1_500,
    onAllow() {},
    onDeny() { autoDenies += 1; },
  }],
}));
mount(React.createElement(ControlOverlay, {
  sessionId: 'session-test',
  controller: { name: 'Agent' },
  visible: true,
  state: { revision: 1, mode: 'ready' },
  interrupting: false,
  automationBypass: false,
  onMinimizedChange() { minimizeCalls += 1; },
  onInterrupt() {},
}));
mount(React.createElement(ControlOverlay, {
  sessionId: 'session-test',
  controller: { name: 'Agent' },
  visible: true,
  state: { revision: 1, mode: 'ready' },
  interrupting: false,
  automationBypass: false,
  minimized: true,
  onMinimizedChange() { minimizeCalls += 1; },
  onInterrupt() {},
}));
mount(React.createElement(RecordOverlay, {
  request: { id: 'record-test', startedAtMs: Date.now(), onFinish() { recordFinishes += 1; } },
}));

setTimeout(async () => {
  const text = document.body.innerText;
  const toggle = document.querySelector('[data-slot="help-collapse-toggle"]');
  const expandedBefore = toggle?.getAttribute('aria-expanded') === 'true';
  toggle?.click();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const collapsed = toggle?.getAttribute('aria-expanded') === 'false';
  toggle?.click();
  await new Promise((resolve) => setTimeout(resolve, 60));
  const expandedAgain = toggle?.getAttribute('aria-expanded') === 'true';
  const handle = document.querySelector('[data-slot="help-drag-handle"]');
  const banner = document.querySelector('[data-slot="help-request-banner"]');
  const beforeLeft = banner?.style.left;
  const beforeTop = banner?.style.top;
  if (handle && banner) {
    const box = handle.getBoundingClientRect();
    const startX = box.left + 8;
    const startY = box.top + 8;
    handle.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, isPrimary: true, button: 0, clientX: startX, clientY: startY }));
    handle.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, isPrimary: true, clientX: startX + 120, clientY: startY + 40 }));
    handle.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, isPrimary: true, clientX: startX + 120, clientY: startY + 40 }));
  }
  await new Promise((resolve) => setTimeout(resolve, 60));
  const dragged = Boolean(banner) && (banner.style.left !== beforeLeft || banner.style.top !== beforeTop);
  window.dispatchEvent(new Event('resize'));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const highlight = document.querySelector('[data-slot="help-highlight"]');
  const rectRefreshed = highlight?.style.top === '120px' && highlight?.style.left === '80px';
  document.querySelector('[data-slot="borrow-confirmation-allow-button"]')?.click();
  document.querySelector('[data-slot="borrow-confirmation-toast"] [data-slot="borrow-confirmation-deny-button"]')?.click();
  document.querySelector('[data-slot="record-overlay-finish"]')?.click();
  document.querySelector('.bb-cooperation-minimize')?.click();
  const pill = document.querySelector('[data-slot="record-overlay-pill"]');
  const pillLeft = pill?.style.left;
  if (pill) {
    const box = pill.getBoundingClientRect();
    const startX = box.left + 8;
    const startY = box.top + 8;
    pill.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 2, isPrimary: true, button: 0, clientX: startX, clientY: startY }));
    pill.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 2, isPrimary: true, clientX: startX + 90, clientY: startY + 30 }));
    pill.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 2, isPrimary: true, clientX: startX + 90, clientY: startY + 30 }));
  }
  await new Promise((resolve) => setTimeout(resolve, 350));
  const autoDenyPending = autoDenies === 0;
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const autoDenied = autoDenyPending && autoDenies === 1;
  const actions = borrowAllows >= 1 && borrowDenies >= 1 && recordFinishes === 1 && minimizeCalls === 1;
  const pillMoved = Boolean(pill) && pill.style.left !== pillLeft;
  const minimized = Boolean(document.querySelector('.bb-cooperation-expand'));
  const checks = {
    help: text.includes('Overlay test'),
    borrow: Boolean(document.querySelector('[data-slot="borrow-confirmation-modal"]')),
    control: Boolean(document.querySelector('.bb-cooperation-header')),
    record: Boolean(document.querySelector('[data-slot="record-overlay-indicator"]')),
    collapse: expandedBefore && collapsed && expandedAgain,
    drag: dragged,
    rectRefreshed,
    actions,
    autoDenied,
    pillMoved,
    minimized,
  };
  document.title = Object.values(checks).every(Boolean)
    ? 'OVERLAY_OK'
    : 'OVERLAY_FAIL:' + JSON.stringify({ ...checks, borrowAllows, borrowDenies, recordFinishes, minimizeCalls });
}, 400);
