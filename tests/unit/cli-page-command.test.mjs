import test from 'node:test';
import assert from 'node:assert/strict';
import { createPageCommand } from '../../cli/commands/page.mjs';
import { ArgError } from '../../cli/lib/args.mjs';

function makeCommand(handler) {
  const printed = [];
  const cmd = createPageCommand({
    withControl: (flags, base) => ({ session: 's1', ...base }),
    withSession: (flags, base) => ({ session: 's1', ...base }),
    callRpc: async (method, params) => handler(method, params),
    timeoutOf: () => 5000,
    renderPageBody: (body, render) => { render(body.result || {}); return 0; },
    resolveTarget: (flags, pos, index) => (flags.selector ? { selector: String(flags.selector) } : null),
    writeDataUrl: () => ({ target: 'out.png', buffer: Buffer.from('x') }),
    writeStreamedCapture: async () => ({ target: 'out.png', buffer: Buffer.from('x') }),
    emitJson: () => 0,
    outputFailure: (body) => { throw new Error(body.error.code); },
    outputJsonBody: () => 0,
    isJson: () => false,
    print: (line) => printed.push(line),
    ACTION_CACHE_PATH: 'action-cache.json',
    applyCachedObservation: async () => null,
    followOpenedTab: async () => null,
    healAction: async () => null,
    readCachedObservation: async () => null,
    saveObservationCache: () => {},
    sessionTabIds: new Map(),
    waitForNavigationAfterClick: async () => null,
    withNavigationProbe: async (fn) => fn(),
    writeFileAtomic: () => {},
  });
  return { cmd, printed };
}

test('navigate 发送 url 并打印', async () => {
  const calls = [];
  const { cmd, printed } = makeCommand((method, params) => { calls.push({ method, params }); return { ok: true, result: { url: 'https://x', title: 'T' } }; });
  assert.equal(await cmd('navigate', {}, ['navigate', 'https://x']), 0);
  const nav = calls.find((item) => item.method === 'navigate');
  assert.ok(nav, 'navigate 必须发送 navigate RPC');
  assert.equal(nav.params.url, 'https://x');
  assert.ok(calls.some((item) => item.method === 'wait-for-navigation'), 'domcontentloaded 后应等待导航提交');
  assert.match(printed.join('\n'), /已导航：https:\/\/x/);
});

test('未注册命令抛 ArgError', async () => {
  const { cmd } = makeCommand(() => ({ ok: true, result: {} }));
  await assert.rejects(() => cmd('nope', {}, []), ArgError);
});

test('reload 走 navigate 同族方法', async () => {
  let seen = null;
  const { cmd } = makeCommand((method) => { seen = method; return { ok: true, result: {} }; });
  assert.equal(await cmd('reload', {}, []), 0);
  assert.equal(seen, 'reload');
});

test('screenshot 走 writeDataUrl 落盘', async () => {
  const { cmd, printed } = makeCommand(() => ({ ok: true, result: { dataUrl: 'data:image/png;base64,xx', width: 10, height: 20 } }));
  assert.equal(await cmd('screenshot', { out: 'shot.png' }, []), 0);
  assert.match(printed.join('\n'), /已保存：out\.png/);
});
