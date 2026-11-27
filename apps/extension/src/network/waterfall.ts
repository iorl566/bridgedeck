// src/network/waterfall.ts —— 网络瀑布：相对时间轴 / 慢请求 / 分类 / 错误统计（M-C 第六批 wave 2）。
//
// 输入是 NetworkService 的公开条目（resource-timing 或 CDP 面同形），输出是 CLI
// `network waterfall` 与 MCP `browser_network_waterfall` 直接消费的 {rows, summary}。
//
// 纯函数：不读全局、不依赖 content/CDP，单测可覆盖排序/过滤/分桶/错误统计。

export interface WaterfallEntryLike {
  id: number;
  url: string;
  method?: string | null;
  status?: number | null;
  durationMs?: number | null;
  startedAt?: number | null;
  type?: string | null;
  resourceType?: string | null;
  responseBytes?: number | null;
  transferSize?: number | null;
  error?: string | null;
  commandId?: string | null;
}

export interface WaterfallRow {
  id: number;
  url: string;
  method: string;
  status: number | null;
  type: string;
  /** 相对第一条请求的起点偏移（ms）。 */
  startOffsetMs: number;
  durationMs: number;
  endOffsetMs: number;
  responseBytes: number;
  commandId: string | null;
  kind: string;
  ok: boolean;
  error: string | null;
}

export interface WaterfallSummary {
  count: number;
  /** 从第一条开始到最后一条结束的墙钟跨度（ms）。 */
  wallMs: number;
  errors: number;
  slowCount: number;
  totalBytes: number;
  avgMs: number;
  maxMs: number;
  kinds: Array<{ kind: string; count: number; bytes: number }>;
}

export interface WaterfallOptions {
  limit?: number;
  slowMs?: number;
  /** 只保留 URL 包含该子串的行（大小写不敏感）。 */
  urlContains?: string;
  /** 只保留指定 HTTP 状态。 */
  status?: number | null;
}

/** 把 URL 归到一个粗分类（document/script/style/image/font/xhr/websocket/other）。 */
export function classifyEntry(entry: WaterfallEntryLike): string {
  const type = String(entry.type || entry.resourceType || '').toLowerCase();
  if (type) {
    if (type === 'document' || type === 'main_frame' || type === 'sub_frame') return 'document';
    if (type === 'script' || type === 'stylesheet' || type === 'image' || type === 'font' || type === 'media') return type;
    if (type === 'xhr' || type === 'fetch' || type === 'xmlhttprequest' || type === 'eventsource') return 'xhr';
    if (type === 'websocket') return 'websocket';
  }
  const url = String(entry.url || '').toLowerCase();
  if (url.startsWith('ws://') || url.startsWith('wss://')) return 'websocket';
  if (/\.(?:m?js)(?:[?#]|$)/.test(url)) return 'script';
  if (/\.css(?:[?#]|$)/.test(url)) return 'stylesheet';
  if (/\.(?:png|jpe?g|gif|webp|avif|svg|ico)(?:[?#]|$)/.test(url)) return 'image';
  if (/\.(?:woff2?|ttf|otf)(?:[?#]|$)/.test(url)) return 'font';
  return 'other';
}

/** 构建瀑布（纯函数）。 */
export function buildNetworkWaterfall(
  entries: WaterfallEntryLike[],
  options: WaterfallOptions = {},
): { rows: WaterfallRow[]; summary: WaterfallSummary } {
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0
    ? Math.max(1, Math.min(2_000, Math.floor(Number(options.limit))))
    : 500;
  const slowMs = Number.isFinite(Number(options.slowMs)) && Number(options.slowMs) > 0 ? Number(options.slowMs) : 1_000;
  const needle = String(options.urlContains || '').toLowerCase();
  const wantedStatus = options.status === undefined || options.status === null ? null : Number(options.status);
  const list = (Array.isArray(entries) ? entries : [])
    .filter((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      if (needle && !String(entry.url || '').toLowerCase().includes(needle)) return false;
      if (wantedStatus !== null && Number(entry.status) !== wantedStatus) return false;
      return true;
    })
    .slice(0, limit);
  const starts = list.map((entry) => Number(entry.startedAt) || 0).filter((value) => value > 0);
  const origin = starts.length ? Math.min(...starts) : 0;
  let wallEnd = 0;
  const rows: WaterfallRow[] = list.map((entry) => {
    const startedAt = Number(entry.startedAt) || origin;
    const durationMs = Math.max(0, Number(entry.durationMs) || 0);
    const startOffsetMs = Math.max(0, startedAt - origin);
    const endOffsetMs = startOffsetMs + durationMs;
    if (endOffsetMs > wallEnd) wallEnd = endOffsetMs;
    const status = entry.status === null || entry.status === undefined ? null : Number(entry.status);
    const error = typeof entry.error === 'string' && entry.error ? entry.error : null;
    return {
      id: Number(entry.id) || 0,
      url: String(entry.url || ''),
      method: String(entry.method || 'GET').toUpperCase(),
      status: Number.isFinite(status as number) ? status : null,
      type: String(entry.type || entry.resourceType || ''),
      startOffsetMs,
      durationMs,
      endOffsetMs,
      responseBytes: Number(entry.transferSize ?? entry.responseBytes ?? 0) || 0,
      commandId: entry.commandId ? String(entry.commandId) : null,
      kind: classifyEntry(entry),
      ok: error === null && (status === null || (status >= 200 && status < 400)),
      error,
    };
  });
  const kinds = new Map<string, { kind: string; count: number; bytes: number }>();
  let errors = 0;
  let slowCount = 0;
  let totalBytes = 0;
  let maxMs = 0;
  let totalMs = 0;
  for (const row of rows) {
    if (!row.ok) errors += 1;
    if (row.durationMs >= slowMs) slowCount += 1;
    totalBytes += row.responseBytes;
    if (row.durationMs > maxMs) maxMs = row.durationMs;
    totalMs += row.durationMs;
    const bucket = kinds.get(row.kind) ?? { kind: row.kind, count: 0, bytes: 0 };
    bucket.count += 1;
    bucket.bytes += row.responseBytes;
    kinds.set(row.kind, bucket);
  }
  return {
    rows,
    summary: {
      count: rows.length,
      wallMs: wallEnd,
      errors,
      slowCount,
      totalBytes,
      avgMs: rows.length ? Math.round(totalMs / rows.length) : 0,
      maxMs,
      kinds: [...kinds.values()].sort((a, b) => b.count - a.count),
    },
  };
}
