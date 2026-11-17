/**
 * RefKey：跨观察、跨帧可核验的引用身份。
 *
 * 页面内 `@eN` 是短期句柄；RefKey 才是文档/帧/节点/代数的复合身份：
 *   backendNodeId + frameId + cdpSessionId + documentId + revision
 *
 * 这里只做纯注册/失效，不读页面、不碰 CDP。动作层拿到 RefKey 后再走
 * DOM.resolveNode / Runtime.callFunctionOn 或页面内回退。
 */

const REF_CODE = 'E_STALE_REF';

function positiveInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function makeFenceKey(parts = {}) {
  const key = {
    backendNodeId: positiveInteger(parts.backendNodeId),
    frameId: Number.isInteger(Number(parts.frameId)) ? Number(parts.frameId) : 0,
    cdpSessionId: nonEmpty(parts.cdpSessionId),
    documentId: nonEmpty(parts.documentId),
    revision: parts.revision == null ? null : (Number.isInteger(Number(parts.revision)) ? Number(parts.revision) : null),
  };
  if (!key.documentId) throw new Error('RefKey 需要 documentId');
  return Object.freeze(key);
}

/** 完整 RefKey：动作可走 CDP 路由。 */
export function makeRefKey(parts = {}) {
  const key = {
    backendNodeId: positiveInteger(parts.backendNodeId),
    frameId: Number.isInteger(Number(parts.frameId)) ? Number(parts.frameId) : 0,
    cdpSessionId: nonEmpty(parts.cdpSessionId),
    documentId: nonEmpty(parts.documentId),
    revision: parts.revision == null ? null : (Number.isInteger(Number(parts.revision)) ? Number(parts.revision) : null),
  };
  if (!key.backendNodeId) throw new Error('RefKey 需要 backendNodeId');
  if (!key.documentId) throw new Error('RefKey 需要 documentId');
  return Object.freeze(key);
}

export function isFullRefKey(key) {
  return Boolean(key && key.backendNodeId && key.documentId);
}

export function refKeyId(key) {
  return [key.documentId, key.frameId, key.backendNodeId, key.revision == null ? '-' : key.revision].join(':');
}

export function sameRef(a, b) {
  return Boolean(a && b
    && a.backendNodeId === b.backendNodeId
    && a.frameId === b.frameId
    && a.documentId === b.documentId
    && (a.revision == null || b.revision == null || a.revision === b.revision));
}

/**
 * 每个 tab 的 RefKey 注册表。
 * - register：observe 时写入；
 * - resolve：动作前校验 document/revision/backend；
 * - invalidateDocument：导航/文档重建时整批失效。
 */
export class RefRegistry {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.byTab = new Map(); // tabId -> Map<ref, { key, role, name, at }>
  }

  register(tabId, ref, parts, meta = {}) {
    if (!Number.isInteger(Number(tabId))) throw new Error('RefRegistry 需要 tabId');
    if (typeof ref !== 'string' || !ref.startsWith('@e')) throw new Error('ref 必须是 @eN');
    const key = makeFenceKey(parts);
    const map = this.byTab.get(Number(tabId)) || new Map();
    map.set(ref, { key, role: meta.role || null, name: meta.name || null, at: this.now() });
    this.byTab.set(Number(tabId), map);
    return key;
  }

  get(tabId, ref) {
    const map = this.byTab.get(Number(tabId));
    return (map && map.get(ref)) || null;
  }

  /**
   * @returns {{ok:true,key:object,meta:object}|{ok:false,code:string,message:string}}
   */
  resolve(tabId, ref, expected = {}) {
    const entry = this.get(tabId, ref);
    if (!entry) return { ok: false, code: REF_CODE, message: 'ref 不在当前注册表里，请重新 observe' };
    if (expected.documentId && entry.key.documentId !== expected.documentId) {
      return { ok: false, code: REF_CODE, message: 'ref 属于旧 document，请重新 observe' };
    }
    if (Number.isInteger(expected.revision) && entry.key.revision !== expected.revision) {
      return { ok: false, code: REF_CODE, message: 'ref 与当前 revision 不匹配，请重新 observe' };
    }
    if (Number.isInteger(expected.frameId) && entry.key.frameId !== expected.frameId) {
      return { ok: false, code: REF_CODE, message: 'ref 与当前 frame 不匹配' };
    }
    if (expected.backendNodeId && entry.key.backendNodeId !== expected.backendNodeId) {
      return { ok: false, code: REF_CODE, message: 'ref 与节点身份不匹配' };
    }
    return { ok: true, key: entry.key, meta: entry };
  }

  upgradeBackend(tabId, ref, backendNodeId) {
    const entry = this.get(tabId, ref);
    if (!entry || !Number.isInteger(Number(backendNodeId)) || Number(backendNodeId) <= 0) return null;
    const map = this.byTab.get(Number(tabId));
    const key = makeFenceKey({ ...entry.key, backendNodeId: Number(backendNodeId) });
    map.set(ref, { ...entry, key });
    return key;
  }

  invalidateDocument(tabId, documentId) {
    const map = this.byTab.get(Number(tabId));
    if (!map) return 0;
    let removed = 0;
    for (const [ref, entry] of map) {
      if (!documentId || entry.key.documentId === documentId) {
        map.delete(ref);
        removed += 1;
      }
    }
    if (!map.size) this.byTab.delete(Number(tabId));
    return removed;
  }

  invalidateTab(tabId) {
    return this.byTab.delete(Number(tabId));
  }

  sweep(maxAgeMs = 5 * 60 * 1000) {
    const at = this.now();
    let removed = 0;
    for (const [tabId, map] of this.byTab) {
      for (const [ref, entry] of map) {
        if (at - entry.at > maxAgeMs) {
          map.delete(ref);
          removed += 1;
        }
      }
      if (!map.size) this.byTab.delete(tabId);
    }
    return removed;
  }

  size(tabId) {
    return (this.byTab.get(Number(tabId)) || new Map()).size;
  }
}
