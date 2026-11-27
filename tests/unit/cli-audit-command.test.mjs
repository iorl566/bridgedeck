import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAuditCommand } from '../../cli/commands/audit.mjs';
import { ArgError, intFlag } from '../../cli/lib/args.mjs';
import { formatTime, renderTable, truncateText } from '../../cli/lib/format.mjs';

function makeCommand() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-audit-cmd-'));
  const printed = [];
  const cmd = createAuditCommand({
    auditDir: dir,
    writeFileAtomic: (file, content) => fs.writeFileSync(file, content, 'utf8'),
    parseSince: (text) => (text === undefined ? 0 : Date.parse(String(text))),
    intFlag,
    ArgError,
    parseDurationMs: () => 0,
    emitJson: () => 0,
    isJson: () => false,
    print: (line) => printed.push(line),
    renderTable,
    formatTime,
    truncateText,
  });
  return { dir, cmd, printed };
}

function writeRows(dir, name, rows) {
  fs.writeFileSync(path.join(dir, name), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

test('audit list 按时间倒序 + offset/limit', async () => {
  const { dir, cmd, printed } = makeCommand();
  try {
    writeRows(dir, '2026-01.jsonl', [
      { ts: Date.parse('2026-01-01T00:00:00Z'), method: 'click', ok: true },
      { ts: Date.parse('2026-01-02T00:00:00Z'), method: 'fill', ok: false, code: 'E_BAD' },
      { ts: Date.parse('2026-01-03T00:00:00Z'), method: 'observe', ok: true },
    ]);
    assert.equal(await cmd({ limit: '2', offset: '0' }, ['audit', 'list']), 0);
    const text = printed.join('\n');
    assert.match(text, /observe/);
    assert.match(text, /fill/);
    assert.doesNotMatch(text, /click/);
    assert.match(text, /共 3 条/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit export 写 jsonl', async () => {
  const { dir, cmd, printed } = makeCommand();
  try {
    writeRows(dir, '2026-01.jsonl', [{ ts: 1, method: 'click', ok: true }]);
    const out = path.join(dir, 'export.jsonl');
    assert.equal(await cmd({ out }, ['audit', 'export']), 0);
    assert.equal(fs.readFileSync(out, 'utf8').trim(), JSON.stringify({ ts: 1, method: 'click', ok: true }));
    assert.match(printed.join('\n'), /已导出 1 条审计/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit prune dry-run 不删除文件', async () => {
  const { dir, cmd } = makeCommand();
  try {
    writeRows(dir, 'old.jsonl', [{ ts: Date.parse('2020-01-01T00:00:00Z'), method: 'click', ok: true }]);
    assert.equal(await cmd({ 'older-than': '30d', 'dry-run': true }, ['audit', 'prune']), 0);
    assert.ok(fs.existsSync(path.join(dir, 'old.jsonl')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('audit clear 需要 --yes', async () => {
  const { dir, cmd } = makeCommand();
  try {
    writeRows(dir, 'a.jsonl', [{ ts: 1 }]);
    await assert.rejects(() => cmd({}, ['audit', 'clear']), ArgError);
    assert.equal(await cmd({ yes: true }, ['audit', 'clear']), 0);
    assert.equal(fs.readdirSync(dir).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
