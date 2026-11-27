/**
 * Action Receipt：写动作的可核验回执。
 * 只描述事实与恢复路径，不重复页面全文。
 * `target` 是**不含输入值**的目标描述（ref/stableRef/role/name/selector/text），
 * 供 daemon 的 session run log / recipe 草稿使用。
 *
 * W2 补充：UNKNOWN 回执带 cleanupState / 账本关联 / 显式 reconcile 指引；
 * 这些字段只在调用方提供时出现，保持既有回执形状（老测试与日志消费方）不变。
 */

/** UNKNOWN 状态的恢复路径：先观察核对，再显式 resolve，绝不允许盲目重放。 */
export const UNKNOWN_RECOVERY = 'observe --force';

export function buildActionReceipt({
  method,
  ref,
  frameId = 0,
  revision = null,
  effectState = 'committed',
  via = null,
  recovery = null,
  target = null,
  cleanupState = null,
  journalId = null,
  txId = null,
  reconcile = null,
  resolution = null,
  transaction = null,
} = {}) {
  const tx = transaction && typeof transaction.snapshot === 'function' ? transaction.snapshot() : null;
  const rawState = effectState !== undefined && effectState !== null
    ? effectState
    : (tx && tx.effectState ? tx.effectState : 'committed');
  const state = rawState === 'none' || rawState === 'unknown' ? rawState : 'committed';
  const cleanup = cleanupState || (tx && tx.cleanupState) || (state === 'unknown' ? 'failed' : 'ok');
  const journal = journalId || (tx && tx.journalId) || null;
  const txIdValue = txId || (tx && tx.id) || null;
  return Object.freeze({
    method: String(method || ''),
    ref: ref || null,
    frameId: Number.isInteger(Number(frameId)) ? Number(frameId) : 0,
    revision: Number.isInteger(Number(revision)) ? Number(revision) : null,
    effectState: state,
    ...(via ? { via: String(via) } : {}),
    ...(target && typeof target === 'object' ? { target } : {}),
    recovery: recovery || (state === 'committed' ? null : UNKNOWN_RECOVERY),
    ...(cleanupState || state === 'unknown' ? { cleanupState: cleanup } : {}),
    ...(journal ? { journalId: String(journal) } : {}),
    ...(txIdValue ? { txId: String(txIdValue) } : {}),
    ...(reconcile || state === 'unknown'
      ? {
        reconcile: reconcile || {
          needResolve: true,
          outcomes: ['confirmed', 'not-applied'],
          hint: '先 observe/截图核对页面，再显式 resolve；UNKNOWN 不会自动重放',
        },
      }
      : {}),
    ...(resolution && typeof resolution === 'object' ? { resolution } : {}),
  });
}

export function attachReceipt(result, receipt) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (result.receipt) return result;
  return { ...result, receipt };
}

/**
 * 事务 → 回执字段：action 层若把 transaction 传给 dispatch 层，可直接摊平。
 * （dispatch.js 暂未接线：它属 W3 写域，字段在这里保持可选。）
 */
export function transactionReceiptFields(transaction) {
  if (!transaction || typeof transaction.snapshot !== 'function') return {};
  const snapshot = transaction.snapshot();
  return {
    txId: snapshot.id,
    effectState: snapshot.effectState,
    cleanupState: snapshot.cleanupState,
    ...(snapshot.journalId ? { journalId: snapshot.journalId } : {}),
    transactionState: snapshot.state,
  };
}

/**
 * UNKNOWN 回执的显式 resolve：把人工/Agent 的结论写进回执，保留原始证据。
 * 只接受 confirmed / not-applied（与事务 resolve 同语义）。
 */
export function resolveActionReceipt(receipt, options = {}) {
  if (!receipt || typeof receipt !== 'object') return receipt;
  if (receipt.effectState !== 'unknown') return receipt;
  const outcome = String(options.outcome || 'confirmed');
  if (!['confirmed', 'not-applied'].includes(outcome)) {
    const error = new Error('resolve outcome 只能是 confirmed / not-applied');
    error.code = 'E_BAD_ARG';
    throw error;
  }
  return Object.freeze({
    ...receipt,
    effectState: outcome === 'not-applied' ? 'none' : 'unknown',
    resolution: {
      outcome,
      by: options.by ? String(options.by) : 'agent',
      at: new Date(options.now || Date.now()).toISOString(),
      ...(options.note ? { note: String(options.note).slice(0, 300) } : {}),
      ...(options.evidence ? { evidence: options.evidence } : {}),
    },
  });
}
