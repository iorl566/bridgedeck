import fs from 'node:fs';
import http from 'node:http';
const PORT = Number(process.argv[2]);
const OPEN = process.argv[3] || '';
const MATCH = process.argv[4] || OPEN;
const OUT = process.argv[5] || 'docs/assets/shot.png';
const W = Number(process.argv[6] || 420);
const H = Number(process.argv[7] || 760);
const get = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>resolve(d)); }).on('error', reject);
});
const put = (p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'PUT' }, (res) => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>resolve(d)); });
  req.on('error', reject); req.end();
});
const slp = (ms) => new Promise((r) => setTimeout(r, ms));
let list = JSON.parse(await get('/json/list'));
let target = list.find((t) => t.type === 'page' && t.url.includes(MATCH));
if (!target && OPEN) { await put('/json/new?' + encodeURIComponent(OPEN)); await slp(900); list = JSON.parse(await get('/json/list')); target = list.find((t) => t.type === 'page' && t.url.includes(MATCH)); }
if (!target) { console.log('no target'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map(); let seq = 0;
ws.onmessage = (ev) => { try { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {} };
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const send = (method, params={}) => new Promise((resolve) => { const id=++seq; pending.set(id, resolve); ws.send(JSON.stringify({id,method,params})); });
await send('Page.enable');
await send('Page.reload', { ignoreCache: true });
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
await slp(1200);
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
console.log(JSON.stringify({ out: OUT, bytes: fs.statSync(OUT).size, url: target.url }));
process.exit(0);
