import { LOCALE_TEXT, SUPPORTED_LANGS } from './locales.js';
// ui/i18n.js —— 运行时中英切换（默认跟随浏览器语言）
const LANG_KEY = 'bb.uiLang';
const RTL_LANG = /^(ar|he|fa|ur|yi|dv|ps|sd|ug|ckb)\b/i;
const DICT = {
  "无障碍浮层（读屏可访问）": "Accessible overlays (screen-reader friendly)",
  "开启后浮层使用开放 shadow DOM，并标注 role/aria-live，方便读屏与自动化审查；默认关闭。": "Uses open shadow DOM with role/aria-live labels for screen readers and audit tools. Off by default.",
  "生成一段给 Agent 的录制指令：Agent 启动录制后你正常操作，结束后 Agent 读取写出的 trace 目录包，就能自动完成同类任务。": "Generate a recording instruction for your agent: after the agent starts recording, operate normally; when you finish, the agent reads the exported trace directory and can automate similar tasks.",
  "录制给 Agent": "Record for the agent",
  "直接录制": "Record directly",
  "录制指令预览": "Recording instruction preview",
  "未连接": "Disconnected",
  "已连接": "Connected",
  "连接中": "Connecting",
  "协议偏差": "Protocol mismatch",
  "已关闭": "Off",
  "连接中…": "Connecting…",
  "未命名浏览器": "Unnamed browser",
  "当前浏览器": "Current browser",
  "复制指令": "Copy command",
  "连接设置": "Connection settings",
  "· 本机": "· Local",
  "本机 · 未连接": "Local · Disconnected",
  "本机": "Local",
  "远程配对": "Remote pairing",
  "本机端口": "Local port",
  "留空恢复默认端口。": "Leave empty to restore the default port.",
  "保存端口": "Save port",
  "保存并连接": "Save and connect",
  "恢复本机": "Back to local",
  "控制提示": "Control hint",
  "Agent 控制页面时显示提示条和蓝色高亮。": "Show a hint bar and blue highlight while the agent controls the page.",
  "自动化设置": "Automation",
  "借用标签页前确认": "Confirm before borrowing tabs",
  "开启时，借用你已打开的标签页前会请求允许；关闭时，直接借用。自动保存到当前浏览器配置，对到达插件的所有会话请求生效；命令行参数不能覆盖。": "When on, the agent asks before taking over one of your tabs. Saved in this browser profile and applies to every session; command-line flags cannot override it.",
  "允许请求人工协助": "Allow human help requests",
  "开启时，Agent 可以请求你协助。关闭时，Agent 会尽力自主完成操作，遇到无法处理的步骤再报告受阻。自动保存到当前浏览器配置，对到达插件的所有会话请求生效；命令行参数不能覆盖。": "When on, the agent may ask you for help. When off, it tries to finish alone and reports a blocker instead. Saved in this browser profile for all sessions; command-line flags cannot override it.",
  "当前任务": "Current tasks",
  "实例 ID": "Instance ID",
  "快捷功能": "Quick actions",
  "视频录制": "Video recording",
  "将任务标签页录制为 MP4 视频": "Record a task tab as MP4 video",
  "网站调试": "Website debugging",
  "记录请求、异常与页面上下文，随时回看": "Capture requests, errors and page context for later review",
  "本地分片": "Local chunks",
  "扫描": "Scan",
  "恢复最新": "Restore latest",
  "尚未扫描": "Not scanned yet",
  "没有本地分片": "No local chunks",
  "没有可恢复的本地分片": "No recoverable local chunks",
  "长截图": "Full-page screenshot",
  "从网页顶部截到底部，预览并保存长图": "Capture the page from top to bottom, preview and save",
  "操作录制": "Action recording",
  "录制你的操作，供 Agent 参考": "Record your actions as a reference for the agent",
  "操作审计": "Task audit",
  "操作审计介绍": "Task audit",
  "在完整页面打开": "Open full page",
  "面板": "Panel",
  "BridgeDeck · 设置": "BridgeDeck · Settings",
  "这些设置立刻对已打开和新建的任务生效，保存在当前浏览器配置里。": "These settings apply immediately to open and new tasks and are saved in this browser profile.",
  "浏览器实例": "Browser instance",
  "名称": "Name",
  "给这个浏览器起个名字，Agent 可用": "Name this browser so the agent can select it with",
  "精确选中它。": "to target it precisely.",
  "复制该实例的启动命令": "Copy this instance's start command",
  "自动化": "Automation",
  "Agent 接管你已有的标签页前，先在页面顶部弹出确认条。": "Show a confirmation before the agent takes over one of your tabs.",
  "允许 Agent 请你处理登录、验证码等必须本人参与的步骤。": "Allow the agent to ask you for login, CAPTCHA or other steps only you can complete.",
  "页面守卫": "Page guard",
  "外部链接或手动新建的标签页落进 Agent 窗口时，自动移回普通窗口。": "Move external or manually opened tabs back to a normal window when they land in the agent window.",
  "默认长截图模式": "Default full-page mode",
  "自动滚动": "Auto scroll",
  "手动拼接": "Manual stitch",
  "保存设置": "Save settings",
  "恢复默认": "Restore defaults",
  "数据默认只在本机流转；详见": "Data stays on this machine by default. See",
  "隐私说明": "Privacy notice",
  "快捷功能 · BridgeDeck": "Quick actions · BridgeDeck",
  "操作审计 · BridgeDeck": "Task audit · BridgeDeck",
  "浏览器本地记录": "Stored locally in this browser",
  "记录仅保存在本机，已结束的任务保留 30 天。只保存方法名、耗时、结果码、会话、标签页与 URL； 输入值、页面正文与截图不会保存。可用": "Records stay on this machine for 30 days. Only method, duration, result code, session, tab and URL are saved; input values, page text and screenshots are not. Use",
  "读取，": "to read;",
  "可关闭。": "",
  "全部任务": "All tasks",
  "最近 1 小时": "Last hour",
  "最近 24 小时": "Last 24 hours",
  "最近 7 天": "Last 7 days",
  "清空记录": "Clear records",
  "刷新": "Refresh",
  "还没有任务记录。后续通过 BridgeDeck 执行的操作会显示在这里。": "No task records yet. Operations run through BridgeDeck will appear here.",
  "视频录制 · BridgeDeck": "Video recording · BridgeDeck",
  "录制": "Record",
  "开始录制": "Start recording",
  "停止录制": "Stop recording",
  "未开始": "Not started",
  "录制的是标签页画面（无声）。浏览器会在标签页上显示「正在共享」提示。 优先用 MP4（H.264），浏览器不支持时自动退回 WebM。": "Records the tab (silent). The browser shows a sharing indicator. MP4 (H.264) is preferred and falls back to WebM.",
  "录制文件": "Recordings",
  "还没有录制文件": "No recordings yet",
  "关闭预览": "Close preview",
  "操作录制历史": "Action recording history",
  "录制文件在当前浏览器保留 24 小时，请及时保存重要视频。": "Recordings are kept for 24 hours in this browser. Save important videos promptly.",
  "最近录制": "Recent recordings",
  "还没有录制视频。": "No videos yet.",
  "完整录制页": "Open recording page",
  "长截图 · BridgeDeck": "Full-page screenshot · BridgeDeck",
  "自动滚动整页，或手动滚动采集，将内容拼成清晰长图。": "Auto-scroll the page or capture it manually, then stitch a long image.",
  "预览": "Preview",
  "打开预览": "Open preview",
  "截图暂不可用": "Screenshot unavailable",
  "预览可能已过期或被清理。请回到网页，通过快捷功能重新截图。": "The preview may have expired or been cleared. Go back to the page and capture again.",
  "重新截图（高级）": "Capture again (advanced)",
  "目标与模式": "Target and mode",
  "截取整页": "Capture full page",
  "自动滚动并拼接，最多 8 屏": "Auto-scroll and stitch, up to 8 screens",
  "开始拼接": "Start stitching",
  "拍一帧": "Capture frame",
  "拼接": "Stitch",
  "0 帧": "0 frames",
  "保存到下载目录": "Save to Downloads",
  "丢弃": "Discard",
  "网站调试 · BridgeDeck": "Website debugging · BridgeDeck",
  "每一次调查，都有迹可循。": "Every investigation leaves a trail.",
  "查看网页上下文、请求和异常，或导出记录交给 Agent 分析。": "Inspect page context, requests and errors, or export records for the agent.",
  "手动采集（高级）": "Manual capture (advanced)",
  "开始采集": "Start capture",
  "停止采集": "Stop capture",
  "采集当前标签页的请求元数据（方法/状态/耗时）与控制台输出/未捕获异常；停止后保存为历史，最多保留 10 条。": "Capture request metadata (method/status/duration), console output and uncaught errors from this tab; keep up to 10 runs.",
  "请求": "Requests",
  "导出 JSON": "Export JSON",
  "还没有请求": "No requests yet",
  "控制台 / 异常": "Console / errors",
  "没有控制台输出": "No console output",
  "页面上下文": "Page context",
  "历史记录": "History",
  "还没有调试记录": "No debug records yet",
  "把网站地址和遇到的问题告诉 Agent，它会建立任务并开启采集。": "Tell the agent the URL and the problem; it will start a capture.",
  "历史详情": "History details",
  "关闭": "Close",
  "调试记录保存在当前浏览器本地，任务结束后仍可查看和导出。保留最近 30 天、最多 50 份、总计 50 MiB；常见凭据脱敏，正文有上限。": "Debug records stay in this browser after the task ends. Kept for 30 days, up to 50 runs and 50 MiB; credentials are redacted and bodies are capped.",
  "采集范围与限制": "Scope and limits",
  "记录请求元数据（方法/状态/耗时）、控制台输出与未捕获异常、页面基础上下文；不记录请求正文与截图。单次采集在本地保留 10 条历史。": "Records request metadata, console output, uncaught errors and basic page context; request bodies and screenshots are not recorded. Each capture keeps 10 local runs.",
  "操作录制 · BridgeDeck": "Action recording · BridgeDeck",
  "录制你的点击/输入/选择/导航，导出 JSON 给 Agent 参考": "Record clicks, input, selections and navigation as JSON for the agent",
  "录制只发生在你选中的这个标签页；密码框的值会被记成": "Recording stays in the selected tab; password values are stored as",
  "。 停止后可导出 JSON，配合": ". Stop, then export JSON and use it with",
  "或": "or",
  "复制": "Copy",
  "未配对": "Unpaired",
  "已验证": "Verified",
  "已连接 · 未配对": "Connected · Unpaired",
  "已连接 · 已验证": "Connected · Verified",
  "远程": "Remote",
  "界面语言 / Language": "Language",
  "保存图片": "Save image",
  "停止并保存": "Stop and save",
  "复制录制指令": "Copy recording command",
  "复制给 Agent 的指令": "Copy agent command",
  "复制给 Agent 的提示词": "Copy agent prompt",
  "已打开手动长截图页": "Opened manual full-page page",
  "开关读写异常": "Failed to read or write switch",
  "开启操作审计": "Enable task audit",
  "开始截图": "Start capture",
  "当前可视区域": "Visible area",
  "当前页面": "Current page",
  "录制完成": "Recording complete",
  "手动录制正在运行的任务": "Record a running task manually",
  "打开录制页": "Open recording page",
  "操作主题（可选）": "Recording topic (optional)",
  "整页 · 自动滚动": "Full page · Auto scroll",
  "时长上限（1–600 秒）": "Max duration (1–600 s)",
  "标准 1280/15": "Standard 1280/15",
  "标准 · 1280 / 15 帧": "Standard · 1280/15 fps",
  "正在停止…": "Stopping…",
  "正在开始录制…": "Starting recording…",
  "正在截取…": "Capturing…",
  "清晰 1920/30": "Clear 1920/30",
  "清晰 · 1920 / 30 帧": "Clear · 1920/30 fps",
  "长图 · 我来滚动": "Full page · I will scroll",
  "需要 ws:// 或 wss:// 地址": "A ws:// or wss:// address is required",
  "非本机连接必须使用 wss://": "Non-local connections must use wss://",
  "配对保存失败": "Pairing save failed",
  "配对恢复失败": "Pairing restore failed",
  "配对链接解析失败": "Pairing link parse failed",
  "本机 · ws://127.0.0.1:": "Local · ws://127.0.0.1:",
  "最近录制（": "Recent recordings (",
  "录制中…": "Recording…",
  "录制中 ·": "Recording ·",
  "开始失败：": "Failed to start: ",
  "停止失败：": "Failed to stop: ",
  "保存失败：": "Save failed: ",
  "截图失败：": "Screenshot failed: ",
  "已保存：": "Saved: ",
  "例如：工作账号": "e.g. Work account",
  "名字": "name",
  "读取，可在弹窗关闭。": "to read it; turn it off in the popup.",
  "可在弹窗关闭。": "it can be turned off in the popup.",
  "记录请求、异常与页面上下文": "Capture requests, errors and page context",
  "从网页顶部截到底部，预览并保存": "Capture from top to bottom, preview and save",
  "查看任务操作审计": "View task audit",
  "启用操作审计": "Enable task audit",
  "读取中…": "Reading…",
  "打开完整审计": "Open full audit",
  "自动滚动并拼接当前标签页，完成后可在完整页预览保存。": "Auto-scroll and stitch this tab, then preview and save on the full page.",
  "模式": "Mode",
  "自动整页": "Auto full page",
  "仅可见区域": "Visible area only",
  "打开完整页": "Open full page",
  "录制当前标签页为 MP4；停止后文件写入视频库。": "Record this tab as MP4; the file is saved to the video library after stopping.",
  "停止": "Stop",
  "历史": "History",
  "记录当前标签页的操作步骤，供 Agent 参考。": "Record actions in this tab as a reference for the agent.",
  "版本不一致": "Version mismatch",
  "复制命令": "Copy command",
  "由": "by",
  "生成；保存前核对命令输出的 6 位配对码。": "generated; verify the 6-digit pairing code before saving.",
  "保存配对": "Save pairing",
  "切换到本机": "Switch to local",
  "高级：手动填写地址与 token": "Advanced: enter address and token manually",
  "配对设备": "Paired devices",
  "全部撤销": "Revoke all",
  "接管时阻止页面点击/滚动": "Block page clicks/scroll while controlling",
  "开启后，Agent 接管期间页面点击和滚动会被阻止（键盘不拦截）；点浮层的暂停/收起会立即放开。默认关闭。": "When on, page clicks and scrolling are blocked while the agent controls (keyboard is not blocked). Pause/minimize releases it immediately. Off by default.",
  "--browser <名字>": "--browser <name>",
  "--browser &lt;名字&gt;": "--browser <name>",
  "开启后，接管期间页面点击和滚动会被阻止（键盘不拦截）；点浮层的暂停/收起会立即放开。默认关闭。": "When on, page clicks and scrolling are blocked while controlling (keyboard is not blocked). Pause/minimize releases it immediately. Off by default.",
  "中文": "Chinese",
  "繁體中文": "Traditional Chinese",
  "日本語": "Japanese",
  "返回": "Back",
  "BridgeDeck 连接": "BridgeDeck connection",
  "修改浏览器名称": "Change browser name",
  "复制后发给 Agent，指定当前浏览器": "Copy and send to the agent to target this browser",
  "未配对：连接身份未验证，建议 bridge daemon pair": "Unpaired: connection identity is unverified; run bridge daemon pair",
  "粘贴配对链接（含端口与凭据）": "Paste pairing link (with port and credential)",
  "6 位配对码（bridge daemon pair 显示）": "6-digit pairing code (shown by bridge daemon pair)",
  "配对 token": "Pairing token",
  "控制提示说明": "Control hint description",
  "借用标签页确认说明": "Borrow confirmation description",
  "允许人工协助说明": "Allow human help description",
  "输入锁说明": "Input lock description",
  "Agent 控制时锁定页面输入": "Block page input while the agent controls",
  "复制实例 ID": "Copy instance ID",
  "性能指标": "Performance metrics",
  "先选一个目标标签页": "Select a target tab first",
  "请求规则": "Request rules",
  "给当前标签页加临时规则：fulfill / block / modify（URL 支持 *）。规则只在本浏览器本地生效，刷新后自动重注入。": "Add a temporary rule to this tab: fulfill / block / modify (URL supports *). Rules apply only in this browser and are re-injected after refresh.",
  "添加": "Add",
  "清空": "Clear",
  "当前标签页没有规则": "No rules for this tab",
  "操作时间线": "Action timeline",
  "还没有操作记录": "No actions recorded yet",
  "URL pattern，例如 */api/*": "URL pattern, e.g. */api/*",
  "fulfill 的响应正文（block/modify 可留空）": "Response body for fulfill (can be empty for block/modify)",
  "复现步骤。": "Reproduction steps.",
  "录制记录": "Recordings",
  "还没有录制记录": "No recordings yet",
  "JSON 预览": "JSON preview",
  "聚焦标签页": "Focus tab",
  "隐私说明 · BridgeDeck": "Privacy notice · BridgeDeck",
  "数据默认只在本机流转": "Data stays on this machine by default",
  "保存什么": "What is stored",
  "调试记录、长截图、视频和操作录制默认保存在当前浏览器的本地存储中，不会上传到服务器。\n        调试记录保留最近 30 天，最多 50 份、总计 50 MiB；凭据类字段会脱敏，正文有大小上限。": "Debug records, full-page screenshots, videos and action recordings are stored in this browser's local storage by default and are not uploaded to a server.\n        Debug records are kept for 30 days, up to 50 entries and 50 MiB total; credential fields are redacted and bodies have a size limit.",
  "不保存什么": "What is not stored",
  "不保存输入框密码值、页面完整正文和截图内容到调试历史。操作录制会把密码框的值记成": "Password field values, full page text and screenshot contents are not stored in debug history. Action recording stores password values as",
  "。远程配对令牌只保存在扩展私有存储中，不写入普通偏好设置。": ". Remote pairing tokens are stored only in extension private storage, not in normal preferences.",
  "你的控制": "Your controls",
  "你可以在弹窗或设置页关闭连接、控制提示、自动化设置；可以随时清空调试历史、录制和视频。\n        本扩展只连接": "You can turn off the connection, control hints and automation settings in the popup or options page, and clear debug history, recordings and videos at any time.\n        This extension only connects to",
  "上的本地 daemon；远程连接必须由你主动配置并授权。": "the local daemon; remote connections must be configured and authorized by you.",
  "已保存": "Saved",
  "已恢复默认": "Defaults restored",
  "已复制：": "Copied: ",
  "复制失败，请手动复制：": "Copy failed, copy manually: ",
  "配对码需为 6 位数字": "Pairing code must be 6 digits",
  "地址格式不正确": "Invalid address format",
  "已清空本机任务审计记录": "Local task audit records cleared",
  "目标标签页": "Target tab",
  "起始网址（可选）": "Start URL (optional)",
  "例如：发布一篇文章": "e.g. publish an article",
  "协议": "Protocol",
};
const PATTERNS = [
  [/^(\d+) 秒$/,'$1 s'],
  [/^最近录制（(\d+)）$/,'Recent recordings ($1)'],
  [/^时长上限（(\d+).*?）$/,'Max duration ($1 s)'],
  [/^协议偏差：daemon (.+)，扩展 (.+)$/, 'Protocol mismatch: daemon $1, extension $2'],
  [/^已连接 · 未配对$/, 'Connected · Unpaired'],
  [/^已连接 · 已验证$/, 'Connected · Verified'],
  [/^(\d+) 帧$/, '$1 frames'],
  [/^(\d+) 个文件$/, '$1 files'],
  [/^(\d+) 条$/, '$1 items'],
  [/^(\d+) 条记录$/, '$1 records'],
  [/^(\d+) 秒后自动拒绝$/, 'Auto-deny in $1 s'],
  [/^已保存：(.+)$/, 'Saved: $1'],
  [/^已复制：?(.*)$/, 'Copied$1'],
  [/^录制中… ?(.*)$/, 'Recording… $1'],
  [/^正在(.+)$/, 'Working: $1'],
  [/^开始失败：?(.*)$/, 'Failed to start$1'],
  [/^保存失败：?(.*)$/, 'Failed to save$1'],
  [/^截图失败：?(.*)$/, 'Screenshot failed$1'],
  [/^拼接失败：?(.*)$/, 'Stitch failed$1'],
  [/^复制失败：?(.*)$/, 'Copy failed$1'],
  [/^读取失败：?(.*)$/, 'Read failed$1'],
  [/^未知错误$/, 'Unknown error'],
];
let current = 'zh';
let observer = null;

export function getLang() {
  return current;
}

function normalizeLang(value) {
  if (SUPPORTED_LANGS.includes(value)) return value;
  if (String(value || '').toLowerCase() === 'auto') return browserLang();
  return browserLang();
}
function browserLang() {
  const raw = String(navigator.language || '').toLowerCase();
  if (raw.startsWith('zh-tw') || raw.startsWith('zh-hk')) return 'zh-TW';
  if (raw.startsWith('zh')) return 'zh';
  if (raw.startsWith('ar')) return 'ar';
  if (raw.startsWith('he') || raw.startsWith('iw')) return 'he';
  for (const code of ['ja','ko','de','es','fr','it','pt']) if (raw.startsWith(code)) return code;
  return 'en';
}

export async function loadLang() {
  try {
    const fromUrl = new URLSearchParams(location.search).get('lang');
    if (SUPPORTED_LANGS.includes(fromUrl)) { current = fromUrl; return current; }
    const stored = await chrome.storage.local.get(LANG_KEY);
    current = normalizeLang(stored && stored[LANG_KEY]);
  } catch {
    current = normalizeLang(null);
  }
  return current;
}

export function translate(text) {
  if (current === 'zh') return text;
  const raw = String(text);
  const trimmed = raw.trim();
  if (!trimmed || !/[\u4e00-\u9fa5]/.test(trimmed)) return raw;
  const normalized = trimmed.replace(/\s+/g, ' ');
  const localized = (LOCALE_TEXT[trimmed] && LOCALE_TEXT[trimmed][current]) || (LOCALE_TEXT[normalized] && LOCALE_TEXT[normalized][current]);
  if (localized !== undefined) return raw.replace(trimmed, localized);
  const exact = DICT[trimmed] !== undefined ? DICT[trimmed] : DICT[normalized];
  if (exact !== undefined) return raw.replace(trimmed, exact);
  for (const [pattern, replacement] of PATTERNS) {
    if (pattern.test(trimmed)) return raw.replace(trimmed, trimmed.replace(pattern, replacement));
  }
  return raw;
}

function translateNode(root) {
  if (!root) return;
  if (root.nodeType === Node.TEXT_NODE) {
    if (root.nodeValue && /[\u4e00-\u9fa5]/.test(root.nodeValue)) {
      const next = translate(root.nodeValue);
      if (next !== root.nodeValue) root.nodeValue = next;
    }
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const tag = root.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE') return;
  for (const attr of ['title', 'placeholder', 'aria-label']) {
    const value = root.getAttribute(attr);
    if (value && /[\u4e00-\u9fa5]/.test(value)) {
      const next = translate(value);
      if (next !== value) root.setAttribute(attr, next);
    }
  }
  for (const child of root.childNodes) translateNode(child);
}

function observe() {
  if (observer) return;
  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) translateNode(node);
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

let readyPromise = null;

export function whenReady() {
  return readyPromise || (readyPromise = initI18n());
}

export async function initI18n() {
  const lang = await loadLang();
  const HTML_LANG = { zh: 'zh-CN', en: 'en', ja: 'ja', ko: 'ko', de: 'de', es: 'es', fr: 'fr', it: 'it', pt: 'pt', 'zh-TW': 'zh-TW', ar: 'ar', he: 'he' };
  document.documentElement.lang = HTML_LANG[lang] || lang;
  const forcedDir = new URLSearchParams(location.search).get('dir');
  const dir = forcedDir === 'rtl' || forcedDir === 'ltr'
    ? forcedDir
    : (RTL_LANG.test(lang) ? 'rtl' : 'ltr');
  document.documentElement.dir = dir;
  document.documentElement.setAttribute('data-bb-dir', dir);
  if (lang === 'zh') return lang;
  const apply = () => {
    if (document.title) {
      const translated = translate(document.title);
      if (translated) document.title = translated;
    }
    translateNode(document.body);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply, { once: true });
  else apply();
  observe();
  return lang;
}

export async function setLang(lang) {
  const next = SUPPORTED_LANGS.includes(lang) ? lang : 'zh';
  await chrome.storage.local.set({ [LANG_KEY]: next });
  current = next;
  location.reload();
}

whenReady();
