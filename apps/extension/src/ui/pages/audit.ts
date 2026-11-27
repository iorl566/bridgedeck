// src/ui/pages/audit.ts —— 操作审计页：读取 daemon 审计日志（只读）。
//
// 数据来源：`bb.ui` 的 `audit.list` → background 用 RpcRegistry 的只读白名单转发到 daemon
// （WS_READONLY_METHODS 里就有 audit.list）。页面侧不直接连 daemon，也不做写操作。
// `?selftest=1` 把条数写进标题（E2E 34）。

import { el, reportSelftest, setupPage } from '../page.ts';
import { describeFailure, sendUi } from '../client.ts';

interface AuditEntry {
  at?: number;
  method?: string;
  ok?: boolean;
  sessionId?: string;
  tabId?: number;
  detail?: unknown;
}

function formatTime(value: unknown): string {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return String(ms);
  }
}

async function loadEntries(limit: number): Promise<{ entries: AuditEntry[]; total: number | null; error: string | null }> {
  const reply = await sendUi<{ entries?: AuditEntry[]; total?: number }>('audit.list', { limit });
  if (reply.ok !== true) {
    return { entries: [], total: null, error: describeFailure(reply as { code?: string; message?: string }) };
  }
  const entries = reply.result?.entries ?? [];
  return { entries, total: Number.isFinite(Number(reply.result?.total)) ? Number(reply.result?.total) : entries.length, error: null };
}

function render(entries: AuditEntry[], total: number | null, error: string | null): void {
  const body = document.getElementById('audit-body');
  if (!body) return;
  body.textContent = '';
  if (error) {
    body.append(el('p', { className: 'status bad', text: '读取失败：' + error }));
    return;
  }
  body.append(el('h2', { text: '审计记录（' + String(entries.length) + (total !== null && total !== entries.length ? ' / ' + String(total) : '') + '）' }));
  if (!entries.length) {
    body.append(el('p', { className: 'muted', text: '暂无审计记录（daemon 审计为空或未开启）' }));
    return;
  }
  const table = document.createElement('table');
  table.style.borderCollapse = 'collapse';
  table.style.width = '100%';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['时间', '方法', '结果', '会话', '标签页']) {
    const cell = document.createElement('th');
    cell.textContent = label;
    cell.style.textAlign = 'start';
    cell.style.borderBottom = '1px solid var(--bb-line)';
    cell.style.padding = '4px 8px';
    headRow.append(cell);
  }
  head.append(headRow);
  table.append(head);
  const tbody = document.createElement('tbody');
  for (const entry of entries) {
    const row = document.createElement('tr');
    const values = [
      formatTime(entry.at),
      String(entry.method ?? ''),
      entry.ok === false ? '失败' : '成功',
      String(entry.sessionId ?? '—'),
      entry.tabId == null ? '—' : String(entry.tabId),
    ];
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = value;
      cell.style.padding = '4px 8px';
      cell.style.borderBottom = '1px solid var(--bb-line)';
      row.append(cell);
    }
    tbody.append(row);
  }
  table.append(tbody);
  body.append(table);
}

async function main(): Promise<void> {
  const boot = setupPage('audit');
  const limit = Math.max(1, Math.min(500, Number(boot.query.get('limit')) || 100));
  const body = el('div', { id: 'audit-body' }, [el('p', { className: 'muted', text: boot.t('loading') })]);
  const refresh = el('button', {
    attrs: { type: 'button', id: 'audit-refresh', 'aria-label': '刷新审计记录' },
    text: '刷新',
  });
  refresh.addEventListener('click', () => {
    void (async () => {
      body.textContent = '';
      body.append(el('p', { className: 'muted', text: boot.t('loading') }));
      const result = await loadEntries(limit);
      render(result.entries, result.total, result.error);
    })();
  });
  document.body.textContent = '';
  document.body.append(
    el('header', {}, [
      el('h1', { text: boot.page ? '操作审计' : '操作审计' }),
      el('p', { className: 'muted', text: 'daemon 审计日志只读视图（limit ' + String(limit) + '）' }),
    ]),
    el('div', { className: 'row' }, [refresh]),
    body,
  );

  const result = await loadEntries(limit);
  render(result.entries, result.total, result.error);
  if (boot.query.get('selftest') === '1') {
    if (result.error) reportSelftest('audit', result.error, false);
    else reportSelftest('audit', String(result.entries.length));
  }
}

void main().catch((error: unknown) => {
  setupPage('audit');
  document.body.textContent = '';
  document.body.append(
    el('h1', { text: '操作审计' }),
    el('p', { className: 'status bad', text: '初始化失败：' + (error instanceof Error ? error.message : String(error)) }),
  );
});
