// src/tools/refs-negotiate.js —— stableRef 协商：按注册表 + 当前文档 revision/generation 重新确认引用是否仍可用。
// 文档变化（documentId 变了）会让旧 stableRef 判定失效并标记 renegotiate:true，调用方需重新 observe。
import { refRegistry } from './state.js';
import { execPage } from '../inject.js';
import { bridgeError } from '../errors.js';

function requireTabId(params) {
  const tabId = Number(params && params.tabId);
  if (!Number.isInteger(tabId)) throw bridgeError('E_BAD_ARG', '需要 tabId');
  return tabId;
}

export async function negotiateRefs(params = {}) {
  const tabId = requireTabId(params);
  const list = (Array.isArray(params.stableRefs) ? params.stableRefs : (params.stableRef ? [params.stableRef] : []))
    .map((item) => String(item || '')).filter(Boolean).slice(0, 50);
  if (!list.length) throw bridgeError('E_BAD_ARG', '需要 stableRefs');
  let currentRevision = null;
  let currentDocument = params.documentId ? String(params.documentId) : null;
  try {
    const metrics = await execPage(tabId, 'page-metrics', {});
    currentRevision = Number.isInteger(Number(metrics && metrics.revision)) ? Number(metrics.revision) : null;
    if (!currentDocument) {
      const documentId = metrics && (metrics.documentId || metrics.url);
      currentDocument = documentId ? String(documentId) : null;
    }
  } catch {
    currentRevision = null;
  }
  // 文档变化：推进 generation，让上一份文档里登记的 stableRef 判定为旧代。
  refRegistry.noteDocument(tabId, currentDocument);
  return refRegistry.negotiate(tabId, list, {
    revision: currentRevision,
    documentId: currentDocument,
    generation: refRegistry.generationOf(tabId),
  });
}
