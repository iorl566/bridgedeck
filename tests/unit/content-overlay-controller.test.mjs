import test from 'node:test';
import assert from 'node:assert/strict';
import { OverlayController, shouldShowAgentControlOverlay } from '../../extension/src/content/overlay-controller.js';

test('activate and control mode drive visibility', () => {
  const c = new OverlayController();
  c.activateAgentSession('s1');
  assert.equal(c.snapshot().controlVisible, true);
  c.applyAgentControlMode('s1', 'paused');
  assert.equal(c.snapshot().controlVisible, false);
  assert.equal(c.snapshot().controlMode, 'paused');
  c.applyAgentControlMode(null, 'hidden');
  assert.equal(c.snapshot().activeSessionId, null);
});

test('borrow requests dedupe by id', () => {
  const c = new OverlayController();
  c.addBorrowRequest({ id: 'a', tabId: 1 });
  c.addBorrowRequest({ id: 'a', tabId: 2 });
  assert.equal(c.snapshot().borrowRequests.length, 1);
  assert.equal(c.snapshot().borrowRequests[0].tabId, 2);
  c.removeBorrowRequest('a');
  assert.equal(c.snapshot().borrowRequests.length, 0);
});

test('help request can be cleared only by matching id', () => {
  const c = new OverlayController();
  c.setAgentHelpRequest({ id: 'h1' });
  c.clearAgentHelpRequest('other');
  assert.equal(c.snapshot().activeHelp.id, 'h1');
  c.clearAgentHelpRequest('h1');
  assert.equal(c.snapshot().activeHelp, null);
});

test('record clear suppresses control and resets bypass count', () => {
  const c = new OverlayController();
  c.activateAgentSession('s1');
  c.setAgentRecordRequest({ id: 'r1' });
  c.setAutomationBypass(true);
  c.setAutomationBypass(true);
  assert.equal(c.snapshot().automationBypassCount, 2);
  c.clearAgentRecordRequest('r1');
  assert.equal(c.snapshot().suppressControlAfterRecord, true);
  assert.equal(c.snapshot().automationBypassCount, 0);
  assert.equal(shouldShowAgentControlOverlay(c.snapshot()), false);
});

test('reset ignores other sessions and keeps preferences', () => {
  const c = new OverlayController();
  c.activateAgentSession('s1');
  c.setControlHintsHidden(true);
  assert.equal(c.resetAgentOverlays('other'), null);
  assert.equal(c.snapshot().activeSessionId, 's1');
  c.resetAgentOverlays('s1');
  assert.equal(c.snapshot().activeSessionId, null);
  assert.equal(c.snapshot().controlHintsHidden, true);
});
