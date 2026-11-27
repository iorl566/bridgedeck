// src/ui/pages/options.ts —— 设置页：语言/RTL、人工开关、远程配对。
//
// 与 background 的边界：
// - 读：`settings.read`（返回完整 BridgeSettings，含人工开关真实值）；
// - 写：`settings.write`（这是唯一允许写 HUMAN_ONLY_KEYS 的通道；daemon/CLI 的
//   `settings.set` 仍然 E_FORBIDDEN —— 安全边界不变）；
// - `?lang=ar|he|en|zh` 直接切换界面语言与方向（E2E 用 tab.title 断言）。

import { resolveUiLanguage, el, setupPage, uiTitle, type UiLanguage } from '../page.ts';
import { describeFailure, requireUi, sendUi } from '../client.ts';

interface SettingsShape {
  controlHint?: boolean;
  recordOverlay?: boolean;
  borrowRequireConfirm?: boolean;
  allowHelp?: boolean;
  pageGuard?: boolean;
  instanceLabel?: string;
  longShotMode?: 'auto' | 'manual';
  daemonUrl?: string;
  daemonToken?: string;
  daemonCode?: string;
  language?: string;
  daemonPort?: number;
}

const LANGUAGE_LABELS: Record<UiLanguage, string> = {
  zh: '中文',
  en: 'English',
  ar: 'العربية',
  he: 'עברית',
};

function field(label: string, control: HTMLElement): HTMLElement {
  const wrapper = el('label', { className: 'row' }, [el('span', { text: label }), control]);
  return wrapper;
}

function checkbox(id: string, checked: boolean): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id;
  input.checked = checked;
  input.setAttribute('role', 'switch');
  input.setAttribute('aria-checked', checked ? 'true' : 'false');
  input.addEventListener('change', () => input.setAttribute('aria-checked', input.checked ? 'true' : 'false'));
  return input;
}

function textInput(id: string, value: string, type = 'text'): HTMLInputElement {
  const input = document.createElement('input');
  input.type = type;
  input.id = id;
  input.value = value;
  return input;
}

function readForm(): Record<string, unknown> {
  const get = (id: string): HTMLElement | null => document.getElementById(id);
  const checked = (id: string): boolean => Boolean((get(id) as HTMLInputElement | null)?.checked);
  const value = (id: string): string => String((get(id) as HTMLInputElement | HTMLSelectElement | null)?.value ?? '');
  return {
    controlHint: checked('opt-control-hint'),
    recordOverlay: checked('opt-record-overlay'),
    borrowRequireConfirm: checked('opt-borrow-confirm'),
    allowHelp: checked('opt-allow-help'),
    pageGuard: checked('opt-page-guard'),
    instanceLabel: value('opt-label'),
    longShotMode: value('opt-longshot') === 'manual' ? 'manual' : 'auto',
    language: value('opt-language') || 'auto',
    daemonUrl: value('opt-daemon-url'),
    daemonToken: value('opt-daemon-token'),
    daemonCode: value('opt-daemon-code'),
  };
}

function render(settings: SettingsShape): void {
  const language = resolveUiLanguage(settings.language);
  const languageSelect = document.createElement('select');
  languageSelect.id = 'opt-language';
  for (const [code, label] of Object.entries(LANGUAGE_LABELS)) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = label;
    option.selected = code === language;
    languageSelect.append(option);
  }
  const autoOption = document.createElement('option');
  autoOption.value = 'auto';
  autoOption.textContent = 'Auto（跟随浏览器）';
  autoOption.selected = !settings.language || settings.language === 'auto';
  languageSelect.append(autoOption);

  const longShot = document.createElement('select');
  longShot.id = 'opt-longshot';
  for (const [value, label] of [['auto', '自动滚动拼接'], ['manual', '手动画布']] as const) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    option.selected = (settings.longShotMode ?? 'auto') === value;
    longShot.append(option);
  }

  const pairing = el('div', { className: 'card' }, [
    el('h2', { text: '远程配对' }),
    el('p', { className: 'muted', text: '非本机连接必须使用 wss://；本机连接留空即自动发现端口。' }),
    field('daemon 地址', textInput('opt-daemon-url', settings.daemonUrl ?? '', 'url')),
    field('访问令牌', textInput('opt-daemon-token', settings.daemonToken ?? '')),
    field('配对码（6 位）', textInput('opt-daemon-code', settings.daemonCode ?? '')),
  ]);

  const human = el('div', { className: 'card' }, [
    el('h2', { text: '人工开关（只能在此页修改）' }),
    field('操作提示浮层', checkbox('opt-control-hint', settings.controlHint !== false)),
    field('录制浮层', checkbox('opt-record-overlay', settings.recordOverlay !== false)),
    field('借用前确认', checkbox('opt-borrow-confirm', settings.borrowRequireConfirm !== false)),
    field('人工协助卡片', checkbox('opt-allow-help', settings.allowHelp !== false)),
    field('页面守卫', checkbox('opt-page-guard', settings.pageGuard !== false)),
  ]);

  const general = el('div', { className: 'card' }, [
    el('h2', { text: '通用' }),
    field('实例名', textInput('opt-label', settings.instanceLabel ?? '')),
    field('界面语言', languageSelect),
    field('长截图默认模式', longShot),
    el('p', { className: 'muted', text: 'daemon 端口（自动发现）：' + String(settings.daemonPort ?? '—') }),
  ]);

  const status = el('p', { className: 'muted', id: 'opt-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const save = el('button', { className: 'primary', attrs: { type: 'button', id: 'opt-save', 'aria-label': '保存设置' }, text: '保存' });
  save.addEventListener('click', () => {
    void (async () => {
      status.textContent = '保存中…';
      const reply = await sendUi('settings.write', { patch: readForm() });
      if (reply.ok !== true) {
        status.textContent = '保存失败：' + describeFailure(reply as { code?: string; message?: string });
        return;
      }
      const result = reply.result as { applied?: string[]; ignored?: string[] } | undefined;
      const applied = result?.applied ?? [];
      const ignored = result?.ignored ?? [];
      status.textContent = '已保存 ' + String(applied.length) + ' 项' + (ignored.length ? '（忽略：' + ignored.join(',') + '）' : '');
      const saved = (reply.result as { settings?: SettingsShape } | undefined)?.settings;
      if (saved) {
        const next = resolveUiLanguage(saved.language);
        document.documentElement.setAttribute('lang', next);
        document.documentElement.setAttribute('dir', next === 'ar' || next === 'he' ? 'rtl' : 'ltr');
      }
    })();
  });

  document.body.textContent = '';
  document.body.append(
    el('header', {}, [
      el('h1', { text: uiTitle(resolveUiLanguage(settings.language), 'options') }),
      el('p', { className: 'muted', text: 'BridgeDeck 扩展设置' }),
    ]),
    general,
    human,
    pairing,
    el('div', { className: 'row' }, [save]),
    status,
  );
}

async function main(): Promise<void> {
  setupPage('options');
  const reply = await requireUi('settings.read', {});
  const settings = (reply as unknown as { settings?: SettingsShape }).settings ?? {};
  render(settings);
}

void main().catch((error: unknown) => {
  const boot = setupPage('options');
  document.body.textContent = '';
  document.body.append(
    el('h1', { text: uiTitle(boot.language, 'options') }),
    el('p', { className: 'status bad', text: '加载失败：' + (error instanceof Error ? error.message : String(error)) }),
  );
});
