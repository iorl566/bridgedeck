// ui/audit.js —— 任务审计（扩展侧记录，默认关闭）
const $ = (id) => document.getElementById(id);

function note(text, isError) {
  const node = $('note');
  node.textContent = text || '';
  node.className = 'note' + (isError ? ' err' : '');
}

function formatTime(ts) {
  const date = new Date(Number(ts) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

function row(entry) {
  const node = document.createElement('div');
  node.className = 'list-row';
  const status = document.createElement('span');
  status.className = 'status-pill';
  status.textContent = '调用';
  const main = document.createElement('span');
  main.className = 'grow truncate mono';
  main.textContent = entry.method + (entry.tabId != null ? '  tab ' + entry.tabId : '');
  const meta = document.createElement('span');
  meta.className = 'muted';
  meta.textContent = formatTime(entry.ts) + (entry.sessionId ? ' · ' + entry.sessionId : '');
  node.append(status, main, meta);
  return node;
}

async function load() {
  const list = $('list');
  list.textContent = '';
  $('empty').textContent = '正在读取…';
  const since = Date.now() - Number($('range').value);
  const result = await chrome.runtime.sendMessage({ type: 'bb.audit.list', since, limit: 100 })
    .catch((error) => ({ ok: false, error: String((error && error.message) || error) }));

  if (!result || result.ok === false) {
    $('empty').textContent = '读不到审计：' + ((result && result.error) || '未知错误');
    return;
  }
  const entries = result.entries || [];
  if (!entries.length) {
    $('empty').textContent = '还没有任务记录。后续通过 BridgeDeck 执行的操作会显示在这里。';
    return;
  }
  $('empty').textContent = '共 ' + (result.total || entries.length) + ' 条，显示最近 ' + entries.length + ' 条';
  for (const entry of entries) list.appendChild(row(entry));
}

$('back').addEventListener('click', () => { if (history.length > 1) history.back(); else window.close(); });
$('openFolder').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'bb.audit.clear' });
  note('已清空本机任务审计记录');
  await load();
});
$('refresh').addEventListener('click', () => load());
$('range').addEventListener('change', () => load());
load();

// ?selftest=1：读一次审计列表，结果写进标题
if (new URLSearchParams(location.search).get('selftest') === '1') {
  (async () => {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'bb.audit.list', since: 0, limit: 10 });
      if (!result || result.ok === false) throw new Error((result && result.error) || 'audit failed');
      document.title = 'SELFTEST:ok:audit:' + ((result.entries || []).length);
    } catch (error) {
      document.title = 'SELFTEST:fail:' + ((error && error.message) || error);
    }
  })();
}
