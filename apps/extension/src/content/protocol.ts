// src/content/protocol.ts —— background ↔ content script 的最小动作桥消息契约。
//
// 为什么单独定义而不复用 shared/messages.ts：那一层是 UI/background 的 runtime
// 消息；这一层只在扩展内部跨 tab 传输，需要在内容脚本侧做一次不可信输入校验
// （页面无法伪造 runtime 消息，但 background 代码的 bug 不应该把内容脚本拖垮）。
//
// 形状：
//   background → content: { type:'bb.content', requestId, op, params }
//   content → background: { ok:true, result } | { ok:false, code, message, data? }
//
// op 分三批迁移：
// - M-C 第二批：observe/click/fill/read 四个核心 + select/get-html/evaluate；
// - M-C 第三批（本文件新增）：只读事实（metrics/element-state/visual-refs/
//   network-entries）、只读提取（extract）与薄动作（scroll/hover/focus/press/wheel/
//   blur/drag/click-point）。所有动作仍然不使用 chrome.debugger，证据字段如实标注
//   via:'content-script' / trusted:false / synthetic:true。
// 未迁移的 op 一律 E_UNKNOWN_OP，而不是静默忽略。

/** 内容脚本认识的页面动作。 */
export type ContentOp =
  | 'ping'
  | 'observe'
  | 'click'
  | 'fill'
  | 'read'
  | 'select'
  | 'get-html'
  | 'evaluate'
  | 'metrics'
  | 'scroll'
  | 'element-state'
  | 'visual-refs'
  | 'hover'
  | 'focus'
  | 'press'
  | 'wheel'
  | 'blur'
  | 'drag'
  | 'click-point'
  | 'extract'
  | 'network-entries'
  // M-C 第四批：页面事实 / 协作时钟 / 收据校验 / 文件 / 手动浮层
  | 'cooperation-state'
  | 'page-state'
  | 'check-facts'
  | 'frame-inventory'
  | 'manual-overlay'
  | 'upload-prepare'
  | 'upload-chunk'
  | 'upload-commit'
  // M-C 第八批：截图期间隐藏 takeover 浮层（隐藏/恢复/查询）
  | 'overlay-suppress';

export const CONTENT_OPS: readonly ContentOp[] = Object.freeze([
  'ping',
  'observe',
  'click',
  'fill',
  'read',
  'select',
  'get-html',
  'evaluate',
  'metrics',
  'scroll',
  'element-state',
  'visual-refs',
  'hover',
  'focus',
  'press',
  'wheel',
  'blur',
  'drag',
  'click-point',
  'extract',
  'network-entries',
  'cooperation-state',
  'page-state',
  'check-facts',
  'frame-inventory',
  'manual-overlay',
  'upload-prepare',
  'upload-chunk',
  'upload-commit',
  'overlay-suppress',
]);

const CONTENT_OP_SET: ReadonlySet<string> = new Set(CONTENT_OPS);

export function isContentOp(value: unknown): value is ContentOp {
  return typeof value === 'string' && CONTENT_OP_SET.has(value);
}

/** background → content 的请求。 */
export interface ContentRequest {
  type: 'bb.content';
  requestId: string;
  op: ContentOp;
  params: Record<string, unknown>;
}

export interface ContentReplyFailure {
  ok: false;
  code: string;
  message: string;
  data?: unknown;
}

export type ContentReply<T = unknown> = { ok: true; result: T } | ContentReplyFailure;

export type ContentParseResult =
  | { ok: true; request: ContentRequest }
  | { ok: false; error: ContentReplyFailure };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function badRequest(message: string): ContentParseResult {
  return { ok: false, error: { ok: false, code: 'E_BAD_REQUEST', message } };
}

/**
 * 校验/规范化一条内容脚本请求（用于内容脚本侧入口与单测）。
 * 非法 op / 缺少 requestId 返回结构化错误，不抛异常（内容脚本不能因为一条坏消息挂掉）。
 */
export function parseContentRequest(raw: unknown): ContentParseResult {
  if (!isRecord(raw)) return badRequest('内容脚本请求必须是对象');
  if (raw.type !== undefined && raw.type !== 'bb.content') return badRequest('未知内容脚本消息类型');
  const op = raw.op;
  if (!isContentOp(op)) {
    return {
      ok: false,
      error: { ok: false, code: 'E_UNKNOWN_OP', message: '内容脚本不支持的操作：' + String(op ?? ''), data: { op: String(op ?? '') } },
    };
  }
  const requestId = typeof raw.requestId === 'string' && raw.requestId ? raw.requestId : '';
  if (!requestId) return badRequest('内容脚本请求缺少 requestId');
  const params = isRecord(raw.params) ? raw.params : {};
  return { ok: true, request: { type: 'bb.content', requestId, op, params } };
}

/** 构造一条内容脚本请求（background 侧用；requestId 由调用方给，便于和日志对齐）。 */
export function makeContentRequest(op: ContentOp, params: Record<string, unknown> = {}, requestId?: string): ContentRequest {
  return {
    type: 'bb.content',
    requestId: requestId ?? 'req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    op,
    params,
  };
}

/**
 * 规范化内容脚本回包：成功必须带 result 字段（允许 undefined→null），
 * 失败必须有非空 code。畸形回包映射成 E_BAD_RESPONSE，而不是让上层以为成功。
 */
export function normalizeContentReply(raw: unknown): ContentReply {
  if (!isRecord(raw)) {
    return { ok: false, code: 'E_BAD_RESPONSE', message: '内容脚本回包必须是对象' };
  }
  if (raw.ok === true) {
    return { ok: true, result: raw.result ?? null };
  }
  if (raw.ok === false) {
    const code = typeof raw.code === 'string' && raw.code ? raw.code : 'E_BAD_RESPONSE';
    const message = typeof raw.message === 'string' && raw.message ? raw.message : '内容脚本操作失败';
    const failure: ContentReplyFailure = { ok: false, code, message };
    if (raw.data !== undefined) failure.data = raw.data;
    return failure;
  }
  return { ok: false, code: 'E_BAD_RESPONSE', message: '内容脚本回包缺少 ok 字段' };
}

/** 内容脚本异常 → 结构化失败回包（内容脚本入口与单测共用）。 */
export function contentFailureOf(error: unknown): ContentReplyFailure {
  if (error && typeof error === 'object') {
    const bag = error as { code?: unknown; message?: unknown; data?: unknown };
    const code = typeof bag.code === 'string' && bag.code ? bag.code : 'E_INTERNAL';
    const message = typeof bag.message === 'string' && bag.message ? bag.message : String(error);
    const failure: ContentReplyFailure = { ok: false, code, message };
    if (bag.data !== undefined) failure.data = bag.data;
    return failure;
  }
  return { ok: false, code: 'E_INTERNAL', message: String(error) };
}

// ---------------------------------------------------------------------------
// 结果形状（内容脚本返回、background 归一后往上抛）
// ---------------------------------------------------------------------------

/** observe 里单个 ref 的页面侧事实（identity/stableRef 的哈希在 background 侧算）。 */
export interface ContentObserveRef {
  ref: string;
  role: string | null;
  name: string | null;
  tag: string;
  id: string | null;
  /** 几何（视口坐标 CSS px）——annotate/visual_refs 与 deep observe 需要。 */
  rect?: { x: number; y: number; width: number; height: number } | null;
  /** 节点在 DOM 里的深度（0 = documentElement）。 */
  depth?: number;
  /** 文本值/控件值（表单值事实，供 --facts 与调试；不包含输入内容时省略）。 */
  value?: string | null;
  /** CDP backendNodeId（内容脚本通常拿不到；closed shadow 候选由 background 透传）。 */
  backendNodeId?: number | null;
  /** 跨 revision 稳定的引用（与 background refDetails 同一套 identity/hash；5b 用）。 */
  stableRef?: string | null;
}

/**
 * closed shadow 候选（background 通过 DOM.pierce 枚举后透传给内容脚本的只读数据）。
 *
 * 内容脚本拿不到 closed shadow root（`element.shadowRoot === null`），所以这里只做
 * “接收/合并”：编号 @eN、写观察文本、随 observe 结果回给 background 登记。
 */
export interface ContentClosedShadowCandidate {
  text: string;
  tag: string;
  backendNodeId?: number | null;
  role?: string | null;
  name?: string | null;
  bounds?: { x: number; y: number; width: number; height: number } | null;
}

/** observe 结果里的 closed shadow 条目（已分配 @eN；动作走 CDP pierce）。 */
export interface ContentClosedShadowEntry extends ContentClosedShadowCandidate {
  ref: string;
  role: string;
  /** 恒为 closed-shadow-ref：内容脚本不能直接解析该 ref，background 必须走 CDP pierce。 */
  via: 'closed-shadow-ref';
  source: 'closed-shadow';
}

/** 未映射到 @eN 的可交互元素（AX / closed shadow 补充证据；只读、无 ref）。 */
export interface ContentUnmappedAxCandidate {
  role?: string | null;
  name?: string | null;
  backendNodeId?: number | null;
  bounds?: { x: number; y: number; width: number; height: number } | null;
  source?: 'dom-aria' | 'closed-shadow';
}

export interface ContentUnmappedAxEntry extends ContentUnmappedAxCandidate {
  role: string;
  name: string;
  backendNodeId: number;
  bounds: { x: number; y: number; width: number; height: number } | null;
  source: 'dom-aria' | 'closed-shadow';
}

export interface ContentObserveResult {
  url: string;
  title: string;
  observation: string;
  refs: number;
  revision: number;
  documentId: string;
  nodes: ContentObserveRef[];
  /** 被可见性/预算过滤掉的候选节点数（诊断用）。 */
  filtered?: number;
  truncated?: boolean;
  /** --max-depth 截断时被省略的深层节点数（0 表示没有深度截断）。 */
  depthOmitted?: number;
  /** 本页输出字符数 / 因预算省略的字符数（--max-tokens 的预算证据）。 */
  chars?: number;
  omittedChars?: number;
  /** 第一页/后续分页游标（--max-tokens 分页）。 */
  cursor?: string | null;
  /** 本页起始行号（--cursor 续取）。 */
  offset?: number;
  /** 页面指纹（--observation 收据校验用）。 */
  fingerprint?: string;
  /** ref → 节点签名（--node-scope 动态校验用）。 */
  signatures?: Record<string, unknown>;
  /** observe 高级面载荷（VOM/AX/facts/…；background 归一后上抛）。 */
  rich?: Record<string, unknown>;
  /** 高级面里需要回到顶层的字段（background 直接展开）。 */
  richResult?: Record<string, unknown>;
  /** 本帧的 CDP session 语义（`tabId:frameId`；background 透传时回显，35b 用）。 */
  cdpSessionId?: string | null;
  /** closed shadow 只读条目（已分配 @eN；动作走 CDP pierce，via='closed-shadow-ref'）。 */
  closedShadow?: ContentClosedShadowEntry[];
  /** 未映射的可交互元素（AX/closed shadow 补充证据；无 ref）。 */
  unmappedAx?: ContentUnmappedAxEntry[];
}

export interface ContentClickResult {
  ok: true;
  ref: string | null;
  selector: string | null;
  tag: string;
  x: number;
  y: number;
  via: 'content-script';
  /** 命中测试结论：self=点击点落到目标本身；descendant=落到子节点；host=shadow host 回退。 */
  hit: 'self' | 'descendant' | 'host';
  isConnected: boolean;
  /** 合成事件永远是 isTrusted=false；这里如实上报（不谎报原生输入）。 */
  trusted: false;
  synthetic: true;
}

export interface ContentFillResult {
  ok: true;
  ref: string | null;
  selector: string | null;
  tag: string;
  expected_value: string;
  actual_value: string;
  matches: boolean;
  cleared: boolean;
  via: 'content-script';
  trusted: false;
  synthetic: true;
}

export interface ContentReadField {
  key: string;
  tag: string;
  type: string | null;
  text: string | null;
  value: string | null;
  checked: boolean | null;
  attributes?: Record<string, string | null>;
}

export interface ContentReadResult {
  fields: ContentReadField[];
  ref: string | null;
  selector: string | null;
  count: number;
  /** read --fields-json 的扁平字段（有值时 background 直接采用，忽略 fields 形状）。 */
  flatFields?: Array<Record<string, unknown>>;
}

export interface ContentSelectResult {
  ok: true;
  ref: string | null;
  selector: string | null;
  expected_value: string;
  actual_value: string;
  matches: boolean;
  via: 'content-script';
}

export interface ContentHtmlFacts {
  /** 元素是否可见（computed style + 几何）。 */
  visible: boolean;
  rect: { x: number; y: number; width: number; height: number };
  role: string | null;
  name: string | null;
  /** 是否在文档里。 */
  attached: boolean;
  /** 子树元素数量（截断到 10000）。 */
  descendants: number;
}

export interface ContentGetHtmlResult {
  html: string;
  tag: string;
  ref: string | null;
  selector: string | null;
  /** outerHTML 模式：返回的是整页/元素的外部 HTML。 */
  outer?: boolean;
  /** html 是否被 maxChars 截断。 */
  truncated?: boolean;
  /** 截断前的原始字符数。 */
  fullLength?: number;
  /** 可见性/几何事实（第三批：只读事实面）。 */
  facts?: ContentHtmlFacts;
}

export interface ContentEvaluateResult {
  value: unknown;
  expression: string;
  world: 'content-script';
}

export interface ContentPingResult {
  runtime: 'ts';
  protocol: string;
  documentId: string;
  revision: number;
  url: string;
}

// ---------------------------------------------------------------------------
// 第三批：只读事实 / 薄动作 / 提取
// ---------------------------------------------------------------------------

export interface ContentRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 固定带明细（长截图重绘页眉/页脚用；最多 8 条）。 */
export interface ContentFixedBand {
  edge: 'top' | 'bottom';
  height: number;
  top: number;
  bottom: number;
}

/** 页面度量（full-page 截图规划、scroll-to 边界、性能证据的共同底座）。 */
export interface ContentMetricsResult {
  url: string;
  title: string;
  scrollX: number;
  scrollY: number;
  innerWidth: number;
  innerHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  devicePixelRatio: number;
  documentId: string;
  /** 固定顶栏高度（CSS 像素；长截图固定带重绘用）。 */
  fixedTopHeight?: number;
  /** 固定页脚高度（CSS 像素）。 */
  fixedBottomHeight?: number;
  /** 固定带明细（position: fixed/sticky 且贴视口顶/底的元素）。 */
  fixedBands?: ContentFixedBand[];
  /** 文档 revision（DOM 变更计数；长截图 stale 判定用）。 */
  revision?: number;
}

export interface ContentScrollResult {
  ok: true;
  scrollX: number;
  scrollY: number;
  clampedX: number;
  clampedY: number;
  bounds: { x: number; y: number; width: number; height: number } | null;
  viewport: { width: number; height: number };
  ref: string | null;
  selector: string | null;
  via: 'content-script';
}

export interface ContentElementState {
  attached: boolean;
  visible: boolean;
  rect: ContentRect;
  tag: string;
  id: string | null;
  role: string | null;
  name: string | null;
  value: string | null;
  disabled: boolean;
  inViewport: boolean;
  ref: string | null;
  selector: string | null;
  /** 链接元素的绝对 href（download 直接用 chrome.downloads.download 时用）。 */
  href?: string | null;
}

export interface ContentVisualRef {
  ref: string;
  role: string | null;
  name: string | null;
  rect: ContentRect;
  pageX: number;
  pageY: number;
}

export interface ContentVisualRefsResult {
  refs: ContentVisualRef[];
  scrollX: number;
  scrollY: number;
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
  url: string;
}

/** 通用薄动作证据（hover/focus/press/wheel/blur/drag/click-point 共用）。 */
export interface ContentThinActionResult {
  ok: true;
  via: 'content-script';
  trusted: false;
  synthetic: true;
  tag: string | null;
  ref: string | null;
  selector: string | null;
  x: number | null;
  y: number | null;
  /** 动作实际落到的元素（event target）标签。 */
  targetTag?: string | null;
  from?: { x: number; y: number } | null;
  to?: { x: number; y: number } | null;
  steps?: number;
  atTop?: boolean;
  atBottom?: boolean;
  scrollX?: number;
  scrollY?: number;
  activeTag?: string | null;
  key?: string | null;
  generated?: number;
}

export interface ContentExtractColumn {
  key: string;
  label: string;
}

export interface ContentExtractTarget {
  id: string;
  kind: 'table' | 'list';
  frameId: number;
  label: string;
  columns: number;
  rowCount: number;
  preview: { columns: string[]; sample: Array<Record<string, string | null>> };
}

export interface ContentExtractPayload {
  mode: 'discover' | 'table' | 'list' | 'auto';
  columns: ContentExtractColumn[];
  rows: Array<Record<string, string | null>>;
  totalRows: number;
  targets: ContentExtractTarget[];
  frameCount: number;
  framesScanned: number;
  framesSeen: number;
  limits: { maxFrames: number; maxTargets: number; previewColumns: number };
  truncated: boolean;
  sourceLabel: string;
  totalTables: number;
  /** 提取时的 DOM 指纹：分页 cursor 用它检测“页面已变化 → 游标失效”。 */
  fingerprint: string;
}

/** 资源计时（PerformanceResourceTiming）→ 网络只读视图。 */
export interface ContentNetworkEntry {
  id: number;
  url: string;
  initiatorType: string;
  startedAt: number;
  durationMs: number;
  status: number | null;
  transferSize: number;
  encodedBodySize: number;
  decodedBodySize: number;
  fromCache: boolean;
  finished: boolean;
  timings: {
    redirectMs: number | null;
    dnsMs: number | null;
    connectMs: number | null;
    tlsMs: number | null;
    requestMs: number | null;
    ttfbMs: number | null;
    downloadMs: number | null;
  };
}

export interface ContentNetworkEntriesResult {
  entries: ContentNetworkEntry[];
  url: string;
  timeOrigin: number;
  now: number;
  /** 时间线里可见的资源总数（含捕获开始前的）。 */
  seen: number;
}

// ---------------------------------------------------------------------------
// 第四批：协作时钟 / 收据校验 / 页面状态 / 文件 / 手动浮层
// ---------------------------------------------------------------------------

/** cooperation-state：页面侧确定性计数器 + 节点签名清单。 */
export interface ContentCooperationStateResult {
  frameState: Record<string, unknown>;
  fingerprint: string;
  url: string;
  documentId: string;
  revision: number;
  nodeScope: { count: number; signatures: Record<string, unknown> };
  /** 是否有 Agent 合成输入正在派发（诊断用）。 */
  agentDispatch: boolean;
}

/** page-state：当前文档指纹 + 可选目标节点签名。 */
export interface ContentPageStateResult {
  url: string;
  documentId: string;
  revision: number;
  fingerprint: string;
  target: Record<string, unknown> | null;
}

/** check-facts：--expect/--depends-on 的事实校验（不派发动作）。 */
export interface ContentCheckFactsResult {
  ok: boolean;
  mismatches: Array<{ target: string; field: string; expected: unknown; actual: unknown; kind: string }>;
  checked: number;
}

/** frame-inventory：主文档 iframe 元素清单（隐藏状态/几何/URL）。 */
export interface ContentFrameInventoryResult {
  frames: Array<{
    src: string;
    absoluteSrc: string;
    title: string;
    hidden: boolean;
    hiddenReason: string | null;
    rect: { x: number; y: number; width: number; height: number };
  }>;
  count: number;
  hiddenCount: number;
}

/** manual-overlay：注入/移除手动长截图占位浮层。 */
export interface ContentManualOverlayResult {
  ok: boolean;
  present: boolean;
  host?: string;
}

/** upload-prepare：登记一次多文件写入。 */
export interface ContentUploadPrepareResult {
  uploadId: string;
  files: number;
  target: 'input' | 'hidden-input' | 'drop' | 'unknown';
  mode: 'input' | 'drop';
}

/** upload-commit：把已暂存字节写进 input.files 或 DataTransfer drop。 */
export interface ContentUploadCommitResult {
  ok: true;
  via: 'input' | 'hidden-input' | 'drop';
  names: string[];
  files: Array<{ name: string; size: number; mime: string }>;
  tag: string | null;
  selector: string | null;
  effectState: 'committed';
  trusted: false;
  synthetic: true;
  note: string;
}
