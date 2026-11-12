// ui/ops.js —— 操作录制页
import { back, fillTabSelect, preferredTabFromQuery, selectedTabId } from './tab-picker.js';

const $ = (id) => document.getElementById(id);
let recordings = [];
let activeTabId = null;
let pollTimer = null;

function note(text, isError) {
  const node = $('note');
  node.textContent = text || '';
  node.className = 'note' + (isError ? ' err' : '');
}

function send(message) {
  return chrome.runtime.sendMessage(message).catch((error) => ({ ok: false, error: String((error && error.message) || error) }));
}

function formatTime(ts) {
  const date = new Date(Number(ts) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

async function refreshActive() {
  const result = await send({ type: 'bb.ops.active' });
  const list = (result && (result.active || (result.result && result.result.active))) || [];
  const current = list.find((item) => item.tabId === activeTabId);
  if (current) {
    $('status').textContent = '录制中 · ' + current.events + ' 条 · 已 ' + Math.round((Date.now() - current.startedAt) / 1000) + 's';
    $('status').className = 'status-pill on';
  } else if (activeTabId != null) {
    $('status').textContent = '未开始';
    $('status').className = 'muted';
  }
}

function renderList() {
  const list = $('list');
  list.textContent = '';
  $('empty').hidden = recordings.length > 0;
  for (const recording of recordings) {
    const row = document.createElement('div');
    row.className = 'list-row';
    const title = document.createElement('span');
    title.className = 'grow truncate';
    title.textContent = (recording.title || recording.url || '录制') + ' · ' + recording.events.length + ' 条';
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = formatTime(recording.startedAt);
    const view = document.createElement('button');
    view.className = 'btn';
    view.textContent = '查看';
    view.addEventListener('click', () => showJson(recording));
    const exportBtn = document.createElement('button');
    exportBtn.className = 'btn';
    exportBtn.textContent = '导出';
    exportBtn.addEventListener('click', () => download(recording));
    const del = document.createElement('button');
    del.className = 'btn danger';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      await send({ type: 'bb.ops.delete', id: recording.id });
      await loadList();
    });
    row.append(title, meta, view, exportBtn, del);
    list.appendChild(row);
  }
}

function showJson(recording) {
  $('jsonPanel').hidden = false;
  $('json').textContent = JSON.stringify({
    url: recording.url,
    title: recording.title,
    startedAt: recording.startedAt,
    endedAt: recording.endedAt,
    events: recording.events,
  }, null, 2);
  $('copyJson').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('json').textContent);
      note('已复制 JSON');
    } catch {
      note('复制失败', true);
    }
  };
}

function download(recording) {
  const blob = new Blob([JSON.stringify(recording, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'ops-' + formatTime(recording.startedAt).replace(/[: ]/g, '-') + '.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function loadList() {
  const result = await send({ type: 'bb.ops.list' });
  recordings = (result && (result.recordings || (result.result && result.result.recordings))) || [];
  renderList();
}

$('back').addEventListener('click', () => back());
$('refresh').addEventListener('click', () => loadList());
$('closeJson').addEventListener('click', () => { $('jsonPanel').hidden = true; });

$('start').addEventListener('click', async () => {
  const tabId = selectedTabId($('tabSelect'));
  if (!tabId) return note('先选一个目标标签页', true);
  const result = await send({ type: 'bb.ops.start', tabId });
  if (!result || !result.ok) return note((result && result.error) || '开始录制失败', true);
  activeTabId = tabId;
  $('start').disabled = true;
  $('stop').disabled = false;
  note('已开始录制：在页面上正常操作即可');
  if (!pollTimer) pollTimer = setInterval(refreshActive, 1000);
});

$('stop').addEventListener('click', async () => {
  const tabId = activeTabId != null ? activeTabId : selectedTabId($('tabSelect'));
  const result = await send({ type: 'bb.ops.stop', tabId });
  if (!result || !result.ok) return note((result && result.error) || '停止录制失败', true);
  activeTabId = null;
  $('start').disabled = false;
  $('stop').disabled = true;
  $('status').textContent = '已停止';
  $('status').className = 'muted';
  note('已保存录制（' + (result.recording ? result.recording.events : 0) + ' 条事件）');
  await loadList();
});

fillTabSelect($('tabSelect'), preferredTabFromQuery());
loadList();

// ?selftest=1：真实开始/停止一次录制，结果写进标题
if (new URLSearchParams(location.search).get('selftest') === '1') {
  (async () => {
    try {
      await fillTabSelect($('tabSelect'), preferredTabFromQuery());
      const tabId = selectedTabId($('tabSelect'));
      const started = await send({ type: 'bb.ops.start', tabId });
      if (!started || !started.ok) throw new Error((started && started.error) || 'start failed');
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          func: () => {
            const button = document.getElementById('submit-btn');
            if (button) button.click();
          },
        });
      } catch {
        // 页面没有该按钮时忽略，只验证录制开关
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
      const stopped = await send({ type: 'bb.ops.stop', tabId });
      if (!stopped || !stopped.ok) throw new Error((stopped && stopped.error) || 'stop failed');
      const count = await chrome.runtime.sendMessage({ type: 'bb.ops.list' });
      const recordings = (count && (count.recordings || (count.result && count.result.recordings))) || [];
      const latest = recordings[0];
      const events = latest && Array.isArray(latest.events) ? latest.events.length : 0;
      document.title = 'SELFTEST:ok:ops:' + recordings.length + ':' + events;
    } catch (error) {
      document.title = 'SELFTEST:fail:' + ((error && error.message) || error);
    }
  })();
}
