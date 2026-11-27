// cli/lib/format.mjs —— CLI 纯格式化辅助（表格/宽度/时间/字节），无 I/O、无全局状态。

/** 单个字符的显示宽度（中文/全角/emoji 记 2）。 */
export function charWidth(ch) {
  const code = ch.codePointAt(0);
  const wide = code >= 0x1100 && (
    code <= 0x115f
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe4f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1f9ff)
  );
  return wide ? 2 : 1;
}

export function textWidth(text) {
  let width = 0;
  for (const ch of String(text)) width += charWidth(ch);
  return width;
}

export function padEndWidth(text, width) {
  return String(text) + ' '.repeat(Math.max(0, width - textWidth(text)));
}

export function truncateText(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/** 简单等宽表格（按显示宽度对齐，兼容中文）。 */
export function renderTable(headers, rows) {
  if (!rows.length) return '';
  const widths = headers.map((header, index) => Math.max(
    textWidth(header),
    ...rows.map((row) => textWidth(String(row[index] ?? ''))),
  ));
  const renderRow = (cells) => cells.map((cell, index) => padEndWidth(String(cell ?? ''), widths[index])).join('  ').trimEnd();
  const lines = [renderRow(headers), renderRow(headers.map((_, index) => '-'.repeat(widths[index])))];
  for (const row of rows) lines.push(renderRow(row));
  return lines.join('\n');
}

export function formatUptime(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatTime(ts) {
  const date = new Date(Number(ts) || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 控制权租约剩余时间（人类可读）。 */
export function formatLease(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (!value) return '0s';
  if (value < 1000) return value + 'ms';
  if (value < 60_000) return (value / 1000).toFixed(1) + 's';
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return minutes + 'm' + (seconds ? seconds + 's' : '');
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
