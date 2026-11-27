// src/ui/pages/record.ts —— 视频录制页（真实 video.* 服务；含 E2E 35/35r 自测）。
//
// 页面是薄壳：
// - 录制/停止/删除走 background 的 bb.ui → VideoService（video.start/stop/discard），不自己造数据；
// - 列表/预览/下载直接读扩展 origin 的 IndexedDB（与 service 同一份 bb-videos 库，Blob 可预览）；
// - ?selftest=1：真实录一段 → 停止 → 读回落库记录 → `SELFTEST:ok:video:<count>:<mp4|webm>:<bytes>`；
// - ?selftest=seed：页面用真实 MediaRecorder 生成一小段视频 → 两片写分片库 →
//   `SELFTEST:ok:seed:<id>:<bytes>:<mp4|webm>`，随后 `bridge video recover` 拼回。
//
// 这里不伪造任何成功标题：任何一步失败都会落到 SELFTEST:fail:*。

import { el, reportSelftest, setupPage } from '../page.ts';
import { describeFailure, requireUi } from '../client.ts';
import { createVideoStore, chunkKey, type StoredChunk, type VideoStore } from '../../video/store.ts';
import { toArrayBuffer } from '../../video/hash.ts';
import { pickVideoMime, containerOfMime } from '../../video/mp4.ts';
import { pickRecordTarget, runRecordSelftest, runSeedSelftest, splitSeedChunks, type SelftestRecordLike } from '../../video/selftest.ts';
import type { VideoRecord } from '../../video/types.ts';

interface TabsApiLike {
  query(queryInfo: Record<string, unknown>): Promise<Array<{ id?: number | null; url?: string; title?: string; lastAccessed?: number }>>;
}

interface RuntimeApiLike {
  getURL(path: string): string;
}

interface BrowserScope {
  tabs?: TabsApiLike;
  runtime?: RuntimeApiLike;
}

function browserScope(): BrowserScope {
  const scope = globalThis as unknown as { browser?: BrowserScope; chrome?: BrowserScope };
  return scope.browser ?? scope.chrome ?? {};
}

function resolveIndexedDb(): IDBFactory | null {
  const factory = (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB;
  return factory && typeof factory.open === 'function' ? factory : null;
}

const store: VideoStore = createVideoStore({ indexedDb: resolveIndexedDb() });

function formatBytes(value: number): string {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function formatTime(ts: number): string {
  const date = new Date(Number(ts) || Date.now());
  const pad = (n: number): string => String(n).padStart(2, '0');
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

function detailOf(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

// ---------------------------------------------------------------------------
// selftest=seed 用的真实短视频生成（canvas.captureStream + MediaRecorder）
// ---------------------------------------------------------------------------

async function recordSeedClip(ms: number): Promise<{ bytes: Uint8Array; mime: string }> {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('拿不到 canvas 2d 上下文');
  let frame = 0;
  const timer = setInterval(() => {
    context.fillStyle = 'hsl(' + ((frame * 37) % 360) + ',70%,50%)';
    context.fillRect(0, 0, canvas.width, canvas.height);
    frame += 1;
  }, 100);
  const stream = canvas.captureStream(10);
  const mime = pickVideoMime((candidate) => MediaRecorder.isTypeSupported(candidate));
  if (!mime) {
    clearInterval(timer);
    throw new Error('浏览器不支持可用的视频编码');
  }
  const parts: Blob[] = [];
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 200_000 });
  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data && event.data.size > 0) parts.push(event.data);
  };
  recorder.start(200);
  try {
    await new Promise<void>((resolve) => { setTimeout(resolve, Math.max(100, ms)); });
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      if (recorder.state !== 'inactive') recorder.stop();
      else resolve();
    });
  } finally {
    clearInterval(timer);
    for (const track of stream.getTracks()) {
      try { track.stop(); } catch { /* 忽略 */ }
    }
  }
  const blob = new Blob(parts, { type: mime });
  if (!blob.size) throw new Error('没有录到任何分片');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime };
}

async function saveSeedChunks(input: { recordingId: string; bytes: Uint8Array; mime: string; startedAt: number }): Promise<void> {
  const meta = {
    recordingId: input.recordingId,
    tabId: 0,
    url: 'e2e://recover',
    title: 'recover drill',
    startedAt: input.startedAt,
    mime: input.mime,
  };
  const chunks: StoredChunk[] = splitSeedChunks(input.bytes).map((part) => ({
    key: chunkKey(input.recordingId, part.index),
    recordingId: input.recordingId,
    index: part.index,
    at: input.startedAt,
    meta,
    blob: new Blob([toArrayBuffer(part.data)], { type: input.mime }),
  }));
  await store.putChunks(chunks);
}

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const boot = setupPage('record');
  const query = boot.query;
  const preferredTabId = (() => {
    const raw = query.get('tab');
    return raw && /^\d+$/.test(raw) ? Number(raw) : null;
  })();

  const tabsApi = browserScope().tabs ?? null;
  const selfPrefix = browserScope().runtime?.getURL?.('') ?? '';
  let currentRecordingId = '';
  let previewUrl: string | null = null;

  const status = el('p', { className: 'muted', id: 'rec-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const backendNote = el('p', { className: 'muted', id: 'rec-backend', text: '存储后端：' + (store.backend === 'indexeddb' ? 'IndexedDB（持久化）' : '内存兜底（刷新即丢，如实标注）') });
  const targetSelect = el('select', { id: 'rec-target', attrs: { 'aria-label': '目标标签页' } });
  const startButton = el('button', { className: 'primary', attrs: { type: 'button', id: 'rec-start' }, text: '开始录制' });
  const stopButton = el('button', { attrs: { type: 'button', id: 'rec-stop', disabled: '' }, text: '停止' });
  const refreshButton = el('button', { attrs: { type: 'button', id: 'rec-refresh' }, text: '刷新列表' });
  const listNode = el('div', { className: 'list', id: 'rec-list' });
  const previewWrap = el('div', { className: 'card', attrs: { id: 'rec-preview-wrap', hidden: '' } }, [
    el('p', { className: 'muted', id: 'rec-preview-title' }),
    el('video', { className: 'preview', attrs: { id: 'rec-preview', controls: 'controls', width: '320' } }),
  ]);
  const previewVideo = previewWrap.querySelector('video');

  function note(text: string, kind: 'ok' | 'bad' | 'muted' = 'muted'): void {
    status.className = kind === 'bad' ? 'status bad' : (kind === 'ok' ? 'status ok' : 'muted');
    status.textContent = text;
  }

  async function fillTargets(): Promise<number | null> {
    if (!tabsApi) {
      note('页面拿不到 chrome.tabs（无法选择目标标签页）', 'bad');
      return null;
    }
    let tabs: Array<{ id?: number | null; url?: string; title?: string; lastAccessed?: number }> = [];
    try {
      tabs = await tabsApi.query({});
    } catch (error) {
      note('读取标签页失败：' + detailOf(error), 'bad');
      return null;
    }
    const chosen = pickRecordTarget(tabs, { selfPrefix, preferredTabId });
    const usable = tabs
      .filter((tab) => Number.isInteger(Number(tab.id)) && Number(tab.id) >= 0)
      .filter((tab) => {
        const url = String(tab.url ?? '');
        if (!url || (selfPrefix && url.startsWith(selfPrefix))) return false;
        return !/^(chrome|edge|about|devtools|view-source|moz-extension):/i.test(url);
      })
      .sort((a, b) => (Number(b.lastAccessed) || 0) - (Number(a.lastAccessed) || 0));
    targetSelect.textContent = '';
    if (!usable.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '没有可用的标签页（先打开一个普通网页）';
      targetSelect.appendChild(option);
      return null;
    }
    for (const tab of usable) {
      const option = document.createElement('option');
      option.value = String(tab.id);
      option.textContent = String(tab.title || tab.url || '标签页').slice(0, 70);
      targetSelect.appendChild(option);
    }
    targetSelect.value = String(chosen ?? usable[0]?.id ?? '');
    return chosen ?? usable[0]?.id ?? null;
  }

  function selectedTabId(): number | null {
    const value = targetSelect.value;
    return value && /^\d+$/.test(value) ? Number(value) : null;
  }

  async function records(): Promise<VideoRecord[]> {
    try {
      return (await store.listRecords()).sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0));
    } catch (error) {
      note('读取录制列表失败：' + detailOf(error), 'bad');
      return [];
    }
  }

  function stopPreview(): void {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      previewUrl = null;
    }
    try { previewVideo?.removeAttribute('src'); } catch { /* 忽略 */ }
    previewWrap.hidden = true;
  }

  function showPreview(record: VideoRecord): void {
    if (!(record.blob instanceof Blob)) return;
    stopPreview();
    previewUrl = URL.createObjectURL(record.blob);
    if (previewVideo) {
      previewVideo.setAttribute('src', previewUrl);
      try { void (previewVideo as HTMLVideoElement).play().catch(() => {}); } catch { /* 忽略 */ }
    }
    const titleNode = previewWrap.querySelector('#rec-preview-title');
    if (titleNode) titleNode.textContent = (record.title || record.url || record.id) + ' · ' + record.mime + ' · ' + formatBytes(record.bytes);
    previewWrap.hidden = false;
  }

  function download(record: VideoRecord): void {
    if (!(record.blob instanceof Blob)) return;
    const url = URL.createObjectURL(record.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'bridgedeck-' + record.id.slice(0, 8) + '.' + containerOfMime(record.mime);
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function discard(record: VideoRecord): Promise<void> {
    const reply = await requireUi('video.discard', { recording: record.id }).catch((error: unknown) => {
      note('删除失败：' + detailOf(error), 'bad');
      return null;
    });
    if (reply === null) return;
    if (currentRecordingId === record.id) {
      currentRecordingId = '';
      stopButton.setAttribute('disabled', '');
    }
    note('已删除录制 ' + record.id.slice(0, 8), 'ok');
    await refreshList();
  }

  function renderList(rows: VideoRecord[]): void {
    listNode.textContent = '';
    if (!rows.length) {
      listNode.append(el('p', { className: 'muted', text: '暂无录制（点“开始录制”真实录一段）' }));
      return;
    }
    for (const record of rows) {
      const row = el('div', { className: 'row', attrs: { 'data-recording-id': record.id } }, [
        el('strong', { text: (record.title || record.url || '录制').slice(0, 40) }),
        el('span', { className: 'muted', text: String(record.mime).includes('mp4') ? 'MP4' : 'WebM' }),
        el('span', { className: 'muted', text: formatBytes(record.bytes) }),
        el('span', { className: 'muted', text: formatTime(record.startedAt) }),
        el('span', { className: 'muted', text: record.completeness + '/' + record.stop_reason }),
      ]);
      const view = el('button', { attrs: { type: 'button' }, text: '预览' });
      view.addEventListener('click', () => showPreview(record));
      const save = el('button', { attrs: { type: 'button' }, text: '下载' });
      save.addEventListener('click', () => download(record));
      const del = el('button', { attrs: { type: 'button', className: 'danger' }, text: '删除' });
      del.addEventListener('click', () => { void discard(record); });
      row.append(view, save, del);
      listNode.append(row);
    }
  }

  async function refreshList(): Promise<void> {
    renderList(await records());
  }

  async function refreshStatus(): Promise<void> {
    const reply = await requireUi<{ active?: boolean; state?: string; recordingId?: string; startedAt?: number; mime?: string }>('video.status', {}).catch(() => null);
    if (!reply) {
      note('后台不可用：video.status 未注册或未连接', 'bad');
      return;
    }
    if (reply.active === true) {
      currentRecordingId = String(reply.recordingId ?? '');
      startButton.setAttribute('disabled', '');
      stopButton.removeAttribute('disabled');
      note('录制中 · ' + (currentRecordingId ? currentRecordingId.slice(0, 8) : '') + ' · ' + (String(reply.mime).includes('mp4') ? 'MP4' : 'WebM'), 'ok');
    } else {
      currentRecordingId = '';
      startButton.removeAttribute('disabled');
      stopButton.setAttribute('disabled', '');
      note(reply.state === 'none' ? '未开始' : '就绪（最近录制已落库）');
    }
  }

  startButton.addEventListener('click', () => {
    void (async () => {
      const tabId = selectedTabId();
      if (tabId === null) {
        note('先选一个目标标签页（或先打开一个普通网页）', 'bad');
        return;
      }
      startButton.setAttribute('disabled', '');
      note('正在启动录制…');
      const reply = await requireUi<{ recordingId?: string; mime?: string; mode?: string }>('video.start', { tabId }).catch((error: unknown) => {
        note('开始录制失败：' + detailOf(error), 'bad');
        startButton.removeAttribute('disabled');
        return null;
      });
      if (!reply) return;
      currentRecordingId = String(reply.recordingId ?? '');
      stopButton.removeAttribute('disabled');
      note('开始录制（' + (String(reply.mime).includes('mp4') ? 'MP4' : 'WebM') + '，' + String(reply.mode ?? '') + '）', 'ok');
    })();
  });

  stopButton.addEventListener('click', () => {
    void (async () => {
      stopButton.setAttribute('disabled', '');
      note('正在停止并写入文件…');
      const reply = await requireUi<{ bytes?: number; mime?: string }>('video.stop', { recording: currentRecordingId }).catch((error: unknown) => {
        note('停止录制失败：' + detailOf(error), 'bad');
        return null;
      });
      currentRecordingId = '';
      startButton.removeAttribute('disabled');
      if (reply) {
        note('已停止：' + formatBytes(Number(reply.bytes) || 0) + '（' + (String(reply.mime).includes('mp4') ? 'MP4' : 'WebM') + '）', 'ok');
        await refreshList();
      }
    })();
  });

  refreshButton.addEventListener('click', () => { void refreshList(); });

  // 画页面（真实控件；数据全部来自后台服务/IndexedDB）。
  document.body.textContent = '';
  document.body.append(
    el('header', {}, [
      el('h1', { text: boot.t('record') }),
      el('p', { className: 'muted', text: '把标签页录成 MP4/WebM：tabCapture + WebCodecs 编码（faststart 真实检测），崩溃后可扫描分片恢复' }),
    ]),
    el('div', { className: 'card' }, [
      el('div', { className: 'row' }, [
        el('label', { attrs: { for: 'rec-target' }, text: boot.t('targetTab') + '：' }),
        targetSelect,
        startButton,
        stopButton,
        refreshButton,
      ]),
      status,
      backendNote,
    ]),
    el('div', { className: 'card' }, [
      el('h2', { text: '录制列表' }),
      listNode,
    ]),
    previewWrap,
  );

  await fillTargets();
  await refreshList();
  await refreshStatus();

  const selftest = query.get('selftest');
  if (selftest === '1') {
    void (async () => {
      try {
        const detail = await runRecordSelftest({
          pickTargetTab: async () => pickRecordTarget(tabsApi ? await tabsApi.query({}) : [], { selfPrefix, preferredTabId }),
          start: (params) => requireUi<{ recordingId?: string; mime?: string; mode?: string }>('video.start', { ...params }),
          stop: (params) => requireUi('video.stop', { ...params }),
          status: (recordingId) => requireUi<{ active?: boolean; state?: string }>('video.status', { recording: recordingId }),
          inspectRecord: async (recordingId) => {
            const record = await store.getRecord(recordingId);
            if (!record) throw new Error('录制没有落库：' + recordingId);
            const magic = new Uint8Array(await record.blob.slice(0, 8).arrayBuffer());
            const container = magic.length >= 8 && String.fromCharCode(magic[4] ?? 0, magic[5] ?? 0, magic[6] ?? 0, magic[7] ?? 0) === 'ftyp'
              ? 'mp4'
              : (magic[0] === 0x1a && magic[1] === 0x45 ? 'webm' : 'unknown');
            return { bytes: record.bytes, container };
          },
          listRecords: async (): Promise<SelftestRecordLike[]> => (await store.listRecords()).map((record) => ({
            id: record.id,
            mime: record.mime,
            bytes: record.bytes,
            startedAt: record.startedAt,
            endedAt: record.endedAt,
          })),
          sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
        });
        reportSelftest('video', detail, true);
      } catch (error) {
        reportSelftest('video', detailOf(error), false);
      }
    })();
  } else if (selftest === 'seed') {
    void (async () => {
      try {
        const detail = await runSeedSelftest({
          recordClip: (options) => recordSeedClip(options.ms),
          saveChunks: (input) => saveSeedChunks(input),
          now: () => Date.now(),
        });
        reportSelftest('seed', detail, true);
      } catch (error) {
        reportSelftest('seed', detailOf(error), false);
      }
    })();
  }

  // 页面按钮的失败信封也进状态栏（便于人工排查）。
  window.addEventListener('unhandledrejection', (event) => {
    note('未处理异常：' + describeFailure({ message: detailOf(event.reason) }), 'bad');
  });
}

void main().catch((error: unknown) => {
  setupPage('record');
  document.body.textContent = '';
  document.body.append(
    el('h1', { text: '视频录制' }),
    el('p', { className: 'status bad', text: '初始化失败：' + detailOf(error) }),
  );
});
