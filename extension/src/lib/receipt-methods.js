import { METHOD_EFFECT } from '../generated/protocol.js';

export const RECEIPT_METHODS = new Set(
  Object.keys(METHOD_EFFECT).filter((method) => METHOD_EFFECT[method] === 'transient_input' || METHOD_EFFECT[method] === 'browser_mutation'),
);

export function needsReceipt(method) {
  return RECEIPT_METHODS.has(String(method || ''));
}

