/** Inline audit panel: toggle, recent entries, and full-viewer entry. */

import { errorText } from '../common.js';

const $ = (id) => document.getElementById(id);

function setStatus(text, error = false) {
  const node = $('auditStatus');
  node.textContent = text;
  node.style.color = error ? 'var(--danger, #dc2626)' : '';
}

async function readState() {
  const response = await chrome.runtime.sendMessage({ type: 'bb.state' });
  return response?.settings || {};
}

async function setEnabled(enabled) {
  const response = await chrome.runtime.sendMessage({ type: 'bb.settings.set', patch: { auditEnabled: enabled } });
  if (!response || response.ok === false) throw new Error(response?.error || '保存失败');
  return response.settings || {};
}

async function listEntries() {
  const response = await chrome.runtime.sendMessage({ type: 'bb.audit.list', limit: 5 });
  if (!response || response.ok === false) throw new Error(response?.error || '读取失败');
  return { entries: response.entries || [], total: response.total || 0 };
}

function renderEntries(entries) {
  const container = $('auditRuns');
  container.replaceChildren();
  for (const entry of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'audit-run';
    const content = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = entry.method || '调用';
    const meta = document.createElement('small');
    meta.textContent = new Date(Number(entry.ts) || Date.now()).toLocaleTimeString();
    content.append(name, meta);
    button.append(content);
    button.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('ui/audit.html') });
    });
    container.append(button);
  }
}

/** Load state and the five most recent audit entries. */
export async function refreshAuditPanel() {
  try {
    const settings = await readState();
    const enabled = settings.auditEnabled === true;
    $('auditToggle').classList.toggle('on', enabled);
    $('auditToggle').setAttribute('aria-checked', String(enabled));
    if (!enabled) {
      setStatus('审计已关闭');
      $('auditRuns').replaceChildren();
      return;
    }
    const list = await listEntries();
    setStatus(`已开启 · 最近 ${list.entries.length} 条 / 共 ${list.total} 条`);
    renderEntries(list.entries);
  } catch (error) {
    setStatus(errorText(error instanceof Error ? error.message : '审计状态读取失败'), true);
  }
}

/** Wire the toggle and full-viewer button once per popup. */
export function mountAuditPanel() {
  $('auditToggle').addEventListener('click', async () => {
    const next = !$('auditToggle').classList.contains('on');
    $('auditToggle').disabled = true;
    try {
      await setEnabled(next);
      await refreshAuditPanel();
    } catch (error) {
      setStatus(errorText(error instanceof Error ? error.message : '保存失败'), true);
    } finally {
      $('auditToggle').disabled = false;
    }
  });
  $('auditOpen').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('ui/audit.html') });
  });
  return { refresh: refreshAuditPanel };
}
