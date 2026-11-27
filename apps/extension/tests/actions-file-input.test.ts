// tests/actions-file-input.test.ts —— 超大文件 CDP 直写 file input（18e）单测。
//
// 覆盖：DOM.setFileInputFiles 成功 + 页面回读校验、目标不是 file input、
// 没有 CDP / 没有本机路径 → E_UNSUPPORTED_CAPABILITY（带替代建议）、
// 回读不一致 → 明确失败（不假成功）、canHandle 判定。

import test from 'node:test';
import assert from 'node:assert/strict';
import type { CdpChannel } from '../src/debug/cdp-channel.ts';
import { FileInputService, findFirstFileInput } from '../src/actions/file-input.ts';
import { RpcMethodError } from '../src/rpc/registry.ts';

type Handler = (params: Record<string, unknown>) => unknown;

class FakeChannel implements CdpChannel {
  readonly sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  private readonly handlers: Record<string, Handler>;
  released = 0;

  constructor(handlers: Record<string, Handler>) {
    this.handlers = handlers;
  }

  async acquire(): Promise<void> {
    // no-op
  }

  release(): void {
    this.released += 1;
  }

  async send<T = unknown>(_tabId: number, method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.sent.push({ method, params });
    const handler = this.handlers[method];
    if (!handler) return {} as T;
    return handler(params) as T;
  }

  onEvent(): () => void {
    return () => undefined;
  }
}

function uploadChannel(applied: Array<{ name: string; size: number }>, attributes: string[] = ['type', 'file', 'id', 'file']): FakeChannel {
  return new FakeChannel({
    'DOM.enable': () => ({}),
    'DOM.getDocument': () => ({ root: { nodeId: 1 } }),
    'DOM.querySelector': () => ({ nodeId: 5 }),
    'DOM.describeNode': () => ({ node: { nodeId: 5, backendNodeId: 42, nodeName: 'INPUT', attributes } }),
    'DOM.setFileInputFiles': () => ({}),
    'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
    'Runtime.callFunctionOn': () => ({ result: { value: applied } }),
    'Runtime.releaseObject': () => ({}),
  });
}

test('upload：selector → DOM.setFileInputFiles → 回读校验通过（via=input-path）', async () => {
  const channel = uploadChannel([{ name: 'big-direct.bin', size: 9 * 1024 * 1024 }]);
  const service = new FileInputService({ client: channel, now: () => 1234 });
  const result = await service.upload({
    tabId: 7,
    selector: '#file',
    paths: ['C:\\tmp\\stage\\big-direct.bin'],
  });
  assert.equal(result.via, 'input-path');
  assert.equal(result.trusted, true);
  assert.deepEqual(result.names, ['big-direct.bin']);
  assert.equal(result.verified, true);
  assert.equal(result.effectState, 'committed');
  const setCall = channel.sent.find((item) => item.method === 'DOM.setFileInputFiles');
  assert.deepEqual(setCall?.params, { files: ['C:\\tmp\\stage\\big-direct.bin'], backendNodeId: 42 });
  assert.equal(channel.released, 1, '租约必须释放');
});

test('upload：没有本机路径（只有内联字节/transfer 元数据）→ E_UNSUPPORTED_CAPABILITY + 替代建议', async () => {
  const channel = uploadChannel([{ name: 'big.bin', size: 9 * 1024 * 1024 }]);
  const service = new FileInputService({ client: channel });
  await assert.rejects(
    service.upload({ tabId: 7, selector: '#file', files: [{ name: 'big.bin', size: 9 * 1024 * 1024, base64: 'AA==' }] }),
    (error: unknown) => {
      assert.ok(error instanceof RpcMethodError);
      assert.equal(error.code, 'E_UNSUPPORTED_CAPABILITY');
      const data = error.data as Record<string, unknown>;
      assert.equal(data.reason, 'no-local-paths');
      assert.ok(Array.isArray(data.alternatives) && data.alternatives.length > 0);
      return true;
    },
  );
  assert.equal(channel.sent.some((item) => item.method === 'DOM.setFileInputFiles'), false);
});

test('upload：没有 CDP 通道 → E_UNSUPPORTED_CAPABILITY（不假成功）', async () => {
  const service = new FileInputService({ client: null });
  assert.equal(service.available(), false);
  await assert.rejects(
    service.upload({ tabId: 7, selector: '#file', paths: ['C:\\tmp\\a.bin'] }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'E_UNSUPPORTED_CAPABILITY');
      const data = (error as RpcMethodError).data as Record<string, unknown>;
      assert.equal(data.capability, 'DOM.setFileInputFiles');
      assert.equal(data.reason, 'no-cdp-channel');
      return true;
    },
  );
});

test('upload：目标不是 input[type=file] → E_NOT_ACTIONABLE（reason=not-file-input）', async () => {
  const channel = uploadChannel([], ['type', 'text', 'id', 'kw']);
  const service = new FileInputService({ client: channel });
  await assert.rejects(
    service.upload({ tabId: 7, selector: '#kw', paths: ['C:\\tmp\\a.bin'] }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'E_NOT_ACTIONABLE');
      const data = (error as RpcMethodError).data as Record<string, unknown>;
      assert.equal(data.reason, 'not-file-input');
      assert.ok(Array.isArray(data.alternatives) && data.alternatives.length > 0);
      return true;
    },
  );
  assert.equal(channel.sent.some((item) => item.method === 'DOM.setFileInputFiles'), false);
});

test('upload：CDP 写入成功但页面回读不一致 → E_NOT_ACTIONABLE（files-not-applied，不假成功）', async () => {
  const channel = uploadChannel([{ name: 'other.bin', size: 1 }]);
  const service = new FileInputService({ client: channel });
  await assert.rejects(
    service.upload({ tabId: 7, selector: '#file', paths: ['C:\\tmp\\big-direct.bin'] }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'E_NOT_ACTIONABLE');
      const data = (error as RpcMethodError).data as Record<string, unknown>;
      assert.equal(data.reason, 'files-not-applied');
      assert.deepEqual(data.expected, ['big-direct.bin']);
      assert.deepEqual(data.actual, ['other.bin']);
      return true;
    },
  );
});

test('upload：selector 找不到时退回全文档第一个 file input（hidden-input 兜底）', async () => {
  const channel = new FakeChannel({
    'DOM.enable': () => ({}),
    'DOM.getDocument': (params) => (Number(params['depth']) === -1
      ? { root: { nodeId: 1, children: [{ nodeId: 8, backendNodeId: 88, nodeType: 1, nodeName: 'INPUT', attributes: ['type', 'file'] }] } }
      : { root: { nodeId: 1 } }),
    'DOM.querySelector': () => ({ nodeId: 0 }),
    'DOM.setFileInputFiles': () => ({}),
    'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
    'Runtime.callFunctionOn': () => ({ result: { value: [{ name: 'a.bin', size: 2 }] } }),
    'Runtime.releaseObject': () => ({}),
  });
  const service = new FileInputService({ client: channel });
  const result = await service.upload({ tabId: 7, selector: '#pick-file', paths: ['/tmp/a.bin'] });
  assert.equal(result.backendNodeId, 88);
  assert.deepEqual(result.names, ['a.bin']);
});

test('canHandle / findFirstFileInput / drop 模式', async () => {
  const channel = uploadChannel([{ name: 'a.bin', size: 1 }]);
  const service = new FileInputService({ client: channel });
  assert.equal(service.canHandle({ tabId: 7, selector: '#file', paths: ['/tmp/a.bin'] }), true);
  assert.equal(service.canHandle({ tabId: 7, selector: '#file', paths: [] }), false);
  assert.equal(service.canHandle({ tabId: 7, selector: '#file', paths: ['/tmp/a.bin'], mode: 'drop' }), false);
  const found = findFirstFileInput({
    nodeType: 9,
    children: [{ nodeType: 1, nodeName: 'DIV', children: [{ nodeType: 1, nodeName: 'INPUT', backendNodeId: 3, attributes: ['type', 'file'] }] }],
  });
  assert.equal(found?.backendNodeId, 3);
  await assert.rejects(
    service.upload({ tabId: 7, selector: '#file', paths: ['/tmp/a.bin'], mode: 'drop' }),
    (error: unknown) => (error as { code?: string }).code === 'E_UNSUPPORTED_CAPABILITY',
  );
});
