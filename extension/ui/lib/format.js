// ui/lib/format.js —— 纯格式化函数（无 DOM/chrome，可在 Node 单测）。
//
// 老页面的 formatTime / formatBytes 是各文件里复制粘贴的私有实现；新能力统一走这里，
// 排序、分页、时间线都依赖相同的「数字 → 文本」口径，避免同一页里出现两种格式。

const PAD = (value, width = 2) => String(value).padStart(width, '0');

/** 安全数字：非有限值返回 null（调用方决定占位符）。 */
export function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** 千分位：1234567 → "1,234,567"；非数字原样返回 "?"。 */
export function formatThousands(value) {
  const number = toFiniteNumber(value);
  if (number === null) return '?';
  const rounded = Math.round(number);
  const sign = rounded < 0 ? '-' : '';
  const digits = String(Math.abs(rounded));
  let out = '';
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) out += ',';
    out += digits[index];
  }
  return sign + out;
}

/** 字节：0–1023 B，其余 KB/MB/GB（保留 1 位小数）。负数/非数字 → "?"。 */
export function formatBytes(bytes) {
  const value = toFiniteNumber(bytes);
  if (value === null || value < 0) return '?';
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(1) + ' MB';
  return (value / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

/** 毫秒：<1ms 显示 1 位小数，<1000ms 取整，之后 1.2s / 1m05s。 */
export function formatDuration(ms) {
  const value = toFiniteNumber(ms);
  if (value === null || value < 0) return '?';
  if (value < 1) return value.toFixed(1) + 'ms';
  if (value < 1000) return Math.round(value) + 'ms';
  const seconds = value / 1000;
  if (seconds < 60) return (seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))) + 's';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes < 60) return minutes + 'm' + PAD(rest) + 's';
  const hours = Math.floor(minutes / 60);
  return hours + 'h' + PAD(minutes % 60) + 'm';
}

/** 秒表式时长：75 → "01:15"，3725 → "1:02:05"。 */
export function formatClock(seconds) {
  const value = toFiniteNumber(seconds);
  if (value === null || value < 0) return '?';
  const total = Math.floor(value);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return hours + ':' + PAD(minutes) + ':' + PAD(rest);
  return PAD(minutes) + ':' + PAD(rest);
}

function safeDate(value) {
  const number = toFiniteNumber(value);
  if (number === null) return null;
  const date = new Date(number);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 本地时间 "MM-DD HH:MM:SS"（与老页面 formatTime 输出一致）。 */
export function formatTimestamp(value) {
  const date = safeDate(value);
  if (!date) return '?';
  return PAD(date.getMonth() + 1) + '-' + PAD(date.getDate()) + ' ' + PAD(date.getHours()) + ':' + PAD(date.getMinutes()) + ':' + PAD(date.getSeconds());
}

/** 本地时间 "HH:MM:SS.mmm"（时间线刻度用）。 */
export function formatTimeOfDay(value, { millis = false } = {}) {
  const date = safeDate(value);
  if (!date) return '?';
  const base = PAD(date.getHours()) + ':' + PAD(date.getMinutes()) + ':' + PAD(date.getSeconds());
  return millis ? base + '.' + String(date.getMilliseconds()).padStart(3, '0') : base;
}

/** 本地日期 "YYYY-MM-DD HH:MM"，用于记录元信息。 */
export function formatDateTime(value) {
  const date = safeDate(value);
  if (!date) return '?';
  return date.getFullYear() + '-' + PAD(date.getMonth() + 1) + '-' + PAD(date.getDate()) + ' ' + PAD(date.getHours()) + ':' + PAD(date.getMinutes());
}

/** 相对时间：刚刚 / 12s / 3m / 2h / 4d；未来时间前缀 "in "（英文）或 "后"。 */
export function formatRelative(value, now = Date.now(), lang = 'zh') {
  const date = safeDate(value);
  const reference = toFiniteNumber(now);
  if (!date || reference === null) return '?';
  const diff = reference - date.getTime();
  const future = diff < 0;
  const abs = Math.abs(diff);
  const zh = String(lang || 'zh').toLowerCase().startsWith('zh');
  const suffix = zh ? (future ? '后' : '前') : (future ? '' : ' ago');
  const prefix = !zh && future ? 'in ' : '';
  let body;
  if (abs < 5000) return zh ? '刚刚' : 'just now';
  if (abs < 60_000) body = Math.round(abs / 1000) + 's';
  else if (abs < 3_600_000) body = Math.round(abs / 60_000) + 'm';
  else if (abs < 86_400_000) body = Math.round(abs / 3_600_000) + 'h';
  else body = Math.round(abs / 86_400_000) + 'd';
  return prefix + body + suffix;
}

/** 百分比：0.256 → "25.6%"；传入 25.6 时不再乘 100（调用方用 ratio 标记）。 */
export function formatPercent(value, { ratio = true, digits = 1 } = {}) {
  const number = toFiniteNumber(value);
  if (number === null) return '?';
  const percent = ratio ? number * 100 : number;
  const fixed = percent.toFixed(digits);
  return fixed.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1') + '%';
}

/** 比率 "3/8" 或 "—"（分母为 0）。 */
export function formatRatio(part, total) {
  const top = toFiniteNumber(part);
  const bottom = toFiniteNumber(total);
  if (top === null || bottom === null || bottom <= 0) return '—';
  return String(top) + '/' + String(bottom);
}

/** 状态码分类：供角标着色与 aria 文本使用。 */
export function statusClass(status, { error = false } = {}) {
  if (error) return 'error';
  const value = toFiniteNumber(status);
  if (value === null) return 'unknown';
  if (value >= 500) return 'server-error';
  if (value >= 400) return 'client-error';
  if (value >= 300) return 'redirect';
  if (value >= 200) return 'ok';
  return 'info';
}

/** "HTTP 200 OK" 风格的可访问名称（状态缺失时返回 "HTTP ?"）。 */
export function formatHttpStatus(status) {
  const value = toFiniteNumber(status);
  if (value === null) return 'HTTP ?';
  return 'HTTP ' + String(value);
}

/** 单行截断：超出长度用省略号，保留首尾便于识别 URL。 */
export function truncateMiddle(text, max = 60, ellipsis = '…') {
  const value = String(text === undefined || text === null ? '' : text);
  const limit = Math.max(4, Math.floor(toFiniteNumber(max) || 60));
  if (value.length <= limit) return value;
  const keep = limit - ellipsis.length;
  const head = Math.ceil(keep * 0.7);
  const tail = Math.max(1, keep - head);
  return value.slice(0, head) + ellipsis + value.slice(value.length - tail);
}

/** 尾部截断（路径场景：保留最后几段）。 */
export function truncateEnd(text, max = 60, ellipsis = '…') {
  const value = String(text === undefined || text === null ? '' : text);
  const limit = Math.max(4, Math.floor(toFiniteNumber(max) || 60));
  if (value.length <= limit) return value;
  return ellipsis + value.slice(value.length - (limit - ellipsis.length));
}

/** URL → 可扫描的短形式："https://a.com/x?y=1" → "a.com/x?y=1"。 */
export function formatUrlShort(url, max = 72) {
  const raw = String(url === undefined || url === null ? '' : url);
  if (!raw) return '';
  let text = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  text = text.replace(/^www\./i, '');
  return truncateMiddle(text, max);
}

/** 从 URL 里取路径（解析失败时回退原串），用于分组。 */
export function urlPath(url) {
  const raw = String(url === undefined || url === null ? '' : url);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return parsed.pathname || '/';
  } catch {
    const match = /^[^:/?#]+:\/\/[^/?#]*(\/[^?#]*)?/.exec(raw);
    return (match && match[1]) || '';
  }
}

/** 方法名归一化（大写、去空白）；空值 → "GET" 之外的空串，交给调用方占位。 */
export function formatMethod(method) {
  return String(method === undefined || method === null ? '' : method).trim().toUpperCase();
}

/** 速率："12.3 req/s"；窗口为 0 返回 "?"。 */
export function formatRate(count, windowMs) {
  const total = toFiniteNumber(count);
  const span = toFiniteNumber(windowMs);
  if (total === null || span === null || span <= 0) return '?';
  return (total / (span / 1000)).toFixed(1) + '/s';
}

/** 变化量："+3" / "-2" / "0"。 */
export function formatDelta(delta) {
  const value = toFiniteNumber(delta);
  if (value === null) return '?';
  const rounded = Math.round(value);
  if (rounded === 0) return '0';
  return (rounded > 0 ? '+' : '') + String(rounded);
}

/** 键值对安全取文本：null/undefined → "—"，对象 → JSON 短串。 */
export function formatValue(value, max = 80) {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'string') return truncateMiddle(value, max);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return '[' + value.length + ']';
  try {
    return truncateMiddle(JSON.stringify(value), max);
  } catch {
    return String(value);
  }
}

/** 时长分档标签：<50ms fast / <300ms ok / <1000ms slow / 其余 very-slow。 */
export function durationBucket(ms) {
  const value = toFiniteNumber(ms);
  if (value === null) return 'unknown';
  if (value < 50) return 'fast';
  if (value < 300) return 'ok';
  if (value < 1000) return 'slow';
  return 'very-slow';
}

/** 分位数（0–1）：空数组 → null；不修改入参。 */
export function percentile(values, ratio) {
  const list = Array.isArray(values)
    ? values.map((item) => toFiniteNumber(item)).filter((item) => item !== null).sort((a, b) => a - b)
    : [];
  if (!list.length) return null;
  const p = Math.min(1, Math.max(0, toFiniteNumber(ratio) === null ? 0.5 : Number(ratio)));
  if (list.length === 1) return list[0];
  const position = (list.length - 1) * p;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return list[lower];
  const weight = position - lower;
  return list[lower] + (list[upper] - list[lower]) * weight;
}

/** 一组数值的摘要（数量/最小/最大/中位/p95/合计），时间线、性能面板共用。 */
export function summarizeNumbers(values, { p95 = true } = {}) {
  const list = Array.isArray(values)
    ? values.map((item) => toFiniteNumber(item)).filter((item) => item !== null)
    : [];
  if (!list.length) return { count: 0, min: null, max: null, median: null, p95: null, sum: 0 };
  const sorted = [...list].sort((a, b) => a - b);
  const sum = sorted.reduce((total, item) => total + item, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: percentile(sorted, 0.5),
    p95: p95 ? percentile(sorted, 0.95) : null,
    sum,
  };
}

/** 安全 JSON 序列化（循环引用/大对象降级不抛错）。 */
export function safeJson(value, space = 2) {
  try {
    return JSON.stringify(value, null, space);
  } catch {
    try {
      return String(value);
    } catch {
      return '';
    }
  }
}

/** 用于 aria-label 的稳定短 id："tab-12" → 原样；空 → ""。 */
export function sanitizeId(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}
