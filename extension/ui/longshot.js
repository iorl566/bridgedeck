// ui/longshot.js —— 长截图：自动滚动 / 手动拼接 + 预览保存
import { back, fillTabSelect, preferredTabFromQuery, selectedTabId } from './tab-picker.js';

const $ = (id) => document.getElementById(id);

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

// ?selftest=1：真实截一次整页，结果写进标题（E2E 用）
if (new URLSearchParams(location.search).get('selftest') === '1') {
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
