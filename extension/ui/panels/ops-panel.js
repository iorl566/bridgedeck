/** Inline operation-recording panel; the full page keeps export, delete and JSON. */

import { errorText } from '../common.js';

const $ = (id) => document.getElementById(id);

function setStatus(text, error = false) {
  $('opsStatus').textContent = text;
  $('opsStatus').style.color = error ? 'var(--danger, #dc2626)' : '';
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function buildPrompt(tabUrl, topic, startUrl) {
  const target = (startUrl || tabUrl || '').trim();
  return [
    "Use BridgeDeck's `bridge` CLI to record my next browser actions.",
    '',
    ...(topic ? ['Topic: ' + topic] : []),
    'Steps:',
    '1. Run: bridge record start --json',
    '2. I will confirm, then operate in the current tab myself.',
    '3. When I finish, run: bridge record stop --json',
    '4. Read the exported trace directory (trace.json + states/), then summarize what I did.',
    '',
    target ? 'Start URL: ' + target : 'Start URL: the tab currently focused in the browser.',
  ].join('\n');
}

async function refreshPrompt() {
  const el = $('opsPrompt');
  if (!el) return;
  const tab = await activeTab();
  const topic = String(($('opsTopic') && $('opsTopic').value) || '').trim().slice(0, 80);
  const startUrl = String(($('opsStartUrl') && $('opsStartUrl').value) || '').trim().slice(0, 2048);
  el.value = buildPrompt(tab && tab.url ? String(tab.url) : '', topic, startUrl);
}

function renderRuns(recordings) {
  const container = $('opsRuns');
  if (!container) return;
  container.replaceChildren();
  for (const recording of (recordings || []).slice(0, 3)) {
    const row = document.createElement('div');
    row.className = 'audit-run';
    const content = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = recording.title || recording.url || '录制';
    const meta = document.createElement('small');
    meta.textContent = `${(recording.events || []).length} 条事件`;
    content.append(name, meta);
    row.append(content);
    container.append(row);
  }
}

async function sync() {
  try {
    const tab = await activeTab();
    const state = await chrome.runtime.sendMessage({ type: 'bb.ops.active' });
    const list = state?.active ?? state?.result?.active ?? [];
    const recording = list.find((item) => item.tabId === tab?.id);
    const running = Boolean(recording);
    $('opsStart').disabled = running;
    $('opsStop').disabled = !running;
    setStatus(running ? `录制中 · ${recording.events ?? 0} 条事件` : '未开始');
    const result = await chrome.runtime.sendMessage({ type: 'bb.ops.list' });
    renderRuns(result?.recordings ?? result?.result?.recordings ?? []);
    await refreshPrompt();
  } catch (error) {
    setStatus(errorText(error instanceof Error ? error.message : '读取失败'), true);
  }
}

/** Wire the panel controls once per popup. */
export function mountOpsPanel() {
  if ($('opsTopic')) {
    $('opsTopic').addEventListener('input', () => { void refreshPrompt(); });
  }
  if ($('opsStartUrl')) {
    $('opsStartUrl').addEventListener('input', () => { void refreshPrompt(); });
  }
  $('opsCopyPrompt').addEventListener('click', async () => {
    const prompt = ($('opsPrompt') && $('opsPrompt').value) || buildPrompt('', '', '');
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      const area = document.createElement('textarea');
      area.value = prompt;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    setStatus('已复制：');
  });
  $('opsStart').addEventListener('click', async () => {
    const tab = await activeTab();
    if (!tab?.id) {
      setStatus('没有可录制的标签页', true);
      return;
    }
    const result = await chrome.runtime.sendMessage({ type: 'bb.ops.start', tabId: tab.id });
    if (!result?.ok) {
      setStatus(errorText(result?.error || '开始录制失败'), true);
      return;
    }
    await sync();
  });
  $('opsStop').addEventListener('click', async () => {
    const tab = await activeTab();
    if (!tab?.id) return;
    const result = await chrome.runtime.sendMessage({ type: 'bb.ops.stop', tabId: tab.id });
    if (!result?.ok) {
      setStatus(errorText(result?.error || '停止录制失败'), true);
      return;
    }
    setStatus(`已保存 · ${result.recording?.events?.length ?? 0} 条事件`);
    await sync();
  });
  $('opsOpen').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('ui/ops.html') });
  });
  void refreshPrompt();
  return { sync };
}
