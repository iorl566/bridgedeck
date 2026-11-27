/**
 * 复合 ref 元数据：ref 是页面内的短期句柄；stableRef 用稳定身份
 * （documentId + frameId + tag + id + role + name）跨观察复用，而不是 backendNodeId。
 * 纯映射，不读取页面。
 */
function hash(value) {
  let h = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    h ^= text.charCodeAt(index);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function buildRefDetails(nodes, context = {}) {
  const frameId = Number.isInteger(context.frameId) ? context.frameId : 0;
  const revision = Number.isInteger(context.revision) ? context.revision : null;
  const documentId = context.documentId || null;
  const cdpSessionId = context.cdpSessionId ? String(context.cdpSessionId) : null;
  const list = Array.isArray(nodes) ? nodes : [];
  const used = new Map();
  return list
    .filter((node) => node && typeof node.ref === 'string' && node.ref.startsWith('@e'))
    .map((node) => {
      const identity = [
        cdpSessionId || '',
        documentId || '',
        frameId,
        node.tag || '',
        node.id || '',
        node.role || '',
        node.name || '',
      ].join('|');
      const identityKey = 'i-' + hash(identity);
      // 同页相同 tag/id/role/name 可能重复：用出现序号区分，仍保持稳定顺序。
      const count = (used.get(identityKey) || 0) + 1;
      used.set(identityKey, count);
      const stableRef = 's-' + hash(identity + '#' + count);
      return {
        ref: node.ref,
        backendNodeId: Number.isInteger(node.backendNodeId) ? node.backendNodeId : null,
        role: node.role || null,
        name: node.name ? String(node.name).slice(0, 120) : null,
        stableRef,
        identityKey,
        frameId,
        cdpSessionId,
        documentId,
        revision,
      };
    });
}
