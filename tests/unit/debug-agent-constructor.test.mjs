import test from 'node:test';
import assert from 'node:assert/strict';
import { DebugManager } from '../../extension/src/debug/manager.js';

test('DebugManager accepts the reference dependency-order constructor', () => {
  const sessions = { get() { return null; }, list() { return []; } };
  const cdp = {};
  const tabs = { async get() { return {}; } };
  const archive = { async list() { return []; }, async delete() {}, async put() {}, async query() {} };
  const manager = new DebugManager(sessions, cdp, tabs, () => 123, archive);
  assert.equal(manager.sessions, sessions);
  assert.equal(manager.cdp, cdp);
  assert.equal(manager.tabs, tabs);
  assert.equal(manager.archive, archive);
  assert.equal(manager.now(), 123);
});

test('DebugManager requires a session registry with get and list', () => {
  assert.throws(() => new DebugManager(), /session registry/);
  assert.throws(() => new DebugManager({ get() {} }), /session registry/);
  assert.throws(() => new DebugManager({ list() {} }), /session registry/);
});
