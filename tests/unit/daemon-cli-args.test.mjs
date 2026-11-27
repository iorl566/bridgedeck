import test from 'node:test';
import assert from 'node:assert/strict';
import { parseServerArgs } from '../../daemon/cli-args.js';

test('parseServerArgs 解析端口与前台', () => {
  assert.deepEqual(parseServerArgs(['--port', '52901', '--foreground']), { port: 52901, foreground: true, stop: false, help: false });
  assert.deepEqual(parseServerArgs(['--port=52902']), { port: 52902, foreground: false, stop: false, help: false });
});

test('parseServerArgs 解析 stop/help', () => {
  assert.equal(parseServerArgs(['--stop']).stop, true);
  assert.equal(parseServerArgs(['-h']).help, true);
});
