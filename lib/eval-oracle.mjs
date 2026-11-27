/**
 * Eval tri-state oracle（三态判定 + evidence 必填规则）。
 *
 * 单项判定（judgeCheck）：
 * - fail:        ok === false（明确失败；证据缺失不会把失败变 unverified）；
 * - pass:        ok === true 且（不要求证据 或 有非空证据）；
 * - unverified:  没有明确结论（ok 缺失）、check 非法、或“要求证据却没给”。
 *
 * 整体判定（judge）：
 * - failed:      任一硬检查失败；
 * - passed:      全部检查通过，且没有任何 unverified；
 * - unverified:  没有失败，但至少一项无法判定（含证据缺失）。
 *
 * 关键约束：unverified 永不算 pass（A skip is NOT passed）。缺 evidence 的“通过”必须降级为 unverified。
 */

function hasEvidence(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  // 0 / false 也是有效证据（例如 refs=0、verified=false）。
  return true;
}

function normalizeUnverified(entry) {
  if (typeof entry === 'string' && entry) return { id: entry, reason: 'unverified' };
  if (entry && typeof entry === 'object') return entry;
  return { id: null, reason: 'unverified' };
}

/** 判定单项检查。#1 返回 { id, status: 'pass'|'fail'|'unverified', reason?, evidence }。 */
export function judgeCheck(check) {
  if (!check || typeof check !== 'object') {
    return { id: null, status: 'unverified', reason: 'invalid check', evidence: null };
  }
  const id = check.id === undefined || check.id === null ? null : String(check.id);
  const evidence = check.evidence === undefined ? null : check.evidence;
  const evidenceRequired = check.evidenceRequired === true || check.requireEvidence === true;
  if (check.ok === false) {
    // 明确失败优先；证据缺失也记在 reason 里，但不改变 fail 结论。
    return {
      id,
      status: 'fail',
      reason: evidenceRequired && !hasEvidence(evidence) ? 'missing evidence' : 'check failed',
      evidence,
    };
  }
  if (check.ok !== true) {
    return { id, status: 'unverified', reason: typeof check.reason === 'string' && check.reason ? check.reason : 'no verdict', evidence };
  }
  if (evidenceRequired && !hasEvidence(evidence)) {
    return { id, status: 'unverified', reason: 'missing evidence', evidence };
  }
  return { id, status: 'pass', reason: null, evidence };
}

export function judge({ checks = [], unverified = [] } = {}) {
  const list = Array.isArray(checks) ? checks : [];
  const unknown = (Array.isArray(unverified) ? unverified : []).map(normalizeUnverified);
  const items = list.map(judgeCheck);
  const failures = items.filter((item) => item.status === 'fail');
  const unresolved = items.filter((item) => item.status === 'unverified');
  const passes = items.filter((item) => item.status === 'pass');
  const allUnverified = [...unknown, ...unresolved.map((item) => ({ id: item.id, reason: item.reason || 'unverified' }))];
  const counts = { pass: passes.length, fail: failures.length, unverified: allUnverified.length };
  if (failures.length) return { status: 'failed', failures, unverified: allUnverified, counts, items };
  if (allUnverified.length) return { status: 'unverified', failures: [], unverified: allUnverified, counts, items };
  if (!list.length) {
    return { status: 'unverified', failures: [], unverified: [{ id: null, reason: 'no checks' }], counts: { pass: 0, fail: 0, unverified: 1 }, items };
  }
  return { status: 'passed', failures: [], unverified: [], counts, items };
}

export function assertStatus(result, expected) {
  if (!result || result.status !== expected) {
    throw new Error('eval 期望 ' + expected + '，实际 ' + (result && result.status));
  }
  return result;
}
