// src/ui/pages/preview.ts —— 截图预览页：显示 background 暂存的大图（长截图/标注图）。
//
// 为什么用 previewId 而不是把 dataUrl 塞进 URL：长截图 base64 动辄数 MB，URL 长度会被浏览器
// 截断；页面通过 `preview.load` 从 background 的短期缓存（最近 4 张）取图。

import { el, setupPage } from '../page.ts';
import { describeFailure, sendUi } from '../client.ts';

async function main(): Promise<void> {
  const boot = setupPage('preview');
  const previewId = boot.query.get('previewId') || boot.query.get('id') || '';
  const status = el('p', { className: 'muted', id: 'pv-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const stage = el('div', { id: 'pv-stage' });
  document.body.textContent = '';
  document.body.append(
    el('header', {}, [el('h1', { text: '截图预览' }), status]),
    stage,
  );
  if (!previewId) {
    status.textContent = '缺少 previewId（从长截图页或 CLI 打开时带上 ?previewId=…）';
    return;
  }
  const reply = await sendUi<{ dataUrl?: string; width?: number; height?: number }>('preview.load', { previewId });
  if (reply.ok !== true) {
    status.textContent = '加载失败：' + describeFailure(reply as { code?: string; message?: string });
    return;
  }
  const result = reply.result ?? {};
  status.textContent = '尺寸 ' + String(result.width ?? '?') + ' × ' + String(result.height ?? '?');
  if (!result.dataUrl) {
    stage.append(el('p', { className: 'status bad', text: '预览数据为空' }));
    return;
  }
  const image = document.createElement('img');
  image.className = 'preview';
  image.alt = '截图预览';
  image.src = result.dataUrl;
  stage.append(el('div', { className: 'card' }, [image]));
}

void main().catch((error: unknown) => {
  setupPage('preview');
  document.body.textContent = '';
  document.body.append(
    el('h1', { text: '截图预览' }),
    el('p', { className: 'status bad', text: '初始化失败：' + (error instanceof Error ? error.message : String(error)) }),
  );
});
