/** Inline audit panel: switch, recent runs, and full-viewer entry. */

const $ = (id) => document.getElementById(id);

async function request(action, params = {}) {
  const response = await chrome.runtime.sendMessage({ kind: 'bb_audit', action, ...params });
  if (!response || !response.ok) throw new Error(response?.error || 'unavailable');
  return response.data;
}

function renderRuns(list) {
  const container = $('auditRuns');
  container.replaceChildren();
  for (const run of list?.runs ?? []) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'audit-run';
    const content = document.createElement('span');
    const name = document.createElement('b');
    name.textContent = run.name || run.site || '未命名任务';
    const meta = document.createElement('small');
    meta.textContent = `${run.operations} 个操作`;
    content.append(name, meta);
    button.append(content);
    button.addEventListener('click', () => {
      const url = new URL(chrome.runtime.getURL('audit.html'));
      url.searchParams.set('id', run.id);
      chrome.tabs.create({ url: url.href });
    });
    container.append(button);
  }
}

/** Load state and the five most recent runs. */
export async function refreshAuditPanel() {
  try {
    const state = await request('state');
    const enabled = state.enabled === true;
    $('auditToggle').classList.toggle('on', enabled);
    $('auditToggle').setAttribute('aria-checked', String(enabled));
    if (!enabled) {
      $('auditStatus').textContent = '审计已关闭';
      $('auditRuns').replaceChildren();
      return;
    }
    const list = await request('list', { limit: 5 });
    $('auditStatus').textContent = `最近 ${list.runs?.length ?? 0} / 共 ${list.total ?? 0} 条`;
    renderRuns(list);
  } catch (error) {
    $('auditStatus').textContent = error instanceof Error ? error.message : '审计不可用';
  }
}

/** Wire the toggle and full-viewer button once per popup. */
export function mountAuditPanel() {
  $('auditToggle').addEventListener('click', async () => {
    const next = !$('auditToggle').classList.contains('on');
    $('auditToggle').disabled = true;
    try {
      await request('configure', { enabled: next });
      await refreshAuditPanel();
    } finally {
      $('auditToggle').disabled = false;
    }
  });
  $('auditOpen').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('audit.html') });
  });
  return { refresh: refreshAuditPanel };
}
