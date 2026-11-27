// tests/unit/compat-rpc.test.mjs —— 兼容 RPC 线名表 + daemon 本地接线。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPAT_RPC_METHODS, COMPAT_RPC_NAMES, isCompatRpcMethod } from '../../lib/compat-rpc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('兼容 RPC 表：4 个线名，均为 daemon-local 且有说明', () => {
  assert.deepEqual([...COMPAT_RPC_NAMES].sort(), ['cancel', 'ledger.request', 'system.handshake', 'system.ping']);
  for (const name of COMPAT_RPC_NAMES) {
    const entry = COMPAT_RPC_METHODS[name];
    assert.equal(entry.wire, name);
    assert.equal(entry.route, 'daemon-local');
    assert.ok(entry.note.length > 10, name + ' 缺少语义说明');
  }
  assert.equal(isCompatRpcMethod('system.ping'), true);
  assert.equal(isCompatRpcMethod('open'), false);
});

test('daemon 本地 dispatch 有真实 case，server 放行兼容方法', () => {
  const local = read('daemon/local-dispatch.js');
  assert.match(local, /case 'system\.ping'/);
  assert.match(local, /case 'system\.handshake'/);
  assert.match(local, /case 'cancel'/);
  assert.match(local, /case 'ledger\.request'/);
  const server = read('daemon/server.mjs');
  assert.match(server, /COMPAT_RPC_NAMES/);
  assert.match(server, /compatPing/);
  assert.match(server, /compatHandshake/);
});

test('兼容 RPC 文档包含全部线名', () => {
  const doc = read('docs/COMPAT-RPC.md');
  for (const name of COMPAT_RPC_NAMES) assert.ok(doc.includes('`' + name + '`'), '文档缺少 ' + name);
});
