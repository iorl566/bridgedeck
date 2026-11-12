import fs from 'node:fs';
import http from 'node:http';
const PORT = 9338;
const get = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>resolve(d)); }).on('error', reject);
});
const slp = (ms) => new Promise((r) => setTimeout(r, ms));
const list = JSON.parse(await get('/json/list'));
const target = list.find((t) => t.type === 'page' && t.url.includes('test.html'));
if (!target) { console.log('no target'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map(); let seq = 0;
ws.onmessage = (ev) => { try { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {} };
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const send = (method, params={}) => new Promise((resolve) => { const id=++seq; pending.set(id, resolve); ws.send(JSON.stringify({id,method,params})); });
const code = fs.readFileSync('tools/overlay-demo.js', 'utf8');
const out = await send('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: false });
console.log(JSON.stringify(out.result && out.result.result && out.result.result.value));
await slp(600);
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync('docs/assets/our-takeover.png', Buffer.from(shot.result.data, 'base64'));
console.log('png', fs.statSync('docs/assets/our-takeover.png').size);
process.exit(0);
