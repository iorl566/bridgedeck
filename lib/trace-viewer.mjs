// lib/trace-viewer.mjs —— 把 Trace v3 渲染成离线、零依赖的 HTML 查看器。
//
// 目标是对标 Playwright trace viewer 的轻量版：步骤时间线、目标、填写/选择值、
// before/after 状态文本、搜索过滤。不依赖网络、不内嵌截图（Trace v3 没有截图字段）。
// 所有动态内容都经过 HTML 转义，trace 里的页面文本不能变成脚本。

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML 转义（文本与属性共用）。 */
export function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ESCAPE_MAP[character]);
}

function text(value) {
  return escapeHtml(value);
}

function stateById(states) {
  const map = new Map();
  for (const state of states) {
    if (state && typeof state.id === 'string') map.set(state.id, state);
  }
  return map;
}

function targetLabel(step) {
  const target = step && step.target ? step.target : {};
  return target.name || target.role || target.ref || target.ctx || '(未知目标)';
}

function targetDetail(step) {
  const target = step && step.target ? step.target : {};
  const parts = [];
  if (target.ref) parts.push('ref=' + target.ref);
  if (target.role) parts.push('role=' + target.role);
  if (target.ctx) parts.push('ctx=' + target.ctx);
  return parts.join(' · ');
}

/** ISO 时间 → HH:MM:SS.mmm（无法解析时返回空串）。 */
export function timeLabel(value) {
  const text = String(value || '');
  const match = /T(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)/.exec(text);
  if (match) return match[1];
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 23) : '';
}

function renderNetwork(network) {
  if (!Array.isArray(network) || network.length === 0) return '';
  const rows = network.map((item, index) => {
    const status = item && item.status != null ? String(item.status) : '—';
    return `<tr>
      <td class="num">${index + 1}</td>
      <td class="time">${text(timeLabel(item && item.at))}</td>
      <td><span class="method">${text(item && item.method)}</span></td>
      <td class="status">${text(status)}</td>
      <td class="url">${text(item && item.url)}</td>
      <td class="type">${text(item && item.type)}</td>
    </tr>`;
  }).join('');
  return `<section class="network">
    <h2>网络请求 <span class="count">${network.length}</span></h2>
    <table>
      <thead><tr><th>#</th><th>时间</th><th>方法</th><th>状态</th><th>URL</th><th>类型</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function stateBlock(id, states) {
  const state = states.get(id);
  if (!state) return '';
  const body = String(state.body || '');
  return `
      <details class="state">
        <summary>状态 ${text(id)}${state.at ? '<span class="time">' + text(timeLabel(state.at)) + '</span>' : ''}${state.title ? ' · ' + text(state.title) : ''}</summary>
        <div class="state-url">${text(state.url || '')}</div>
        <pre>${body ? text(body) : '(空)'}</pre>
      </details>`;
}

function stepValue(step) {
  if (step.redacted === true) return '<span class="redacted">•••（敏感值已脱敏）</span>';
  if (Array.isArray(step.selection) && step.selection.length) {
    return '<div class="value">选择：' + step.selection
      .map((item) => text(item && (item.label || item.value) || ''))
      .join('、') + '</div>';
  }
  if (step.value !== undefined) {
    return '<div class="value">值：<code>' + text(step.value) + '</code></div>';
  }
  return '';
}

function stepRequests(step, context) {
  const network = Array.isArray(context.network) ? context.network : [];
  const start = Date.parse(step.at || '');
  if (!Number.isFinite(start) || network.length === 0) return [];
  const next = Number.isFinite(context.nextAt) ? context.nextAt : context.recordedAt;
  const end = Number.isFinite(next) && next > start ? next : start + 60000;
  return network.filter((item) => {
    const at = Date.parse(item && item.at);
    return Number.isFinite(at) && at >= start && at < end;
  });
}

function renderStep(step, index, states, context = {}) {
  const op = String(step.op || 'step');
  const label = targetLabel(step);
  const detail = targetDetail(step);
  const search = [op, label, detail, step.redacted === true ? 'redacted' : step.value, step.commit]
    .filter(Boolean).join(' ').toLowerCase();
  const badges = [];
  if (Number(step.frameId) > 0) badges.push('frame ' + Number(step.frameId));
  if (step.commit) badges.push('commit ' + String(step.commit));
  if (step.redacted === true) badges.push('redacted');
  const requests = stepRequests(step, context);
  const requestSummary = requests.length
    ? '<div class="step-net">' + text(requests.length) + ' 个请求 · ' + requests.slice(0, 3)
      .map((item) => text(String(item.method || '') + ' ' + (item.status == null ? '—' : item.status)))
      .join(' · ') + '</div>'
    : '';
  const screenshot = typeof step.screenshot === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(step.screenshot)
    ? '<img class="step-shot" src="' + escapeHtml(step.screenshot) + '" alt="步骤截图" loading="lazy">'
    : '';
  return `
    <article class="step" data-search="${escapeHtml(search)}" data-op="${escapeHtml(op)}">
      <header>
        <span class="index">${index + 1}</span>
        <span class="op op-${escapeHtml(op)}">${text(op)}</span>
        <span class="target">${text(label)}</span>
        ${step.at ? '<span class="time">' + text(timeLabel(step.at)) + '</span>' : ''}
        ${badges.map((badge) => '<span class="badge">' + text(badge) + '</span>').join('')}
      </header>
      ${detail ? '<div class="detail">' + text(detail) + '</div>' : ''}
      ${stepValue(step)}
      ${screenshot}
      ${requestSummary}
      ${stateBlock(step.state, states)}
      ${step.result && step.result.state && step.result.state !== step.state ? stateBlock(step.result.state, states) : ''}
    </article>`;
}

function renderScreenshots(screenshots) {
  if (!Array.isArray(screenshots)) return '';
  const items = screenshots.filter((item) => item && typeof item.dataUrl === 'string' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(item.dataUrl));
  if (items.length === 0) return '';
  const figures = items.map((item) => {
    const dimensions = Number(item.width) > 0 && Number(item.height) > 0 ? ' · ' + text(item.width) + '×' + text(item.height) : '';
    return `<figure>
      <img src="${escapeHtml(item.dataUrl)}" alt="${escapeHtml(item.label || '截图')}" loading="lazy">
      <figcaption>${text(item.label || '截图')}${item.at ? ' · ' + text(timeLabel(item.at)) : ''}${dimensions}</figcaption>
    </figure>`;
  }).join('');
  return `<section class="screens">
    <h2>截图 <span class="count">${items.length}</span></h2>
    ${figures}
  </section>`;
}

/**
 * 渲染 Trace v3 为完整 HTML 字符串。
 * @param {object} trace buildTraceV3 的输出
 * @param {{ title?: string }} [options]
 */
export function renderTraceHtml(trace, options = {}) {
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) {
    throw new Error('trace 必须是对象');
  }
  const steps = Array.isArray(trace.steps) ? trace.steps : [];
  const states = Array.isArray(trace.states) ? trace.states : [];
  const statesMap = stateById(states);
  const title = String(options.title || trace.purpose || 'BridgeDeck Trace');
  const startUrl = trace.entry && trace.entry.start_url ? String(trace.entry.start_url) : '';
  const meta = [
    ['起始 URL', startUrl],
    ['开始', trace.started_at || ''],
    ['结束', trace.recorded_at || ''],
    ['步骤', String(steps.length)],
    ['状态', String(states.length)],
    ['录制成因', trace.stopped_by || ''],
    ['recorder', trace.recorder ? `cli ${trace.recorder.cli || '?'} · vom ${trace.recorder.vom || '?'}` : ''],
  ].filter(([, value]) => value);

  const network = Array.isArray(trace.network) ? trace.network : [];
  const recordedAt = Date.parse(trace.recorded_at || '');
  const stepHtml = steps.length
    ? steps.map((step, index) => renderStep(step, index, statesMap, {
      network,
      nextAt: index + 1 < steps.length ? Date.parse(steps[index + 1].at || '') : recordedAt,
      recordedAt,
    })).join('\n')
    : '<p class="empty">这个 trace 没有可回放步骤。</p>';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${text(title)} · Trace Viewer</title>
<style>
  :root { color-scheme: light; --bg:#f6f7fb; --panel:#fff; --ink:#0f172a; --muted:#64748b; --line:#e2e8f0; --accent:#2f6fed; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif; }
  header.top { position:sticky; top:0; z-index:2; background:rgba(255,255,255,.94); backdrop-filter:blur(8px); border-bottom:1px solid var(--line); padding:16px 24px; }
  h1 { margin:0 0 6px; font-size:18px; }
  .meta { display:flex; flex-wrap:wrap; gap:6px 18px; color:var(--muted); font-size:12px; }
  .meta b { color:var(--ink); font-weight:600; }
  .toolbar { display:flex; gap:10px; align-items:center; margin-top:12px; }
  .toolbar input { flex:1; max-width:420px; padding:8px 12px; border:1px solid var(--line); border-radius:8px; font:inherit; }
  .toolbar .count { color:var(--muted); font-size:12px; }
  main { max-width:1100px; margin:0 auto; padding:20px 24px 64px; }
  .step { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin:0 0 12px; box-shadow:0 1px 2px rgba(15,23,42,.04); }
  .step header { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .index { width:26px; height:26px; border-radius:50%; background:#eef2ff; color:var(--accent); display:inline-flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; }
  .op { font-weight:700; text-transform:lowercase; }
  .op-fill { color:#0f766e; } .op-click { color:#b45309; } .op-select { color:#7c3aed; } .op-hover { color:#0369a1; } .op-switch_tab { color:#be123c; }
  .target { font-weight:600; }
  .badge { font-size:11px; color:var(--muted); background:#f1f5f9; border-radius:999px; padding:1px 8px; }
  .time { font-size:11px; color:var(--muted); font-variant-numeric:tabular-nums; }
  .step-net { margin-top:8px; font-size:12px; color:#0f766e; background:#f0fdfa; border:1px solid #ccfbf1; border-radius:8px; padding:5px 9px; }
  .step-shot { display:block; max-width:100%; max-height:260px; margin-top:8px; border:1px solid var(--line); border-radius:8px; object-fit:contain; }
  .network { margin-top:28px; background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .network h2 { font-size:15px; margin:0 0 10px; }
  .network .count { color:var(--muted); font-size:12px; font-weight:400; }
  .network table { width:100%; border-collapse:collapse; font-size:12px; }
  .network th, .network td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  .network th { color:var(--muted); font-weight:600; }
  .network .num { color:var(--muted); width:36px; }
  .network .method { font-weight:700; }
  .network .url { word-break:break-all; }
  .network .type { color:var(--muted); }
  .network tbody tr:last-child td { border-bottom:0; }
  .screens { margin-top:28px; background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .screens h2 { font-size:15px; margin:0 0 10px; }
  .screens .count { color:var(--muted); font-size:12px; font-weight:400; }
  .screens figure { margin:0 0 16px; }
  .screens img { max-width:100%; border:1px solid var(--line); border-radius:8px; display:block; }
  .screens figcaption { color:var(--muted); font-size:12px; margin-top:6px; }
  .detail { color:var(--muted); font-size:12px; margin-top:4px; }
  .value { margin-top:8px; }
  .value code { background:#f1f5f9; padding:2px 6px; border-radius:6px; }
  .redacted { color:#b45309; }
  details.state { margin-top:10px; border-top:1px dashed var(--line); padding-top:8px; }
  details.state summary { cursor:pointer; color:var(--muted); font-size:12px; }
  .state-url { color:var(--muted); font-size:12px; margin:6px 0; word-break:break-all; }
  pre { margin:0; padding:12px; background:#0f172a; color:#e2e8f0; border-radius:8px; overflow:auto; max-height:360px; white-space:pre-wrap; word-break:break-word; font:12px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace; }
  .empty { color:var(--muted); }
  @media (max-width:640px) { header.top { padding:12px 14px; } main { padding:14px; } }
</style>
</head>
<body>
<header class="top">
  <h1>${text(title)}</h1>
  <div class="meta">${meta.map(([key, value]) => `<span><b>${text(key)}</b> ${key === '起始 URL' ? `<code>${text(value)}</code>` : text(value)}</span>`).join('')}</div>
  <div class="toolbar">
    <input id="q" type="search" placeholder="搜索步骤 / 目标 / 值…" autocomplete="off">
    <span class="count" id="count"></span>
  </div>
</header>
<main id="steps">
${stepHtml}
${renderNetwork(trace.network)}
${renderScreenshots(trace.screenshots)}
</main>
<script>
(function () {
  var input = document.getElementById('q');
  var count = document.getElementById('count');
  var steps = Array.prototype.slice.call(document.querySelectorAll('article.step'));
  function apply() {
    var q = input.value.trim().toLowerCase();
    var shown = 0;
    steps.forEach(function (step) {
      var hit = !q || step.getAttribute('data-search').indexOf(q) !== -1;
      step.hidden = !hit;
      if (hit) shown += 1;
    });
    count.textContent = shown + ' / ' + steps.length;
  }
  input.addEventListener('input', apply);
  apply();
})();
</script>
</body>
</html>`;
}
