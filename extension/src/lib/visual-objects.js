/** Merge visual regions and ref-coordinate map into one ordered object list. */
export function buildVisualObjects({ regions = null, refs = null } = {}) {
  const out = [];
  if (regions && Array.isArray(regions.candidates)) {
    for (const region of regions.candidates) {
      out.push({
        kind: 'region',
        index: region.index,
        tag: region.tag,
        id: region.id || null,
        rect: region.rect,
      });
    }
  }
  if (refs && Array.isArray(refs.refs)) {
    for (const ref of refs.refs) {
      out.push({
        kind: 'ref',
        ref: ref.ref,
        role: ref.role || null,
        name: ref.name || null,
        rect: { x: ref.x, y: ref.y, width: ref.width, height: ref.height },
      });
    }
  }
  return out;
}
