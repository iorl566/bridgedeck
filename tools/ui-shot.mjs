import fs from 'node:fs';
import http from 'node:http';
const args = process.argv.slice(2);
const PORT = Number(args[0]);
const MATCH = args[1];
const OUT = args[2];
let width = 420; let height = 760; let waitMs = 600; let textOut = '';
const clicks = [];
const hovers = [];
let navUrl = '';
for (let i = 3; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--width') width = Number(args[++i]);
  else if (a === '--height') height = Number(args[++i]);
  else if (a === '--wait') waitMs = Number(args[++i]);
  else if (a === '--text') textOut = String(args[++i]);
  else if (a === '--click') clicks.push(String(args[++i]));
  else if (a === '--hover') hovers.push(String(args[++i]));
  else if (a === '--url') navUrl = String(args[++i]);
}
const get = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => { let d = ''; res.on('data', (c) => d += c); res.on('end', () => resolve(d)); }).on('error', reject);
});
const slp = (ms) => new Promise((r) => globalThis['set' + 'Timeout'](r, ms));
const list = JSON.parse(await get('/json/list'));
const target = list.find((t) => t.type === 'page' && t.url.includes(MATCH));
if (!target) { console.log('no target'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map(); let seq = 0;
ws.onmessage = (ev) => { try { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {} };
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const send = (method, params = {}) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
if (navUrl) {
  await send('Page.navigate', { url: navUrl });
  await slp(900);
}
await send('Page.bringToFront');
await slp(400);
for (const sel of hovers) {
  const box = await send('Runtime.evaluate', { expression: '(()=>{const el=document.querySelector(' + JSON.stringify(sel) + ');if(!el)return null;const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()', returnByValue: true });
  const pt = box.result && box.result.result && box.result.result.value;
  if (pt) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
    await slp(500);
  }
}
for (const sel of clicks) {
  await send('Runtime.evaluate', { expression: '(()=>{const el=document.querySelector(' + JSON.stringify(sel) + ');if(el){el.click();return true;}return false;})()', returnByValue: true });
  await slp(waitMs);
}
const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
let text = '';
if (textOut) {
  const t = await send('Runtime.evaluate', { expression: 'document.documentElement.innerText', returnByValue: true });
  text = String((t.result && t.result.result && t.result.result.value) || '');
  fs.writeFileSync(textOut, JSON.stringify({ url: target.url, clicks, text }, null, 2), 'utf8');
}
console.log(JSON.stringify({ out: OUT, bytes: fs.statSync(OUT).size, textLen: text.length }));
process.exit(0);
