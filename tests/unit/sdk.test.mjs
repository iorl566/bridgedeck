import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { BrowserBridge, BridgeRpcError, connect, targetParams } from '../../sdk/index.mjs';

async function harness(options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-sdk-'));
  const calls = [];
  const server = http.createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      calls.push({ method: message.method, params: message.params, token: request.headers['x-bridge-token'] });
      const send = (payload) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      switch (message.method) {
        case 'session.start':
          return send({ ok: true, result: { sessionId: 's1', tabId: 11, windowId: 12, instanceId: 'i1', borrowed: false } });
        case 'session.list':
          return send({ ok: true, result: { sessions: [{ sessionId: 's1', tabId: 11, windowId: 12 }] } });
        case 'navigate':
          return send({ ok: true, result: { url: message.params.url, title: 'fixture' } });
        case 'click':
        case 'fill':
          if (message.params.fail === true) {
            return send({ ok: false, error: { code: 'E_SESSION_PAUSED', message: '会话已暂停' } });
          }
          return send({ ok: true, result: { ok: true } });
        case 'evaluate':
          return send({ ok: true, result: { value: 42 } });
        case 'screenshot':
          return send({ ok: true, result: { dataUrl: 'data:image/png;base64,' + Buffer.from('png-bytes').toString('base64'), width: 3, height: 4 } });
        case 'session.stop':
          return send({ ok: true, result: { ok: true } });
        default:
          return send({ ok: true, result: { ok: true, method: message.method } });
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  if (options.writeInfo !== false) {
    fs.writeFileSync(path.join(home, 'daemon.json'), JSON.stringify({ pid: 1, port, token: 'tok', version: 'test' }));
  }
  return {
    home,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('connect 读取 daemon.json 并携带 token', async (t) => {
  const h = await harness();
  t.after(h.close);
  const bridge = await connect({ home: h.home });
  assert.equal(bridge.info.token, 'tok');
  await bridge.status();
  assert.equal(h.calls[0].token, 'tok');
  assert.equal(h.calls[0].method, 'status');
});

test('newPage / goto / click / fill 自动带 session 并映射 ref/selector', async (t) => {
  const h = await harness();
  t.after(h.close);
  const bridge = await BrowserBridge.connect({ home: h.home });
  const page = await bridge.newPage({ url: 'http://example.test/' });
  assert.equal(page.id, 's1');
  assert.equal(page.tabId, 11);
  assert.equal(h.calls[0].method, 'session.start');
  assert.equal(h.calls[1].method, 'navigate');
  assert.equal(h.calls[1].params.session, 's1');
  assert.equal(h.calls[1].params.url, 'http://example.test/');

  await page.click('@e3', { trusted: true });
  assert.deepEqual(h.calls[2].params, { session: 's1', ref: '@e3', trusted: true });

  await page.fill('#name', 'bridge', { noClear: true });
  assert.deepEqual(h.calls[3].params, { session: 's1', selector: '#name', value: 'bridge', noClear: true });

  const result = await page.evaluate('1 + 41');
  assert.equal(result.value, 42);
});

test('错误映射为 BridgeRpcError，保留 code 与 method', async (t) => {
  const h = await harness();
  t.after(h.close);
  const bridge = await BrowserBridge.connect({ home: h.home });
  const page = await bridge.newPage();
  await assert.rejects(
    () => page.click('#covered', { fail: true }),
    (error) => {
      assert.ok(error instanceof BridgeRpcError);
      assert.equal(error.code, 'E_SESSION_PAUSED');
      assert.equal(error.method, 'click');
      return true;
    },
  );
});

test('screenshot 落盘并返回 dataUrl', async (t) => {
  const h = await harness();
  t.after(h.close);
  const bridge = await BrowserBridge.connect({ home: h.home });
  const page = await bridge.newPage();
  const output = path.join(h.home, 'shot.png');
  const result = await page.screenshot({ path: output, fullPage: true });
  assert.equal(result.width, 3);
  assert.equal(fs.readFileSync(output, 'utf8'), 'png-bytes');
  assert.equal(h.calls.at(-1).params.fullPage, true);
});

test('pages() 列出会话，page(id) 取回 Page', async (t) => {
  const h = await harness();
  t.after(h.close);
  const bridge = await BrowserBridge.connect({ home: h.home });
  const pages = await bridge.pages();
  assert.equal(pages.length, 1);
  assert.equal(pages[0].id, 's1');
  const page = await bridge.page('s1');
  assert.equal(page.tabId, 11);
  await assert.rejects(() => bridge.page('nope'), (error) => error.code === 'E_NO_SESSION');
});

test('daemon 不存在且 autoStart=false 时报 E_DAEMON', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-sdk-empty-'));
  await assert.rejects(
    () => connect({ home, autoStart: false }),
    (error) => error instanceof BridgeRpcError && error.code === 'E_DAEMON',
  );
});

test('targetParams 支持 @ref、selector 与对象', () => {
  assert.deepEqual(targetParams('@e1'), { ref: '@e1' });
  assert.deepEqual(targetParams('#x'), { selector: '#x' });
  assert.deepEqual(targetParams({ selector: 'a' }), { selector: 'a' });
  assert.throws(() => targetParams(''), BridgeRpcError);
});
