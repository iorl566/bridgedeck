import test from 'node:test';
import assert from 'node:assert/strict';
import { createHelpCommand } from '../../cli/help.mjs';

function makeHelp() {
  const printed = [];
  const printHelp = createHelpCommand({
    print: (line) => printed.push(line),
    VERSION: '9.9.9',
    loadSchemaInfo: async () => ({ renderFlagUsage: (method) => ['--' + method + '-flag'] }),
  });
  return { printHelp, printed };
}

test('help 输出包含版本、总览与关键命令', async () => {
  const { printHelp, printed } = makeHelp();
  await printHelp();
  const text = printed.join('\n');
  assert.match(text, /BridgeDeck CLI v9\.9\.9/);
  assert.match(text, /总览/);
  for (const command of ['open', 'sync', 'status', 'doctor', 'debug', 'observe']) {
    assert.ok(text.includes(command), '缺少命令 ' + command);
  }
});

test('help 从 schema 生成 click/fill flag 用法', async () => {
  const { printHelp, printed } = makeHelp();
  await printHelp();
  const text = printed.join('\n');
  assert.match(text, /--click-flag/);
  assert.match(text, /--fill-flag/);
});
