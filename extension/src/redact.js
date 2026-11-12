// src/redact.js —— 网络/调试证据脱敏（参考实现的红action 思路，独立实现）
const SECRET_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'x-auth-token', 'x-csrf-token', 'x-xsrf-token',
]);
const SECRET_KEYS = new Set([
  'password', 'passwd', 'pwd', 'token', 'access_token', 'refresh_token',
  'id_token', 'secret', 'client_secret', 'api_key', 'apikey', 'authorization',
  'cookie', 'set-cookie', 'session', 'sessionid', 'otp', 'one-time-code',
]);
const REDACTED = '[redacted]';

export function redactHeaders(headers) {
  if (!headers || typeof headers !== 'object') return headers;
  const out = Array.isArray(headers) ? [] : {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SECRET_HEADERS.has(String(key).toLowerCase()) ? REDACTED : value;
  }
  return out;
}

export function redactUrl(raw) {
  const value = String(raw == null ? '' : raw);
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_KEYS.has(key.toLowerCase())) url.searchParams.set(key, REDACTED);
    }
    return url.toString();
  } catch {
    return value.replace(/([?&](?:password|passwd|pwd|token|access_token|refresh_token|secret|api_key|apikey|session|otp)=)[^&#]*/gi, '$1' + REDACTED);
  }
}

export function redactBody(text) {
  const value = String(text == null ? '' : text);
  if (!value) return value;
  const trimmed = value.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const walk = (node) => {
        if (Array.isArray(node)) return node.map(walk);
        if (node && typeof node === 'object') {
          const out = {};
          for (const [key, item] of Object.entries(node)) {
            out[key] = SECRET_KEYS.has(key.toLowerCase()) ? REDACTED : walk(item);
          }
          return out;
        }
        return node;
      };
      return JSON.stringify(walk(JSON.parse(trimmed)));
    } catch {
      // 不是合法 JSON，退回文本规则
    }
  }
  return value.replace(/(["']?(?:password|passwd|pwd|token|access_token|refresh_token|secret|api_key|apikey|authorization|cookie|session|otp)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^&\s,}]+)/gi, '$1' + REDACTED);
}
