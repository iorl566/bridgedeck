import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReadViews } from '../../daemon/read-views.js';

function make() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-read-'));
  fs.mkdirSync(path.join(home, 'audit'), { recursive: true });
  fs.writeFileSync(path.join(home, 'audit', 'a.jsonl'), [
    JSON.stringify({ id: 'op1', method: 'click', ts: 2 }),
    JSON.stringify({ id: 'op2', method: 'fill', ts: 1 }),
    '',
  ].join('\n'), 'utf8');
  const views = createReadViews({
    HOME_DIR: home,
    BridgeError: class extends Error { constructor(code, message) { super(message); this.code = code; } },
    resolveSession: (id) => ({ sessionId: id || 's1', observation: { text: 'a\nb\nc', linesText: 'a\nb\nc', url: 'u', title: 't', at: 1, refs: 2 } }),
  });
  return { views, home };
}

test('listAudit 过滤 since 并按时间倒序', () => {
  const { views } = make();
  const result = views.listAudit({ since: 2 });
  assert.equal(result.total, 1);
  assert.equal(result.entries[0].id, 'op1');
});

test('getOperation 找到记录，缺失报 E_NOT_FOUND', () => {
  const { views } = make();
  assert.equal(views.getOperation('op2').entry.method, 'fill');
  assert.throws(() => views.getOperation('none'), (error) => error.code === 'E_NOT_FOUND');
});

test('viewCache 分页与 grep', () => {
  const { views } = make();
  const all = views.viewCache({ session: 's1', limit: 2 });
    assert.equal(all.total, 3);
  assert.equal(all.lines.length, 2);
  const grep = views.viewCache({ session: 's1', grep: 'b' });
  assert.equal(grep.matched, 1);
});
