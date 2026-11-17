/**
 * Whether `node` is the focused element, including inside open or closed shadow
 * roots. `document.activeElement` reports only the outermost host for a shadow
 * tree, so a plain comparison misreports focused inputs as unfocused.
 * @param {{ getRootNode?: () => { activeElement?: unknown, host?: unknown } | null } | null} node
 * @returns {boolean}
 */
export function isElementFocused(node) {
  let current = node;
  while (current) {
    const root = typeof current.getRootNode === 'function' ? current.getRootNode() : null;
    if (root && root.activeElement === current) return true;
    current = root && root.host ? root.host : null;
  }
  return false;
}
