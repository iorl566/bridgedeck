#!/usr/bin/env node
// tools/serve-fixture.mjs —— 独立启动与 E2E 相同的夹具站点（供外部工具对比测试）
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let crossPort = 0;

const handler = (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/script') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
    res.end('window.__realScript = true;');
    return;
  }
  if (url.pathname === '/api/script-mock') {
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
    res.end('window.__modifiedScript = true;');
    return;
  }
  if (url.pathname === '/api/image') {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'no-store' });
    res.end(png);
    return;
  }
  if (url.pathname === '/api/download') {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': 'attachment; filename="sample.txt"',
      'cache-control': 'no-store',
    });
    res.end('browser-bridge download sample\n');
    return;
  }
  if (url.pathname === '/api/ping') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, ts: Date.now() }));
    return;
  }
  const file = url.pathname === '/' ? 'test.html' : url.pathname.replace(/^\//, '');
  const full = path.join(ROOT, 'tests', 'fixtures', file);
  if (!existsSync(full)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(readFileSync(full, 'utf8').split('__XFRAME_PORT__').join(String(crossPort || 0)));
};

const main = createServer(handler);
const cross = createServer(handler);
const port = await new Promise((resolve) => main.listen(0, '127.0.0.1', () => resolve(main.address().port)));
crossPort = await new Promise((resolve) => cross.listen(0, '127.0.0.1', () => resolve(cross.address().port)));
console.log(JSON.stringify({ url: 'http://127.0.0.1:' + port + '/test.html', port, crossPort }));
