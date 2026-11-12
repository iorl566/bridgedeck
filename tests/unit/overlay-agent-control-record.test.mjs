import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ControlOverlay } from '../../extension/src/content/ControlOverlay.js';
import { RecordOverlay, clampDragPos, formatElapsed } from '../../extension/src/content/RecordOverlay.js';
import { translate } from '../../extension/src/vendor/i18n-lite.js';

const t = (key, params) => translate(key, params, 'extension');

const base = {
  visible: true,
  interrupting: false,
  automationBypass: false,
  onInterrupt: () => {},
};

function renderControl(overrides = {}) {
  return renderToStaticMarkup(React.createElement(ControlOverlay, { ...base, ...overrides }));
}

function renderRecord(request) {
  return renderToStaticMarkup(React.createElement(RecordOverlay, { request }));
}

/* ------------------------------------------------------------------ *
 * Cooperation card
 * ------------------------------------------------------------------ */

test('ControlOverlay renders nothing while the host keeps it hidden', () => {
  assert.equal(renderControl({ visible: false }), '');
  assert.equal(
    renderControl({
      visible: false,
      state: { revision: 1, mode: 'ready', editing: false },
      controller: { name: 'Agent' },
    }),
    '',
  );
});

test('ControlOverlay fallback card blocks page input and exposes only stop', () => {
  const html = renderControl();
  assert.match(html, /data-slot="control-overlay"/);
  assert.match(html, /data-slot="control-overlay-blocker"/);
  assert.match(html, /data-slot="control-overlay-card"/);
  assert.match(html, /class="bb-cooperation"/);
  assert.match(html, /role="toolbar"/);
  assert.match(html, new RegExp(`aria-label="${t('cooperation.label')}"`));
  assert.match(html, /pointer-events:auto/);
  assert.match(html, /data-slot="control-overlay-stop-all"/);
  assert.match(html, new RegExp(`>${t('cooperation.stop')}</button>`));
  assert.doesNotMatch(html, /bb-cooperation-primary/);
  assert.match(html, new RegExp(`>${t('controlOverlay.status')}<`));
});

test('ControlOverlay fallback card lets input through under automation bypass', () => {
  const html = renderControl({ automationBypass: true });
  assert.match(html, /data-slot="control-overlay-blocker"/);
  assert.match(html, /pointer-events:none/);
});

test('ControlOverlay disables stop while an interrupt is in flight and nothing is controlled', () => {
  const html = renderControl({ interrupting: true });
  assert.match(html, /data-slot="control-overlay-stop-all"[^>]*disabled=""/);
  assert.match(html, new RegExp(`>${t('controlOverlay.interrupting')}</button>`));
});

test('ControlOverlay toolbar shows controller, project, session, status and hint', () => {
  const html = renderControl({
    sessionId: 'session-1',
    controller: { name: 'Agent', project: 'Project A' },
    state: { revision: 4, mode: 'acting', editing: false },
  });
  assert.match(html, /data-slot="cooperation-toolbar"/);
  assert.match(html, /data-mode="acting"/);
  assert.doesNotMatch(html, /data-slot="control-overlay-card"/);
  assert.doesNotMatch(html, /data-slot="control-overlay-blocker"/);
  assert.match(html, /bb-controller-name" title="Agent">Agent</);
  assert.match(html, /bb-cooperation-badge/);
  assert.match(html, />Project A</);
  assert.match(html, />session-1</);
  assert.match(html, new RegExp(`>${t('controlOverlay.project')}<`));
  assert.match(html, new RegExp(`>${t('controlOverlay.session')}<`));
  assert.match(html, /role="status"/);
  assert.match(html, new RegExp(`>${t('cooperation.acting')}<`));
  assert.match(html, new RegExp(`>${t('cooperation.hints.acting')}<`));
  assert.match(html, /data-slot="control-overlay-stop-all"/);
  assert.match(html, /bb-cooperation-minimize/);
});

test('ControlOverlay toolbar names the hold action for an idle agent', () => {
  const html = renderControl({
    controller: { name: 'Agent' },
    state: { revision: 2, mode: 'ready', editing: false },
  });
  assert.match(
    html,
    new RegExp(`title="${t('controlOverlay.holdController', { name: 'Agent' })}"`),
  );
  assert.match(html, new RegExp(`>${t('controlOverlay.holdController', { name: 'Agent' })}</span>`));
});

test('ControlOverlay toolbar names the resume action for held and human modes', () => {
  for (const mode of ['held', 'human']) {
    const html = renderControl({
      controller: { name: 'Agent' },
      state: { revision: 9, mode, editing: false },
    });
    assert.match(
      html,
      new RegExp(`title="${t('controlOverlay.resumeController', { name: 'Agent' })}"`),
      mode,
    );
  }
});

test('ControlOverlay falls back to generic action and brand labels without a controller', () => {
  const hold = renderControl({ state: { revision: 1, mode: 'ready', editing: false } });
  assert.match(hold, new RegExp(`>${t('cooperation.hold')}</span>`));
  assert.match(hold, new RegExp(`>${t('popup.brandName')}</span>`));
  const resume = renderControl({ state: { revision: 1, mode: 'held', editing: false } });
  assert.match(resume, new RegExp(`>${t('cooperation.resume')}</span>`));
});

test('ControlOverlay shows the editing status for an editing human and disables yielding', () => {
  const editing = renderControl({
    state: { revision: 5, mode: 'human', editing: true },
  });
  assert.match(editing, new RegExp(`>${t('cooperation.editing')}<`));
  assert.match(editing, new RegExp(`>${t('cooperation.hints.editing')}<`));

  const yielding = renderControl({
    state: { revision: 6, mode: 'yielding', editing: false },
  });
  assert.match(yielding, /class="bb-cooperation-primary"[^>]*disabled=""/);
});

test('ControlOverlay collapses to the expand affordance when minimized', () => {
  const html = renderControl({
    minimized: true,
    sessionId: 'session-1',
    controller: { name: 'Agent' },
    state: { revision: 3, mode: 'ready', editing: false },
  });
  assert.match(html, /data-minimized="true"/);
  assert.match(html, /bb-cooperation-expand/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, new RegExp(`aria-label="${t('controlOverlay.expand')}"`));
  assert.doesNotMatch(html, /bb-cooperation-details/);
  assert.doesNotMatch(html, /bb-cooperation-actions/);
  assert.doesNotMatch(html, /bb-cooperation-minimize/);
});

test('ControlOverlay keeps an unminimized card without the minimized marker', () => {
  const html = renderControl();
  assert.doesNotMatch(html, /data-minimized/);
  assert.match(html, /bb-cooperation-minimize/);
  assert.match(html, /aria-expanded="true"/);
});

test('ControlOverlay pins the agent target to page coordinates without card coupling', () => {
  const html = renderControl({
    state: {
      revision: 7,
      mode: 'acting',
      editing: false,
      target: { x: 75, y: 120, expires: Date.now() + 60_000 },
    },
  });
  assert.match(html, /class="bb-cooperation-target"/);
  assert.match(html, /style="left:75px;top:120px"/);
  assert.match(html, /bb-cooperation-target"[^>]*aria-hidden="true"/);
  assert.match(html, /bb-cooperation-target"[^>]*><span>Agent<\/span>/);
});

test('ControlOverlay omits the target marker and session list when absent', () => {
  const html = renderControl({ state: { revision: 1, mode: 'ready', editing: false } });
  assert.doesNotMatch(html, /bb-cooperation-target/);
  assert.doesNotMatch(html, /bb-controller-details/);
  const expiring = renderControl({
    state: {
      revision: 1,
      mode: 'ready',
      editing: false,
      target: { x: 1, y: 2, expires: Date.now() - 1 },
    },
  });
  assert.doesNotMatch(expiring, /bb-cooperation-target/);
});

/* ------------------------------------------------------------------ *
 * Recording pill
 * ------------------------------------------------------------------ */

test('RecordOverlay renders nothing without a recording request', () => {
  assert.equal(renderRecord(null), '');
});

test('RecordOverlay renders the fixed pill with the intro label and pulsing indicator', () => {
  const html = renderRecord({ id: 'rec-1', startedAtMs: Date.now(), onFinish: () => {} });
  assert.match(html, /data-slot="record-overlay-pill"/);
  assert.match(html, /data-phase="intro"/);
  assert.match(html, /data-dragging="false"/);
  assert.match(html, /position:fixed/);
  assert.match(html, /bottom:32px/);
  assert.match(html, /left:50%/);
  assert.match(html, /z-index:2147483647/);
  assert.match(html, /height:50px/);
  assert.match(html, /border-radius:9999px/);
  assert.match(html, /background-color:#fff/);
  assert.match(html, /gap:5px/);
  assert.match(html, /opacity:0/);
  assert.match(html, /translateX\(-50%\) translateY\(8px\)/);
  assert.match(html, /@keyframes bb-rec-pulse/);
  assert.match(html, /data-slot="record-overlay-status"/);
  assert.match(html, /data-slot="record-overlay-indicator"/);
  assert.match(html, /animation:bb-rec-pulse 1.4s ease-in-out infinite/);
  assert.match(html, /data-slot="record-overlay-label"/);
  assert.match(html, new RegExp(`>${t('recordOverlay.recording')}<`));
});

test('RecordOverlay renders an icon-only finish button wired to onFinish', () => {
  let finished = 0;
  const html = renderRecord({ id: 'rec-2', onFinish: () => { finished += 1; } });
  assert.match(html, /data-slot="record-overlay-finish"/);
  assert.match(html, new RegExp(`aria-label="${t('recordOverlay.finish')}"`));
  assert.match(html, /record-icon\.png/);
  assert.match(html, /width="24"/);
  assert.match(html, /height="24"/);
  assert.match(html, /draggable="false"/);
  assert.match(html, /width:32px;height:32px/);
  assert.match(html, /border:none/);
  assert.equal(finished, 0);
});

test('RecordOverlay keeps the intro phase independent from the reported start time', () => {
  const fresh = renderRecord({ id: 'rec-3', startedAtMs: Date.now(), onFinish: () => {} });
  const resumed = renderRecord({ id: 'rec-3', startedAtMs: Date.now() - 65_000, onFinish: () => {} });
  assert.match(fresh, /data-phase="intro"/);
  assert.match(resumed, /data-phase="intro"/);
  assert.match(fresh, new RegExp(`>${t('recordOverlay.recording')}<`));
  assert.match(resumed, new RegExp(`>${t('recordOverlay.recording')}<`));
});

test('formatElapsed zero-pads minutes and seconds and grows past two digits', () => {
  assert.equal(formatElapsed(0), '00:00');
  assert.equal(formatElapsed(5), '00:05');
  assert.equal(formatElapsed(59), '00:59');
  assert.equal(formatElapsed(60), '01:00');
  assert.equal(formatElapsed(125), '02:05');
  assert.equal(formatElapsed(3_599), '59:59');
  assert.equal(formatElapsed(6_000), '100:00');
});

test('clampDragPos keeps the pill inside the viewport margin', () => {
  const originalWindow = globalThis.window;
  globalThis.window = { innerWidth: 1_000, innerHeight: 800 };
  try {
    assert.deepEqual(clampDragPos(300, 200, 300, 100), { top: 300, left: 200 });
    assert.deepEqual(clampDragPos(-40, -40, 300, 100), { top: 16, left: 16 });
    assert.deepEqual(clampDragPos(10_000, 10_000, 300, 100), { top: 684, left: 684 });
    // A panel larger than the viewport must pin to the top/left margin.
    assert.deepEqual(clampDragPos(500, 500, 2_000, 2_000), { top: 16, left: 16 });
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
