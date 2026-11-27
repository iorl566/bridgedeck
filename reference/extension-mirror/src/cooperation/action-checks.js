/** Preserve the actual failed check across handler/dispatch exception boundaries. */
export class ActionCheckError extends Error {
  constructor(rpcError) {
    super(rpcError.message);
    this.rpcError = rpcError;
    this.name = 'ActionCheckError';
  }
}

export function actionError(reason, message, phase, recovery, details = {}) {
  return {
    code: 'permission_denied',
    message,
    data: { reason, phase, effect_state: 'none', recovery, ...details },
  };
}

export function parseExpectations(value) {
  if (value === undefined) return [];
  const invalid = {
    code: 'invalid_params',
    message: 'expect requires at most 16 checks with target, field and equals; only attribute checks accept attribute',
    data: { reason: 'precondition_invalid', phase: 'precondition', effect_state: 'none' },
  };
  if (!Array.isArray(value) || value.length > 16) return invalid;
  for (const check of value) {
    if (!check || typeof check !== 'object' || Array.isArray(check)
      || Object.keys(check).some((key) => !['target', 'field', 'equals', 'attribute'].includes(key))
      || typeof check.target !== 'string' || !check.target.trim() || [...check.target].length > 1024) return invalid;
    if (check.field === 'attribute') {
      if (typeof check.attribute !== 'string' || !check.attribute.trim() || [...check.attribute].length > 256 || (check.equals !== null && typeof check.equals !== 'string')) return invalid;
    } else {
      if (check.attribute !== undefined) return invalid;
      if (['text', 'value'].includes(check.field)) {
        if (typeof check.equals !== 'string') return invalid;
      } else if (['checked', 'exists'].includes(check.field)) {
        if (typeof check.equals !== 'boolean') return invalid;
      } else return invalid;
    }
  }
  return value;
}
