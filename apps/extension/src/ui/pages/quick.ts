// src/ui/pages/quick.ts —— 快捷功能页：5 个入口（长截图 / 网站调试 / 视频录制 / 操作录制 / 操作审计）。
//
// 入口本身就是"打开对应子页面"：扩展页面之间用 `chrome.tabs.create(runtime.getURL(...))`，
// 不走 `ui.open`（那需要 daemon，而快捷功能页要能在**离线**时也打开子页面）。

import { UI_PAGES } from '../catalog.ts';
import { el, setupPage, uiTitle, describeValue } from '../page.ts';

interface Entry {
  page: string;
  label: string;
  hint: string;
}

function runtimeUrl(path: string): string {
  try {
    const runtime = (globalThis as unknown as { chrome?: { runtime?: { getURL?(path: string): string } } }).chrome?.runtime;
    if (runtime && typeof runtime.getURL === 'function') return runtime.getURL(path);
  } catch {
    // 忽略：回退相对路径
  }
  return path;
}

async function openPage(path: string): Promise<void> {
  try {
    const tabs = (globalThis as unknown as { chrome?: { tabs?: { create(props: Record<string, unknown>): Promise<unknown> } } }).chrome?.tabs;
    if (tabs && typeof tabs.create === 'function') {
      await tabs.create({ url: runtimeUrl(path), active: true });
      return;
    }
  } catch {
    // 回退到 location 跳转
  }
  location.href = runtimeUrl(path);
}

function main(): void {
  const boot = setupPage('quick');
  const entries: Entry[] = [
    { page: 'longshot.html', label: '长截图', hint: '整页滚动拼接、固定带重绘、本地分片恢复' },
    { page: 'debug.html', label: '网站调试', hint: '请求与 console 采集、规则面板、性能指标' },
    { page: 'record.html', label: '视频录制', hint: '把标签页录成 MP4/WebM（运行时未迁移）' },
    { page: 'ops.html', label: '操作录制', hint: '记录人工操作步骤（运行时未迁移）' },
    { page: 'audit.html', label: '操作审计', hint: 'daemon 审计日志只读视图' },
  ];
  document.body.textContent = '';
  const header = el('header', {}, [
    el('h1', { text: uiTitle(boot.language, 'quick') }),
    el('p', { className: 'muted', text: 'BridgeDeck · ' + String(entries.length) + ' ' + boot.t('entries') }),
  ]);
  const grid = el('div', { className: 'grid' });
  for (const entry of entries) {
    const definition = UI_PAGES.find((page) => page.path === entry.page);
    const available = definition ? definition.available : false;
    const button = el('button', {
      className: 'feature',
      attrs: { type: 'button', 'data-page': entry.page },
      onClick: () => {
        void openPage(entry.page);
      },
    }, [
      el('strong', { text: entry.label }),
      el('span', { className: 'muted', text: entry.hint }),
      el('span', {
        className: 'muted',
        text: available ? '' : '（' + describeValue(definition?.requires.join(',') ?? '') + ' 未迁移）',
      }),
    ]);
    grid.append(button);
  }
  document.body.append(header, grid);
}

main();
