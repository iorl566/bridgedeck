// tests/record-chrome-deps.test.ts —— 真实 chrome.* 依赖适配（executeScript 注入/浮层/存储/导出截图）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChromeRecordDeps, createChromeRecordService, type ChromeRecordApi } from '../src/record/chrome-deps.ts';
import type { StorageAreaLike } from '../src/record/store.ts';

interface ScriptCall {
  func: string;
  target: Record<string, unknown>;
  args: unknown[];
}

class FakeArea implements StorageAreaLike {
  readonly data = new Map<string, unknown>();
  async get(key: string): Promise<Record<string, unknown>> {
    return this.data.has(key) ? { [key]: this.data.get(key) } : {};
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.data.set(key, value);
  }
}

class FakeChromeApi implements ChromeRecordApi {
  readonly calls: ScriptCall[] = [];
  readonly deactivated: Array<{ tabId: number; message: unknown }> = [];
  readonly session = new FakeArea();
  readonly local = new FakeArea();
  failCaptureTab: number | null = null;
  readonly tabs = {
    get: async (tabId: number) => ({ id: tabId, windowId: tabId === 13 ? 2 : 1, url: 'https://example.test/', title: '夹具页' }),
    sendMessage: async (tabId: number, message: unknown) => {
      this.deactivated.push({ tabId, message });
      return { ok: true };
    },
    captureVisibleTab: async () => 'data:image/jpeg;base64,SHOT',
  };
  readonly scripting = {
    executeScript: async (options: Record<string, unknown>) => {
      const func = options.func as (...args: unknown[]) => unknown;
      this.calls.push({
        func: func.name,
        target: options.target as Record<string, unknown>,
        args: (options.args as unknown[]) ?? [],
      });
      if (this.failCaptureTab !== null && func.name === 'installRecordCapture') {
        const target = options.target as { tabId?: number };
        if (Number(target.tabId) === this.failCaptureTab) return [{ result: { ok: false, reason: 'no-dom' } }];
      }
      return [{ result: { ok: true } }, { result: { ok: true } }];
    },
  };
  readonly storage = { session: this.session, local: this.local };
  readonly runtime = { id: 'ext-1', getURL: (path: string) => 'chrome-extension://ext-1/' + path };
}

function functionsOf(calls: ScriptCall[]): string[] {
  return calls.map((call) => call.func);
}

test('createChromeRecordDeps：start 注入页面录制器（allFrames）与浮层；stop 先 deactivate 再移除浮层', async () => {
  const api = new FakeChromeApi();
  const service = createChromeRecordService(api, { now: () => 1_700_000_000_000, lang: 'en' });
  const started = await service.start({ tabId: 12, includeAgent: true });
  assert.equal(started.ok, true);
  assert.ok(started.captureFrames >= 1);
  assert.equal(started.overlay, true);
  assert.deepEqual(functionsOf(api.calls), ['installRecordCapture', 'installRecordOverlay']);
  const captureCall = api.calls[0];
  assert.ok(captureCall);
  assert.deepEqual(captureCall.target, { tabId: 12, allFrames: true });
  assert.equal((captureCall.args[0] as { includeAgent: boolean }).includeAgent, true);
  assert.equal((api.calls[1]?.args[1] as string), 'en', '浮层语言透传');

  api.calls.length = 0;
  const stopped = await service.stop({ tabId: 12 });
  assert.equal(stopped.ok, true);
  assert.equal(api.deactivated[0]?.tabId, 12);
  assert.deepEqual(api.deactivated[0]?.message, { type: 'bb.record.deactivate' });
  assert.deepEqual(functionsOf(api.calls), ['stopRecordCapture', 'removeRecordOverlay']);
});

test('createChromeRecordDeps：事件入会话 + 持久化到 session/local + record.list 摘要', async () => {
  const api = new FakeChromeApi();
  const service = createChromeRecordService(api);
  await service.start({ tabId: 12, includeAgent: true });
  const pushed = service.pushEvent({ kind: 'click', selector: '#submit-btn' }, { tab: { id: 12 }, frameId: 0, documentId: 'doc-12' });
  assert.equal(pushed.recorded, true);
  await service.stop({ tabId: 12 });
  assert.equal(api.session.data.size > 0, true, '录制要落 session');
  assert.equal(api.local.data.size > 0, true, '录制要落 local');
  const listed = await service.list({ includeEvents: false });
  const summary = listed.recordings[0] as { events?: number; kinds?: Record<string, number> };
  assert.equal(summary.events, 1);
  assert.equal(summary.kinds?.click, 1);
  const deps = createChromeRecordDeps(api);
  assert.equal(typeof deps.capture?.start, 'function');
  assert.equal(typeof deps.overlay?.show, 'function');
});

test('createChromeRecordDeps：导出截图走 captureVisibleTab；无截图能力时 screenshots=0', async () => {
  const api = new FakeChromeApi();
  const service = createChromeRecordService(api);
  await service.start({ tabId: 12, includeAgent: true });
  service.pushEvent({ kind: 'click', selector: '#submit-btn' }, { tab: { id: 12 } });
  await service.stop({ tabId: 12 });
  const exported = await service.export({ screenshot: true });
  assert.equal(exported.screenshots, 1);
  assert.match(String(exported.trace.screenshots?.[0]?.dataUrl), /^data:image\//);

  const noShot = new FakeChromeApi();
  noShot.tabs.captureVisibleTab = undefined as unknown as typeof noShot.tabs.captureVisibleTab;
  const service2 = createChromeRecordService(noShot);
  await service2.start({ tabId: 12, includeAgent: true });
  await service2.stop({ tabId: 12 });
  assert.equal((await service2.export({ screenshot: true })).screenshots, 0);
});

test('createChromeRecordDeps：无 scripting 能力时降级（captureFrames=0、overlay=false）且不抛错', async () => {
  const api = new FakeChromeApi();
  const deps = createChromeRecordDeps({ tabs: api.tabs, storage: api.storage });
  const service = createChromeRecordService({ tabs: api.tabs, storage: api.storage });
  const started = await service.start({ tabId: 12, includeAgent: true });
  assert.equal(started.captureFrames, 0);
  assert.equal(started.overlay, false);
  assert.equal(await deps.capture?.start(12, { startedAt: 1, includeAgent: true }), 0);
  assert.equal(await deps.overlay?.show(12, 1), false);
  const stopped = await service.stop({ tabId: 12 });
  assert.equal(stopped.ok, true);
});
