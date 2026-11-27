// src/ui/pages/longshot.ts —— 长截图页：目标选择、整页采集、预览、本地分片恢复。
//
// 与 background 的分工：
// - 采集/拼接/固定带重绘/落盘全在 `LongshotCapture`（src/capture/longshot.ts）；
// - 本页只发 `capture` / `longshot.recover` / `longshot.list` 三个 bb.ui op 并渲染结果；
// - `?selftest=1`：对"最近活跃的目标标签页"真实截一次整页，把尺寸写进标题；
// - `?selftest=restore`：从本地分片恢复最近一张（`<tiles>:<w>x<h>` 写进标题）。

import { el, reportSelftest, setupPage } from '../page.ts';
import { describeFailure, requireUi, sendUi } from '../client.ts';

interface TabInfo {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
}

interface CaptureResult {
  dataUrl?: string;
  width?: number;
  height?: number;
  tiled?: number;
  dpr?: number;
  fixedTop?: number;
  fixedFooter?: number;
  fixedBands?: number;
  stale?: boolean;
  stale_attempts?: number;
  segmented?: boolean;
  segment_count?: number;
  longshot_id?: string;
  tiles_persisted?: number;
  via?: string;
}

interface RecoverResult {
  dataUrl?: string;
  width?: number;
  height?: number;
  tiles?: number;
  recovered?: boolean;
  complete?: boolean;
  longshotId?: string;
}

function preview(dataUrl: string | undefined, width: unknown, height: unknown): HTMLElement {
  if (!dataUrl) return el('p', { className: 'muted', text: '（没有可显示的图片）' });
  const image = document.createElement('img');
  image.className = 'preview';
  image.alt = '整页长截图预览';
  image.src = dataUrl;
  return el('div', { className: 'card' }, [
    el('p', { className: 'muted', text: String(width ?? '?') + ' × ' + String(height ?? '?') }),
    image,
  ]);
}

async function loadTabs(select: HTMLSelectElement): Promise<TabInfo[]> {
  const reply = await sendUi<{ tabs?: TabInfo[] }>('tabs', {});
  const tabs = (reply.ok === true ? reply.result?.tabs : []) ?? [];
  select.textContent = '';
  if (!tabs.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = '没有可用的网页标签页';
    select.append(option);
    return [];
  }
  for (const tab of tabs) {
    const option = document.createElement('option');
    option.value = String(tab.tabId);
    option.textContent = (tab.title || tab.url || '标签页').slice(0, 70);
    if (tab.active) option.selected = true;
    select.append(option);
  }
  return tabs;
}

async function main(): Promise<void> {
  const boot = setupPage('longshot');
  const query = boot.query;
  const selftest = query.get('selftest');

  const select = document.createElement('select');
  select.id = 'ls-tab';
  select.setAttribute('aria-label', '目标标签页');
  const status = el('p', { className: 'muted', id: 'ls-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const resultBox = el('div', { id: 'ls-result' });
  const listBox = el('div', { id: 'ls-list' });

  const capture = async (tabId: number): Promise<CaptureResult> => {
    const reply = await requireUi('capture', { tabId, fullPage: true, segmented: false });
    return reply as unknown as CaptureResult;
  };

  const captureButton = el('button', {
    className: 'primary',
    attrs: { type: 'button', id: 'ls-capture', 'aria-label': '开始整页截图' },
    text: '开始截图',
  });
  const restoreButton = el('button', {
    attrs: { type: 'button', id: 'ls-restore', 'aria-label': '恢复最近一张长截图' },
    text: '恢复最近一张',
  });
  const refreshButton = el('button', {
    attrs: { type: 'button', id: 'ls-refresh', 'aria-label': '刷新本地分片列表' },
    text: '刷新分片',
  });

  document.body.textContent = '';
  document.body.append(
    el('header', {}, [
      el('h1', { text: '长截图' }),
      el('p', { className: 'muted', text: '滚动分段采集 + 拼接 + 固定顶/底带重绘（captureVisibleTab，无 CDP）' }),
    ]),
    el('div', { className: 'card' }, [
      el('div', { className: 'row' }, [el('span', { text: '目标标签页' }), select]),
      el('div', { className: 'row' }, [captureButton, restoreButton, refreshButton]),
      status,
    ]),
    resultBox,
    el('h2', { text: '本地分片（可恢复）' }),
    listBox,
  );

  const refreshList = async (): Promise<void> => {
    const reply = await sendUi<{ longshots?: Array<Record<string, unknown>>; backend?: string }>('longshot.list', {});
    listBox.textContent = '';
    if (reply.ok !== true) {
      listBox.append(el('p', { className: 'status bad', text: describeFailure(reply as { code?: string; message?: string }) }));
      return;
    }
    const longshots = reply.result?.longshots ?? [];
    listBox.append(el('p', { className: 'muted', text: '存储后端：' + String(reply.result?.backend ?? '?') + ' · ' + String(longshots.length) + ' 张' }));
    if (!longshots.length) {
      listBox.append(el('p', { className: 'muted', text: '暂无分片（先截一张）' }));
      return;
    }
    const list = el('ul', { className: 'list' });
    for (const item of longshots) {
      list.append(el('li', {
        text: String(item.id) + ' · ' + String(item.width) + '×' + String(item.height) + ' · ' +
          String(item.tiles) + ' 段 · ' + (item.sealed ? '已封版' : '未封版'),
      }));
    }
    listBox.append(list);
  };

  captureButton.addEventListener('click', () => {
    void (async () => {
      const tabId = Number(select.value);
      if (!Number.isInteger(tabId) || tabId <= 0) {
        status.textContent = boot.t('selectTab');
        return;
      }
      status.textContent = '正在采集整页…（滚动分段，可能需要数秒）';
      const reply = await sendUi<CaptureResult>('capture', { tabId, fullPage: true });
      if (reply.ok !== true) {
        status.textContent = '截图失败：' + describeFailure(reply as { code?: string; message?: string });
        return;
      }
      const result = reply.result ?? {};
      status.textContent = '完成：' + String(result.width) + '×' + String(result.height) +
        ' · ' + String(result.tiled) + ' 帧 · 顶带 ' + String(result.fixedTop ?? 0) + ' / 底带 ' + String(result.fixedFooter ?? 0) +
        (result.longshot_id ? ' · id ' + String(result.longshot_id).slice(0, 8) : '');
      resultBox.textContent = '';
      resultBox.append(preview(result.dataUrl, result.width, result.height));
      await refreshList();
    })();
  });

  restoreButton.addEventListener('click', () => {
    void (async () => {
      status.textContent = '正在从本地分片恢复…';
      const reply = await sendUi<RecoverResult>('longshot.recover', {});
      if (reply.ok !== true) {
        status.textContent = '恢复失败：' + describeFailure(reply as { code?: string; message?: string });
        return;
      }
      const result = reply.result ?? {};
      status.textContent = '已恢复 ' + String(result.tiles) + ' 段（' + (result.complete ? '完整' : '缺段') + '）';
      resultBox.textContent = '';
      resultBox.append(preview(result.dataUrl, result.width, result.height));
    })();
  });

  refreshButton.addEventListener('click', () => {
    void refreshList();
  });

  await loadTabs(select);
  await refreshList().catch(() => undefined);

  if (selftest === 'restore') {
    try {
      const reply = await requireUi<RecoverResult>('longshot.recover', {});
      const result = reply as unknown as RecoverResult;
      if (!result.dataUrl) throw new Error('恢复结果没有图片');
      reportSelftest('restore', String(result.tiles ?? 0) + ':' + String(result.width) + 'x' + String(result.height));
    } catch (error) {
      reportSelftest('restore', error instanceof Error ? error.message : String(error), false);
    }
    return;
  }
  if (selftest === '1') {
    try {
      const tabId = Number(select.value);
      if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('没有可截图的目标标签页');
      const result = await capture(tabId);
      if (!result.width || !result.height) throw new Error('截图结果没有尺寸');
      reportSelftest('longshot', String(result.width) + 'x' + String(result.height));
    } catch (error) {
      reportSelftest('longshot', error instanceof Error ? error.message : String(error), false);
    }
  }
}

void main().catch((error: unknown) => {
  setupPage('longshot');
  document.body.textContent = '';
  document.body.append(
    el('h1', { text: '长截图' }),
    el('p', { className: 'status bad', text: '初始化失败：' + (error instanceof Error ? error.message : String(error)) }),
  );
});
