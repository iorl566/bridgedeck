// src/ui/page.ts —— 子页面共用引导：语言/RTL、标题、DOM 小工具、自测回报。
//
// 设计取向：
// - 页面是**薄壳**：状态全部来自 `bb.ui` 消息（background 侧服务），页面只做渲染与交互；
// - 语言来自 `?lang=ar|he|en|zh`（设置页切换语言也复用同一份表）；`ar`/`he` 自动 `dir=rtl`；
// - 每个页面的 document.title 必须跟着语言变（E2E 用 tab.title 断言页面真的渲染并切了语言）；
// - 不做框架（React 只用于工具栏弹窗）：子页面 DOM 结构简单，原生 DOM 更少依赖、更容易
//   在真实浏览器里排查；样式统一由 `applyBaseStyles()` 注入一份最小 CSS。

import { findUiPage, type UiPageName } from './catalog.ts';

export type UiLanguage = 'zh' | 'en' | 'ar' | 'he';

export const UI_LANGUAGES: readonly UiLanguage[] = Object.freeze(['zh', 'en', 'ar', 'he']);

const RTL_LANGUAGES: ReadonlySet<UiLanguage> = new Set<UiLanguage>(['ar', 'he']);

/** 语言是否 RTL（阿拉伯语/希伯来语）；页面方向与 CSS 逻辑属性的单一判据。 */
export function isRtlLanguage(language: UiLanguage): boolean {
  return RTL_LANGUAGES.has(language);
}

/** 把 `lang` / `dir` 写到根元素（首次引导与语言切换共用；RTL 逻辑属性的前提）。 */
export function applyDocumentDirection(root: Element | null | undefined, language: UiLanguage): void {
  if (!root || typeof root.setAttribute !== 'function') return;
  root.setAttribute('lang', language);
  root.setAttribute('dir', isRtlLanguage(language) ? 'rtl' : 'ltr');
}

/**
 * 写 document.title，并保证 `<title>` 位于 `<head>` 内。
 *
 * 为什么不是一行 `document.title = text`：如果产物 HTML 把 `<title>` 解析进了 body
 * （游离 BOM 等解析异常），页面清空 body 时 title 会被一起移除，`tab.title` 退化成
 * URL（29d 阿拉伯语/希伯来语标题失败的根因）。这里把 title 固定到 head，再写文本；
 * 非文档环境（单测）安静降级。
 */
export function setDocumentTitle(doc: Document | null | undefined, text: string): void {
  if (!doc) return;
  try {
    const head = doc.head ?? null;
    let title = head ? head.querySelector('title') : null;
    if (!title && typeof doc.querySelector === 'function') {
      title = doc.querySelector('title');
    }
    if (!title && head) {
      title = doc.createElement('title');
      head.appendChild(title);
    }
    if (title && head && title.parentNode !== head) head.appendChild(title);
    if (title) {
      title.textContent = text;
      return;
    }
  } catch {
    // 落到 document.title 兜底
  }
  try {
    doc.title = text;
  } catch {
    // 非文档环境忽略
  }
}

interface TextTable {
  /** 页面标题（与 catalog 的 zh title 对齐）。 */
  titles: Record<UiPageName, string>;
  /** 通用 UI 文案。 */
  labels: Record<string, string>;
}

const TEXT: Record<UiLanguage, TextTable> = {
  zh: {
    titles: {
      popup: 'BridgeDeck',
      options: '设置',
      quick: '快捷功能',
      longshot: '长截图',
      debug: '网站调试',
      audit: '操作审计',
      ops: '操作录制',
      record: '视频录制',
      preview: '截图预览',
    },
    labels: {
      connected: '已连接',
      disconnected: '未连接',
      version: '版本',
      protocol: '协议',
      language: '语言',
      theme: '主题',
      save: '保存',
      saved: '已保存',
      restore: '恢复',
      capture: '开始截图',
      refresh: '刷新',
      loading: '加载中…',
      empty: '暂无数据',
      error: '失败',
      unavailable: '该能力尚未迁移到 TS 运行时',
      targetTab: '目标标签页',
      close: '关闭',
      back: '返回',
      entries: '条',
      requests: '请求',
      rules: '规则',
      consoleLines: '控制台输出',
      selectTab: '先选择一个目标标签页',
      done: '完成',
      backend: '存储后端',
    },
  },
  en: {
    titles: {
      popup: 'BridgeDeck',
      options: 'Settings',
      quick: 'Quick actions',
      longshot: 'Full-page capture',
      debug: 'Site debug',
      audit: 'Audit log',
      ops: 'Operation recording',
      record: 'Video recording',
      preview: 'Screenshot preview',
    },
    labels: {
      connected: 'Connected',
      disconnected: 'Disconnected',
      version: 'Version',
      protocol: 'Protocol',
      language: 'Language',
      theme: 'Theme',
      save: 'Save',
      saved: 'Saved',
      restore: 'Restore',
      capture: 'Capture',
      refresh: 'Refresh',
      loading: 'Loading…',
      empty: 'No data',
      error: 'Failed',
      unavailable: 'This capability is not migrated to the TS runtime yet',
      targetTab: 'Target tab',
      close: 'Close',
      back: 'Back',
      entries: 'entries',
      requests: 'requests',
      rules: 'rules',
      consoleLines: 'console lines',
      selectTab: 'Select a target tab first',
      done: 'Done',
      backend: 'Storage backend',
    },
  },
  ar: {
    titles: {
      popup: 'BridgeDeck',
      options: 'الإعدادات',
      quick: 'إجراءات سريعة',
      longshot: 'لقطة الشاشة الكاملة',
      debug: 'تصحيح الموقع',
      audit: 'سجل التدقيق',
      ops: 'تسجيل العمليات',
      record: 'تسجيل الفيديو',
      preview: 'معاينة اللقطة',
    },
    labels: {
      connected: 'متصل',
      disconnected: 'غير متصل',
      version: 'الإصدار',
      protocol: 'البروتوكول',
      language: 'اللغة',
      theme: 'المظهر',
      save: 'حفظ',
      saved: 'تم الحفظ',
      restore: 'استعادة',
      capture: 'التقاط',
      refresh: 'تحديث',
      loading: 'جارٍ التحميل…',
      empty: 'لا توجد بيانات',
      error: 'فشل',
      unavailable: 'هذه القدرة غير منقولة إلى وقت التشغيل TypeScript بعد',
      targetTab: 'علامة التبويب الهدف',
      close: 'إغلاق',
      back: 'رجوع',
      entries: 'سجلات',
      requests: 'طلبات',
      rules: 'قواعد',
      consoleLines: 'أسطر وحدة التحكم',
      selectTab: 'اختر علامة تبويب هدف أولاً',
      done: 'تم',
      backend: 'خلفية التخزين',
    },
  },
  he: {
    titles: {
      popup: 'BridgeDeck',
      options: 'הגדרות',
      quick: 'פעולות מהירות',
      longshot: 'צילום מסך מלא',
      debug: 'ניפוי האתר',
      audit: 'יומן ביקורת',
      ops: 'הקלטת פעולות',
      record: 'הקלטת וידאו',
      preview: 'תצוגה מקדימה',
    },
    labels: {
      connected: 'מחובר',
      disconnected: 'לא מחובר',
      version: 'גרסה',
      protocol: 'פרוטוקול',
      language: 'שפה',
      theme: 'ערכת נושא',
      save: 'שמור',
      saved: 'נשמר',
      restore: 'שחזר',
      capture: 'צלם',
      refresh: 'רענן',
      loading: 'טוען…',
      empty: 'אין נתונים',
      error: 'נכשל',
      unavailable: 'היכולת הזו עדיין לא הועברה לריצה מסוג TypeScript',
      targetTab: 'לשונית יעד',
      close: 'סגור',
      back: 'חזרה',
      entries: 'רשומות',
      requests: 'בקשות',
      rules: 'כללים',
      consoleLines: 'שורות קונסולה',
      selectTab: 'בחר תחילה לשונית יעד',
      done: 'הושלם',
      backend: 'אחסון',
    },
  },
};

/** 语言归一：`auto` 按浏览器语言猜；未知语言回落中文。 */
export function resolveUiLanguage(raw: unknown, navigatorLanguage?: string): UiLanguage {
  const text = String(raw ?? '').trim().toLowerCase();
  if (text === 'zh' || text === 'zh-cn' || text.startsWith('zh-')) return 'zh';
  if (text === 'ar' || text.startsWith('ar-')) return 'ar';
  if (text === 'he' || text.startsWith('he-') || text.startsWith('iw')) return 'he';
  if (text === 'en' || text.startsWith('en-')) return 'en';
  if (text === 'auto' || !text) {
    const detected = String(navigatorLanguage ?? '').toLowerCase();
    if (detected.startsWith('ar')) return 'ar';
    if (detected.startsWith('he') || detected.startsWith('iw')) return 'he';
    if (detected.startsWith('en')) return 'en';
    return 'zh';
  }
  return 'zh';
}

/** 页面标题（按语言）；未知页名回落 BridgeDeck。 */
export function uiTitle(language: UiLanguage, page: string): string {
  const table = TEXT[language] ?? TEXT.zh;
  const name = findUiPage(page)?.name;
  if (name && table.titles[name]) return table.titles[name];
  return 'BridgeDeck';
}

/** 文案查表（缺 key 时回落中文，再回落 key 本身）。 */
export function uiText(language: UiLanguage, key: string): string {
  const table = TEXT[language] ?? TEXT.zh;
  return table.labels[key] ?? TEXT.zh.labels[key] ?? key;
}

/** 当前页的查询参数（页面初始化一次即可）。 */
export function pageQuery(): URLSearchParams {
  try {
    return new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  } catch {
    return new URLSearchParams();
  }
}

export interface PageBootstrap {
  page: UiPageName | null;
  language: UiLanguage;
  query: URLSearchParams;
  /** 文案查表（已绑定语言）。 */
  t(key: string): string;
  /** 设置 document.title（自测会覆盖它）。 */
  setTitle(text: string): void;
}

/**
 * 页面引导：语言/RTL/标题 + 基础样式。幂等（重复调用只更新一次）。
 *
 * ```ts
 * const boot = setupPage('quick');
 * document.body.append(el('h1', {}, boot.t('quick')));
 * ```
 */
export function setupPage(pageName: string, options: { navigatorLanguage?: string } = {}): PageBootstrap {
  const query = pageQuery();
  const language = resolveUiLanguage(query.get('lang'), options.navigatorLanguage);
  const definition = findUiPage(pageName);
  const page = (definition?.name ?? null) as UiPageName | null;
  const t = (key: string): string => uiText(language, key);
  const setTitle = (text: string): void => {
    // title 固定到 head：RTL 页面标题（E2E 用 tab.title 断言语言生效）不会因 body 重绘丢失。
    setDocumentTitle(typeof document === 'undefined' ? null : document, text);
  };
  const applyDirection = (): void => {
    try {
      applyDocumentDirection(typeof document === 'undefined' ? null : document.documentElement, language);
    } catch {
      // 非文档环境（单测）忽略
    }
  };
  applyDirection();
  try {
    if (typeof document !== 'undefined' && document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', applyDirection, { once: true });
    }
  } catch {
    // 同上
  }
  applyBaseStyles();
  setTitle(page ? uiTitle(language, page) : 'BridgeDeck');
  return { page, language, query, t, setTitle };
}

/** 注入一份最小样式（子页面共用的暗色/亮色两套变量 + 基础组件）。 */
export function applyBaseStyles(): void {
  try {
    if (document.getElementById('bb-ui-base')) return;
    const style = document.createElement('style');
    style.id = 'bb-ui-base';
    style.textContent = `
:root { color-scheme: light dark; --bb-bg:#f7f8fa; --bb-fg:#1c1f23; --bb-muted:#5c6570; --bb-card:#ffffff; --bb-line:#dfe3e8; --bb-accent:#2f6feb; --bb-ok:#1a7f37; --bb-bad:#c0392b; }
@media (prefers-color-scheme: dark) { :root { --bb-bg:#16181b; --bb-fg:#e8eaed; --bb-muted:#9aa4ae; --bb-card:#1f2226; --bb-line:#2d3238; --bb-accent:#6fa0ff; --bb-ok:#4ec27a; --bb-bad:#ff6b5e; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bb-bg); color: var(--bb-fg); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
h1 { font-size: 18px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 16px 0 8px; }
p { margin: 4px 0; }
.muted { color: var(--bb-muted); }
.card { background: var(--bb-card); border: 1px solid var(--bb-line); border-radius: 10px; padding: 12px 14px; margin: 10px 0; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
button { font: inherit; padding: 7px 12px; border-radius: 8px; border: 1px solid var(--bb-line); background: var(--bb-card); color: var(--bb-fg); cursor: pointer; }
button.primary { background: var(--bb-accent); border-color: var(--bb-accent); color: #fff; }
button:disabled { opacity: .55; cursor: not-allowed; }
select, input[type=text], input[type=url] { font: inherit; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--bb-line); background: var(--bb-card); color: var(--bb-fg); min-width: 0; }
.status { font-weight: 600; }
.status.ok { color: var(--bb-ok); }
.status.bad { color: var(--bb-bad); }
.list { margin: 0; padding-inline-start: 18px; }
img.preview { max-width: 100%; border: 1px solid var(--bb-line); border-radius: 8px; background: #fff; }
.feature { text-align: start; padding: 14px; border-radius: 10px; border: 1px solid var(--bb-line); background: var(--bb-card); cursor: pointer; }
.feature strong { display: block; margin-bottom: 4px; }
`;
    document.head.appendChild(style);
  } catch {
    // 非文档环境忽略
  }
}

// ---------------------------------------------------------------------------
// DOM 小工具
// ---------------------------------------------------------------------------

export interface ElementOptions {
  className?: string;
  id?: string;
  title?: string;
  text?: string;
  html?: string;
  attrs?: Record<string, string>;
  onClick?: (event: Event) => void;
}

/** 建一个元素（比 innerHTML 安全：文本一律 textContent）。 */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, options: ElementOptions = {}, children: Array<Node | string> = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.id) node.id = options.id;
  if (options.title) node.setAttribute('title', options.title);
  if (options.text !== undefined) node.textContent = options.text;
  if (options.html !== undefined) node.innerHTML = options.html;
  for (const [key, value] of Object.entries(options.attrs ?? {})) node.setAttribute(key, value);
  if (options.onClick) node.addEventListener('click', options.onClick);
  for (const child of children) node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  return node;
}

/** 自测结果写进标题（E2E 轮询 tab.title 判定；也给人看）。 */
export function reportSelftest(kind: string, detail: string, ok = true): void {
  try {
    document.title = (ok ? 'SELFTEST:ok:' : 'SELFTEST:fail:') + kind + ':' + detail;
  } catch {
    // 忽略
  }
}

/** 安全地把任意值渲染成一行文本（错误信息/证据）。 */
export function describeValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
