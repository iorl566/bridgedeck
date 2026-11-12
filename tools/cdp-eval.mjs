import http from 'node:http';
const PORT = Number(process.argv[2] || 9335);
const MATCH = process.argv[3] || '';
const EXPR = process.argv[4] || 'document.body.innerText.slice(0, 4000)';
const get = (p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>resolve(d)); }).on('error', reject);
});
const slp = (ms) => new Promise((r) => setTimeout(r, ms));
const list = JSON.parse(await get('/json/list'));
const target = list.find((t) => t.type === 'page' && t.url.includes(MATCH));
if (!target) { console.log('no target'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map(); let seq = 0;
ws.onmessage = (ev) => { try { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {} };
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const send = (method, params={}) => new Promise((resolve) => { const id=++seq; pending.set(id, resolve); ws.send(JSON.stringify({id,method,params})); });
await slp(800);
const out = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true });
console.log(JSON.stringify(out.result && out.result.result && out.result.result.value, null, 1));
process.exit(0);
