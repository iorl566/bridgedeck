// src/ui/catalog.ts —— 扩展子页面清单（单源）。
//
// `ui.open`（CLI `bridge ui --page <name>`）与 doctor/diagnostics 共用这一份清单：
// - 页面名 → 产物内的 HTML 路径（WXT 把 entrypoints/*.html 输出到产物根）；
// - 每个页面显式标注它依赖的运行时能力与"当前是否可用"，避免把未迁移的能力说成能用；
// - 别名只做 `--page` 参数归一（例如 record/video 指向同一页）。
//
// 这里刻意不 import 浏览器 API：纯数据 + 纯函数，CLI/诊断/单测都能直接用。

export type UiPageName =
  | 'popup'
  | 'options'
  | 'quick'
  | 'longshot'
  | 'debug'
  | 'audit'
  | 'ops'
  | 'record'
  | 'preview';

export interface UiPageDefinition {
  name: UiPageName;
  /** 产物内的路径（相对扩展根）。 */
  path: string;
  /** `--page` 接受的其他写法。 */
  aliases: readonly string[];
  /** 中文标题（与页面 document.title 的默认语言一致）。 */
  title: string;
  /** 一句话说明。 */
  description: string;
  /** 该页面依赖的运行时能力（技能名；诊断时逐项检查）。 */
  requires: readonly string[];
  /** 能力是否已在本运行时迁移（false = 页面存在但会显式显示"未迁移"）。 */
  available: boolean;
}

export const UI_PAGES: readonly UiPageDefinition[] = Object.freeze([
  {
    name: 'popup',
    // 与 0.3.0 JS 产物布局对齐（JS: action.default_popup = ui/popup.html）。
    // WXT 把 entrypoints/popup/index.html 输出到根 popup.html；wxt.config.ts 的
    // ui-html 插件额外产出 ui/popup.html 别名页（同一份 HTML/chunk），因此根路径与
    // ui/ 路径都可用，E2E 与 JS parity 期望的 ui/popup.html 同时成立。
    path: 'ui/popup.html',
    aliases: ['action', 'toolbar'],
    title: 'BridgeDeck',
    description: '扩展弹窗：连接状态、会话、开关与快捷入口',
    requires: ['status', 'settings'],
    available: true,
  },
  {
    name: 'options',
    path: 'options.html',
    aliases: ['settings'],
    title: '设置',
    description: '扩展设置：语言/主题、人工开关、远程配对',
    requires: ['settings'],
    available: true,
  },
  {
    name: 'quick',
    path: 'quick.html',
    aliases: ['features'],
    title: '快捷功能',
    description: '快捷功能：长截图 / 网站调试 / 视频录制 / 操作录制 / 操作审计',
    requires: ['ui.open'],
    available: true,
  },
  {
    name: 'longshot',
    path: 'longshot.html',
    aliases: ['capture'],
    title: '长截图',
    description: '整页长截图：滚动分段拼接、固定带重绘、本地分片恢复',
    requires: ['screenshot', 'longshot.recover'],
    available: true,
  },
  {
    name: 'debug',
    path: 'debug.html',
    aliases: ['devtools'],
    title: '网站调试',
    description: '网站调试：请求/console 采集、规则面板、性能与重放',
    requires: ['debug.start', 'debug.performance'],
    available: true,
  },
  {
    name: 'audit',
    path: 'audit.html',
    aliases: ['journal'],
    title: '操作审计',
    description: '操作审计：读取 daemon 审计日志（只读）',
    requires: ['audit.list'],
    available: true,
  },
  {
    name: 'ops',
    path: 'ops.html',
    aliases: ['record-ops', 'operation-record'],
    title: '操作录制',
    description: '操作录制：记录人工操作步骤（record.* 运行时尚未迁移）',
    requires: ['record.start', 'record.list'],
    available: false,
  },
  {
    name: 'record',
    path: 'record.html',
    aliases: ['video'],
    title: '视频录制',
    description: '视频录制：标签页录制成 MP4/WebM（video.* 运行时尚未迁移）',
    requires: ['video.start', 'video.save'],
    available: false,
  },
  {
    name: 'preview',
    path: 'preview.html',
    aliases: ['image'],
    title: '截图预览',
    description: '截图预览：查看长截图/标注图',
    requires: ['screenshot'],
    available: true,
  },
]);

/** 页面名归一（小写、去空白、去扩展名）；未知名返回空串。 */
export function normalizeUiPageName(raw: unknown): UiPageName | '' {
  const text = String(raw ?? '').trim().toLowerCase().replace(/\.html$/, '');
  if (!text) return '';
  for (const page of UI_PAGES) {
    if (page.name === text) return page.name;
    if (page.aliases.includes(text)) return page.name;
  }
  return '';
}

/** 查找页面定义；未知返回 null。 */
export function findUiPage(raw: unknown): UiPageDefinition | null {
  const name = normalizeUiPageName(raw);
  if (!name) return null;
  return UI_PAGES.find((page) => page.name === name) ?? null;
}

/** 默认页（CLI `bridge ui` 不带 --page 时）。 */
export const DEFAULT_UI_PAGE: UiPageName = 'popup';

/** 全部页面名（CLI 帮助与诊断用）。 */
export function uiPageNames(): UiPageName[] {
  return UI_PAGES.map((page) => page.name);
}

/**
 * 诊断视图：doctor `extension-ui` 与 settings 页共用。
 * `resolveUrl` 注入 `runtime.getURL`（Node 单测传纯函数），避免本模块依赖浏览器 API。
 */
export function uiDiagnostics(resolveUrl: (path: string) => string, version: string): Record<string, unknown> {
  const pages: Record<string, unknown> = {};
  for (const page of UI_PAGES) {
    pages[page.name] = {
      ok: page.available,
      path: page.path,
      url: resolveUrl(page.path),
      title: page.title,
      requires: [...page.requires],
      available: page.available,
      ...(page.available ? {} : { missing: page.requires.slice() }),
    };
  }
  const unavailablePages = UI_PAGES.filter((page) => !page.available).map((page) => page.name);
  return {
    // ok 的语义是"页面产物齐全、能打开"；能力缺口单独放在 gaps 里（doctor 的 extension-ui
    // 检查的是自检可用性，不该因为某个页面依赖未迁移能力就判失败）。
    ok: true,
    runtime: 'ts',
    packageVersion: version,
    pages,
    pageCount: UI_PAGES.length,
    availablePages: UI_PAGES.filter((page) => page.available).map((page) => page.name),
    unavailablePages,
    gaps: unavailablePages.map((name) => ({ page: name, reason: '依赖的运行时能力尚未迁移' })),
    note: unavailablePages.length === 0
      ? 'TS 运行时子页面全部可用'
      : '以下页面依赖尚未迁移的运行时能力（页面仍可打开，但会显式显示缺口）：' + unavailablePages.join(','),
  };
}
