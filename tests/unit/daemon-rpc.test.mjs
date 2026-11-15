// 插件直连 daemon：读 daemon.json、token、成功/错误/缺失。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { daemonRpc, DaemonRpcError, readDaemonInfo } from '../../dsh-plugin/lib/daemon-rpc.mjs';
import { buildToolSpecs } from '../../dsh-plugin/lib/tools.mjs';

async function withServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

test('daemonRpc 携带 token 并返回 result', async () => {
  const seen = [];
  const { server, port } = await withServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({ method: message.method, params: message.params, token: req.headers['x-bridge-token'] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { value: 42 } }));
    });
  });
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-plugin-rpc-'));
    fs.writeFileSync(path.join(home, 'daemon.json'), JSON.stringify({ port, token: 'tok' }));
    const result = await daemonRpc('status', {}, { home });
    assert.deepEqual(result, { value: 42 });
    assert.equal(seen[0].method, 'status');
    assert.equal(seen[0].token, 'tok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('daemon 错误映射为 DaemonRpcError；缺失 daemon.json 报 E_DAEMON', async () => {
  const { server, port } = await withServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'E_NO_SESSION', message: '没有会话' } }));
    });
  });
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-plugin-rpc-'));
    fs.writeFileSync(path.join(home, 'daemon.json'), JSON.stringify({ port, token: 'tok' }));
    await assert.rejects(
      () => daemonRpc('observe', {}, { home }),
      (error) => error instanceof DaemonRpcError && error.code === 'E_NO_SESSION',
    );
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-plugin-rpc-empty-'));
    assert.equal(readDaemonInfo(empty), null);
    await assert.rejects(
      () => daemonRpc('status', {}, { home: empty }),
      (error) => error.code === 'E_DAEMON',
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('插件 browser_session_start 走 session.start_tracked + 插件 journal', async () => {
  const messages = [];
  const { server, port } = await withServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      messages.push(message);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: { sessionId: 's1', tabId: 11, windowId: 22, instanceId: 'i1', borrowed: false } }));
    });
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-plugin-start-'));
  fs.writeFileSync(path.join(home, 'daemon.json'), JSON.stringify({ port, token: 'tok' }));
  const oldHome = process.env.BB_HOME;
  const oldFlag = process.env.BB_PLUGIN_DIRECT_RPC;
  process.env.BB_HOME = home;
  delete process.env.BB_PLUGIN_DIRECT_RPC;
  try {
    const events = [];
    const journal = {
      add: (token, info) => events.push({ type: 'add', token, info }),
      ready: (token, info) => events.push({ type: 'ready', token, info }),
      fail: (token, code) => events.push({ type: 'fail', token, code }),
    };
    let cliCalls = 0;
    const specs = buildToolSpecs(async () => {
      cliCalls += 1;
      throw new Error('不应走 CLI');
    }, { journal });
    const start = specs.find((spec) => spec.name === 'browser_session_start');
    const result = await start.execute({ agentName: 'A', project: 'P', noFocus: true }, {});
    assert.equal(result.sessionId, 's1');
    assert.equal(result.tabId, 11);
    assert.equal(cliCalls, 0);
    assert.equal(messages[0].method, 'session.start_tracked');
    assert.equal(typeof messages[0].params.requestId, 'string');
    assert.equal(messages[0].params.controller.name, 'A');
    assert.equal(messages[0].params.controller.project, 'P');
    assert.deepEqual(events.map((e) => e.type), ['add', 'ready']);
    assert.equal(events[0].token, messages[0].params.requestId);
  } finally {
    if (oldHome === undefined) delete process.env.BB_HOME;
    else process.env.BB_HOME = oldHome;
    if (oldFlag === undefined) delete process.env.BB_PLUGIN_DIRECT_RPC;
    else process.env.BB_PLUGIN_DIRECT_RPC = oldFlag;
    await new Promise((resolve) => server.close(resolve));
  }
});

test('插件 browser_observe/act/read/navigate 优先直连 daemon，不 spawn CLI', async () => {
  const messages = [];
  const { server, port } = await withServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      messages.push(message);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (message.method === 'screenshot') {
        res.end(JSON.stringify({ ok: true, result: { dataUrl: 'data:image/png;base64,' + Buffer.from('png-direct').toString('base64'), width: 10, height: 8 } }));
      } else {
        res.end(JSON.stringify({ ok: true, result: { url: 'https://x/', title: 'T', refs: 1, observation: '- link "x"', nodes: [], ok: true } }));
      }
    });
  });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-plugin-direct-'));
  fs.writeFileSync(path.join(home, 'daemon.json'), JSON.stringify({ port, token: 'tok' }));
  const oldHome = process.env.BB_HOME;
  const oldFlag = process.env.BB_PLUGIN_DIRECT_RPC;
  process.env.BB_HOME = home;
  delete process.env.BB_PLUGIN_DIRECT_RPC;
  try {
    let cliCalls = 0;
    const specs = buildToolSpecs(async () => {
      cliCalls += 1;
      throw new Error('不应走 CLI');
    });
    const byName = new Map(specs.map((spec) => [spec.name, spec]));
    const observed = await byName.get('browser_observe').execute({ sessionId: 's1', vom: true }, {});
    assert.equal(observed.observation, '- link "x"');
    await byName.get('browser_navigate').execute({ sessionId: 's1', url: 'https://y/' }, {});
    await byName.get('browser_act').execute({ sessionId: 's1', action: 'fill', ref: '@e1', value: 'x' }, {});
    await byName.get('browser_read').execute({ sessionId: 's1', kind: 'read', selector: '#kw' }, {});
    const shot = await byName.get('browser_screenshot').execute({ sessionId: 's1', out: path.join(home, 'shot.png') }, {});
    await byName.get('browser_tab').execute({ action: 'list' }, {});
    await byName.get('browser_tab').execute({ action: 'new', url: 'https://z/' }, {});
    await byName.get('browser_window').execute({ action: 'list' }, {});
    assert.equal(cliCalls, 0);
    assert.deepEqual(messages.map((m) => m.method), ['observe', 'navigate', 'fill', 'read', 'screenshot', 'tab.list', 'tab.new', 'window.list']);
    assert.equal(messages[1].params.url, 'https://y/');
    assert.equal(messages[2].params.ref, '@e1');
    assert.equal(messages[2].params.value, 'x');
    assert.equal(messages[3].params.selector, '#kw');
    assert.equal(messages[5].params.scope, 'agent');
    assert.equal(messages[6].params.url, 'https://z/');
    assert.equal(shot.width, 10);
    assert.equal(fs.readFileSync(path.join(home, 'shot.png'), 'utf8'), 'png-direct');
  } finally {
    if (oldHome === undefined) delete process.env.BB_HOME;
    else process.env.BB_HOME = oldHome;
    if (oldFlag === undefined) delete process.env.BB_PLUGIN_DIRECT_RPC;
    else process.env.BB_PLUGIN_DIRECT_RPC = oldFlag;
    await new Promise((resolve) => server.close(resolve));
  }
});
