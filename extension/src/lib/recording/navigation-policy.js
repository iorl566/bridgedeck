const REDIRECT_QUALIFIERS = new Set(['client_redirect', 'server_redirect']);

/**
 * @param {readonly string[]} [qualifiers]
 * @returns {boolean}
 */
export function hasRedirectQualifier(qualifiers) {
  return (qualifiers ?? []).some((qualifier) => REDIRECT_QUALIFIERS.has(qualifier));
}
