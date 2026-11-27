// ui/longshot.js —— 长截图：自动滚动 / 手动拼接 + 预览保存
import { back, fillTabSelect, preferredTabFromQuery, selectedTabId } from './tab-picker.js';

import { $ } from './common.js';
import { getLang } from './i18n.js';
import { installPageTools } from './lib/page-tools.js';
import { labeler } from './lib/labels.js';
import { mount, setText } from './lib/dom.js';
import { h, button } from './lib/render.js';
import { createStateMachine, stateModel } from './lib/states.js';
import { buildHistoryView } from './views/history-view.js';
import { buildTimelineView } from './views/timeline-view.js';
import { createRovingModel } from './lib/focus.js';
import { resolveEvent } from './lib/keyboard.js';
import { formatTimestamp } from './lib/format.js';
import { listLongshot } from '../src/lib/longshot-store.js';
import { pruneManifests } from '../src/lib/capture-manifest.js';
import { planStitch } from '../src/longshot-render.js';

async function loadLastPreview() {
  try {
    const stored = await chrome.storage.session.get('bb.longshot.last');
    const last = stored && stored['bb.longshot.last'];
    if (!last || !last.dataUrl) return;
    $('lastPreview').src = last.dataUrl;
    $('lastWrap').hidden = false;
    $('lastEmpty').hidden = true;
  } catch {
    // 忽略
  }
}

$('openPreview')?.addEventListener('click', async () => {
  const stored = await chrome.storage.session.get('bb.longshot.last');
  const last = stored && stored['bb.longshot.last'];
  if (last && last.dataUrl) {
    await chrome.tabs.create({ url: last.dataUrl });
  } else {
    $('lastEmpty').hidden = false;
  }
});
loadLastPreview();
let pendingDataUrl = null;

async function readManifests() {
  const stored = await chrome.storage.local.get('bb.capture.manifests');
  return pruneManifests(Array.isArray(stored && stored['bb.capture.manifests']) ? stored['bb.capture.manifests'] : []);
}

async function stitchFrames(frames) {
  const bitmaps = [];
  for (const frame of frames) {
    const blob = await (await fetch(frame.dataUrl)).blob();
    bitmaps.push(await createImageBitmap(blob));
  }
  const width = Math.max(1, ...bitmaps.map((item) => item.width));
  // 新分片带 drawY（自动截图有重叠）：按页面坐标拼接；旧分片没有 drawY 时按顺序累加。
  const layout = planStitch(frames, { width });
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  for (const placement of layout.placements) {
    const bitmap = bitmaps[placement.index];
    if (bitmap) ctx.drawImage(bitmap, 0, placement.drawY);
  }
  return { dataUrl: canvas.toDataURL('image/png'), width: layout.width, height: layout.height };
}

async function refreshRecovery() {
  const list = await readManifests();
  const node = $('restoreList');
  if (!list.length) { node.textContent = '没有本地分片'; return []; }
  node.innerHTML = list.map((item) => '<div>' + item.id + ' · ' + item.width + '×' + item.height + ' · ' + item.tiles + ' 帧 · ' + item.createdAt + '</div>').join('');
  return list;
}

$('restoreRefresh')?.addEventListener('click', () => void refreshRecovery());
$('restoreLatest')?.addEventListener('click', async () => {
  const list = await readManifests();
  if (!list.length) return note('没有可恢复的本地分片', true);
  const id = list[0].id;
  const frames = await listLongshot(id);
  if (!frames.length) return note('分片已不存在：' + id, true);
  try {
    const stitched = await stitchFrames(frames);
    showPreview(stitched.dataUrl, stitched.width, stitched.height);
    note('已恢复 ' + id + '（' + frames.length + ' 帧）');
  } catch (error) {
    note('恢复失败：' + (error && error.message ? error.message : error), true);
  }
});
refreshRecovery().catch(() => {});

function note(text, isError) {
  const node = $('note');
  node.textContent = text || '';
  node.className = 'note' + (isError ? ' err' : '');
}

function send(message) {
  return chrome.runtime.sendMessage(message).catch((error) => ({ ok: false, error: String((error && error.message) || error) }));
}

function showPreview(dataUrl, width, height) {
  pendingDataUrl = dataUrl;
  $('preview').src = dataUrl;
  $('previewSize').textContent = (width || '?') + ' × ' + (height || '?');
  $('previewPanel').hidden = false;
}

function clearPreview() {
  pendingDataUrl = null;
  $('preview').removeAttribute('src');
  $('previewPanel').hidden = true;
}

function syncMode() {
  const manual = $('modeSelect').value === 'manual';
  $('autoBox').hidden = manual;
  $('manualBox').hidden = !manual;
}

$('back').addEventListener('click', () => back());
$('modeSelect').addEventListener('change', syncMode);

$('autoShot').addEventListener('click', async () => {
  const tabId = selectedTabId($('tabSelect'));
  if (!tabId) return note('先选一个目标标签页', true);
  note('正在截取整页…');
  const result = await send({ type: 'bb.capture', mode: 'auto', preview: true, tabId });
  if (!result || !result.ok) return note((result && result.error) || '截图失败', true);
  showPreview(result.dataUrl, result.width, result.height);
  note('截取完成');
});

$('manualStart').addEventListener('click', async () => {
  const tabId = selectedTabId($('tabSelect'));
  if (!tabId) return note('先选一个目标标签页', true);
  const result = await send({ type: 'bb.manual.start', tabId });
  if (!result || !result.ok) return note((result && result.error) || '开始失败', true);
  clearPreview();
  $('manualFrame').disabled = false;
  $('manualStitch').disabled = true;
  $('manualCount').textContent = '0 帧';
  note('已开始：滚到目标位置后点「拍一帧」');
});

$('manualFrame').addEventListener('click', async () => {
  const result = await send({ type: 'bb.manual.frame' });
  if (!result || !result.ok) return note((result && result.error) || '拍帧失败', true);
  $('manualCount').textContent = result.frames + ' 帧';
  $('manualStitch').disabled = false;
  note('已拍第 ' + result.frames + ' 帧（' + result.width + '×' + result.height + '）');
});

$('manualStitch').addEventListener('click', async () => {
  note('正在拼接…');
  const result = await send({ type: 'bb.manual.stitch' });
  if (!result || !result.ok) return note((result && result.error) || '拼接失败', true);
  showPreview(result.dataUrl, result.width, result.height);
  $('manualFrame').disabled = true;
  $('manualStitch').disabled = true;
  note('拼接完成（' + result.frames + ' 帧）');
});

$('save').addEventListener('click', async () => {
  if (!pendingDataUrl) return;
  const result = await send({ type: 'bb.file.save', dataUrl: pendingDataUrl, prefix: 'longshot' });
  if (!result || !result.ok) return note((result && result.error) || '保存失败', true);
  note('已保存：' + result.filename);
});

$('discard').addEventListener('click', () => {
  clearPreview();
  note('已丢弃预览');
});

fillTabSelect($('tabSelect'), preferredTabFromQuery()).then((tabs) => {
});
syncMode();

// ?selftest=1：真实截一次整页；?selftest=restore：从本地分片恢复最新一张（E2E 用）
const selftest = new URLSearchParams(location.search).get('selftest');
if (selftest === 'restore') {
  (async () => {
    try {
      const list = await readManifests();
      if (!list.length) throw new Error('no-manifests');
      const frames = await listLongshot(list[0].id);
      if (!frames.length) throw new Error('no-frames:' + list[0].id);
      const stitched = await stitchFrames(frames);
      document.title = 'SELFTEST:ok:restore:' + list[0].tiles + ':' + stitched.width + 'x' + stitched.height;
    } catch (error) {
      document.title = 'SELFTEST:fail:restore:' + ((error && error.message) || String(error));
    }
  })();
} else if (selftest === '1') {
  (async () => {
    try {
      await fillTabSelect($('tabSelect'), preferredTabFromQuery());
      const tabId = selectedTabId($('tabSelect'));
      const result = await send({ type: 'bb.capture', mode: 'auto', preview: true, tabId });
      document.title = result && result.ok
        ? 'SELFTEST:ok:longshot:' + result.width + 'x' + result.height
        : 'SELFTEST:fail:' + ((result && result.error) || 'unknown');
    } catch (error) {
      document.title = 'SELFTEST:fail:' + ((error && error.message) || error);
    }
  })();
}

// ---------------------------------------------------------------------------
// 深度交互（第十批 E）：分片过滤 / 分页 / 恢复时间线 / 详情 / 键盘 / aria。
// 不改动既有 SELFTEST 契约（restore / 1 两个自测分支完全保持原样）。
// ---------------------------------------------------------------------------
const t = labeler(getLang());
const longshotState = createStateMachine();
const longshotRoving = createRovingModel({ total: 0, wrap: true });
let longshotCache = [];
let longshotFilter = '';
let longshotSort = { key: 'ts', direction: 'desc' };

function longshotStatusNode(kind, error, retry) {
  const model = stateModel(kind, { lang: getLang(), error });
  return h('div', { class: 'state-block ' + kind, role: 'status', 'aria-live': 'polite' }, [
    model.text,
    kind === 'error' && retry ? button({ label: model.retryText || t('state.retry'), on: { click: retry } }) : '',
  ]);
}

function ensureLongshotTools() {
  const tools = $('longshotTools');
  if (!tools || tools.dataset.ready) return;
  tools.dataset.ready = '1';
  const search = document.createElement('input');
  search.type = 'search';
  search.id = 'longshotFilter';
  search.setAttribute('aria-label', t('list.filterHint'));
  search.placeholder = t('list.filterHint');
  search.addEventListener('input', () => { longshotFilter = search.value; applyLongshotView(); });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { search.value = ''; longshotFilter = ''; applyLongshotView(); }
  });
  const timeline = document.createElement('button');
  timeline.type = 'button';
  timeline.className = 'btn';
  timeline.textContent = t('timeline.title');
  timeline.addEventListener('click', () => {
    const node = $('longshotTimeline');
    if (!node) return;
    node.hidden = !node.hidden;
    if (!node.hidden) renderLongshotTimeline();
  });
  tools.append(search, timeline);
}

function applyLongshotView() {
  const list = $('longshotList');
  if (!list) return;
  const manifests = Array.isArray(longshotCache) ? longshotCache : [];
  if (!manifests.length) {
    longshotRoving.setTotal(0);
    longshotState.set('empty');
    if (list) list.hidden = true;
    return;
  }
  const model = buildHistoryView({
    items: manifests.map((item) => ({
      ...item,
      ts: Number(item.createdAt) || 0,
      label: String(item.id || 'longshot'),
      detail: (item.width || '?') + '×' + (item.height || '?') + (item.tiles ? ' · ' + t('longshot.tiles', { count: item.tiles }) : ''),
    })),
    kind: 'longshot',
    lang: getLang(),
    query: longshotFilter,
    sort: longshotSort,
    page: 1,
    pageSize: Math.max(1, manifests.length),
  });
  list.hidden = false;
  list.textContent = '';
  list.setAttribute('role', 'list');
  list.setAttribute('aria-label', t('a11y.list', { count: model.model.filtered }));
  if (!model.model.matching) {
    mount(list, longshotStatusNode('empty'));
    longshotRoving.setTotal(0);
    return;
  }
  longshotRoving.setTotal(model.model.rows.length);
  model.model.rows.forEach((item, index) => {
    const rowNode = document.createElement('div');
    rowNode.className = 'list-row';
    rowNode.setAttribute('role', 'listitem');
    rowNode.setAttribute('aria-label', String(item.label) + ' · ' + String(item.detail));
    const title = document.createElement('span');
    title.className = 'grow truncate mono';
    title.textContent = String(item.id || 'longshot');
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = String(item.detail);
    const restore = document.createElement('button');
    restore.className = 'btn primary';
    restore.textContent = t('longshot.restore');
    restore.setAttribute('aria-label', t('longshot.restore'));
    restore.addEventListener('click', async () => {
      longshotRoving.moveTo(index);
      await restoreManifest(item.id);
    });
    const inspect = document.createElement('button');
    inspect.className = 'btn';
    inspect.textContent = t('longshot.inspect');
    inspect.setAttribute('aria-label', t('longshot.inspect'));
    inspect.addEventListener('click', () => inspectManifest(item, index));
    rowNode.append(title, meta, restore, inspect);
    rowNode.tabIndex = longshotRoving.tabIndexAt(index);
    rowNode.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); inspectManifest(item, index); }
    });
    list.appendChild(rowNode);
  });
  longshotRoving.moveTo(0);
  const pager = $('longshotPager');
  if (pager) {
    setText(pager, t('paging.total', { total: model.model.filtered }) + (longshotFilter ? ' · ' + t('list.filter') : ''));
    pager.setAttribute('role', 'status');
    pager.setAttribute('aria-live', 'polite');
  }
  if ($('longshotTimeline') && !$('longshotTimeline').hidden) renderLongshotTimeline();
}

async function restoreManifest(id) {
  try {
    const frames = await listLongshot(id);
    if (!frames.length) return note('分片已不存在：' + id, true);
    const stitched = await stitchFrames(frames);
    showPreview(stitched.dataUrl, stitched.width, stitched.height);
    note('已恢复 ' + id + '（' + frames.length + ' 帧）');
  } catch (error) {
    note('恢复失败：' + (error && error.message ? error.message : error), true);
  }
}

function inspectManifest(item, index) {
  const list = $('longshotList');
  if (!list) return;
  longshotRoving.moveTo(index);
  for (const existing of list.parentElement.querySelectorAll('[data-longshot-detail]')) existing.remove();
  const detail = h('div', { class: 'detail-panel', role: 'group', 'aria-label': String(item.id || ''), 'data-longshot-detail': '' }, [
    h('div', { class: 'kv-list' }, [
      h('div', { class: 'kv' }, [h('span', { class: 'muted' }, 'id'), h('span', { class: 'mono truncate' }, String(item.id || ''))]),
      h('div', { class: 'kv' }, [h('span', { class: 'muted' }, 'size'), h('span', { class: 'mono' }, (item.width || '?') + '×' + (item.height || '?') + ' px')]),
      h('div', { class: 'kv' }, [h('span', { class: 'muted' }, 'tiles'), h('span', { class: 'mono' }, String(item.tiles || 0))]),
      h('div', { class: 'kv' }, [h('span', { class: 'muted' }, 'createdAt'), h('span', { class: 'mono' }, formatTimestamp(item.createdAt))]),
    ]),
  ]);
  if (list.nextElementSibling) list.parentElement.insertBefore(detail, list.nextElementSibling);
  else list.parentElement.appendChild(detail);
}

function renderLongshotTimeline() {
  const node = $('longshotTimeline');
  if (!node) return;
  const manifests = Array.isArray(longshotCache) ? longshotCache : [];
  const spans = manifests.map((item, index) => ({
    id: String(item.id || index),
    label: String(item.id || 'longshot'),
    start: Number(item.createdAt) || index,
    end: (Number(item.createdAt) || index) + 1,
  }));
  const view = buildTimelineView({ spans, width: Math.max(240, node.clientWidth || 480), lang: getLang(), title: t('timeline.title') });
  mount(node, view.tree);
  node.hidden = view.empty;
}

function bootLongshotEnhancements() {
  ensureLongshotTools();
  applyLongshotView();
  document.addEventListener('keydown', (event) => {
    const intent = resolveEvent(event, { target: event.target });
    if (!intent.handled) return;
    if (intent.intent === 'open-filter') {
      event.preventDefault();
      $('longshotFilter') && $('longshotFilter').focus();
    } else if (intent.intent === 'close') {
      const panel = $('previewPanel');
      if (panel && !panel.hidden) { event.preventDefault(); panel.hidden = true; }
    }
  });
}

const originalRefreshRecovery = refreshRecovery;
refreshRecovery = async function refreshRecoveryEnhanced() {
  try {
    const list = await originalRefreshRecovery();
    longshotCache = Array.isArray(list) ? list : [];
    longshotState.set(longshotCache.length ? 'ready' : 'empty');
    applyLongshotView();
    return longshotCache;
  } catch (error) {
    longshotState.fail(error);
    const list = $('longshotList');
    if (list) {
      list.hidden = false;
      mount(list, longshotStatusNode('error', error, () => { void refreshRecovery(); }));
    }
    return [];
  }
};

fillTabSelect($('tabSelect'), preferredTabFromQuery()).then(() => {
  bootLongshotEnhancements();
  void refreshRecovery();
});

// 第十一批 F：页面导出 / 导入校验工具（只增强；不改上面的 SELFTEST 契约与列表渲染）。
installPageTools({
  surface: 'longshot',
  toolsId: 'longshotTools',
  listId: 'longshotList',
  lang: () => getLang(),
  rows: () => longshotCache,
});
