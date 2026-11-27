// src/ui/pages/debug.ts —— 网站调试页：采集会话、请求/console 面板、规则面板、性能指标、请求重放。
//
// 全部数据来自 background 的 debug/network 只读域（console 钩子 + PerformanceResourceTiming，
// 无 CDP；重放走 `network.replay` 的页面 MAIN world fetch）。页面只做渲染与事件，
// 不在页面里重算业务结果。
// 自测（E2E 用）：
// - `?selftest=1`     ：真实采集一次，标题写 `<requests>:<console>`；
// - `?selftest=rules` ：规则添加 → 列出 → 清空，标题写规则数；
// - `?selftest=perf`  ：读性能指标，标题写指标键数；
// - `?selftest=replay`：debug.start 采集一次 → 从采集结果挑一条真实请求 →
//                       `network.replay` 在主世界重放 → 标题写响应 status（200 才算 ok）。

import { el, reportSelftest, setupPage } from '../page.ts';
import { describeFailure, requireUi, sendUi } from '../client.ts';

interface TabInfo {
  tabId: number;
  url: string;
  title: string;
  active: boolean;
}

/** 调试采集里的一条请求（CDP recorder / 资源计时两种来源的并集，只取页面用到的字段）。 */
interface DebugRequestEntry {
  id?: number | string | null;
  requestId?: string | null;
  url?: string | null;
  method?: string | null;
  status?: number | null;
  durationMs?: number | null;
  startedAt?: number | null;
}

/** `debug.current` 的请求数组；`debug.stop` 的计数（同一个 `requests` 字段两种形状）。 */
type DebugSnapshotRequests = number | DebugRequestEntry[] | undefined;

interface DebugSnapshot {
  requests?: DebugSnapshotRequests;
  console?: number | unknown[];
  durationMs?: number;
  active?: boolean;
  stopped?: boolean;
  entries?: DebugRequestEntry[];
  url?: string;
  context?: { url?: string } | null;
}

interface ReplayResult {
  ok?: boolean;
  status?: number | null;
  statusText?: string;
  url?: string;
  method?: string;
  durationMs?: number;
  mode?: string;
}

/** 从 debug.current / debug.stop 的快照里取出请求数组（两种形状都容错）。 */
export function requestEntriesOf(snapshot: DebugSnapshot | null | undefined): DebugRequestEntry[] {
  if (!snapshot) return [];
  if (Array.isArray(snapshot.requests)) return snapshot.requests;
  if (Array.isArray(snapshot.entries)) return snapshot.entries;
  return [];
}

function sleeping(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 页面侧触发一次页面请求（直接点页面上的按钮；没有就忽略）。 */
async function pokePage(tabId: number): Promise<boolean> {
  try {
    const scripting = (globalThis as unknown as {
      chrome?: { scripting?: { executeScript(options: Record<string, unknown>): Promise<unknown> } };
    }).chrome?.scripting;
    if (!scripting || typeof scripting.executeScript !== 'function') return false;
    await scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => {
        const button = document.getElementById('ping-btn');
        if (button) (button as HTMLElement).click();
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** 从采集结果里挑一条可重放的请求：优先 `/api/ping`，其次任意 http(s) 且成功过的条目。 */
export function pickReplayTarget(entries: readonly DebugRequestEntry[]): { url: string; method: string } | null {
  const usable = entries.filter((entry) => typeof entry.url === 'string' && /^https?:/i.test(entry.url));
  if (!usable.length) return null;
  const preferred = usable.find((entry) => String(entry.url).includes('/api/ping'));
  const successful = usable.find((entry) => Number(entry.status) === 200);
  const chosen = preferred ?? successful ?? usable[0];
  if (!chosen || !chosen.url) return null;
  return {
    url: chosen.url,
    method: typeof chosen.method === 'string' && chosen.method ? chosen.method.toUpperCase() : 'GET',
  };
}

export interface ReplaySelftestDeps {
  tabId: number;
  /** bb.ui 调用（requireUi 语义：失败抛错）。 */
  call<T extends object = Record<string, unknown>>(op: string, params?: Record<string, unknown>): Promise<T>;
  /** 页面侧制造一次请求；不可用/失败返回 false，不阻塞自测。 */
  poke?: (tabId: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  /** 采集后等资源计时落条目的沉降时间（默认 1200ms）。 */
  settleMs?: number;
}

export interface ReplaySelftestOutcome {
  ok: boolean;
  status: number | null;
  url: string;
  method: string;
  requestsSeen: number;
  /** 是否真的调用了 `network.replay`（失败时也便于区分“没采集到”和“重放失败”）。 */
  replayed: boolean;
  /** 写进 SELFTEST 标题的 detail（ok 时是 status 数字）。 */
  detail: string;
  error?: string;
}

/**
 * `?selftest=replay` 的真实链路（抽成导出函数便于用假 RPC 单测）：
 *
 * `debug.start` → 页面制造一次请求 → `debug.current` 取真实采集条目 →
 * 取条目 URL 走 `network.replay`（页面 MAIN world fetch）→ 断言响应 status 200。
 *
 * 不抛异常：失败也返回结构化 outcome，由调用方写 `SELFTEST:fail:replay:<原因>`。
 */
export async function runReplaySelftest(deps: ReplaySelftestDeps): Promise<ReplaySelftestOutcome> {
  const sleep = deps.sleep ?? sleeping;
  const outcome: ReplaySelftestOutcome = {
    ok: false,
    status: null,
    url: '',
    method: 'GET',
    requestsSeen: 0,
    replayed: false,
    detail: '',
  };
  const tabId = Number(deps.tabId);
  if (!Number.isInteger(tabId) || tabId <= 0) {
    outcome.detail = '没有可采集的目标标签页';
    outcome.error = outcome.detail;
    return outcome;
  }
  try {
    await deps.call('debug.start', { tabId });
    if (deps.poke) {
      try {
        await deps.poke(tabId);
      } catch {
        // 制造请求失败不阻塞：可能页面本来就有周期性请求
      }
    }
    await sleep(deps.settleMs ?? 1200);
    const snapshot = await deps.call<DebugSnapshot>('debug.current', { tabId });
    const entries = requestEntriesOf(snapshot as unknown as DebugSnapshot);
    outcome.requestsSeen = entries.length;
    const target = pickReplayTarget(entries);
    if (!target) throw new Error('没有可重放的请求（先让页面发出一次请求）');
    outcome.url = target.url;
    outcome.method = target.method;
    const replay = await deps.call<ReplayResult>('network.replay', {
      tabId,
      request: { url: target.url, method: target.method },
    });
    outcome.replayed = true;
    const status = Number((replay as ReplayResult).status);
    if (!Number.isFinite(status) || status <= 0) throw new Error('重放没有返回响应 status');
    outcome.status = status;
    outcome.ok = status === 200;
    outcome.detail = String(status);
    if (!outcome.ok) outcome.error = '重放响应 status=' + String(status) + '（期望 200）';
  } catch (error) {
    outcome.ok = false;
    outcome.error = error instanceof Error ? error.message : String(error);
    if (!outcome.detail) outcome.detail = outcome.error;
  } finally {
    // 自测结束收尾采集；stop 失败（已被别的步骤停止等）不影响结论。
    try {
      await deps.call('debug.stop', { tabId });
    } catch {
      // 忽略
    }
  }
  return outcome;
}

async function main(): Promise<void> {
  const boot = setupPage('debug');
  const selftest = boot.query.get('selftest');

  const select = document.createElement('select');
  select.id = 'dbg-tab';
  select.setAttribute('aria-label', '目标标签页');
  const status = el('p', { className: 'muted', id: 'dbg-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const requestsBox = el('div', { id: 'dbg-requests' });
  const rulesBox = el('div', { id: 'dbg-rules' });
  const perfBox = el('div', { id: 'dbg-perf' });
  const replayBox = el('div', { id: 'dbg-replay' });

  const action = (id: string, label: string, onClick: () => void): HTMLButtonElement => {
    const button = el('button', { attrs: { type: 'button', id, 'aria-label': label }, text: label });
    button.addEventListener('click', onClick);
    return button;
  };

  const selectedTab = (): number => Number(select.value);

  /** 最近一次渲染的请求条目（重放面板的“重放最近一条”用）。 */
  let lastEntries: DebugRequestEntry[] = [];

  /** 重放面板的可见结果（成功/失败都写在这里，不只写 status 栏）。 */
  const renderReplay = (text: string, ok: boolean): void => {
    replayBox.textContent = '';
    replayBox.append(el('p', { className: ok ? 'status ok' : 'status bad', text }));
  };

  /**
   * 用 `network.replay` 在页面 MAIN world 重放一条**采集到的**请求。
   * 页面侧不自己 fetch：判据（status/url/method）全部来自 background 的 network 服务。
   */
  const replayEntry = async (entry: DebugRequestEntry): Promise<ReplayResult | null> => {
    const tabId = selectedTab();
    const url = typeof entry.url === 'string' ? entry.url : '';
    if (!Number.isInteger(tabId) || tabId <= 0) {
      renderReplay('重放失败：先选择目标标签页', false);
      return null;
    }
    if (!url) {
      renderReplay('重放失败：这条请求没有 URL', false);
      return null;
    }
    const method = typeof entry.method === 'string' && entry.method ? entry.method.toUpperCase() : 'GET';
    renderReplay('重放中：' + method + ' ' + url, true);
    const reply = await sendUi<ReplayResult>('network.replay', { tabId, request: { url, method } });
    if (reply.ok !== true) {
      const failure = describeFailure(reply as { code?: string; message?: string });
      renderReplay('重放失败：' + failure, false);
      status.textContent = '重放失败：' + failure;
      return null;
    }
    const result = reply.result ?? {};
    const codeText = result.status == null ? '?' : String(result.status);
    renderReplay(
      '重放完成：HTTP ' + codeText + ' ' + method + ' ' + String(result.url || url)
        + (result.durationMs == null ? '' : ' · ' + String(result.durationMs) + 'ms'),
      true,
    );
    status.textContent = '重放完成：HTTP ' + codeText;
    return result;
  };

  const renderRequests = (snapshot: DebugSnapshot): void => {
    requestsBox.textContent = '';
    const entries = requestEntriesOf(snapshot);
    lastEntries = entries;
    requestsBox.append(el('h2', { text: '请求（' + String(entries.length) + '）' }));
    if (!entries.length) {
      requestsBox.append(el('p', { className: 'muted', text: '暂无采集数据（先开始采集并刷新目标页面）' }));
      return;
    }
    const list = el('ul', { className: 'list' });
    for (const entry of entries.slice(0, 40)) {
      const method = String(entry.method ?? 'GET');
      const url = String(entry.url ?? '');
      const statusCode = entry.status == null ? '' : ' ' + String(entry.status);
      const duration = entry.durationMs == null ? '' : ' · ' + String(entry.durationMs) + 'ms';
      const line = el('li', { text: method + ' ' + url.slice(0, 120) + statusCode + duration });
      // 逐条“重放”（与 0.3.0 debug.js 的请求行按钮同语义：只重放采集到的真实请求）。
      if (/^https?:/i.test(url)) {
        const replayButton = el('button', {
          attrs: { type: 'button', 'aria-label': '重放 ' + url.slice(0, 60) },
          text: '重放',
        });
        replayButton.addEventListener('click', () => {
          void replayEntry(entry);
        });
        line.append(' ', replayButton);
      }
      list.append(line);
    }
    requestsBox.append(list);
  };

  const loadRules = async (): Promise<number> => {
    const reply = await sendUi<{ rules?: Array<Record<string, unknown>> }>('debug.rule.list', {});
    rulesBox.textContent = '';
    const rules = (reply.ok === true ? reply.result?.rules : []) ?? [];
    rulesBox.append(el('h2', { text: '规则（' + String(rules.length) + '）' }));
    if (!rules.length) {
      rulesBox.append(el('p', { className: 'muted', text: '暂无规则' }));
      return 0;
    }
    const list = el('ul', { className: 'list' });
    for (const rule of rules) {
      list.append(el('li', {
        text: String(rule.action ?? '') + ' · ' + String(rule.urlPattern ?? '') + (rule.applied === false ? '（只登记：需要 CDP Fetch）' : ''),
      }));
    }
    rulesBox.append(list);
    return rules.length;
  };

  const loadPerformance = async (): Promise<number> => {
    const reply = await sendUi<{ metrics?: Record<string, unknown> }>('debug.performance', { tabId: selectedTab() });
    perfBox.textContent = '';
    if (reply.ok !== true) {
      perfBox.append(el('p', { className: 'status bad', text: describeFailure(reply as { code?: string; message?: string }) }));
      return 0;
    }
    const metrics = reply.result?.metrics ?? {};
    const keys = Object.keys(metrics);
    perfBox.append(el('h2', { text: '性能指标（' + String(keys.length) + '）' }));
    const list = el('ul', { className: 'list' });
    for (const key of keys.slice(0, 30)) {
      list.append(el('li', { text: key + ': ' + JSON.stringify(metrics[key]).slice(0, 120) }));
    }
    if (keys.length) perfBox.append(list);
    else perfBox.append(el('p', { className: 'muted', text: '暂无可读指标（页面还没有资源计时）' }));
    return keys.length;
  };

  const startButton = action('dbg-start', '开始采集', () => {
    void (async () => {
      const reply = await sendUi('debug.start', { tabId: selectedTab() });
      status.textContent = reply.ok === true ? '已开始采集' : '开始失败：' + describeFailure(reply as { code?: string; message?: string });
    })();
  });
  const stopButton = action('dbg-stop', '停止采集', () => {
    void (async () => {
      const reply = await sendUi<DebugSnapshot>('debug.stop', { tabId: selectedTab() });
      if (reply.ok !== true) {
        status.textContent = '停止失败：' + describeFailure(reply as { code?: string; message?: string });
        return;
      }
      const snapshot = reply.result ?? {};
      status.textContent = '已停止：' + String(snapshot.requests ?? 0) + ' 请求 / ' + String(snapshot.console ?? 0) + ' 条输出';
      const current = await sendUi<DebugSnapshot>('debug.current', { tabId: selectedTab() });
      if (current.ok === true) renderRequests(current.result ?? {});
    })();
  });
  const refreshButton = action('dbg-refresh', '刷新面板', () => {
    void (async () => {
      const [current] = await Promise.all([
        sendUi<DebugSnapshot>('debug.current', { tabId: selectedTab() }),
        loadRules(),
        loadPerformance(),
      ]);
      if (current.ok === true) renderRequests(current.result ?? {});
    })();
  });
  const replayLastButton = action('dbg-replay-last', '重放最近一条请求', () => {
    void (async () => {
      if (!lastEntries.length) {
        renderReplay('没有可重放的请求：先“刷新面板”拿到采集结果', false);
        return;
      }
      const target = lastEntries.find((entry) => typeof entry.url === 'string' && /^https?:/i.test(entry.url));
      if (!target) {
        renderReplay('采集结果里没有 http(s) 请求可重放', false);
        return;
      }
      await replayEntry(target);
    })();
  });
  const ruleAddButton = action('dbg-rule-add', '添加规则', () => {
    void (async () => {
      const reply = await sendUi('debug.rule.add', {
        tabId: selectedTab(),
        rule: { urlPattern: '*/__bb_selftest_rule__*', action: 'block' },
      });
      status.textContent = reply.ok === true ? '规则已添加' : '添加失败：' + describeFailure(reply as { code?: string; message?: string });
      await loadRules();
    })();
  });
  const ruleClearButton = action('dbg-rule-clear', '清空规则', () => {
    void (async () => {
      const reply = await sendUi('debug.rule.clear', {});
      status.textContent = reply.ok === true ? '规则已清空' : '清空失败：' + describeFailure(reply as { code?: string; message?: string });
      await loadRules();
    })();
  });

  document.body.textContent = '';
  document.body.append(
    el('header', {}, [
      el('h1', { text: '网站调试' }),
      el('p', { className: 'muted', text: '请求/console 采集走页面钩子 + 资源计时（无 CDP）；fulfill/modify 只登记' }),
    ]),
    el('div', { className: 'card' }, [
      el('div', { className: 'row' }, [el('span', { text: '目标标签页' }), select]),
      el('div', { className: 'row' }, [startButton, stopButton, refreshButton]),
      status,
    ]),
    el('div', { className: 'card', id: 'dbg-replay-card' }, [
      el('h2', { text: '请求重放' }),
      el('p', { className: 'muted', text: '在页面主世界重放一条采集到的请求（network.replay；页面侧不自己 fetch）' }),
      el('div', { className: 'row' }, [replayLastButton]),
      replayBox,
    ]),
    el('div', { className: 'card' }, [
      el('div', { className: 'row' }, [ruleAddButton, ruleClearButton]),
      rulesBox,
    ]),
    el('div', { className: 'card' }, [perfBox]),
    el('div', { className: 'card' }, [requestsBox]),
  );

  const listReply = await sendUi<{ tabs?: TabInfo[] }>('tabs', {});
  const tabs = (listReply.ok === true ? listReply.result?.tabs : []) ?? [];
  select.textContent = '';
  for (const tab of tabs) {
    const option = document.createElement('option');
    option.value = String(tab.tabId);
    option.textContent = (tab.title || tab.url || '标签页').slice(0, 70);
    if (tab.active) option.selected = true;
    select.append(option);
  }
  if (selectedTab() && Number.isFinite(selectedTab())) {
    await Promise.all([loadRules(), loadPerformance()]);
  }

  // -- 自测 ---------------------------------------------------------------
  if (selftest === 'rules') {
    try {
      await requireUi('debug.rule.add', { tabId: selectedTab(), rule: { urlPattern: '*/__selftest_rule__*', action: 'block' } });
      const reply = await requireUi<{ rules?: unknown[] }>('debug.rule.list', {});
      const rules = (reply as unknown as { rules?: unknown[] }).rules ?? [];
      await requireUi('debug.rule.clear', {});
      reportSelftest('rules', String(rules.length));
    } catch (error) {
      reportSelftest('rules', error instanceof Error ? error.message : String(error), false);
    }
    return;
  }
  if (selftest === 'perf') {
    try {
      const reply = await requireUi<{ metrics?: Record<string, unknown> }>('debug.performance', { tabId: selectedTab() });
      const metrics = (reply as unknown as { metrics?: Record<string, unknown> }).metrics ?? {};
      reportSelftest('perf', String(Object.keys(metrics).length));
    } catch (error) {
      reportSelftest('perf', error instanceof Error ? error.message : String(error), false);
    }
    return;
  }
  if (selftest === 'replay') {
    const outcome = await runReplaySelftest({
      tabId: selectedTab(),
      call: (op, params) => requireUi(op, params),
      poke: pokePage,
      sleep: sleeping,
      settleMs: 1200,
    });
    if (outcome.ok) {
      reportSelftest('replay', String(outcome.status));
      status.textContent = '自测完成：重放 ' + outcome.method + ' ' + outcome.url + ' → HTTP ' + String(outcome.status);
      renderReplay('重放成功：HTTP ' + String(outcome.status) + ' ' + outcome.method + ' ' + outcome.url, true);
    } else {
      reportSelftest('replay', outcome.error || '重放失败', false);
      status.textContent = '自测失败：' + (outcome.error || '重放失败');
      renderReplay('重放失败：' + (outcome.error || '未知原因')
        + '（采集到 ' + String(outcome.requestsSeen) + ' 条请求）', false);
    }
    return;
  }
  if (selftest === '1') {
    try {
      const tabId = selectedTab();
      if (!Number.isInteger(tabId) || tabId <= 0) throw new Error('没有可采集的目标标签页');
      await requireUi('debug.start', { tabId });
      await pokePage(tabId);
      await sleeping(1200);
      const stopped = await requireUi<DebugSnapshot>('debug.stop', { tabId });
      const snapshot = stopped as unknown as DebugSnapshot;
      reportSelftest('debug', String(snapshot.requests ?? 0) + ':' + String(snapshot.console ?? 0));
      status.textContent = '自测完成：' + String(snapshot.requests ?? 0) + ' 请求 / ' + String(snapshot.console ?? 0) + ' 条输出';
      const current = await sendUi<DebugSnapshot>('debug.current', { tabId });
      if (current.ok === true) renderRequests(current.result ?? {});
    } catch (error) {
      reportSelftest('debug', error instanceof Error ? error.message : String(error), false);
    }
  }
}

void main().catch((error: unknown) => {
  setupPage('debug');
  document.body.textContent = '';
  document.body.append(
    el('h1', { text: '网站调试' }),
    el('p', { className: 'status bad', text: '初始化失败：' + (error instanceof Error ? error.message : String(error)) }),
  );
});
