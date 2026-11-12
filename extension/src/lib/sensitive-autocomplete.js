/**
 * Recognisers for fields that must never be recorded verbatim.
 *
 * An `autocomplete` value is an ASCII-whitespace separated token list such as
 * `section-login current-password webauthn`. Only individual tokens carry
 * meaning, so matching the raw string would miss hints wrapped in extra tokens
 * and could also produce false positives. Both the JavaScript predicate below
 * and the generated CSS selector are derived from the same token set so a page
 * probe and the recording path agree on what counts as sensitive.
 */

/** Autocomplete tokens that name a secret field. */
const SECRET_FIELDS = new Set(['current-password', 'new-password', 'one-time-code']);

/**
 * Marks an input whose type was switched away from "password" during recording,
 * so the recorder can recognise it after the type change and restore it later.
 */
export const RECORD_PASSWORD_ATTRIBUTE = 'data-bb-record-password';

/**
 * True when an autocomplete attribute names a credential, code or card field.
 * The value is an ASCII-whitespace token list, so match each token rather than
 * the whole string. Matching is case-insensitive, `cc-*` card tokens are treated
 * as sensitive, and a missing value is not sensitive.
 *
 * @param {string | null | undefined} value  Raw `autocomplete` attribute value.
 * @returns {boolean} True when any token identifies a secret field.
 */
export function sensitiveAutocomplete(value) {
  return (value ?? '')
    .toLowerCase()
    .split(/[\t\n\f\r ]+/)
    .some((token) => token.startsWith('cc-') || SECRET_FIELDS.has(token));
}

/** The same match as CSS, for probes that run in the page and cannot import this module. */
export const SENSITIVE_AUTOCOMPLETE_SELECTOR = [
  ...[...SECRET_FIELDS].map((token) => `[autocomplete~="${token}" i]`),
  '[autocomplete^="cc-" i]',
  '[autocomplete*=" cc-" i]',
].join(',');
