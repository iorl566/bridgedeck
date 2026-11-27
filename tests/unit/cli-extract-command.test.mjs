import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExtractCommand } from '../../cli/commands/extract.mjs';
import { ArgError, intFlag } from '../../cli/lib/args.mjs';
import { renderTable, truncateText } from '../../cli/lib/format.mjs';

function makeCommand(handler) {
  const printed = [];
  const cmd = createExtractCommand({
    withControl: (flags, base) => ({ session: 's1', ...base }),
    resolveTarget: (flags) => (flags.selector ? { selector: String(flags.selector) } : null),
    callRpc: async (method, params) => handler(method, params),
    timeoutOf: () => 5000,
    outputFailure: (body) => { throw new Error(body.error.code); },
    outputJsonBody: () => 0,
    emitJson: () => 0,
    isJson: () => false,
    print: (line) => printed.push(line),
    renderTable,
    truncateText,
    intFlag,
    ArgError,
  });
  return { cmd, printed };
}

test('extract discover 空列表提示', async () => {
  const { cmd, printed } = makeCommand(() => ({ ok: true, result: { targets: [] } }));
  assert.equal(await cmd({}, ['extract', 'discover']), 0);
  assert.match(printed.join('\n'), /没有可导出的表格/);
});

test('extract list 非法 --fields-json 抛 ArgError', async () => {
  const { cmd } = makeCommand(() => ({ ok: true, result: { rows: [] } }));
  await assert.rejects(() => cmd({ 'fields-json': '{bad', selector: '#x' }, ['extract', 'list']), ArgError);
});

test('extract table 缺 target/selector 抛 ArgError', async () => {
  const { cmd } = makeCommand(() => ({ ok: true, result: { rows: [] } }));
  await assert.rejects(() => cmd({}, ['extract', 'table']), ArgError);
});

test('extract --format csv 写 BOM 与表头', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-extract-cmd-'));
  try {
    const { cmd, printed } = makeCommand(() => ({
      ok: true,
      result: { columns: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], rows: [{ a: '=1', b: 'x,y' }], rowCount: 1, truncated: false },
    }));
    const out = path.join(dir, 'out.csv');
    assert.equal(await cmd({ selector: '#t', format: 'csv', out, 'csv-safe': true }, ['extract']), 0);
    const text = fs.readFileSync(out, 'utf8');
    assert.ok(text.startsWith('\ufeffA,B'));
    assert.match(text, /'=1/);
    assert.match(text, /"x,y"/);
    assert.match(printed.join('\n'), /已导出 1 行/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
