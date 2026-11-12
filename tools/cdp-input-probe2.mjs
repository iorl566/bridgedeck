import http from 'node:http';
const PORT = 9348;
const get = (p) => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => { let d=''; res.on('data', c=>d+=c); res.on('end', ()=>resolve(d)); }).on('error', reject); });
const slp = (ms) => new Promise((r) => setTimeout(r, ms));
const list = JSON.parse(await get('/json/list'));
const target = list.find((t) => t.type === 'page' && t.url.includes('test.html'));
if (!target) { console.log('no target'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map(); let seq = 0;
ws.onmessage = (ev) => { try { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } catch {} };
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const send = (method, params={}) => new Promise((resolve) => { const id=++seq; pending.set(id, resolve); ws.send(JSON.stringify({id,method,params})); });
await send('Page.bringToFront');
await send('Runtime.evaluate',{expression:"window.__ev={down:0,up:0,click:0,move:0};['mousedown','mouseup','click','mousemove'].forEach(t=>document.addEventListener(t,()=>window.__ev[t]++));'ok'"});
// 触控
await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:74,y:264}]});
await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
await slp(200);
console.log('touch', (await send('Runtime.evaluate',{expression:'JSON.stringify(window.__ev)',returnByValue:true})).result.result.value);
// 手势
try { await send('Input.synthesizeTapGesture',{x:74,y:264,gestureSourceType:'touch'}); } catch (e) { console.log('tap err', e.message); }
await slp(200);
console.log('tap', (await send('Runtime.evaluate',{expression:'JSON.stringify(window.__ev)',returnByValue:true})).result.result.value);
// 鼠标带 pointerType
await send('Input.dispatchMouseEvent',{type:'mousePressed',x:74,y:264,button:'left',buttons:1,clickCount:1,pointerType:'mouse'});
await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:74,y:264,button:'left',buttons:0,clickCount:1,pointerType:'mouse'});
await slp(200);
console.log('mouse', (await send('Runtime.evaluate',{expression:'JSON.stringify(window.__ev)',returnByValue:true})).result.result.value);
process.exit(0);
