// daemon/preview.js —— /preview 路由（从 server 拆出）。

export function createPreviewHandler(ctx) {
  const { resolveSession, instances, sendCommand, tokenMatches, authResolve, readBody, sendJson } = ctx;

function previewAuthorized(token) {
    return Boolean(token) && (tokenMatches(token) || authResolve.isPairTokenValid(token));
  }
  
  function sendPng(res, buffer) {
    res.writeHead(200, {
      'content-type': 'image/png',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    res.end(buffer);
  }
  
  function previewPageHtml(sessionId, token) {
    const safeSession = JSON.stringify(sessionId);
    const safeToken = JSON.stringify(token);
    return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>BridgeDeck Remote View</title>'
      + '<style>body{margin:0;background:#111827;color:#e5e7eb;font:14px/1.5 system-ui,sans-serif}header{display:flex;gap:10px;align-items:center;padding:10px 14px;background:#1f2937;position:sticky;top:0}header h1{font-size:14px;margin:0;flex:1}button{height:30px;padding:0 12px;border:0;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer}main{padding:10px}#meta{color:#9ca3af;font-size:12px;margin-bottom:8px;overflow-wrap:anywhere}img{max-width:100%;height:auto;display:block;margin:auto;background:#000;border:1px solid #374151}</style>'
      + '<header><h1>BridgeDeck Remote View</h1><span id="status" style="color:#9ca3af;font-size:12px">…</span><input id="key" placeholder="按键 Enter/Tab" style="height:30px;width:110px;border-radius:8px;border:1px solid #374151;background:#111827;color:#e5e7eb;padding:0 8px"><button id="sendKey">发送按键</button><button id="focus">聚焦标签页</button></header>'
      + '<main><div id="meta"></div><img id="shot" alt="" title="点击画面即远程点击"></main>'
      + '<script type="module">const S=' + safeSession + ',T=' + safeToken + ';'
      + 'const qs=(p)=>"/preview/"+p+"?session="+encodeURIComponent(S)+"&token="+encodeURIComponent(T);'
      + 'const shot=document.getElementById("shot"),status=document.getElementById("status"),meta=document.getElementById("meta"),keyInput=document.getElementById("key");'
      + 'let vw=0,vh=0;'
      + 'async function loadMeta(){try{const r=await fetch(qs("meta"));if(!r.ok)throw new Error("HTTP "+r.status);const j=await r.json();vw=j.width;vh=j.height;meta.textContent=(j.title||S)+" · "+j.url+" · "+vw+"x"+vh;}catch(e){meta.textContent=S;}}'
      + 'async function refresh(){try{const r=await fetch(qs("shot"),{cache:"no-store"});if(!r.ok)throw new Error("HTTP "+r.status);const b=await r.blob();shot.src=URL.createObjectURL(b);status.textContent="已更新 "+new Date().toLocaleTimeString();}catch(e){status.textContent="刷新失败："+e.message}}'
      + 'async function post(p,body){const r=await fetch(qs(p),{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});if(!r.ok)throw new Error((await r.text()).slice(0,120));return r.json();}'
      + 'shot.onclick=async(e)=>{try{const r=shot.getBoundingClientRect();const ix=(e.clientX-r.left)/r.width*shot.naturalWidth;const iy=(e.clientY-r.top)/r.height*shot.naturalHeight;const x=vw?ix*vw/shot.naturalWidth:ix;const y=vh?iy*vh/shot.naturalHeight:iy;await post("click",{x,y});status.textContent="已点击 "+Math.round(x)+","+Math.round(y);setTimeout(refresh,250);}catch(err){status.textContent="点击失败："+err.message}};'
      + 'document.getElementById("sendKey").onclick=async()=>{try{await post("key",{key:keyInput.value||"Enter"});status.textContent="已发送按键";setTimeout(refresh,250);}catch(err){status.textContent="按键失败："+err.message}};'
      + 'document.getElementById("focus").onclick=async()=>{try{await post("focus",{});status.textContent="已聚焦";}catch(e){status.textContent="聚焦失败："+e.message}};'
      + 'loadMeta();refresh();setInterval(refresh,2000);setInterval(loadMeta,5000);</script></html>';
  }
  
  async function previewBody(req) {
    try {
      const raw = await readBody(req);
      return JSON.parse(raw || '{}');
    } catch {
      return {};
    }
  }
  
  function previewControlAllowed(instance) {
    return !(instance && instance.remote === true && instance.scope === 'read');
  }
  
  async function previewSelectorAt(instance, tabId, x, y) {
    const expression = '(() => { const el = document.elementFromPoint(' + Number(x) + ',' + Number(y) + '); if (!el) return "";'
      + ' const old = el.id; if (old && document.querySelectorAll("#" + CSS.escape(old)).length === 1) return "#" + CSS.escape(old);'
      + ' const id = "__bb_preview_" + Date.now().toString(36); el.id = id; return "#" + id; })()';
    const result = await sendCommand(instance, 'evaluate', { tabId, expression }, 5000);
    return String((result && result.value) || '');
  }
return async function handlePreviewRequest(req, res, pathname, url) {
  const token = url.searchParams.get('token') || '';
  if (!previewAuthorized(token)) {
    sendJson(res, 401, { ok: false, error: { code: 'E_AUTH', message: 'preview token invalid' } });
    return;
  }
  let session;
  try {
    session = resolveSession(url.searchParams.get('session') || '');
  } catch (error) {
    sendJson(res, 404, { ok: false, error: { code: 'E_NO_SESSION', message: (error && error.message) || 'no session' } });
    return;
  }
  if (pathname === '/preview' || pathname === '/preview/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end(previewPageHtml(session.sessionId, token));
    return;
  }
  const instance = instances.get(session.instanceId);
  if (!instance) {
    sendJson(res, 503, { ok: false, error: { code: 'E_NO_BROWSER', message: 'browser disconnected' } });
    return;
  }
  if (pathname === '/preview/meta') {
    try {
      const result = await sendCommand(instance, 'evaluate', { tabId: session.tabId, expression: '({ width: window.innerWidth, height: window.innerHeight })' }, 5000);
      const value = (result && result.value) || {};
      sendJson(res, 200, { ok: true, width: Number(value.width) || 0, height: Number(value.height) || 0, url: session.url || '', title: session.title || '' });
    } catch (error) { sendJson(res, 502, { ok: false, error: { code: 'E_PREVIEW_META', message: (error && error.message) || 'meta failed' } }); }
    return;
  }
  if (pathname === '/preview/click' && req.method === 'POST') {
    if (!previewControlAllowed(instance)) { sendJson(res, 403, { ok: false, error: { code: 'E_FORBIDDEN', message: 'read-only device' } }); return; }
    const body = await previewBody(req);
    const x = Number(body.x); const y = Number(body.y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 20000 || y > 20000) { sendJson(res, 400, { ok: false, error: { code: 'E_BAD_ARG', message: 'x/y required' } }); return; }
    try {
      const selector = await previewSelectorAt(instance, session.tabId, x, y);
      if (!selector) { sendJson(res, 409, { ok: false, error: { code: 'E_NOT_FOUND', message: 'no element at point' } }); return; }
      const result = await sendCommand(instance, 'click', { tabId: session.tabId, selector, force: true }, 8000);
      sendJson(res, 200, { ok: true, selector, result });
    } catch (error) { sendJson(res, 502, { ok: false, error: { code: 'E_CLICK', message: (error && error.message) || 'click failed' } }); }
    return;
  }
  if (pathname === '/preview/key' && req.method === 'POST') {
    if (!previewControlAllowed(instance)) { sendJson(res, 403, { ok: false, error: { code: 'E_FORBIDDEN', message: 'read-only device' } }); return; }
    const body = await previewBody(req);
    const key = String(body.key || '').slice(0, 32);
    if (!key) { sendJson(res, 400, { ok: false, error: { code: 'E_BAD_ARG', message: 'key required' } }); return; }
    try {
      const result = await sendCommand(instance, 'press', { tabId: session.tabId, key }, 5000);
      sendJson(res, 200, { ok: true, result });
    } catch (error) { sendJson(res, 502, { ok: false, error: { code: 'E_KEY', message: (error && error.message) || 'key failed' } }); }
    return;
  }
  if (pathname === '/preview/shot') {
    try {
      const result = await sendCommand(instance, 'screenshot', { tabId: session.tabId, scope: 'viewport', preview: true }, 10000);
      const dataUrl = String((result && result.dataUrl) || '');
      const comma = dataUrl.indexOf(',');
      if (comma < 0) throw new Error('screenshot returned no dataUrl');
      sendPng(res, Buffer.from(dataUrl.slice(comma + 1), 'base64'));
    } catch (error) {
      sendJson(res, 502, { ok: false, error: { code: 'E_SCREENSHOT', message: (error && error.message) || 'screenshot failed' } });
    }
    return;
  }
  if (pathname === '/preview/focus' && req.method === 'POST') {
    try {
      await sendCommand(instance, 'window.focus', { windowId: session.windowId }, 5000);
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 502, { ok: false, error: { code: 'E_FOCUS', message: (error && error.message) || 'focus failed' } });
    }
    return;
  }
  sendJson(res, 404, { ok: false, error: { code: 'E_NOT_FOUND', message: 'preview route not found' } });
}
}
