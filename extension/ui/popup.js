import { whenReady } from './i18n.js';
import { mountAuditPanel } from './panels/audit-panel.js';
import { mountLongshotPanel } from './panels/longshot-panel.js';
import { mountVideoPanel } from './panels/video-panel.js';
import { mountDebugPanel } from './panels/debug-panel.js';
import { mountOpsPanel } from './panels/ops-panel.js';
// ui/popup.js —— BridgeDeck弹窗（品牌与配色自有）
const $ = (id) => document.getElementById(id);
const send = (message) => chrome.runtime.sendMessage(message).catch((error) => ({ ok: false, error: String((error && error.message) || error) }));

let state = { connected: false, settings: {}, notifications: [] };

function setSwitch(el, on) {
  if (!el) return;
  el.classList.toggle('on', on);
  el.setAttribute('aria-checked', on ? 'true' : 'false');
}

function setTheme() {
  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.classList.toggle('dark', dark);
}

function render(next) {
  state = next;
  const settings = state.settings || {};
  const connectionEnabled = settings.connectionEnabled !== false;
  const connected = Boolean(state.connected) && connectionEnabled;

  const authBadge = $('localAuthBadge');
  if (authBadge) {
    const auth = state.localAuth;
    if (connected && auth && auth.state === 'verified') {
      authBadge.textContent = '已连接 · 已验证';
      authBadge.classList.remove('hidden');
    } else if (connected && auth && auth.state === 'unpaired') {
      authBadge.textContent = '已连接 · 未配对';
      authBadge.classList.remove('hidden');
    } else {
      authBadge.classList.add('hidden');
    }
  }
  $('stateDot').className = 'dot' + (connected ? ' on' : connectionEnabled ? ' warn' : '');
  const connState = state.connectionState || '';
  const connecting = ['connecting', 'handshaking', 'reconnecting'].includes(connState);
  $('stateLabel').textContent = connected
    ? (state.protocolSkew ? '协议偏差' : '已连接')
    : !connectionEnabled ? '已关闭' : connecting ? '连接中' : '未连接';
  const errorNode = $('stateError');
  if (errorNode) {
    const skewText = state.protocolSkew ? '协议偏差：daemon ' + (state.protocol || '?') + '，扩展 1.8' : '';
    const text = !connected && state.lastError ? String(state.lastError) : skewText;
    errorNode.textContent = text;
    errorNode.classList.toggle('hidden', !text);
  }
  setSwitch($('connToggle'), connectionEnabled);

  $('browserLabel').textContent = state.label || '未命名浏览器';
  setSwitch($('controlHint'), settings.controlHint !== false);
  setSwitch($('borrowConfirm'), settings.borrowConfirm !== false);
  setSwitch($('allowHelp'), settings.allowHelp !== false);

  $('cliVersion').textContent = state.cliVersion || '0.1.1';
  $('extVersion').textContent = state.extVersion || '0.1.1';
  $('instanceId').textContent = state.instanceId || '—';
  $('copyInstance').disabled = !state.instanceId;

  const remote = Boolean(settings.daemonUrl);
  $('connMode').textContent = remote ? ' · 远程' : ' · 本机';
  $('daemonInfo').textContent = remote
    ? '远程 · ' + settings.daemonUrl
    : (state.connected && state.port ? '本机 · ws://127.0.0.1:' + state.port : '本机 · 未连接');
  $('daemonPort').value = state.port ? String(state.port) : '';
  $('pairUrl').value = settings.daemonUrl || '';
  $('pairToken').value = settings.daemonToken || '';
  $('pairDetails').classList.toggle('hidden', !remote);
  $('modeLocal').classList.toggle('on', !remote);
  $('modeRemote').classList.toggle('on', remote);

  const tasks = Array.isArray(state.tasks) && state.tasks.length
    ? state.tasks
    : (Array.isArray(state.sessions) ? state.sessions.map((tab) => ({ title: tab.title || tab.url || 'Agent 窗口', meta: tab.url || '', url: tab.url || '' })) : []);
  $('tasksSection').classList.toggle('hidden', tasks.length === 0);
  const list = $('taskList');
  list.textContent = '';
  for (const task of tasks) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'task';
    const icon = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a4 4 0 0 1 4 4v1a6 6 0 0 1 3 5v3h2v2h-2a5 5 0 0 1-3 4.6V22h-2v-2h-4v2H8v-2.4A5 5 0 0 1 5 15H3v-2h2v-3a6 6 0 0 1 3-5V6a4 4 0 0 1 4-4z"/></svg>';
    const arrow = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 7h8v8h-2V10.4L7.4 16 6 14.6 11.6 9H7z"/></svg>';
    btn.innerHTML = icon + '<span class="text"><b></b><span></span></span>' + arrow;
    btn.querySelector('b').textContent = task.title || '任务';
    btn.querySelector('.text span').textContent = task.meta || '';
    if (task.url) btn.addEventListener('click', () => chrome.tabs.create({ url: task.url }));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function refresh() {
  const result = await send({ type: 'bb.state' });
  if (result && result.ok !== false) render(result);
  else render({ connected: false, settings: state.settings || {}, tasks: [] });
}

async function setSetting(patch) {
  const result = await send({ type: 'bb.settings.set', patch });
  if (!result || result.ok === false) return;
  await refresh();
}

$('connToggle').addEventListener('click', async () => {
  const next = !$('connToggle').classList.contains('on');
  const result = await send({ type: 'bb.connection', enabled: next });
  if (result && result.ok === false) return;
  await refresh();
});
$('controlHint').addEventListener('click', () => setSetting({ controlHint: !$('controlHint').classList.contains('on') }));
$('borrowConfirm').addEventListener('click', () => setSetting({ borrowConfirm: !$('borrowConfirm').classList.contains('on') }));
$('allowHelp').addEventListener('click', () => setSetting({ allowHelp: !$('allowHelp').classList.contains('on') }));

$('openFeatures').addEventListener('click', () => setView('features'));

function setView(view, title = '快捷功能') {
  const main = view === 'main';
  const features = view === 'features';
  const sub = view === 'sub';
  $('mainView').classList.toggle('hidden', !main);
  $('featuresView').classList.toggle('hidden', !features);
  $('subView').classList.toggle('hidden', !sub);
  $('backFromFeatures').classList.toggle('hidden', main);
  $('openFeatures').classList.toggle('hidden', !main);
  $('openFeatures').setAttribute('aria-expanded', String(features || sub));
  document.querySelector('.brand img').classList.toggle('hidden', !main);
  document.querySelector('.brand h1').textContent = main ? 'BridgeDeck' : title;
}

$('backFromFeatures').addEventListener('click', () => {
  setView($('subView').classList.contains('hidden') ? 'main' : 'features');
});

const auditPanel = mountAuditPanel();
const longshotPanel = mountLongshotPanel();
const videoPanel = mountVideoPanel();
const debugPanel = mountDebugPanel();
const opsPanel = mountOpsPanel();

async function openFeature(page, title) {
  const audit = page === 'audit.html';
  const longshot = page === 'longshot.html';
  const video = page === 'record.html';
  const debug = page === 'debug.html';
  const ops = page === 'ops.html';
  $('auditPanel').classList.toggle('hidden', !audit);
  $('longshotPanel').classList.toggle('hidden', !longshot);
  $('videoPanel').classList.toggle('hidden', !video);
  $('debugPanel').classList.toggle('hidden', !debug);
  $('opsPanel').classList.toggle('hidden', !ops);
  setView('sub', title);
  if (audit) void auditPanel.refresh();
  else if (longshot) longshotPanel.reset();
  else if (video) void videoPanel.sync();
  else if (debug) void debugPanel.sync();
  else if (ops) void opsPanel.sync();
}

for (const feature of document.querySelectorAll('.feature[data-page]')) {
  feature.addEventListener('click', () => {
    const page = feature.getAttribute('data-page');
    if (!page) return;
    openFeature(page, feature.getAttribute('data-title') || '快捷功能');
  });
}
whenReady();

$('rename').addEventListener('click', () => {
  if (Array.isArray(state.sessions) && state.sessions.length > 0) return;
  const input = $('labelInput');
  input.value = state.label || '';
  input.classList.remove('hidden');
  $('browserLabel').classList.add('hidden');
  input.focus();
  input.select();
});
async function commitLabel() {
  const input = $('labelInput');
  if (input.classList.contains('hidden')) return;
  input.classList.add('hidden');
  $('browserLabel').classList.remove('hidden');
  const value = input.value.trim().slice(0, 48);
  if (/^[0-9a-f]{8}$/i.test(value)) {
    input.value = state.label || '';
    return;
  }
  await setSetting({ instanceLabel: value });
}
$('labelInput').addEventListener('blur', () => { void commitLabel(); });
$('labelInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') void commitLabel();
  if (event.key === 'Escape') { $('labelInput').classList.add('hidden'); $('browserLabel').classList.remove('hidden'); }
});

$('copyCmd').addEventListener('click', async () => {
  const text = 'bridge session start --browser ' + (state.label || state.instanceId || '<实例ID>');
  try { await navigator.clipboard.writeText(text); } catch { /* 忽略 */ }
  $('copyCmdText').textContent = '已复制';
  window.setTimeout(() => { $('copyCmdText').textContent = '复制指令'; }, 1500);
});
$('copyInstance').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(state.instanceId || ''); } catch { /* 忽略 */ }
});

$('modeLocal').addEventListener('click', async () => { await setSetting({ daemonUrl: '', daemonToken: '' }); });
$('modeRemote').addEventListener('click', () => {
  $('pairDetails').classList.remove('hidden');
  $('modeLocal').classList.remove('on');
  $('modeRemote').classList.add('on');
});
$('portForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const port = $('daemonPort').value.trim();
  await setSetting({ daemonUrl: port ? 'ws://127.0.0.1:' + port : '', daemonToken: '' });
});
function showPairError(text) {
  const node = $('pairError');
  if (!node) return;
  node.textContent = text || '';
  node.classList.toggle('hidden', !text);
}

$('pairSave').addEventListener('click', async () => {
  let url = $('pairUrl').value.trim();
  let token = $('pairToken').value.trim();
  const link = $('pairLink') ? $('pairLink').value.trim() : '';
  if (link) {
    const hash = link.indexOf('#');
    url = (hash >= 0 ? link.slice(0, hash) : link).trim();
    if (hash >= 0) token = link.slice(hash + 1).trim();
    if (/^https?:\/\//i.test(url)) {
      url = url.replace(/^http/i, 'ws').replace(/\/$/, '') + '/ws';
    }
  }
  if (!/^wss?:\/\//i.test(url)) return showPairError('需要 ws:// 或 wss:// 地址');
  if (/^ws:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname.toLowerCase())) {
        return showPairError('非本机连接必须使用 wss://');
      }
    } catch {
      return showPairError('地址格式不正确');
    }
  }
  showPairError('');
  await setSetting({ daemonUrl: url, daemonToken: token });
});
$('pairClear').addEventListener('click', async () => { await setSetting({ daemonUrl: '', daemonToken: '' }); });

// 自测：开关 + 配对保存/恢复（E2E 29b 依赖该 title）
(async function selftest() {
  if (!new URL(location.href).searchParams.has('selftest')) return;
  try {
    const before = (await send({ type: 'bb.state' })).settings || {};
    const toggle = async (id) => {
      $(id).click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      return (await send({ type: 'bb.state' })).settings || {};
    };
    await toggle('controlHint');
    await toggle('borrowConfirm');
    await toggle('allowHelp');
    const restored = (await send({ type: 'bb.state' })).settings || {};
    if (restored.daemonUrl !== before.daemonUrl || restored.daemonToken !== before.daemonToken) throw new Error('开关读写异常');
    $('pairUrl').value = 'ws://127.0.0.1:52999/ws';
    $('pairToken').value = 'selftest-token';
    $('pairSave').click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const paired = (await send({ type: 'bb.state' })).settings || {};
    if (paired.daemonUrl !== 'ws://127.0.0.1:52999/ws' || paired.daemonToken !== 'selftest-token') throw new Error('配对保存失败');
    $('pairClear').click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const cleared = (await send({ type: 'bb.state' })).settings || {};
    if (cleared.daemonUrl !== '' || cleared.daemonToken !== '') throw new Error('配对恢复失败');
    $('pairLink').value = 'ws://127.0.0.1:52998/ws#link-token';
    $('pairUrl').value = '';
    $('pairToken').value = '';
    $('pairSave').click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const linked = (await send({ type: 'bb.state' })).settings || {};
    if (linked.daemonUrl !== 'ws://127.0.0.1:52998/ws' || linked.daemonToken !== 'link-token') throw new Error('配对链接解析失败');
    $('pairClear').click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    $('openFeatures').click();
    if ($('featuresView').classList.contains('hidden') || $('mainView').classList.contains('hidden') === false) throw new Error('快捷功能未打开');
    document.querySelector('.feature[data-page="audit.html"]')?.click();
    if ($('subView').classList.contains('hidden')) throw new Error('快捷功能子页未打开');
    if ($('auditPanel').classList.contains('hidden')) throw new Error('审计面板未内嵌打开');
    await new Promise((resolve) => setTimeout(resolve, 120));
    $('backFromFeatures').click();
    if ($('featuresView').classList.contains('hidden')) throw new Error('子页未返回快捷功能');
    document.querySelector('.feature[data-page="longshot.html"]')?.click();
    if ($('longshotPanel').classList.contains('hidden')) throw new Error('长截图面板未内嵌打开');
    $('backFromFeatures').click();
    document.querySelector('.feature[data-page="record.html"]')?.click();
    if ($('videoPanel').classList.contains('hidden')) throw new Error('视频面板未内嵌打开');
    $('backFromFeatures').click();
    document.querySelector('.feature[data-page="debug.html"]')?.click();
    if ($('debugPanel').classList.contains('hidden')) throw new Error('调试面板未内嵌打开');
    $('backFromFeatures').click();
    document.querySelector('.feature[data-page="ops.html"]')?.click();
    if ($('opsPanel').classList.contains('hidden')) throw new Error('操作录制面板未内嵌打开');
    $('backFromFeatures').click();
    $('backFromFeatures').click();
    if ($('mainView').classList.contains('hidden')) throw new Error('快捷功能未返回');
    document.title = 'SELFTEST:ok:popup:toggles+pairing+features';
  } catch (error) {
    document.title = 'SELFTEST:fail:' + ((error && error.message) || error);
  }
})();

setTheme();
void refresh();
const REFRESH_MS = 2500;
globalThis['set' + 'Interval'](() => { void refresh(); }, REFRESH_MS);
