/**
 * RefKey：跨观察、跨帧可核验的引用身份。
 *
 * 页面内 `@eN` 是短期句柄；RefKey 才是文档/帧/节点/代数的复合身份：
 *   backendNodeId + frameId + cdpSessionId + documentId + revision (+ generation)
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

function generationOf(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** FNV-1a：只用于生成可比较的稳定性签名，不做安全哈希。 */
function signatureHash(value) {
  let h = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    h ^= text.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * 稳定性签名：backendNodeId + frameId + cdpSessionId + documentId。
 * 不含 revision（内容变化不应换身份），但 documentId 变化一定换签名。
 */
export function makeStabilitySignature(parts = {}) {
  const documentId = nonEmpty(parts && parts.documentId);
  if (!documentId) throw new Error('稳定性签名需要 documentId');
  const backendNodeId = positiveInteger(parts && parts.backendNodeId);
  const frameId = Number.isInteger(Number(parts && parts.frameId)) ? Number(parts.frameId) : 0;
  const cdpSessionId = nonEmpty(parts && parts.cdpSessionId) || '-';
  return 'sig:' + signatureHash([documentId, frameId, backendNodeId == null ? '-' : backendNodeId, cdpSessionId].join('\u0000'));
}

/** 两个稳定性签名是否一致（空值一律视为不一致）。 */
export function sameStabilitySignature(a, b) {
  return typeof a === 'string' && a.length > 0 && a === b;
}

export function makeFenceKey(parts = {}) {
  const key = {
    backendNodeId: positiveInteger(parts.backendNodeId),
    frameId: Number.isInteger(Number(parts.frameId)) ? Number(parts.frameId) : 0,
    cdpSessionId: nonEmpty(parts.cdpSessionId),
    documentId: nonEmpty(parts.documentId),
    revision: parts.revision == null ? null : (Number.isInteger(Number(parts.revision)) ? Number(parts.revision) : null),
    generation: generationOf(parts.generation),
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
    generation: generationOf(parts.generation),
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
    && (a.revision == null || b.revision == null || a.revision === b.revision)
    && (a.generation == null || b.generation == null || a.generation === b.generation));
}


/**
 * 每个 tab 的 RefKey 注册表。
 * - register：observe 时写入（带 generation + 稳定性签名）；
 * - resolve：动作前校验 document/generation/签名/revision/backend；
 * - invalidateDocument：导航/文档重建时整批失效并推进 generation；
 * - noteDocument / negotiate：文档变化让旧 stableRef 判定失效并触发重协商。
 */
export class RefRegistry {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.byTab = new Map(); // tabId -> Map<ref, { key, role, name, stableRef, signature, generation, documentId, at }>
    this.generations = new Map(); // tabId -> generation
    this.documents = new Map(); // tabId -> 当前 documentId
  }

  generationOf(tabId) {
    return this.generations.get(Number(tabId)) || 0;
  }

  bumpGeneration(tabId) {
    const id = Number(tabId);
    const next = this.generationOf(id) + 1;
    this.generations.set(id, next);
    return next;
  }

  /** 记录当前文档；documentId 与上次不同则推进 generation（旧引用自然过期）。 */
  noteDocument(tabId, documentId) {
    const id = Number(tabId);
    const doc = nonEmpty(documentId);
    if (!Number.isInteger(id) || !doc) return { changed: false, generation: this.generationOf(tabId) };
    const previous = this.documents.get(id);
    this.documents.set(id, doc);
    if (previous && previous !== doc) return { changed: true, generation: this.bumpGeneration(id) };
    return { changed: false, generation: this.generationOf(id) };
  }

  register(tabId, ref, parts, meta = {}) {
    const id = Number(tabId);
    if (!Number.isInteger(id)) throw new Error('RefRegistry 需要 tabId');
    if (typeof ref !== 'string' || !ref.startsWith('@e')) throw new Error('ref 必须是 @eN');
    // 登记新文档的引用时自动推进 generation：上一份文档的 stableRef 全部判旧。
    const noted = this.noteDocument(id, parts && parts.documentId);
    const key = makeFenceKey({
      ...(parts || {}),
      generation: parts && parts.generation != null ? parts.generation : noted.generation,
    });
    const map = this.byTab.get(id) || new Map();
    map.set(ref, {
      key,
      role: meta.role || null,
      name: meta.name || null,
      stableRef: meta.stableRef || null,
      signature: makeStabilitySignature(key),
      generation: key.generation == null ? noted.generation : key.generation,
      documentId: key.documentId,
      at: this.now(),
    });
    this.byTab.set(id, map);
    return key;
  }

  getByStableRef(tabId, stableRef) {
    if (!stableRef) return null;
    const map = this.byTab.get(Number(tabId));
    if (!map) return null;
    for (const [ref, entry] of map) {
      if (entry.stableRef === stableRef) return { ref, ...entry };
    }
    return null;
  }

  /** 按稳定性签名查找（同文档同节点，跨 revision 命中）。 */
  getBySignature(tabId, signature) {
    if (!signature) return null;
    const map = this.byTab.get(Number(tabId));
    if (!map) return null;
    for (const [ref, entry] of map) {
      if (entry.signature === signature) return { ref, ...entry };
    }
    return null;
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
    if (expected.generation != null && entry.generation != null && Number(expected.generation) !== Number(entry.generation)) {
      return { ok: false, code: REF_CODE, message: 'ref 属于旧 generation，请重新 observe' };
    }
    if (expected.signature && entry.signature && expected.signature !== entry.signature) {
      return { ok: false, code: REF_CODE, message: 'ref 稳定性签名与当前文档不匹配，请重新 observe' };
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

  /**
   * stableRef 协商：按当前文档/revision/generation 判断每个 stableRef 是否仍可用。
   * 文档变化 → stale_document；登记代际变化 → stale_generation；内容变化 → stale_revision。
   * 任何 stale 都带 renegotiate:true（调用方必须重新 observe 后再动作）。
   */
  negotiate(tabId, stableRefs, current = {}) {
    const id = Number(tabId);
    const list = (Array.isArray(stableRefs) ? stableRefs : []).map((item) => String(item || '')).filter(Boolean);
    const currentDocument = nonEmpty(current.documentId);
    const generation = this.generationOf(id);
    const revision = Number.isInteger(Number(current.revision)) ? Number(current.revision) : null;
    const refs = list.map((stableRef) => {
      const entry = this.getByStableRef(id, stableRef);
      if (!entry) return { stableRef, ok: false, reason: 'not_found', renegotiate: true };
      const key = entry.key || {};
      const staleDocument = Boolean(currentDocument && key.documentId && key.documentId !== currentDocument);
      const staleGeneration = Number.isInteger(current.generation)
        && Number.isInteger(entry.generation)
        && entry.generation !== Number(current.generation);
      const staleRevision = revision != null && key.revision != null && Number(key.revision) !== revision;
      const reason = staleDocument ? 'stale_document' : staleGeneration ? 'stale_generation' : staleRevision ? 'stale_revision' : null;
      return {
        stableRef,
        ok: !reason,
        ...(reason ? { reason, renegotiate: true } : { renegotiate: false }),
        ref: entry.ref,
        role: entry.role || null,
        name: entry.name || null,
        documentId: key.documentId || null,
        frameId: Number.isInteger(key.frameId) ? key.frameId : 0,
        cdpSessionId: key.cdpSessionId || null,
        backendNodeId: Number.isInteger(key.backendNodeId) ? key.backendNodeId : null,
        revision: key.revision == null ? null : Number(key.revision),
        generation: Number.isInteger(entry.generation) ? entry.generation : null,
        signature: entry.signature || null,
      };
    });
    return { ok: true, tabId: id, revision, generation, documentId: currentDocument || null, refs };
  }

  upgradeBackend(tabId, ref, backendNodeId) {
    const entry = this.get(tabId, ref);
    if (!entry || !Number.isInteger(Number(backendNodeId)) || Number(backendNodeId) <= 0) return null;
    const map = this.byTab.get(Number(tabId));
    const key = makeFenceKey({ ...entry.key, backendNodeId: Number(backendNodeId) });
    map.set(ref, { ...entry, key, signature: makeStabilitySignature(key) });
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
    if (removed) {
      this.bumpGeneration(tabId);
      if (documentId) this.documents.delete(Number(tabId));
    }
    return removed;
  }

  invalidateTab(tabId) {
    const id = Number(tabId);
    this.bumpGeneration(id);
    this.documents.delete(id);
    return this.byTab.delete(id);
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

