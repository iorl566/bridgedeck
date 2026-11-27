import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type { ExtensionReply, StatusPayload } from '@/shared/messages';
import type { BridgeSettings } from '@/shared/settings';
import { sendUi } from '@/src/ui/client';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: StatusPayload; settings: BridgeSettings }
  | { kind: 'error'; message: string };

async function request<T extends ExtensionReply>(message: unknown): Promise<T> {
  const reply = (await browser.runtime.sendMessage(message)) as ExtensionReply;
  if (!reply || reply.ok !== true) throw new Error(reply && reply.ok === false ? reply.message : '后台无响应');
  return reply as T;
}

/** 读设置（走 bb.ui：包含人工开关的真实值）。 */
async function readSettings(): Promise<BridgeSettings> {
  const reply = await sendUi<{ settings?: BridgeSettings }>('settings.read', {});
  if (reply.ok !== true) throw new Error(reply.message || reply.code || '读取设置失败');
  return (reply.result?.settings ?? {}) as BridgeSettings;
}

/** 写设置（扩展页面是用户本人，这是唯一允许写人工开关的通道）。 */
async function writeSettings(patch: Record<string, unknown>): Promise<void> {
  const reply = await sendUi('settings.write', { patch });
  if (reply.ok !== true) throw new Error(reply.message || reply.code || '写入设置失败');
}

/** 页面 URL：WXT 的 getURL 只对已声明的 HTML 入口做字面量收窄，这里按普通字符串取。 */
function pageUrl(path: string): string {
  const getUrl = (browser.runtime as unknown as { getURL(p: string): string }).getURL;
  return getUrl.call(browser.runtime, path);
}

function openSettingsPage(): void {
  void browser.tabs.create({ url: pageUrl('/options.html'), active: true });
}

/**
 * `?selftest=a11y`：端到端可访问性自检（lang / 按钮名 / switch aria-checked / img alt）。
 * 与 0.3.0 的口径一致：检查的是**当前真实 DOM**，不是静态断言。
 */
function runA11ySelftest(report: (title: string) => void): void {
  window.setTimeout(() => {
    const issues: string[] = [];
    if (!document.documentElement.getAttribute('lang')) issues.push('html-lang');
    for (const button of document.querySelectorAll('button')) {
      const name = String(button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent || '').trim();
      if (!name) issues.push('button:' + (button.id || '(anonymous)'));
    }
    for (const control of document.querySelectorAll('[role="switch"]')) {
      if (!control.hasAttribute('aria-checked')) issues.push('switch:' + (control.id || '(anonymous)'));
    }
    for (const image of document.querySelectorAll('img')) {
      if (!image.hasAttribute('alt')) issues.push('img:' + (image.id || image.src || '(anonymous)'));
    }
    report(issues.length ? 'SELFTEST:fail:a11y:' + issues.join(',') : 'SELFTEST:ok:a11y:0');
  }, 300);
}

/**
 * `?selftest=<任意非 a11y 值>`：开关与配对设置的写入/还原自测。
 * 只动一个无害开关（controlHint）且来回切两次恢复原值；配对字段写完立刻清空。
 */
async function runToggleSelftest(report: (title: string) => void): Promise<void> {
  try {
    const before = await readSettings();
    if (typeof before.controlHint !== 'boolean') throw new Error('设置里没有 controlHint');
    await writeSettings({ controlHint: !before.controlHint });
    const toggled = await readSettings();
    if (toggled.controlHint === before.controlHint) throw new Error('开关写入没有生效');
    await writeSettings({ controlHint: before.controlHint });
    const restored = await readSettings();
    if (restored.controlHint !== before.controlHint) throw new Error('开关没有恢复原值');
    // 远程配对：写入 → 读回 → 清空（不改变最终状态）。
    await writeSettings({ daemonUrl: 'ws://127.0.0.1:52999/ws', daemonToken: 'selftest-token', daemonCode: '123456' });
    const paired = await readSettings();
    if (paired.daemonUrl !== 'ws://127.0.0.1:52999/ws' || paired.daemonToken !== 'selftest-token' || paired.daemonCode !== '123456') {
      throw new Error('配对保存失败');
    }
    await writeSettings({ daemonUrl: '', daemonToken: '', daemonCode: '' });
    const cleared = await readSettings();
    if (cleared.daemonUrl !== '' || cleared.daemonToken !== '' || cleared.daemonCode !== '') throw new Error('配对清空失败');
    report('SELFTEST:ok:popup:toggles+pairing');
  } catch (error) {
    report('SELFTEST:fail:' + (error instanceof Error ? error.message : String(error)));
  }
}

export default function App() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [controlHint, setControlHint] = useState(true);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const status = await request<Extract<ExtensionReply, { type: 'status' }>>({ type: 'bb.status' });
        const settings = await request<Extract<ExtensionReply, { type: 'settings' }>>({ type: 'bb.settings.get' });
        if (alive) {
          setState({ kind: 'ready', status: status.status, settings: settings.settings });
          setControlHint(settings.settings.controlHint !== false);
        }
      } catch (error) {
        if (alive) setState({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 自测：?selftest=a11y 跑可访问性；其它 selftest 跑开关/配对往返。
  useEffect(() => {
    if (state.kind !== 'ready') return;
    const selftest = new URLSearchParams(window.location.search).get('selftest');
    if (!selftest) return;
    const report = (title: string): void => {
      document.title = title;
    };
    if (selftest === 'a11y') {
      runA11ySelftest(report);
      return;
    }
    void runToggleSelftest(report);
  }, [state.kind]);

  if (state.kind === 'loading') return <p role="status">正在连接后台…</p>;
  if (state.kind === 'error') return <p role="alert">后台不可用：{state.message}</p>;

  const { status, settings } = state;
  const toggleControlHint = (): void => {
    const next = !controlHint;
    setControlHint(next);
    void writeSettings({ controlHint: next }).catch(() => setControlHint(!next));
  };
  return (
    <main>
      <header>
        <img src={pageUrl('/icons/icon48.png')} alt="BridgeDeck 图标" width="32" height="32" />
        <h1>{status.name}</h1>
      </header>
      <p>
        版本 {status.version} · 协议 {status.protocol} · 运行时 {status.runtime}
      </p>
      <dl>
        <dt>canonical 方法</dt>
        <dd>{status.canonicalMethods}</dd>
        <dt>MCP 工具</dt>
        <dd>{status.mcpTools}</dd>
        <dt>活动标签页</dt>
        <dd>{status.openTabs}</dd>
        <dt>daemon 端口</dt>
        <dd>{settings.daemonPort}</dd>
      </dl>
      <section>
        <h2>快捷控制</h2>
        <button
          type="button"
          role="switch"
          id="controlHint"
          aria-checked={controlHint ? 'true' : 'false'}
          onClick={toggleControlHint}
        >
          操作提示浮层：{controlHint ? '开' : '关'}
        </button>
        <button type="button" onClick={openSettingsPage}>打开设置页</button>
        <button type="button" onClick={() => { void browser.tabs.create({ url: pageUrl('/quick.html'), active: true }); }}>
          快捷功能
        </button>
      </section>
    </main>
  );
}
