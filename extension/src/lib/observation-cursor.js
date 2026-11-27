/** Observation cursor codec: opaque base64url JSON with tab/offset/at/revision/document. */
export function encodeCursor(value) {
  const json = JSON.stringify(value);
  const base64 = typeof btoa === 'function'
    ? btoa(unescape(encodeURIComponent(json)))
    : Buffer.from(json, 'utf8').toString('base64');
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(text) {
  const base64 = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
  const json = typeof atob === 'function'
    ? decodeURIComponent(escape(atob(base64)))
    : Buffer.from(base64, 'base64').toString('utf8');
  return JSON.parse(json);
}
