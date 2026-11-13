(() => {
  const ID = '__bb_takeover_demo';
  const old = document.getElementById(ID); if (old) old.remove();
  const host = document.createElement('div');
  host.id = ID;
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<style>'
    + '.glow{position:fixed;inset:0;border-radius:10px;box-shadow:inset 0 0 0 2px rgba(249,115,22,.6),inset 0 0 30px rgba(249,115,22,.25);animation:bbp 2.4s ease-in-out infinite}'
    + '@keyframes bbp{0%,100%{opacity:.55}50%{opacity:1}}'
    + '.card{position:fixed;right:20px;bottom:20px;width:300px;padding:16px;border:1px solid #f4d6bc;border-radius:20px;background:#fffdfa;color:#302820;box-shadow:0 14px 38px -12px rgba(101,56,24,.12),0 3px 8px -3px rgba(101,56,24,.12);font:13px/1.5 system-ui,sans-serif;pointer-events:auto}'
    + '.head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}'
    + '.brand{display:flex;align-items:center;gap:7px;color:#7b7168;font-size:11px;font-weight:500}'
    + '.dot{width:8px;height:8px;border-radius:50%;background:#f97316;outline:1px solid #7b7168;outline-offset:2px}'
    + '.title{font-size:13px;font-weight:600;color:#a63e0c}'
    + '.sub{margin-top:6px;font-size:11px;color:#7b7168}'
    + '.actions{display:flex;gap:8px;margin-top:14px}'
    + '.btn{flex:1;height:30px;border-radius:10px;border:1px solid #e9e4de;background:#fff;color:#302820;font-size:12px;font-weight:500}'
    + '.btn.primary{background:#c2410c;border-color:#c2410c;color:#fff}'
    + '</style>'
    + '<div class="glow"></div><div class="card"><div class="head"><div class="brand"><span class="dot"></span>BridgeDeck · Agent</div><span style="color:#7b7168">–</span></div><div class="title">Agent 正在控制此页面</div><div class="sub">操作会以你的登录态执行；需要时可随时收回控制。</div><div class="actions"><button class="btn primary">收回控制</button><button class="btn">收起</button></div></div>';
  document.documentElement.appendChild(host);
  return 'ok';
})()