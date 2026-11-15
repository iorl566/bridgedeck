// extension/src/lib/facts-annotate.js —— 把 DOMSnapshot 事实反馈到语义树文本。
//
// 目前只做一件事：页面语义树里认为可交互、但 DOMSnapshot 判定不可见（display:none /
// visibility:hidden / opacity:0 / 零面积）的 ref，在该行末尾标注 [dom-hidden]。
// 纯函数，便于单测；只有 --facts 时才调用，默认观察文本不受影响。

/** 从结构化节点里挑出带 ref 且 DOMSnapshot 判定不可见的节点。 */
export function collectHiddenRefs(nodes) {
  const refs = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || typeof node.ref !== 'string' || !node.ref) continue;
    if (node.visible === false) refs.push(node.ref);
  }
  return refs;
}

/** 在包含指定 ref 的文本行末追加标记；已标记的行不重复追加。 */
export function annotateHiddenRefs(text, refs) {
  const wanted = new Set((Array.isArray(refs) ? refs : []).filter((ref) => typeof ref === 'string' && ref));
  if (!wanted.size || typeof text !== 'string' || !text) return text;
  return text.split('\n').map((line) => {
    if (!line || line.includes('[dom-hidden]')) return line;
    for (const ref of wanted) {
      // @e1 不能命中 @e12
      const pattern = new RegExp('(^|[^@A-Za-z0-9])' + ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![0-9A-Za-z])');
      if (pattern.test(line)) return line + ' [dom-hidden]';
    }
    return line;
  }).join('\n');
}
