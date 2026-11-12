// ui/debug.js —— 网站调试页
import { back, fillTabSelect, preferredTabFromQuery, selectedTabId } from './tab-picker.js';

const $ = (id) => document.getElementById(id);
let activeTabId = null;
let pollTimer = null;
let lastLive = null;
let detailRecord = null;

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

function row(cells, className) {
  const node = document.createElement('div');
  node.className = 'list-row ' + (className || '');
  for (const cell of cells) {
    const span = document.createElement('span');
    if (cell.grow) span.className = 'grow truncate';
    if (cell.mono) span.className = (span.className ? span.className + ' ' : '') + 'mono';
    if (cell.cls) span.className = (span.className ? span.className + ' ' : '') + cell.cls;
    span.textContent = cell.text;
    node.appendChild(span);
  }
  return node;
}

async function replayRequest(id) {
  const tabId = activeTabId != null ? activeTabId : selectedTabId($('tabSelect'));
  if (!tabId) return note('先选一个目标标签页', true);
  const reply = await send({ type: 'bb.debug.replay', tabId, id });
  if (!reply || !reply.ok) return note((reply && (reply.error || reply.message)) || '重放失败', true);
  note('重放完成：HTTP ' + (reply.status != null ? reply.status : '?') + ' ' + (reply.url || ''));
}

function renderLive(data) {
  lastLive = data;
  $('livePanel').hidden = false;
  $('reqCount').textContent = '(' + data.requests.length + ')';
  $('reqEmpty').hidden = data.requests.length > 0;
  const requests = $('requests');
  requests.textContent = '';
  for (const entry of data.requests.slice(-50).reverse()) {
    const line = row([
      { text: entry.method || '', mono: true },
      { text: String(entry.status || '') , cls: entry.error ? 'muted' : '' },
      { text: entry.durationMs != null ? entry.durationMs + 'ms' : '', cls: 'muted' },
      { text: entry.url || '', grow: true, mono: true },
    ]);
    if (entry.id != null) {
      const replay = document.createElement('button');
      replay.className = 'btn';
      replay.textContent = '重放';
      replay.addEventListener('click', () => replayRequest(entry.id));
      line.appendChild(replay);
    }
    requests.appendChild(line);
  }

  $('conCount').textContent = '(' + data.console.length + ')';
  $('conEmpty').hidden = data.console.length > 0;
  const conList = $('consoleList');
  conList.textContent = '';
  for (const entry of data.console.slice(-50)) {
    conList.appendChild(row([
      { text: entry.level || 'log', cls: entry.level === 'error' ? 'mono' : 'muted' },
      { text: String(entry.text || '').slice(0, 300), grow: true, mono: true },
    ]));
  }

  const context = data.context || {};
  $('context').textContent = '';
  for (const [key, value] of Object.entries(context)) {
    const span = document.createElement('span');
    span.textContent = key + ': ' + value;
    $('context').appendChild(span);
  }
}

async function refreshLive() {
  if (activeTabId == null) return;
  const result = await send({ type: 'bb.debug.current', tabId: activeTabId });
  if (!result || !result.ok) return;
  renderLive(result.result || result);
  $('status').textContent = '收集中 · ' + ((result.result && result.result.requests) || result.requests || []).length + ' 请求';
  $('status').className = 'status-pill on';
}

function renderHistory(list) {
  const node = $('history');
  node.textContent = '';
  $('historyEmpty').hidden = list.length > 0;
  for (const item of list) {
    const line = document.createElement('div');
    line.className = 'list-row';
    const title = document.createElement('span');
    title.className = 'grow truncate';
    title.textContent = (item.title || item.url || '调试记录') + ' · ' + item.requests + ' 请求 / ' + item.console + ' 条输出';
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = formatTime(item.startedAt);
    const view = document.createElement('button');
    view.className = 'btn';
    view.textContent = '查看';
    view.addEventListener('click', () => showDetail(item.id));
    const del = document.createElement('button');
    del.className = 'btn danger';
    del.textContent = '删除';
    del.addEventListener('click', async () => {
      await send({ type: 'bb.debug.delete', id: item.id });
      await loadHistory();
    });
    line.append(title, meta, view, del);
    node.appendChild(line);
  }
}

async function loadOperations() {
  const reply = await send({ type: 'bb.call', method: 'operations.list', params: { limit: 30 } });
  const list = (reply && reply.ok && reply.result && reply.result.entries) || [];
  const node = $('operations');
  if (!node) return;
  node.textContent = '';
  $('opsEmpty').hidden = list.length > 0;
  for (const item of list) {
    const line = row([
      { text: formatTime(item.ts), cls: 'muted' },
      { text: item.method || '', mono: true },
      { text: item.ok === false ? (item.code || 'fail') : (item.durationMs != null ? item.durationMs + 'ms' : 'ok'), cls: item.ok === false ? 'mono' : 'muted' },
      { text: item.url || '', grow: true, mono: true },
    ]);
    node.appendChild(line);
  }
}

function currentRuleTab() {
  return activeTabId != null ? activeTabId : selectedTabId($('tabSelect'));
}

async function loadRules() {
  const tabId = currentRuleTab();
  const node = $('rules');
  if (!node) return;
  if (!tabId) {
    node.textContent = '';
    $('rulesEmpty').textContent = '先选一个目标标签页';
    $('rulesEmpty').hidden = false;
    return;
  }
  const reply = await send({ type: 'bb.debug.rule_list', tabId });
  const rules = (reply && reply.ok && (reply.rules || (reply.result && reply.result.rules))) || [];
  node.textContent = '';
  $('rulesEmpty').textContent = '当前标签页没有规则';
  $('rulesEmpty').hidden = rules.length > 0;
  for (const item of rules) {
    node.appendChild(row([
      { text: '#' + item.id, cls: 'muted' },
      { text: item.action || '', mono: true },
      { text: item.urlPattern || '', grow: true, mono: true },
      { text: 'hits=' + (item.hits || 0), cls: 'muted' },
    ]));
  }
}

async function addRule() {
  const tabId = currentRuleTab();
  if (!tabId) return note('先选一个目标标签页', true);
  const pattern = String($('rulePattern').value || '').trim();
  if (!pattern) return note('先填 URL pattern', true);
  const action = String($('ruleAction').value || 'fulfill');
  const rule = { urlPattern: pattern, action };
  if (action === 'fulfill') {
    rule.status = Number($('ruleStatus').value) || 200;
    rule.body = String($('ruleText').value || '');
  }
  const reply = await send({ type: 'bb.debug.rule_add', tabId, rule });
  if (!reply || !reply.ok) return note((reply && (reply.error || reply.message)) || '添加规则失败', true);
  note('已添加规则');
  await loadRules();
}

async function clearRules() {
  const tabId = currentRuleTab();
  if (!tabId) return note('先选一个目标标签页', true);
  const reply = await send({ type: 'bb.debug.rule_clear', tabId });
  if (!reply || !reply.ok) return note((reply && (reply.error || reply.message)) || '清空规则失败', true);
  note('已清空规则');
  await loadRules();
}

async function loadPerf() {
  const tabId = currentRuleTab();
  const node = $('perf');
  if (!node) return;
  if (!tabId) {
    $('perfEmpty').hidden = false;
    return;
  }
  const reply = await send({ type: 'bb.debug.performance', tabId });
  if (!reply || !reply.ok) return;
  const metrics = reply.metrics || (reply.result && reply.result.metrics) || {};
  node.textContent = '';
  const entries = Object.entries(metrics);
  $('perfEmpty').hidden = entries.length > 0;
  $('perfEmpty').textContent = entries.length ? '' : '没有性能数据';
  for (const [key, value] of entries) {
    const span = document.createElement('span');
    span.textContent = key + ': ' + (value == null ? '—' : value);
    node.appendChild(span);
  }
}

async function loadHistory() {
  const result = await send({ type: 'bb.debug.history' });
  const list = (result && (result.history || (result.result && result.result.history))) || [];
  renderHistory(list);
}

async function showDetail(id) {
  const result = await send({ type: 'bb.debug.history.detail', id });
  if (!result || !result.ok) return note((result && result.error) || '读取失败', true);
  detailRecord = result.record || (result.result && result.result.record);
  $('detailPanel').hidden = false;
  $('detailMeta').textContent = '';
  for (const [key, value] of Object.entries({
    url: detailRecord.url,
    title: detailRecord.title,
    startedAt: formatTime(detailRecord.startedAt),
    endedAt: formatTime(detailRecord.endedAt),
  })) {
    const span = document.createElement('span');
    span.textContent = key + ': ' + (value || '');
    $('detailMeta').appendChild(span);
  }
  const body = $('detailBody');
  body.textContent = '';
  for (const entry of (detailRecord.requests || []).slice(0, 100)) {
    body.appendChild(row([
      { text: (entry.method || '') + ' ' + (entry.status || ''), mono: true },
      { text: (entry.durationMs != null ? entry.durationMs + 'ms' : ''), cls: 'muted' },
      { text: entry.url || '', grow: true, mono: true },
    ]));
  }
  for (const entry of (detailRecord.console || []).slice(0, 100)) {
    body.appendChild(row([
      { text: entry.level || 'log', cls: entry.level === 'error' ? 'mono' : 'muted' },
      { text: String(entry.text || '').slice(0, 300), grow: true, mono: true },
    ]));
  }
}

function downloadJson(data, name) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('back').addEventListener('click', () => back());
$('refresh').addEventListener('click', () => loadHistory());
$('refreshOps').addEventListener('click', () => loadOperations());
$('refreshRules').addEventListener('click', () => loadRules());
$('refreshPerf').addEventListener('click', () => loadPerf());
$('addRule').addEventListener('click', () => addRule());
$('clearRules').addEventListener('click', () => clearRules());
$('closeDetail').addEventListener('click', () => { $('detailPanel').hidden = true; });
$('exportLive').addEventListener('click', () => {
  if (!lastLive) return;
  downloadJson(lastLive, 'debug-live.json');
});
$('exportDetail').addEventListener('click', () => {
  if (!detailRecord) return;
  downloadJson(detailRecord, 'debug-' + detailRecord.id.slice(0, 8) + '.json');
});

$('start').addEventListener('click', async () => {
  const tabId = selectedTabId($('tabSelect'));
  if (!tabId) return note('先选一个目标标签页', true);
  const result = await send({ type: 'bb.debug.start', tabId });
  if (!result || !result.ok) return note((result && result.error) || '开始采集失败', true);
  activeTabId = tabId;
  $('start').disabled = true;
  $('stop').disabled = false;
  note('已开始采集：正常操作页面，采集会持续记录');
  if (!pollTimer) pollTimer = setInterval(refreshLive, 2000);
  await refreshLive();
});

$('stop').addEventListener('click', async () => {
  const tabId = activeTabId != null ? activeTabId : selectedTabId($('tabSelect'));
  const result = await send({ type: 'bb.debug.stop', tabId });
  if (!result || !result.ok) return note((result && result.error) || '停止采集失败', true);
  activeTabId = null;
  $('start').disabled = false;
  $('stop').disabled = true;
  $('status').textContent = '已停止';
  $('status').className = 'muted';
  note('已保存：' + result.requests + ' 请求 / ' + result.console + ' 条输出');
  await loadHistory();
});

fillTabSelect($('tabSelect'), preferredTabFromQuery()).then(() => {
  loadHistory();
  loadOperations();
  loadRules();
  loadPerf();
});

// ?selftest=1：真实采集一次，结果写进标题
if (new URLSearchParams(location.search).get('selftest') === '1') {
  (async () => {
    try {
      await fillTabSelect($('tabSelect'), preferredTabFromQuery());
      const tabId = selectedTabId($('tabSelect'));
      const started = await send({ type: 'bb.debug.start', tabId });
      if (!started || !started.ok) throw new Error((started && started.error) || 'start failed');
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          func: () => {
            const button = document.getElementById('ping-btn');
            if (button) button.click();
          },
        });
      } catch {
        // 页面没有该按钮时忽略
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const stopped = await send({ type: 'bb.debug.stop', tabId });
      if (!stopped || !stopped.ok) throw new Error((stopped && stopped.error) || 'stop failed');
      document.title = 'SELFTEST:ok:debug:' + stopped.requests + ':' + stopped.console;
    } catch (error) {
      document.title = 'SELFTEST:fail:' + ((error && error.message) || error);
    }
  })();
}

// ?selftest=replay：采集 /api/ping 后重放一条请求
if (new URLSearchParams(location.search).get('selftest') === 'replay') {
  (async () => {
    try {
      await fillTabSelect($('tabSelect'), preferredTabFromQuery());
      const tabId = selectedTabId($('tabSelect'));
      if (!tabId) throw new Error('no tab selected');
      const started = await send({ type: 'bb.debug.start', tabId });
      if (!started || !started.ok) throw new Error((started && started.error) || 'start failed');
      try {
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          func: () => {
            const button = document.getElementById('ping-btn');
            if (button) button.click();
          },
        });
      } catch {
        // 页面没有该按钮时忽略
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const current = await send({ type: 'bb.debug.current', tabId });
      const requests = (current && current.requests) || (current && current.result && current.result.requests) || [];
      const target = requests.find((item) => String(item.url || '').includes('/api/ping')) || requests[0];
      if (!target || target.id == null) throw new Error('no request to replay');
      const replayed = await send({ type: 'bb.debug.replay', tabId, id: target.id });
      if (!replayed || !replayed.ok) {
        throw new Error('replay failed ' + JSON.stringify({
          error: replayed && replayed.error,
          id: target.id,
          url: target.url,
          method: target.method,
          currentOk: current && current.ok,
        }).slice(0, 300));
      }
      await send({ type: 'bb.debug.stop', tabId });
      document.title = 'SELFTEST:ok:replay:' + (replayed.status != null ? replayed.status : '?');
    } catch (error) {
      document.title = 'SELFTEST:fail:replay:' + ((error && error.message) || error);
    }
  })();
}
// ?selftest=perf：读取性能指标并写进标题
if (new URLSearchParams(location.search).get('selftest') === 'perf') {
  (async () => {
    try {
      await fillTabSelect($('tabSelect'), preferredTabFromQuery());
      const tabId = selectedTabId($('tabSelect'));
      if (!tabId) throw new Error('no tab selected');
      const reply = await send({ type: 'bb.debug.performance', tabId });
      if (!reply || !reply.ok) throw new Error((reply && (reply.error || reply.message)) || 'performance failed');
      const metrics = reply.metrics || (reply.result && reply.result.metrics) || {};
      document.title = 'SELFTEST:ok:perf:' + Object.keys(metrics).length;
    } catch (error) {
      document.title = 'SELFTEST:fail:perf:' + ((error && error.message) || error);
    }
  })();
}
// ?selftest=rules：规则添加 → 列出 → 清空，结果写进标题
if (new URLSearchParams(location.search).get('selftest') === 'rules') {
  (async () => {
    try {
      await fillTabSelect($('tabSelect'), preferredTabFromQuery());
      const tabId = selectedTabId($('tabSelect'));
      if (!tabId) throw new Error('no tab selected');
      const added = await send({
        type: 'bb.debug.rule_add',
        tabId,
        rule: { urlPattern: '*/__selftest_rule__*', action: 'block' },
      });
      if (!added || !added.ok) throw new Error((added && (added.error || added.message)) || 'rule_add failed');
      const listed = await send({ type: 'bb.debug.rule_list', tabId });
      const rules = (listed && (listed.rules || (listed.result && listed.result.rules))) || [];
      const cleared = await send({ type: 'bb.debug.rule_clear', tabId });
      if (!cleared || !cleared.ok) throw new Error((cleared && (cleared.error || cleared.message)) || 'rule_clear failed');
      document.title = 'SELFTEST:ok:rules:' + rules.length;
    } catch (error) {
      document.title = 'SELFTEST:fail:rules:' + ((error && error.message) || error);
    }
  })();
}
