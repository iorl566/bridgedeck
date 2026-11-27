import { parseJsonSource } from './json-source.js';
import { BODY_CHARS, redactBody, redactHeaders, redactText, redactUrl } from './redact.js';

/**
 * Validation and normalization for local request control: rule specs, replay
 * specs, header/body limits and the live request shape sent to the browser.
 *
 * Evidence shapes (`DebugRequestEdit`, `DebugRuleSpec`, `DebugReplaySpec`,
 * `DebugRequest`) are declared in ./types.js; the bare names below refer to
 * those declarations.
 *
 * @typedef {object} LiveRequest
 * @property {string} url
 * @property {string} method
 * @property {Record<string, string>} headers Lower-cased header names.
 * @property {string} [postData] Complete text body; binary bodies are excluded.
 * @property {boolean} [hasPostData] Whether the browser reported a body.
 */

/** Rule and replay limits enforced per capture. */
export const MAX_RULES = 32;
export const MAX_REPLAYS = 20;
const METHODS = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/;
const CONTROL_URL_CHARS = 16 * 1024;
const PLACEHOLDER = /\[redacted\]|%5bredacted%5d|\[depth limit\]/i;
const FORBIDDEN_HEADER = /^(?:host|content-length|cookie|cookie2|origin|referer|user-agent|accept-encoding|connection|transfer-encoding|upgrade|proxy-.*|sec-.*|access-control-request-.*)$/i;
const own = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {boolean} ok Condition that must hold.
 * @param {string} message Error message shown when it does not.
 * @returns {void}
 * Throws the plain message; callers catch it and report a validation failure.
 */
function requireValue(ok, message) { if (!ok) throw new Error(message); }
/**
 * @param {object} value Candidate option object.
 * @param {string[]} allowed Accepted option names.
 * @returns {void}
 * Throws when the object has any name outside `allowed`, so an unsupported
 * option cannot be ignored silently.
 */
function keys(value, allowed) { requireValue(Object.keys(value).every((key) => allowed.includes(key)), 'unknown control option'); }

/**
 * @param {string} value Candidate URL.
 * @returns {URL} Parsed absolute HTTP(S) URL.
 * Throws when the URL is missing, redacted, too long, carries credentials, a
 * fragment, or a non-HTTP(S) scheme.
 */
export function httpUrl(value) {
  requireValue(typeof value === 'string' && value.length <= CONTROL_URL_CHARS && !PLACEHOLDER.test(value), 'URL is missing, redacted or too long');
  const url = new URL(value);
  requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash, 'an absolute HTTP(S) URL without credentials or fragment is required');
  return url;
}
/**
 * @param {unknown} value Candidate body text.
 * @returns {void}
 * Throws unless the body is complete text within the retained character budget;
 * redacted placeholders are rejected because they cannot be replayed.
 */
function body(value) {
  requireValue(typeof value === 'string' && value.length <= BODY_CHARS && !PLACEHOLDER.test(value), 'body must be complete text up to 65536 characters, without redacted placeholders');
}
/**
 * @param {unknown} value Replacement value for one JSON field.
 * @returns {string} Compact JSON text, safe to splice into a request body.
 * Throws for values that cannot round-trip exactly, such as non-finite numbers
 * or integers outside the safe range.
 */
function jsonEditValue(value) {
  const text = JSON.stringify(value, (_key, item) => {
    requireValue(typeof item !== 'number' || (Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item))), 'JSON edits cannot carry unsafe numeric values; use an exact text body replacement');
    return item;
  });
  requireValue(text !== undefined, 'JSON edit value is not serializable');
  return text;
}
/**
 * @param {object} value Header map; at most 40 entries, names lower-cased.
 * @param {boolean} [response] Apply response-side restrictions (content-encoding).
 * @returns {Record<string, string | null>} Normalized headers; null means remove.
 * Throws on invalid, duplicate, forbidden or redacted headers.
 */
export function checkedHeaders(value, response = false) {
  requireValue(own(value), 'headers must be an object');
  requireValue(Object.keys(value).length <= 40, 'too many headers');
  const result = {};
  for (const [key, valueText] of Object.entries(value)) {
    const name = key.toLowerCase();
    requireValue(/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) && name.length <= 128, 'invalid header name');
    requireValue(!FORBIDDEN_HEADER.test(name) && name !== 'set-cookie' && (!response || name !== 'content-encoding'), `unsupported header: ${name}`);
    requireValue(valueText === null || (typeof valueText === 'string' && valueText.length <= 4096 && !/[\r\n\0]/.test(valueText) && !PLACEHOLDER.test(valueText)), `invalid or redacted header: ${name}`);
    requireValue(!Object.hasOwn(result, name), 'duplicate header name');
    Object.defineProperty(result, name, { value: valueText, enumerable: true });
  }
  requireValue(JSON.stringify(result).length <= 8192, 'headers too large');
  return result;
}
/**
 * @param {DebugRequestEdit} edit URL, method, header, body or JSON changes.
 * @returns {void}
 * Throws when a change is unsupported, redacted, ambiguous or too large.
 */
export function validateEdit(edit) {
  if (edit.url !== undefined) httpUrl(edit.url);
  if (edit.method !== undefined) requireValue(METHODS.test(edit.method), 'unsupported HTTP method');
  if (edit.headers !== undefined) checkedHeaders(edit.headers);
  if (edit.body !== undefined) body(edit.body);
  requireValue(!(edit.body !== undefined && edit.json !== undefined), 'choose body replacement or JSON edits');
  if (edit.json !== undefined) {
    requireValue(own(edit.json), 'JSON edits must be an object');
    keys(edit.json, ['set', 'remove', 'rename']);
    if (edit.json.set !== undefined) { requireValue(own(edit.json.set), 'JSON set must be an object'); jsonEditValue(edit.json.set); }
    if (edit.json.rename !== undefined) {
      requireValue(own(edit.json.rename), 'JSON rename must be an object');
      requireValue(Object.values(edit.json.rename).every((value) => typeof value === 'string' && value.length > 0 && value.length <= 128), 'invalid JSON rename');
    }
    if (edit.json.remove !== undefined) {
      requireValue(Array.isArray(edit.json.remove) && edit.json.remove.every((key) => typeof key === 'string' && key.length <= 128), 'invalid JSON remove');
    }
    const count = Object.keys(edit.json.set ?? {}).length + Object.keys(edit.json.rename ?? {}).length + (edit.json.remove?.length ?? 0);
    requireValue(count > 0 && count <= 32, 'JSON edits require 1..32 top-level fields');
    body(JSON.stringify(edit.json));
  }
}
/**
 * @param {unknown} input Untrusted rule description.
 * @returns {DebugRuleSpec} Normalized rule spec with an absolute match URL.
 * Throws on unknown options, unsupported effects or exceeded limits.
 */
export function validateRule(input) {
  requireValue(own(input), 'rule must be an object');
  keys(input, ['name', 'match', 'effect', 'times']);
  requireValue(own(input.match) && own(input.effect), 'rule requires match and effect');
  keys(input.match, ['url', 'method', 'resource_type']);
  requireValue(typeof input.match.url === 'string', 'match.url is required');
  const url = httpUrl(input.match.url);
  requireValue(!url.origin.includes('*'), 'wildcards are only supported in the URL path/query');
  requireValue(input.match.method === undefined || (typeof input.match.method === 'string' && METHODS.test(input.match.method)), 'unsupported match method');
  requireValue(input.match.resource_type === undefined || ['Fetch', 'XHR', 'Document'].includes(input.match.resource_type), 'unsupported resource type');
  requireValue(input.name === undefined || (typeof input.name === 'string' && input.name.length <= 120), 'rule name too long');
  requireValue(input.times === undefined || (Number.isInteger(input.times) && input.times >= 0 && input.times <= 100), 'times must be 0..100 (default 1)');
  const effect = input.effect;
  if (effect.type === 'block') keys(effect, ['type']);
  else if (effect.type === 'modify') {
    keys(effect, ['type', 'url', 'method', 'headers', 'body', 'json']);
    validateEdit(effect);
    requireValue(Object.keys(effect).length > 1, 'modify requires at least one change');
    if (effect.url !== undefined) requireValue(httpUrl(effect.url).origin === url.origin, 'request URL changes must keep the same origin');
  } else if (effect.type === 'mock') {
    keys(effect, ['type', 'status', 'headers', 'body', 'delay_ms']);
    requireValue(Number.isInteger(effect.status) && effect.status >= 200 && effect.status <= 599 && ![301, 302, 303, 304, 305, 306, 307, 308].includes(effect.status), 'mock status must be 200..599, excluding redirects/304');
    body(effect.body);
    requireValue(![204, 205].includes(effect.status) || effect.body === '', '204/205 responses must have an empty body');
    if (effect.headers !== undefined) {
      const headers = checkedHeaders(effect.headers, true);
      requireValue(Object.values(headers).every((value) => value !== null), 'mock headers cannot be null');
    }
    requireValue(effect.delay_ms === undefined || (Number.isInteger(effect.delay_ms) && effect.delay_ms >= 0 && effect.delay_ms <= 10000), 'delay_ms must be 0..10000');
  } else throw new Error('effect.type must be block, modify or mock');
  requireValue(JSON.stringify(input).length <= 80 * 1024, 'rule too large');
  const normalized = structuredClone(input);
  normalized.match.url = url.href;
  return normalized;
}
/**
 * @param {unknown} input Untrusted replay description.
 * @returns {DebugReplaySpec} Normalized spec; `key` must be unique per capture.
 * Throws when the key is malformed or a replacement value is invalid.
 */
export function validateReplay(input) {
  requireValue(own(input), 'replay options with a unique key are required');
  keys(input, ['key', 'url', 'method', 'headers', 'body']);
  requireValue(typeof input.key === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(input.key), 'replay key must be 1..80 letters, digits, _ or -');
  validateEdit(input);
  return structuredClone(input);
}
/**
 * @param {string} pattern Match URL; `*` is the only wildcard.
 * @returns {RegExp} Anchored matcher where every other character is literal.
 */
export function urlMatcher(pattern) {
  return new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}
/**
 * @param {LiveRequest} request Intercepted request as sent by the browser.
 * @param {DebugRequestEdit} edit Validated changes.
 * @returns {LiveRequest} Effective request to continue with.
 * Throws when the change would alter the origin, target a binary or multipart
 * body, or add a body to GET/HEAD.
 */
export function editRequest(request, edit) {
  const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), value]));
  for (const [key, value] of Object.entries(checkedHeaders(edit.headers ?? {}))) {
    if (value === null) delete headers[key];
    else Object.defineProperty(headers, key, { value, enumerable: true, configurable: true, writable: true });
  }
  let postData = edit.body ?? request.postData;
  if (edit.json) {
    requireValue(postData !== undefined && postData.length <= BODY_CHARS && /json/i.test(headers['content-type'] ?? ''), 'JSON edits require a complete JSON request body');
    const source = parseJsonSource(postData);
    requireValue(source.kind === 'object', 'JSON edits require a top-level object');
    const value = new Map(source.children.map(({ key, value }) => [key, postData.slice(value.start, value.end)]));
    requireValue(value.size === source.children.length, 'JSON edits require unique top-level keys');
    for (const [from, to] of Object.entries(edit.json.rename ?? {})) {
      requireValue(value.has(from) && !value.has(to), 'JSON rename source missing or destination already exists');
      value.set(to, value.get(from));
      value.delete(from);
    }
    for (const key of edit.json.remove ?? []) value.delete(key);
    for (const [key, item] of Object.entries(edit.json.set ?? {})) value.set(key, jsonEditValue(item));
    postData = `{${[...value].map(([key, raw]) => `${JSON.stringify(key)}:${raw}`).join(',')}}`;
  }
  if (edit.body !== undefined || edit.json !== undefined) requireValue(postData === undefined || postData.length <= BODY_CHARS, 'request body too large');
  requireValue(!/multipart\/|octet-stream/i.test(headers['content-type'] ?? '') || (edit.body === undefined && edit.json === undefined), 'binary/multipart body editing is unsupported');
  const method = edit.method ?? request.method;
  requireValue(!['GET', 'HEAD'].includes(method) || !postData, 'GET/HEAD cannot have a body');
  const url = edit.url ?? request.url;
  requireValue(httpUrl(url).origin === httpUrl(request.url).origin, 'request URL changes must keep the same origin');
  return { url, method, headers, ...(postData === undefined ? {} : { postData }) };
}
/**
 * @param {DebugRequest} source Retained request used as the template.
 * @param {DebugReplaySpec} spec Validated replay options.
 * @param {string} pageUrl Current page URL; the replay must share its origin.
 * @returns {LiveRequest} Request to send.
 * Throws when the source URL, metadata or body is incomplete, redacted or
 * unverified, or when a replacement violates the edit rules.
 */
export function replayRequest(source, spec, pageUrl) {
  requireValue(spec.url !== undefined || source.integrity?.url === 'complete', 'source URL is incomplete, redacted or unverified; provide a complete replacement URL');
  const url = httpUrl(spec.url ?? source.url);
  requireValue(url.origin === httpUrl(new URL(pageUrl).origin).origin && new URL(source.url).origin === url.origin, 'replay currently requires the source request and active page to share an origin');
  requireValue(source.integrity ? source.integrity.metadata === 'complete' : !source.truncated, 'source request is incomplete; reproduce it to capture a complete request');
  requireValue(!source.intervention || source.intervention.state === 'applied', 'source intervention did not complete');
  const headers = {};
  for (const [key, value] of Object.entries(source.request_headers ?? {})) {
    if (!FORBIDDEN_HEADER.test(key) && key.toLowerCase() !== 'set-cookie') Object.defineProperty(headers, key.toLowerCase(), { value, enumerable: true });
  }
  if (spec.body === undefined) {
    requireValue(['available', 'empty'].includes(source.request_body.state) && source.request_body.replay_safe === true && !source.request_body.redacted && (source.request_body.state === 'empty' || source.request_body.text !== undefined), 'source body is missing, changed or unverified; provide a complete replacement body');
  }
  const result = editRequest({ url: url.href, method: source.method, headers, postData: source.request_body.text }, spec);
  httpUrl(result.url);
  for (const [key, value] of Object.entries(result.headers)) requireValue(!PLACEHOLDER.test(value), `provide or remove redacted header: ${key}`);
  if (result.postData !== undefined) body(result.postData);
  requireValue(!/multipart\/|octet-stream/i.test(result.headers['content-type'] ?? ''), 'binary/multipart replay is unsupported');
  return result;
}
/**
 * @param {DebugRuleSpec} spec Rule spec to expose.
 * @returns {DebugRuleSpec} Copy with URL, headers and body redacted for output.
 */
export function publicRule(spec) {
  const copy = structuredClone(spec);
  copy.name = spec.name === undefined ? undefined : redactText(spec.name, 120);
  copy.match.url = redactUrl(spec.match.url);
  const effect = copy.effect;
  if (effect.type === 'modify') {
    if (effect.url) effect.url = redactUrl(effect.url);
    if (effect.headers) {
      effect.headers = Object.fromEntries(Object.entries(effect.headers).map(([key, value]) => [key, value === null ? null : redactHeaders({ [key]: value })[key.toLowerCase()]]));
    }
    if (effect.json?.set) effect.json.set = JSON.parse(redactBody(JSON.stringify(effect.json.set), 'application/json').text || '{}');
  }
  if (effect.type === 'mock' && effect.headers) effect.headers = redactHeaders(effect.headers);
  if (effect.type !== 'block' && effect.body !== undefined) {
    const mime = Object.entries(effect.headers ?? {}).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? 'text/plain';
    effect.body = redactBody(effect.body, mime).text;
  }
  return copy;
}
