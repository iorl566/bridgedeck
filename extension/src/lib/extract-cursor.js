// lib/extract-cursor.js —— 提取分页游标（多页续取）的编解码与校验。
//
// 大表格/长列表一次 maxRows 取不完时，结果带 cursor；下一次 extract --cursor 从 offset 继续。
// 游标是**无状态**的：只记录 (tabId, frameId, kind, offset, revision, target, at)，
// 不持有页面对象。DOM 代（revision）变化、跨 tab/frame、类型不符、超过 10 分钟 → E_CURSOR_STALE。

export const EXTRACT_CURSOR_TTL_MS = 10 * 60 * 1000;

function toBase64Url(text) {
  const b64 = typeof btoa === 'function'
    ? btoa(unescape(encodeURIComponent(text)))
    : Buffer.from(String(text), 'utf8').toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(token) {
  const b64 = String(token).replace(/-/g, '+').replace(/_/g, '/');
  const text = typeof atob === 'function'
    ? decodeURIComponent(escape(atob(b64)))
    : Buffer.from(b64, 'base64').toString('utf8');
  return text;
}

/** 生成游标：x1.<base64url(JSON)>。 */
export function encodeExtractCursor(payload = {}) {
  const cursor = {
    v: 1,
    tabId: Number.isInteger(payload.tabId) ? payload.tabId : null,
    frameId: Number.isInteger(payload.frameId) ? payload.frameId : 0,
    kind: payload.kind ? String(payload.kind) : null,
    offset: Number.isInteger(payload.offset) && payload.offset >= 0 ? payload.offset : 0,
    revision: Number.isInteger(payload.revision) ? payload.revision : null,
    target: payload.target && typeof payload.target === 'object' ? payload.target : null,
    at: Number.isFinite(payload.at) ? payload.at : Date.now(),
  };
  return 'x1.' + toBase64Url(JSON.stringify(cursor));
}

/** 解析游标：无效/版本不符/过期都返回 ok:false。 */
export function decodeExtractCursor(token, now = Date.now()) {
  if (typeof token !== 'string' || !token.startsWith('x1.')) {
    return { ok: false, reason: 'cursor 前缀不是 x1.' };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(fromBase64Url(token.slice(3)));
  } catch {
    return { ok: false, reason: 'cursor 不是合法 JSON' };
  }
  if (!parsed || parsed.v !== 1 || !Number.isInteger(parsed.offset) || parsed.offset < 0) {
    return { ok: false, reason: 'cursor 版本/offset 不合法' };
  }
  if (Number.isFinite(parsed.at) && now - parsed.at > EXTRACT_CURSOR_TTL_MS) {
    return { ok: false, reason: 'cursor 已超过 10 分钟' };
  }
  return {
    ok: true,
    cursor: {
      v: 1,
      tabId: Number.isInteger(parsed.tabId) ? parsed.tabId : null,
      frameId: Number.isInteger(parsed.frameId) ? parsed.frameId : 0,
      kind: parsed.kind ? String(parsed.kind) : null,
      offset: parsed.offset,
      revision: Number.isInteger(parsed.revision) ? parsed.revision : null,
      target: parsed.target && typeof parsed.target === 'object' ? parsed.target : null,
      at: Number.isFinite(parsed.at) ? parsed.at : now,
    },
  };
}

/**
 * 校验游标与本次请求是否一致；返回 null 表示可用，否则返回原因（调用方转 E_CURSOR_STALE）。
 * @param {object} cursor decodeExtractCursor().cursor
 * @param {{tabId?:number,frameId?:number,kind?:string,revision?:number|null}} ctx
 */
export function verifyExtractCursor(cursor, ctx = {}) {
  if (!cursor || typeof cursor !== 'object') return 'cursor 为空';
  if (Number.isInteger(ctx.tabId) && cursor.tabId != null && Number.isInteger(cursor.tabId) && cursor.tabId !== ctx.tabId) {
    return 'cursor 属于另一个 tab';
  }
  if (Number.isInteger(ctx.frameId) && Number.isInteger(cursor.frameId) && cursor.frameId !== ctx.frameId) {
    return 'cursor 属于另一个 frame';
  }
  if (ctx.kind && cursor.kind && cursor.kind !== ctx.kind) return 'cursor 与提取类型不匹配';
  if (Number.isInteger(ctx.revision) && Number.isInteger(cursor.revision) && cursor.revision !== ctx.revision) {
    return 'cursor 对应的 DOM 代已变化';
  }
  return null;
}
