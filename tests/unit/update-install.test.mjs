import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupAndSwap, findRoot, readVersion, restore } from '../../tools/install-update.mjs';

function temp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function layout(root, version, value) {
  write(root, 'package.json', JSON.stringify({ version }));
  write(root, 'cli/bridge.mjs', '// bridge');
  write(root, 'daemon/server.mjs', '// daemon');
  write(root, 'lib/a.txt', value);
  write(root, 'bin/bridge', '#!/bin/sh\n');
  write(root, 'tools/make-cert.ps1', '# cert');
}

test('update swap replaces app files and keeps a restorable backup', () => {
  const root = temp('bb-update-test-');
  try {
    const dest = path.join(root, 'dest');
    const next = path.join(root, 'next');
    const backup = path.join(root, 'dest', '.rollback', 'test');
    layout(dest, '0.1.2', 'old');
    layout(next, '0.1.3', 'new');
    write(next, 'lib/b.txt', 'added');

    const entries = backupAndSwap(next, dest, backup);
    assert.ok(entries.length > 0);
    assert.equal(readVersion(dest), '0.1.3');
    assert.equal(fs.readFileSync(path.join(dest, 'lib/a.txt'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(dest, 'lib/b.txt'), 'utf8'), 'added');
    assert.ok(fs.existsSync(path.join(backup, 'install.json')));

    const record = restore(backup);
    assert.equal(record.version, '0.1.3');
    assert.equal(readVersion(dest), '0.1.2');
    assert.equal(fs.readFileSync(path.join(dest, 'lib/a.txt'), 'utf8'), 'old');
    assert.equal(fs.existsSync(path.join(dest, 'lib/b.txt')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('update swap handles a nested archive root', () => {
  const root = temp('bb-update-root-');
  try {
    const nested = path.join(root, 'BridgeDeck-cli-0.1.3');
    write(nested, 'cli/bridge.mjs', '// bridge');
    write(nested, 'package.json', JSON.stringify({ version: '0.1.3' }));
    assert.equal(findRoot(root), nested);
    assert.equal(readVersion(nested), '0.1.3');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('update swap removes directories missing from the new package', () => {
  const root = temp('bb-update-remove-');
  try {
    const dest = path.join(root, 'dest');
    const next = path.join(root, 'next');
    layout(dest, '0.1.2', 'old');
    write(dest, 'sdk/index.mjs', '// old sdk');
    layout(next, '0.1.3', 'new');

    backupAndSwap(next, dest, path.join(dest, '.rollback', 'remove'));
    assert.equal(fs.existsSync(path.join(dest, 'sdk')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
