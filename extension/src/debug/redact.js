/**
 * Redaction applied before anything is retained or reported.
 *
 * Credentials can appear in a URL, in request or response headers, in form and
 * JSON bodies, and in server-rendered markup. Every exported helper removes
 * them while preserving the surrounding structure, because a consumer still
 * needs to recognize a redacted value as redacted rather than as a real short
 * string. The mask is stable so callers can test for it.
 */
import { parseJsonSource } from './json-source.js';

/** Redact before retaining evidence, including URLs and JSON/form values. */
const SECRET = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|pwd|secret|client[_-]?secret|(?:(?:access|refresh|id|auth|csrf|xsrf)[_-]?)?token|api[_-]?key|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token|session[_-]?(?:id|key)|credentials?)$/i;
// Exact vendor credential names. A generic `*token` suffix would also hide
// pagination cursors such as pageToken (#555), so each name is listed.
const VENDOR_SECRET = /^(?:private-token|x-goog-api-key|x-amz-security-token|ocp-apim-subscription-key|x-vault-token|x-access-token|x-csrftoken|x-shopify-access-token|x-hasura-admin-secret)$/i;
const MASK = '[redacted]';
/**
 * Retained character budget for one body.
 *
 * A structured body above this budget is withheld rather than truncated, because
 * a prefix could end in the middle of a secret value. Plain text may be cut and
 * is then marked as truncated and unsafe for replay.
 */
export const BODY_CHARS = 64 * 1024;
/**
 * Retained character budget for one URL.
 *
 * Longer URLs are cut after masking; the retained state records the truncation
 * so a consumer does not treat a shortened URL as complete.
 */
export const URL_CHARS = 2048;

/**
 * @param {string} name Header or field name.
 * @returns {boolean} True when the name itself denotes a credential.
 */
function secretName(name) {
  return SECRET.test(name) || VENDOR_SECRET.test(name.replaceAll('_', '-'));
}

/**
 * Inspect a key that may be a path, a form field or a camelCase name.
 * @param {string} key Field name.
 * @returns {boolean} True when any segment denotes a credential.
 */
function secretField(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[.[\]]+/)
    .some((part) => secretName(part) || /(?:^|[_-])(?:password|passwd|pwd)(?:[_-]|$)/i.test(part));
}

const HTML_FIELD_SEPARATORS = {
  period: '.', lowbar: '_', UnderBar: '_', lbrack: '[', lsqb: '[', rbrack: ']', rsqb: ']',
};

function htmlField(value) {
  // Normalize only references that can form our ASCII secret fields. A single
  // pass avoids treating escaped references as markup; retained bytes stay intact.
  return value.replace(
    /&(?:#(?:[xX]([\da-fA-F]+)|(\d+));?|(period|lowbar|UnderBar|lbrack|lsqb|rbrack|rsqb);)/g,
    (reference, hex, decimal, named) => {
      if (named) return HTML_FIELD_SEPARATORS[named];
      const code = Number.parseInt(hex ?? decimal, hex === undefined ? 10 : 16);
      return code > 0 && code < 128 ? String.fromCharCode(code) : reference;
    },
  );
}

/**
 * Mask credential patterns inside free text and cap its length.
 *
 * Bearer and Basic authorization values are replaced with the mask, as are
 * `name=value` and `"name": "value"` pairs whose name denotes a secret. The
 * surrounding syntax is preserved so the text still parses and a consumer can
 * see that a value was removed.
 *
 * @param {string} value Text to inspect.
 * @param {number} [cap] Maximum retained characters, applied before masking.
 * @returns {string} Masked text, at most `cap` characters.
 */
export function redactText(value, cap = 4096) {
  return value
    .slice(0, cap)
    .replace(/\b(Bearer|Basic)\s+[\w.+/~=-]+/gi, `$1 ${MASK}`)
    .replace(
      /((?:password|passwd|pwd|secret|(?:(?:access|refresh|id|auth|csrf|xsrf)[_-]?)?token|api[_-]?key)["']?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|[^\s,;&}]+)/gi,
      `$1${MASK}`,
    );
}

/**
 * Redact a request URL and report how completely it survived.
 *
 * Removes user information and the fragment, and replaces the values of query
 * parameters whose names denote credentials. A parsing failure falls back to text
 * masking, so the result is still safe to retain.
 *
 * @param {string} value Absolute or relative URL text.
 * @returns {{ text: string, state: 'complete' | 'redacted' | 'truncated' }}
 *   Masked URL and whether anything was removed or the budget was exceeded.
 */
export function redactRequestUrl(value) {
  let result;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (secretField(key)) url.searchParams.set(key, MASK);
    }
    result = url.href;
  } catch {
    result = value;
  }
  const text = redactText(result, URL_CHARS);
  return {
    text: text.slice(0, URL_CHARS),
    state: Math.max(result.length, text.length) > URL_CHARS
      ? 'truncated' : text !== value ? 'redacted' : 'complete',
  };
}

/**
 * @param {string} value URL text.
 * @returns {string} Masked and length-capped URL.
 */
export function redactUrl(value) {
  return redactRequestUrl(value).text;
}

/**
 * Redact a header map while preserving its shape.
 *
 * Names are lower-cased and capped; credential-bearing names are replaced by the
 * mask without reading the value. Total retained bytes and entry count are
 * bounded, and a repeated name or an exhausted budget stops the projection. The
 * `truncated` flag tells the caller that evidence was withheld, so integrity can
 * be recorded as partial.
 *
 * @param {unknown} value Candidate header map; non-objects yield an empty map.
 * @returns {{ headers: Record<string, string>, truncated: boolean }} Redacted
 *   headers and whether any entry was withheld or shortened.
 */
export function redactHeaderEvidence(value) {
  const headers = {};
  let truncated = false;
  if (!value || typeof value !== 'object') return { headers, truncated };
  const entries = Object.entries(value);
  truncated = entries.length > 80;
  let remaining = 4 * 1024;
  for (const [key, raw] of entries.slice(0, 80)) {
    const name = key.slice(0, 128).toLowerCase();
    const secret = secretName(name);
    const original = String(raw);
    const redacted = secret ? MASK : redactText(original, 2048);
    const limit = Math.max(0, Math.min(2048, remaining - name.length));
    truncated ||= key.length > 128 || (!secret && original.length > 2048);
    if (name.length > remaining || (secret && redacted.length > limit)) {
      truncated = true;
      break;
    }
    const text = redacted.slice(0, limit);
    truncated ||= text.length < redacted.length || Object.hasOwn(headers, name);
    // Define avoids the legacy __proto__ setter for untrusted header names.
    Object.defineProperty(headers, name, { value: text, enumerable: true, configurable: true });
    remaining -= name.length + text.length;
  }
  return { headers, truncated };
}

/**
 * @param {unknown} value Candidate header map.
 * @returns {Record<string, string>} Redacted headers; evidence loss is not
 *   reported on this convenience path.
 */
export function redactHeaders(value) {
  return redactHeaderEvidence(value).headers;
}

function redactJson(text, bounds) {
  const root = parseJsonSource(text);
  const parts = [];
  let cursor = 0;
  const replace = (node, value) => {
    parts.push(text.slice(cursor, node.start), JSON.stringify(value));
    cursor = node.end;
  };
  const visit = (node, depth, secret = false) => {
    if (secret) replace(node, MASK);
    else if (depth > 24) {
      bounds.truncated = true;
      replace(node, '[depth limit]');
    } else if (node.children) {
      for (const child of node.children) visit(child.value, depth + 1, node.kind === 'object' && secretField(child.key));
    } else if (node.kind === 'string') {
      const value = JSON.parse(text.slice(node.start, node.end));
      const redacted = redactText(value, BODY_CHARS);
      if (redacted !== value) replace(node, redacted);
    }
  };
  visit(root, 0);
  parts.push(text.slice(cursor));
  return parts.join('');
}

/**
 * Redact a request or response body according to its media type.
 *
 * Structured payloads are redacted before any truncation, because cutting a JSON
 * or form body first could retain half of a secret value. Oversized or
 * unparsable structured bodies are therefore withheld entirely and marked
 * unsafe for replay. HTML input elements that carry credential fields are
 * replaced, and form bodies keep their ordering and duplicate fields.
 *
 * @param {string} text Complete body text.
 * @param {string} mime Media type reported for the body.
 * @returns {{ text: string, redacted: boolean, truncated: boolean,
 *   replay_safe: boolean, reason?: string }} Retained text and the integrity
 *   flags a later replay must respect.
 */
export function redactBody(text, mime) {
  const truncated = text.length > BODY_CHARS;
  // Structured payloads must be redacted before truncation. Refuse oversized JSON
  // rather than retaining a prefix that may contain a cut-off secret value.
  if (truncated && /json|x-www-form-urlencoded/i.test(mime)) {
    return { text: '', redacted: true, truncated: true, replay_safe: false };
  }
  let result;
  const bounds = { truncated: false };
  if (/json/i.test(mime) || /^[\s]*[\[{]/.test(text)) {
    try {
      if (truncated) return { text: '', redacted: true, truncated: true, replay_safe: false };
      result = redactJson(text, bounds);
    } catch {
      // An unparsed structured payload cannot be safely inspected for nested secrets.
      return { text: '', redacted: true, truncated: true, replay_safe: false, reason: 'unparsed_json' };
    }
  } else if (/html/i.test(mime)) {
    // A password can also occur in a server-rendered input's value attribute.
    // Remove that input from retained HTML rather than exposing its initial value.
    result = redactText(
      text.replace(/<input\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => {
        const attributes = tag.matchAll(/\b(type|name|id|autocomplete)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi);
        for (const match of attributes) {
          const value = htmlField(match[2] ?? match[3] ?? match[4]);
          if (
            secretField(value) ||
            secretField(value.toLowerCase()) ||
            value.trim().split(/\s+/).some((token) => /^(?:current-password|new-password|one-time-code|cc-.+)$/i.test(token))
          ) return '<input data-bb-redacted="true">';
        }
        return tag;
      }),
      BODY_CHARS,
    );
  } else if (/x-www-form-urlencoded/i.test(mime)) {
    // Preserve untouched bytes, ordering and duplicates (including signed form bodies).
    result = text.split('&').map((field) => {
      const key = new URLSearchParams(field).keys().next().value;
      if (key === undefined || !secretField(key)) return field;
      return `${field.split('=', 1)[0]}=${encodeURIComponent(MASK)}`;
    }).join('&');
  } else {
    result = redactText(text, BODY_CHARS);
  }
  return {
    text: result.slice(0, BODY_CHARS),
    redacted: result !== text,
    truncated: truncated || bounds.truncated || result.length > BODY_CHARS,
    replay_safe: !truncated && !bounds.truncated && result === text,
  };
}
