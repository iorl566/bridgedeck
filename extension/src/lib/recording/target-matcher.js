/**
 * Match a captured target against observation geometry and semantics.
 *
 * @typedef {object} TargetGeometry
 * @property {{ x: number, y: number, w: number, h: number }} rect
 * @property {string} tag
 *
 * @typedef {object} TargetMatchHint
 * @property {TargetGeometry} [geometry]
 * @property {string | null} [frameId]
 * @property {'top' | 'local'} [geometrySpace]
 *
 * @typedef {object} MatchInput
 * @property {object} observation
 * @property {TargetMatchHint} [hint]
 * @property {{ role?: string, name?: string }} [fallback]
 */

const MATCH_TOLERANCE_PX = 2;

function close(a, b) { return Math.abs(a - b) <= MATCH_TOLERANCE_PX; }
function rectMatches(a, b) { return close(a.x, b.x) && close(a.y, b.y) && close(a.w, b.w) && close(a.h, b.h); }

function candidateMatches(candidate, geometry, geometrySpace) {
  const rect = geometrySpace === 'local' ? candidate.geometry.localRect : candidate.geometry.rect;
  return rect != null && rectMatches(geometry.rect, rect);
}

/**
 * @param {{ role?: string, name?: string }} [fallback]
 * @returns {object}
 */
export function unmatchedTarget(fallback) {
  return {
    ...(fallback?.role ? { role: fallback.role } : {}),
    ...(fallback?.name ? { name: fallback.name } : {}),
    unmatched: true,
  };
}

function normalized(value) { return value?.replace(/\s+/g, ' ').trim().toLowerCase() ?? ''; }

function matchesSemantics(ref, fallback) {
  const role = normalized(fallback?.role);
  const name = normalized(fallback?.name);
  if (!role && !name) return false;
  if (role && normalized(ref.role) !== role) return false;
  if (name && normalized(ref.name) !== name) return false;
  return true;
}

function descriptor(ref) {
  return {
    ref: ref.ref,
    ...(ref.role ? { role: ref.role } : {}),
    ...(ref.name ? { name: ref.name } : {}),
    ...(ref.ctx ? { ctx: ref.ctx } : {}),
  };
}

/**
 * @param {MatchInput} input
 * @returns {object}
 */
export function matchObservationTarget(input) {
  if (input.hint?.frameId === null) return unmatchedTarget(input.fallback);
  const frameId = input.hint?.frameId ?? input.observation.rootFrameId;
  const geometry = input.hint?.geometry;
  if (geometry) {
    const candidates = input.observation.index.candidates(frameId, geometry.tag).filter((candidate) => candidate.ref);
    const matches = candidates.filter((candidate) => candidateMatches(candidate, geometry, input.hint?.geometrySpace ?? 'top'));
    if (matches.length === 1) return descriptor(matches[0].ref);
    const pool = matches.length > 0 ? matches : normalized(input.fallback?.name) ? candidates : [];
    const semanticMatches = pool.filter((candidate) => candidate.ref && matchesSemantics(candidate.ref, input.fallback));
    if (semanticMatches.length === 1) return descriptor(semanticMatches[0].ref);
    return unmatchedTarget(input.fallback);
  }
  const semanticMatches = input.observation.index.refs(frameId).filter((ref) => matchesSemantics(ref, input.fallback));
  return semanticMatches.length === 1 ? descriptor(semanticMatches[0]) : unmatchedTarget(input.fallback);
}
