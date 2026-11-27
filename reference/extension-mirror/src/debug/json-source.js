/**
 * JSON structure backed by source ranges. Numbers never pass through Number.
 *
 * The platform parser validates the grammar first, but its values are
 * discarded: a document id or body pointer must address the exact source text,
 * so every node records a half-open character range instead of a parsed value.
 *
 * @typedef {object} JsonSourceNode
 * @property {number} start First character of the node in the source text.
 * @property {number} end Character after the node.
 * @property {'object' | 'array' | 'string' | 'primitive'} kind Node kind.
 * @property {{ key: string, value: JsonSourceNode }[]} [children] Object members or array items.
 */

/**
 * Parse a JSON document into a range tree.
 *
 * @param {string} text Valid JSON source.
 * @returns {JsonSourceNode} Root node with nested ranges.
 * @throws {Error} When the document nests deeper than the accepted limit.
 */
export function parseJsonSource(text) {
  // Let the platform validate grammar; discard its potentially rounded values.
  JSON.parse(text);
  const tokens = text.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g);
  let token = tokens.next().value;
  const next = () => {
    token = tokens.next().value;
  };
  const read = (depth) => {
    if (depth > 64) throw new Error('JSON structure exceeds depth limit');
    const raw = token[0];
    const node = {
      start: token.index,
      end: token.index + raw.length,
      kind: raw === '{' ? 'object' : raw === '[' ? 'array' : raw[0] === '"' ? 'string' : 'primitive',
    };
    next();
    if (node.kind === 'object' || node.kind === 'array') {
      node.children = [];
      const end = node.kind === 'object' ? '}' : ']';
      while (token[0] !== end) {
        let key = String(node.children.length);
        if (node.kind === 'object') {
          key = JSON.parse(token[0]);
          next(); // colon
          next(); // value
        }
        node.children.push({ key, value: read(depth + 1) });
        if (token[0] === ',') next();
      }
      node.end = token.index + 1;
      next();
    }
    return node;
  };
  return read(0);
}

/**
 * Resolve an RFC 6901 pointer to the exact source text it addresses.
 *
 * Escapes are applied per token, not across the whole pointer, and duplicate
 * object keys resolve to the last occurrence, matching a real parse.
 *
 * @param {string} text JSON source.
 * @param {string} pointer Pointer such as `/items/0/id`; an empty pointer is the root.
 * @returns {string} Source substring for the addressed value.
 * @throws {Error} When the pointer is malformed or addresses a missing node.
 */
export function jsonPointer(text, pointer) {
  if (pointer !== '' && !pointer.startsWith('/')) throw new Error('pointer must be an RFC 6901 JSON pointer');
  let node = parseJsonSource(text);
  for (const token of pointer === '' ? [] : pointer.slice(1).split('/')) {
    if (/~(?:[^01]|$)/.test(token)) throw new Error('invalid JSON pointer escape');
    const key = token.replaceAll('~1', '/').replaceAll('~0', '~');
    const child = node.children && [...node.children].reverse().find((item) => item.key === key);
    if (!child) throw new Error('JSON pointer not found');
    node = child.value;
  }
  return text.slice(node.start, node.end);
}
