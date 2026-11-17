import { whenReady } from './i18n.js';
import { mountAuditPanel } from './panels/audit-panel.js';
import { mountLongshotPanel } from './panels/longshot-panel.js';
import { mountVideoPanel } from './panels/video-panel.js';
import { mountDebugPanel } from './panels/debug-panel.js';
import { mountOpsPanel } from './panels/ops-panel.js';
// ui/popup.js —— BridgeDeck弹窗（品牌与配色自有）
import { $ } from './common.js';
import { PROTOCOL_VERSION } from '../src/protocol-version.js';
const send = (message) => chrome.runtime.sendMessage(message).catch((error) => ({ ok: false, error: String((error && error.message) || error) }));

let state = { connected: false, settings: {}, notifications: [] };
// 弹窗里的"本机/远程配对"是 UI 状态：用户点开远程后，轮询刷新不能把它弹回本机。
// null = 跟随已保存的设置；'remote'/'local' = 用户正在看的模式。
let uiMode = null;
let settingsSaving = false;

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
    const auth = state.localAuth && typeof state.localAuth === 'object' ? state.localAuth : null;
    let badge = '';
    if (connected && auth && auth.state === 'verified') badge = '已连接 · 已验证';
    else if (connected && auth && auth.state === 'unverified_local') {
      badge = auth.reason === 'skip' ? '已连接 · 已跳过配对（身份未验证）' : '已连接 · 未配对（身份未验证）';
    } else if (connected && auth && auth.state === 'pairing_required') badge = '需要配对：daemon 要求 6 位配对码';
    else if (connected && auth && auth.state === 'unpaired') badge = '已连接 · 未配对';
    else if (connected && auth && auth.state && auth.state !== 'verified') badge = '本地认证状态：' + auth.state;
    authBadge.textContent = badge;
    authBadge.classList.toggle('hidden', !badge);
    const warn = $('connWarn');
    if (warn) warn.classList.toggle('hidden', !(connected && auth && auth.state && auth.state !== 'verified'));
  }
  $('stateDot').className = 'dot' + (connected ? ' on' : connectionEnabled ? ' warn' : '');
  const connState = state.connectionState || '';
  const connecting = ['connecting', 'handshaking', 'reconnecting'].includes(connState);
  $('stateLabel').textContent = connected
    ? (state.protocolSkew ? '协议偏差' : '已连接')
    : !connectionEnabled ? '已关闭' : connecting ? '连接中' : '未连接';
  const errorNode = $('stateError');
  if (errorNode) {
    const text = !connected && state.lastError ? String(state.lastError) : '';
    errorNode.textContent = text;
    errorNode.classList.toggle('hidden', !text);
  }
  const upgrade = $('upgradeNotice');
  if (upgrade) {
    const skew = state.protocolSkew;
    if (skew) {
      const extensionOlder = skew === 'daemon_newer';
      $('upgradeTitle').textContent = extensionOlder ? '扩展需要更新' : '版本不兼容';
      $('upgradeVersion').textContent = 'daemon ' + (state.protocol || '?') + ' / 扩展 ' + PROTOCOL_VERSION;
      $('upgradeDesc').textContent = extensionOlder
        ? 'daemon 使用的协议比当前扩展新。请更新 BridgeDeck 扩展后重连。'
        : 'daemon 与扩展协议不一致。请先升级 daemon，再刷新扩展。';
      $('upgradeCommand').textContent = extensionOlder ? '请更新扩展' : 'bridge update apply';
      $('upgradeCommand').classList.toggle('hidden', extensionOlder);
      $('copyUpgrade').classList.toggle('hidden', extensionOlder);
      upgrade.classList.remove('hidden');
    } else {
      upgrade.classList.add('hidden');
    }
  }
  setSwitch($('connToggle'), connectionEnabled);

  $('browserLabel').textContent = state.label || '未命名浏览器';
  const renameBusy = Array.isArray(state.sessions) && state.sessions.length > 0;
  $('rename').disabled = renameBusy;
  $('rename').title = renameBusy ? '会话进行中不能修改浏览器名称' : '修改浏览器名称';
  $('rename').setAttribute('aria-disabled', String(renameBusy));
  setSwitch($('controlHint'), settings.controlHint !== false);
  setSwitch($('borrowConfirm'), settings.borrowConfirm !== false);
  setSwitch($('allowHelp'), settings.allowHelp !== false);
  setSwitch($('cooperationGuard'), settings.cooperationGuard === true);

  $('cliVersion').textContent = state.cliVersion || '—';
  $('extVersion').textContent = chrome.runtime.getManifest().version;
  $('instanceId').textContent = state.instanceId || '—';
  $('copyInstance').disabled = !state.instanceId;

  const savedRemote = Boolean(settings.daemonUrl);
  const remote = uiMode === null ? savedRemote : uiMode === 'remote';
  $('connMode').textContent = remote ? ' · 远程' : ' · 本机';
  $('daemonInfo').textContent = remote
    ? (settings.daemonUrl ? '远程 · ' + settings.daemonUrl : '远程 · 尚未保存配对链接')
    : (state.connected && state.port ? '本机 · ws://127.0.0.1:' + state.port : '本机 · 未连接');
  if (document.activeElement !== $('daemonPort')) $('daemonPort').value = state.port ? String(state.port) : '';
  if (uiMode === null) {
    $('pairUrl').value = settings.daemonUrl || '';
    $('pairToken').value = settings.daemonToken || '';
    $('pairCode').value = settings.daemonCode || '';
  }
  $('localSection').classList.toggle('hidden', remote);
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
    if (task.debug === true && Number.isInteger(task.tabId)) {
      btn.addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('ui/debug.html') + '?tab=' + task.tabId });
      });
    } else if (task.url) {
      btn.addEventListener('click', () => chrome.tabs.create({ url: task.url }));
    }
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
  if (settingsSaving) return;
  settingsSaving = true;
  for (const id of ['controlHint', 'borrowConfirm', 'allowHelp', 'cooperationGuard', 'connToggle']) {
    const node = $(id);
    if (node) node.disabled = true;
  }
  try {
    const result = await send({ type: 'bb.settings.set', patch });
    if (!result || result.ok === false) {
      const errorNode = $('stateError');
      if (errorNode) {
        errorNode.textContent = (result && result.error) || '设置保存失败';
        errorNode.classList.remove('hidden');
      }
      return;
    }
    await refresh();
  } finally {
    settingsSaving = false;
    for (const id of ['controlHint', 'borrowConfirm', 'allowHelp', 'cooperationGuard', 'connToggle']) {
      const node = $(id);
      if (node) node.disabled = false;
    }
  }
}

$('connToggle').addEventListener('click', async () => {
  if (settingsSaving) return;
  settingsSaving = true;
  $('connToggle').disabled = true;
  try {
    const next = !$('connToggle').classList.contains('on');
    const result = await send({ type: 'bb.connection', enabled: next });
    if (!result || result.ok === false) return;
    await refresh();
  } finally {
    settingsSaving = false;
    $('connToggle').disabled = false;
  }
});
// 配对指引：按浏览器语言给 10 种文案，未配对连接仍可用但会提示身份未验证。
const PAIRING_GUIDE = {
  zh: ['运行 bridge daemon pair 生成配对链接', '粘贴到下面并保存', '未配对连接仍可用，但会显示身份未验证'],
  'zh-tw': ['執行 bridge daemon pair 產生配對連結', '貼到下面並儲存', '未配對連線仍可用，但會顯示身分未驗證'],
  en: ['Run bridge daemon pair to get a pairing link', 'Paste it below and save', 'Unpaired connections still work, with an identity warning'],
  ja: ['bridge daemon pair でペアリングリンクを生成', '下に貼り付けて保存', '未ペアリングでも利用できますが、身元未確認の警告が出ます'],
  ko: ['bridge daemon pair 로 페어링 링크 생성', '아래에 붙여넣고 저장', '페어링하지 않아도 사용할 수 있지만 신원 미확인 경고가 표시됩니다'],
  fr: ['Exécutez bridge daemon pair pour obtenir un lien', 'Collez-le ci-dessous puis enregistrez', 'Les connexions non appairées restent utilisables avec un avertissement d’identité'],
  de: ['bridge daemon pair ausführen, um einen Link zu erhalten', 'Unten einfügen und speichern', 'Nicht gekoppelte Verbindungen funktionieren weiterhin mit Identitätswarnung'],
  es: ['Ejecuta bridge daemon pair para obtener un enlace', 'Pégalo abajo y guarda', 'Las conexiones sin emparejar siguen funcionando con un aviso de identidad'],
  it: ['Esegui bridge daemon pair per ottenere un link', 'Incollalo qui sotto e salva', 'Le connessioni non associate funzionano comunque con un avviso di identità'],
  pt: ['Execute bridge daemon pair para obter um link', 'Cole abaixo e salve', 'Conexões não emparelhadas continuam funcionando com um aviso de identidade'],
};

function renderPairingGuide() {
  const list = $('pairGuide');
  if (!list) return;
  const lang = String(navigator.language || 'zh').toLowerCase();
  const key = lang.startsWith('zh-tw') || lang.startsWith('zh-hk') ? 'zh-tw' : lang.slice(0, 2);
  const steps = PAIRING_GUIDE[key] || PAIRING_GUIDE.en;
  list.textContent = '';
  for (const step of steps) {
    const item = document.createElement('li');
    item.textContent = step;
    list.appendChild(item);
  }
}

renderPairingGuide();

async function refreshDevices() {
  const result = await send({ type: 'bb.devices.list' });
  const devices = (result && result.ok !== false && Array.isArray(result.devices)) ? result.devices : [];
  const count = $('deviceCount');
  if (count) count.textContent = devices.length ? ' · ' + devices.length : '';
  const list = $('deviceList');
  if (!list) return;
  list.textContent = '';
  if (!devices.length) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.style.margin = '0';
    hint.textContent = '没有已保存的配对设备';
    list.appendChild(hint);
    return;
  }
  for (const device of devices) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0';
    const label = document.createElement('span');
    label.style.cssText = 'flex:1;font-size:11.5px;color:#475569;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
    label.textContent = String(device.daemonId || '').slice(0, 8) + '…/' + String(device.deviceId || '').slice(0, 8) + '… · gen ' + device.gen;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn sm';
    button.textContent = '撤销';
    button.addEventListener('click', async () => {
      await send({ type: 'bb.devices.revoke', daemonId: device.daemonId, deviceId: device.deviceId });
      await refreshDevices();
    });
    row.appendChild(label);
    row.appendChild(button);
    list.appendChild(row);
  }
}

$('deviceRevokeAll')?.addEventListener('click', async () => {
  await send({ type: 'bb.devices.revoke', all: true });
  await refreshDevices();
});

void refreshDevices();

$('controlHint').addEventListener('click', () => setSetting({ controlHint: !$('controlHint').classList.contains('on') }));
$('borrowConfirm').addEventListener('click', () => setSetting({ borrowConfirm: !$('borrowConfirm').classList.contains('on') }));
$('allowHelp').addEventListener('click', () => setSetting({ allowHelp: !$('allowHelp').classList.contains('on') }));
$('cooperationGuard').addEventListener('click', () => setSetting({ cooperationGuard: !$('cooperationGuard').classList.contains('on') }));

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

// 复制：剪贴板 API 在无用户手势时会拒绝，回退到 textarea + execCommand。
async function copyText(text) {
  const value = String(text || '');
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch { /* 回退 */ }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

$('copyCmd').addEventListener('click', async () => {
  const text = 'bridge session start --browser ' + (state.label || state.instanceId || '<实例ID>');
  const copied = await copyText(text);
  $('copyCmdText').textContent = copied ? '已复制' : '复制失败';
  window.setTimeout(() => { $('copyCmdText').textContent = '复制指令'; }, 1500);
});
$('copyInstance').addEventListener('click', async () => {
  await copyText(state.instanceId || '');
});
$('copyUpgrade').addEventListener('click', async () => {
  const command = $('upgradeCommand').textContent || 'bridge update apply';
  const copied = await copyText(command);
  $('copyUpgrade').textContent = copied ? '已复制' : '复制失败';
  setTimeout(() => { $('copyUpgrade').textContent = '复制命令'; }, 1500);
});

$('modeLocal').addEventListener('click', async () => {
  uiMode = 'local';
  render(state);
  await setSetting({ daemonUrl: '', daemonToken: '', daemonCode: '' });
  uiMode = null;
});
$('modeRemote').addEventListener('click', () => {
  uiMode = 'remote';
  render(state);
  $('pairLink').focus();
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
  const code = $('pairCode') ? $('pairCode').value.replace(/\D/g, '').slice(0, 6) : '';
  if (link) {
    const hash = link.indexOf('#');
    url = (hash >= 0 ? link.slice(0, hash) : link).trim();
    if (hash >= 0) token = link.slice(hash + 1).trim();
    if (/^https?:\/\//i.test(url)) {
      url = url.replace(/^http/i, 'ws').replace(/\/$/, '') + '/ws';
    }
  }
  if (!/^wss?:\/\//i.test(url)) return showPairError('需要 ws:// 或 wss:// 地址');
  if (code && code.length !== 6) return showPairError('配对码需为 6 位数字');
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
  uiMode = null;
  await setSetting({ daemonUrl: url, daemonToken: token, daemonCode: code });
});
$('pairClear').addEventListener('click', async () => {
  uiMode = null;
  await setSetting({ daemonUrl: '', daemonToken: '', daemonCode: '' });
});

// 自测：开关 + 配对保存/恢复（E2E 29b 依赖该 title）
(async function selftest() {
  if (!new URL(location.href).searchParams.has('selftest')) return;
  try {
    const before = (await send({ type: 'bb.state' })).settings || {};
    // v0.1.8 UI：版本偏差提示 / 本地认证徽标 / 复制升级命令必须真实渲染。
    const demo = {
      ...state,
      connected: true,
      settings: { ...(state.settings || {}), connectionEnabled: true },
      tasks: [],
      sessions: [],
    };
    render({ ...demo, protocolSkew: 'daemon_newer', protocol: '9.9.9', localAuth: { state: 'unpaired' } });
    if ($('upgradeNotice').classList.contains('hidden')) throw new Error('版本提示未显示');
    if (!/扩展需要更新/.test($('upgradeTitle').textContent)) throw new Error('扩展更新标题不对：' + $('upgradeTitle').textContent);
    if (!String($('upgradeVersion').textContent).includes('daemon 9.9.9')) throw new Error('版本号未显示：' + $('upgradeVersion').textContent);
    if ($('upgradeCommand').textContent !== '请更新扩展') throw new Error('扩展更新命令文案不对：' + $('upgradeCommand').textContent);
    if (!$('copyUpgrade').classList.contains('hidden')) throw new Error('扩展更新时不应显示复制命令');
    if (!/已连接 · 未配对/.test($('localAuthBadge').textContent)) throw new Error('未配对徽标不对：' + $('localAuthBadge').textContent);
    render({ ...demo, protocolSkew: 'daemon_older', protocol: '0.9.0', localAuth: { state: 'verified' } });
    if (!/版本不兼容/.test($('upgradeTitle').textContent)) throw new Error('版本不兼容标题不对：' + $('upgradeTitle').textContent);
    if ($('upgradeCommand').textContent !== 'bridge update apply') throw new Error('升级命令文案不对：' + $('upgradeCommand').textContent);
    if ($('copyUpgrade').classList.contains('hidden')) throw new Error('版本不兼容时应显示复制命令');
    if (!/已验证/.test($('localAuthBadge').textContent)) throw new Error('已验证徽标不对：' + $('localAuthBadge').textContent);
    $('copyUpgrade').click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    if ($('copyUpgrade').textContent !== '已复制') throw new Error('复制升级命令没有反馈');
    render({ ...demo, localAuth: { state: 'unverified_local', reason: 'skip' } });
    if (!/已跳过配对/.test($('localAuthBadge').textContent)) throw new Error('跳过配对徽标不对：' + $('localAuthBadge').textContent);
    render({ ...demo, localAuth: { state: 'pairing_required' } });
    if (!/需要配对/.test($('localAuthBadge').textContent)) throw new Error('需要配对徽标不对：' + $('localAuthBadge').textContent);
    await refresh();
    const toggle = async (id) => {
      $(id).click();
      await new Promise((resolve) => setTimeout(resolve, 120));
      return (await send({ type: 'bb.state' })).settings || {};
    };
    // 只测一个无害开关，并且来回切两次恢复原值（不要动借用确认/人工协助）。
    await toggle('controlHint');
    await toggle('controlHint');
    const restored = (await send({ type: 'bb.state' })).settings || {};
    if (restored.daemonUrl !== before.daemonUrl || restored.daemonToken !== before.daemonToken) throw new Error('开关读写异常');
    if ((restored.controlHint !== false) !== (before.controlHint !== false)) throw new Error('开关未恢复原值');
    $('pairUrl').value = 'ws://127.0.0.1:52999/ws';
    $('pairToken').value = 'selftest-token';
    $('pairCode').value = '123456';
    $('pairSave').click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const paired = (await send({ type: 'bb.state' })).settings || {};
    if (paired.daemonUrl !== 'ws://127.0.0.1:52999/ws' || paired.daemonToken !== 'selftest-token' || paired.daemonCode !== '123456') throw new Error('配对保存失败');
    $('pairClear').click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const cleared = (await send({ type: 'bb.state' })).settings || {};
    if (cleared.daemonUrl !== '' || cleared.daemonToken !== '' || cleared.daemonCode !== '') throw new Error('配对恢复失败');
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
    await new Promise((resolve) => setTimeout(resolve, 400));
    const auditStatus = ($('auditStatus')?.textContent || '').trim();
    if (!auditStatus || /unavailable|读取失败|失败/i.test(auditStatus)) {
      throw new Error('审计面板状态异常：' + auditStatus);
    }
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
    // 轮询刷新不能把「远程配对」弹回本机（回归 2026-11-13 用户反馈）
    $('modeRemote').click();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if ($('pairDetails').classList.contains('hidden')) throw new Error('远程配对被刷新弹回本机');
    if (!$('modeRemote').classList.contains('on')) throw new Error('远程配对模式状态丢失');
    if (!$('localSection').classList.contains('hidden')) throw new Error('远程模式下本机分区仍显示');
    $('modeLocal').click();
    await new Promise((resolve) => setTimeout(resolve, 400));
    if ($('localSection').classList.contains('hidden')) throw new Error('切回本机失败');
    if (!deviceRevokeAll) throw new Error('配对设备面板缺失');
    if (!pairGuide || pairGuide.children.length < 3) throw new Error('配对指引缺失');
    document.title = 'SELFTEST:ok:popup:toggles+pairing+features';
  } catch (error) {
    document.title = 'SELFTEST:fail:' + ((error && error.message) || error);
  }
})();

setTheme();
// 诊断钩子：?syncTest=on|off 直接调用接管浮层同步，标题返回结果。
if (new URL(location.href).searchParams.get('syncTest')) {
  const on = new URL(location.href).searchParams.get('syncTest') === 'on';
  import('../src/takeover.js')
    .then((module) => module.syncControlHintsVisible(on))
    .then(() => { document.title = 'SYNC:ok:' + (on ? 'on' : 'off'); })
    .catch((error) => { document.title = 'SYNC:fail:' + ((error && error.message) || error); });
}
// 维护钩子：?reload 重新加载扩展（改完 service worker 代码后免去手动点刷新）。
if (new URL(location.href).searchParams.has('reload')) {
  try { chrome.runtime.reload(); } catch { /* 忽略 */ }
}
// 一次性修复钩子：?fixSettings=on 把三个安全开关恢复到开启（默认值）。
(async function fixSettingsHook() {
  if (new URL(location.href).searchParams.get('fixSettings') !== 'on') return;
  try {
    await send({ type: 'bb.settings.set', patch: { controlHint: true, borrowConfirm: true, allowHelp: true } });
    document.title = 'FIX:settings:on:done';
  } catch (error) {
    document.title = 'FIX:settings:fail:' + ((error && error.message) || error);
  }
})();
// 视觉自检/演示：?mode=remote 直接展示远程配对表单
if (new URL(location.href).searchParams.get('mode') === 'remote') uiMode = 'remote';
// 诊断：?coopState=<tabId> 直接询问内容脚本输入锁状态，避免暂停时不能用 evaluate。
const coopStateRaw = new URL(location.href).searchParams.get('coopState');
const coopStateTab = coopStateRaw == null || coopStateRaw === '' ? null : Number(coopStateRaw);
if (Number.isInteger(coopStateTab) && coopStateTab > 0) {
  chrome.tabs.sendMessage(coopStateTab, { type: 'bb.cooperation.state' }, { frameId: 0 })
    .then((reply) => { document.title = 'COOP:' + JSON.stringify(reply && reply.state ? reply.state : null); })
    .catch(() => { document.title = 'COOP:fail'; });
}
// 视觉自检/演示：?guard=on|off 只用于本机验收输入锁（人类开关的正常入口是 UI）。
const guardParam = new URL(location.href).searchParams.get('guard');
if (guardParam === 'on' || guardParam === 'off') {
  void send({ type: 'bb.settings.set', patch: { cooperationGuard: guardParam === 'on' } })
    .then((result) => { document.title = 'GUARD:' + (result && result.ok !== false ? guardParam : 'fail'); })
    .catch(() => { document.title = 'GUARD:fail'; });
}
// 视觉自检/演示：?preview=upgrade|incompatible 用假状态渲染协议偏差（不动真实连接状态）。
const previewMode = new URL(location.href).searchParams.get('preview');
void refresh().then(() => {
  if (previewMode !== 'upgrade' && previewMode !== 'incompatible') return;
  const incompatible = previewMode === 'incompatible';
  render({
    ...state,
    connected: true,
    protocolSkew: incompatible ? 'daemon_older' : 'daemon_newer',
    protocol: incompatible ? '1.8.0' : '0.2.0',
    localAuth: { state: 'unpaired' },
    tasks: [],
    sessions: [],
  });
  document.documentElement.dataset.bbPreview = previewMode;
});
const REFRESH_MS = 2500;
if (!previewMode) globalThis['set' + 'Interval'](() => { void refresh(); }, REFRESH_MS);
