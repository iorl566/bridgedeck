// src/ui/pages/ops.ts —— 操作录制页（record.* 运行时：真实开始/停止/列表/导出）。
//
// 与 background 的分工：
// - 录制/导出/落库全部在 `RecordService`（src/record/service.ts，background 注册）；
// - 本页只发 `bb.record.start/stop/list/export/status` 页面消息并渲染结果，不重算计数；
// - 目标标签页列表复用 `bb.ui` 的 `tabs` op（已排除扩展页/浏览器内部页）；
// - `?selftest=1`：真实开始 → 在目标页面真实点一下 → 停止 → 读持久化 → 标题写
//   `SELFTEST:ok:ops:<recordings>:<events>`（E2E 32）；失败写 fail + 原因。

import { el, reportSelftest, setupPage } from '../page.ts';
import { describeFailure, sendUi } from '../client.ts';
import { sendRecordMessage, type RecordPageOp } from '../../record/messages.ts';
import { runOpsSelftest } from '../../record/ops-selftest.ts';

interface TabInfo {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
  windowId?: number | null;
}

interface RecordingSummary {
  id: string;
  url?: string;
  title?: string;
  startedAt?: number;
  endedAt?: number;
  events?: number;
  kinds?: Record<string, number>;
}

interface RecordStatus {
  active?: Array<{ tabId: number; events: number; startedAt: number }>;
  backend?: string;
}

function formatTime(ts: unknown): string {
  const value = Number(ts);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

/** 页面侧调用 record.* 消息（失败抛错；自测把错误变成 fail 标题）。 */
async function requireRecord<T extends object>(op: RecordPageOp, params: Record<string, unknown> = {}): Promise<T> {
  const reply = await sendRecordMessage<T>(op, params);
  if (reply.ok !== true) {
    const failure = reply as { code?: string; message?: string; data?: unknown };
    const error = new Error(describeFailure(failure));
    (error as Error & { code?: string }).code = failure.code;
    throw error;
  }
  return (reply.result ?? {}) as T;
}

/** 在目标页面真实点一下（#submit-btn 优先；没有就点 body 兜底，保证有真实事件）。 */
async function clickTargetPage(tabId: number): Promise<boolean> {
  const scripting = (globalThis as unknown as {
    chrome?: { scripting?: { executeScript(options: Record<string, unknown>): Promise<unknown> } };
  }).chrome?.scripting;
  if (!scripting || typeof scripting.executeScript !== 'function') return false;
  try {
    await scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => {
        const button = document.getElementById('submit-btn');
        if (button) {
          (button as HTMLElement).click();
          return;
        }
        const body = document.body;
        if (body) body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      },
    });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const boot = setupPage('ops');
  const selftest = boot.query.get('selftest');

  const select = document.createElement('select');
  select.id = 'ops-tab';
  select.setAttribute('aria-label', '目标标签页');
  const status = el('p', { className: 'muted', id: 'ops-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const listBox = el('div', { id: 'ops-list' });

  const selectedTab = (): number => Number(select.value);

  const renderList = async (): Promise<number> => {
    listBox.textContent = '';
    try {
      const listed = await requireRecord<{ recordings?: RecordingSummary[]; backend?: string; total?: number }>('list', { includeEvents: false });
      const recordings = listed.recordings ?? [];
      listBox.append(el('h2', { text: '历史录制（' + String(recordings.length) + '）' }));
      listBox.append(el('p', { className: 'muted', text: '存储后端：' + String(listed.backend ?? '?') }));
      if (!recordings.length) {
        listBox.append(el('p', { className: 'muted', text: '暂无录制（先开始录制并在页面上操作）' }));
        return 0;
      }
      const list = el('ul', { className: 'list' });
      for (const recording of recordings.slice(0, 20)) {
        list.append(el('li', {
          text: formatTime(recording.startedAt) + ' · ' + String(recording.events ?? 0) + ' 条 · ' +
            (recording.title || recording.url || '录制').slice(0, 80),
        }));
      }
      listBox.append(list);
      return recordings.length;
    } catch (error) {
      listBox.append(el('p', { className: 'status bad', text: '读取历史失败：' + (error instanceof Error ? error.message : String(error)) }));
      return 0;
    }
  };

  const refreshStatus = async (): Promise<void> => {
    const [stateReply, recordReply] = await Promise.all([
      sendUi<{ status?: { version?: string }; settings?: Record<string, unknown> }>('state', {}),
      sendRecordMessage<RecordStatus>('status', {}),
    ]);
    const parts: string[] = [];
    if (stateReply.ok === true) {
      parts.push('后台可用 · 版本 ' + String(stateReply.result?.status?.version ?? '?'));
    } else {
      parts.push('后台不可用：' + describeFailure(stateReply as { code?: string; message?: string }));
    }
    if (recordReply.ok === true) {
      const record = recordReply.result ?? {};
      const active = record.active ?? [];
      parts.push(active.length
        ? '录制中：' + active.map((item) => 'tab ' + item.tabId + '（' + item.events + ' 条）').join('，')
        : '未在录制');
      parts.push('存储：' + String(record.backend ?? '?'));
    } else {
      parts.push('record 服务：' + describeFailure(recordReply as { code?: string; message?: string }));
    }
    status.textContent = parts.join(' · ');
  };

  const actionButton = (id: string, label: string, onClick: () => void): HTMLButtonElement => {
    const button = el('button', { attrs: { type: 'button', id, 'aria-label': label }, text: label });
    button.addEventListener('click', onClick);
    return button;
  };

  const startButton = actionButton('ops-start', '开始录制', () => {
    void (async () => {
      const tabId = selectedTab();
      if (!Number.isInteger(tabId) || tabId <= 0) {
        status.textContent = '先选择一个目标标签页';
        return;
      }
      try {
        const result = await requireRecord<{ tabId?: number; captureFrames?: number }>('start', { tabId });
        status.textContent = '已开始录制（tab ' + String(result.tabId ?? tabId) + '，已注入 ' + String(result.captureFrames ?? 0) + ' 个 frame）';
      } catch (error) {
        status.textContent = '开始失败：' + (error instanceof Error ? error.message : String(error));
      }
      await refreshStatus();
    })();
  });

  const stopButton = actionButton('ops-stop', '停止录制', () => {
    void (async () => {
      const tabId = selectedTab();
      try {
        const result = await requireRecord<{ recording?: { events?: number } }>('stop', { tabId });
        status.textContent = '已停止：' + String(result.recording?.events ?? 0) + ' 条事件已保存';
      } catch (error) {
        status.textContent = '停止失败：' + (error instanceof Error ? error.message : String(error));
      }
      await refreshStatus();
      await renderList();
    })();
  });

  const refreshButton = actionButton('ops-refresh', '刷新', () => {
    void (async () => {
      await refreshStatus();
      await renderList();
    })();
  });

  document.body.textContent = '';
  document.body.append(
    el('header', {}, [
      el('h1', { text: '操作录制' }),
      el('p', { className: 'muted', text: '把人工操作记录成 step 模型，可导出 Trace v3（states + 截图引用）' }),
    ]),
    el('div', { className: 'card' }, [
      el('div', { className: 'row' }, [el('span', { text: '目标标签页' }), select]),
      el('div', { className: 'row' }, [startButton, stopButton, refreshButton]),
      status,
    ]),
    el('div', { className: 'card' }, [listBox]),
  );

  // 目标标签页：来自 bb.ui 的 tabs（background 已排除扩展页/内部页，active 优先）。
  try {
    const tabsReply = await sendUi<{ tabs?: TabInfo[] }>('tabs', {});
    const tabs = (tabsReply.ok === true ? tabsReply.result?.tabs : []) ?? [];
    select.textContent = '';
    for (const tab of tabs) {
      const option = document.createElement('option');
      option.value = String(tab.tabId);
      option.textContent = (tab.title || tab.url || '标签页').slice(0, 70);
      if (tab.active) option.selected = true;
      select.append(option);
    }
    if (!tabs.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '没有可录制的网页标签页';
      select.append(option);
    }
  } catch {
    // 目标列表失败不影响自测（自测会给出结构化失败）
  }

  await refreshStatus().catch(() => undefined);
  await renderList().catch(() => undefined);

  if (selftest === '1') {
    try {
      const result = await runOpsSelftest({
        tabs: async () => {
          const reply = await sendUi<{ tabs?: TabInfo[] }>('tabs', {});
          return reply.ok === true ? (reply.result?.tabs ?? []) : [];
        },
        start: (params) => requireRecord<{ tabId?: number; startedAt?: number }>('start', params),
        stop: (params) => requireRecord<{ recording?: { id?: string; events?: number } }>('stop', params),
        list: (params) => requireRecord<{ recordings?: Array<{ id?: string; events?: unknown }> }>('list', params ?? {}),
        clickPage: clickTargetPage,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
      status.textContent = '自测完成：' + String(result.recordings) + ' 条录制 / ' + String(result.events) + ' 条事件';
      reportSelftest('ops', String(result.recordings) + ':' + String(result.events));
      await refreshStatus();
      await renderList();
    } catch (error) {
      reportSelftest('ops', error instanceof Error ? error.message : String(error), false);
    }
  }
}

void main().catch((error: unknown) => {
  setupPage('ops');
  document.body.textContent = '';
  document.body.append(
    el('h1', { text: '操作录制' }),
    el('p', { className: 'status bad', text: '初始化失败：' + (error instanceof Error ? error.message : String(error)) }),
  );
});
