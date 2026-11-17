/**
 * 复合 ref 元数据：ref 是页面内的短期句柄，backendNodeId/frameId/documentId/revision
 * 才是跨观察、跨帧可核验的身份。这里只做纯映射，不读取页面。
 */
export function buildRefDetails(nodes, context = {}) {
  const frameId = Number.isInteger(context.frameId) ? context.frameId : 0;
  const revision = Number.isInteger(context.revision) ? context.revision : null;
  const documentId = context.documentId || null;
  const list = Array.isArray(nodes) ? nodes : [];
  return list
    .filter((node) => node && typeof node.ref === 'string' && node.ref.startsWith('@e'))
    .map((node) => ({
      ref: node.ref,
      backendNodeId: Number.isInteger(node.backendNodeId) ? node.backendNodeId : null,
      role: node.role || null,
      name: node.name ? String(node.name).slice(0, 120) : null,
      frameId,
      documentId,
      revision,
    }));
}
