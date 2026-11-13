import test from 'node:test';
import assert from 'node:assert/strict';
import { attachDaemonUpgradeNotice } from '../../extension/src/lib/daemon-upgrade-notice.js';

function harness(initial) {
  let subscriber;
  const events = [];
  const session = new Map();
  const deps = {
    action: {
      async setBadgeBackgroundColor(value) { events.push(['bg', value]); },
      async setBadgeText(value) { events.push(['text', value.text]); },
      async setTitle(value) { events.push(['title', value.title]); },
      async openPopup() { events.push(['popup']); },
    },
    notifications: {
      async clear(id) { events.push(['clear', id]); },
      async create(id, value) { events.push(['create', id, value]); },
      onClicked: { addListener(fn) { events.push(['onClicked', fn]); }, removeListener() {} },
      onButtonClicked: { addListener(fn) { events.push(['onButton', fn]); }, removeListener() {} },
    },
    session: {
      async get(key) { return { [key]: session.get(key) }; },
      async set(items) { for (const [key, value] of Object.entries(items)) session.set(key, value); },
    },
    runtime: { getURL: (path) => `chrome-extension://x/${path}` },
    tabs: { async create() {} },
    copy: (key) => `copy:${key}`,
    i18n: { on() {}, off() {} },
  };
  const controller = {
    snapshot: () => initial,
    subscribe(fn) { subscriber = fn; return () => {}; },
  };
  const handle = attachDaemonUpgradeNotice({ controller, connectionKey: () => 'local', isRecording: () => false, deps });
  return { handle, events, session, update: (next) => subscriber(next) };
}

const issue = { daemonVersion: '1', daemonProtocolVersion: '1.8', requiredProtocolVersion: '1.9' };

test('upgrade issue sets badge and creates notice once', async () => {
  const h = harness({ connectionEnabled: true, extensionVersion: '0.1', state: 'disconnected', daemonUpgradeRequired: issue });
  await h.handle.refresh();
  assert(h.events.some((event) => event[0] === 'text' && event[1] === '!'));
  assert(h.events.some((event) => event[0] === 'create'));
  await h.handle.refresh();
  assert.equal(h.events.filter((event) => event[0] === 'create').length, 1);
});

test('connected clears the notice', async () => {
  const h = harness({ connectionEnabled: true, extensionVersion: '0.1', state: 'disconnected', daemonUpgradeRequired: issue });
  await h.handle.refresh();
  h.update({ connectionEnabled: true, extensionVersion: '0.1', state: 'connected' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(h.events.some((event) => event[0] === 'clear'));
});

test('recording shows REC when no upgrade issue', async () => {
  const h = harness({ connectionEnabled: true, extensionVersion: '0.1', state: 'connected' });
  await h.handle.refresh();
  assert.equal(h.events.find((event) => event[0] === 'text')[1], '');
});
