/**
 * Action Receipt：写动作的可核验回执。
 * 只描述事实与恢复路径，不重复页面全文。
 */
export function buildActionReceipt({ method, ref, frameId = 0, revision = null, effectState = 'committed', via = null, recovery = null } = {}) {
  const state = effectState === 'none' || effectState === 'unknown' ? effectState : 'committed';
  return Object.freeze({
    method: String(method || ''),
    ref: ref || null,
    frameId: Number.isInteger(Number(frameId)) ? Number(frameId) : 0,
    revision: Number.isInteger(Number(revision)) ? Number(revision) : null,
    effectState: state,
    ...(via ? { via: String(via) } : {}),
    recovery: recovery || (state === 'committed' ? null : 'observe --force'),
  });
}

export function attachReceipt(result, receipt) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (result.receipt) return result;
  return { ...result, receipt };
}
