import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEV_MODE_WARNING_SNOOZE_END_TIME, browserArgs, prepareBrowserProfile } from '../../tools/browser-launch.mjs';

test('prepareBrowserProfile writes deterministic prefs and local state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-launch-test-'));
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Default', 'Preferences'), JSON.stringify({ keep: true }), 'utf8');
  prepareBrowserProfile(dir);
  const prefs = JSON.parse(fs.readFileSync(path.join(dir, 'Default', 'Preferences'), 'utf8'));
  assert.equal(prefs.keep, true);
  assert.equal(prefs.extensions.ui.dev_mode_warning_snooze_end_time, DEV_MODE_WARNING_SNOOZE_END_TIME);
  assert.deepEqual(prefs.fre_sync_consent, { seen: true, confirmed: true });
  assert.equal(prefs.google.services.consented_to_sync, true);
  const local = JSON.parse(fs.readFileSync(path.join(dir, 'Local State'), 'utf8'));
  assert.equal(local.browser.first_run_finished, true);
  assert.equal(local.edge.first_run_completed, true);
  const raw = fs.readFileSync(path.join(dir, 'Default', 'Preferences'));
  assert.notEqual(raw[0], 0xef);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('browserArgs carries flags that suppress Edge first-run/sync/extension warnings', () => {
  const args = browserArgs({ profileDir: 'C:\\tmp\\p', extensionDir: 'C:\\ext', windowSize: '1280,900' });
  assert.ok(args.includes('--no-first-run'));
  assert.ok(args.includes('--disable-sync'));
  assert.ok(args.some((item) => item.startsWith('--disable-features=')));
  assert.ok(args.some((item) => item.includes('msEdgeFirstRunExperience')));
  assert.ok(args.some((item) => item.includes('msEdgeSyncConsent')));
  assert.ok(args.some((item) => item.includes('msEdgeSyncFRE')));
  assert.ok(args.includes('--load-extension=C:\\ext'));
  assert.ok(args.includes('--window-size=1280,900'));
  assert.equal(args[args.length - 1], 'about:blank');
});

test('browserArgs can open a dedicated new window', () => {
  const args = browserArgs({ profileDir: 'p', extensionDir: 'e', newWindow: true });
  assert.ok(args.includes('--new-window'));
  assert.ok(!args.some((item) => item.startsWith('--window-size=')));
});
