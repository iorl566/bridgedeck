/**
 * Eval tri-state oracle:
 * - failed: any hard check failed;
 * - passed: all checks passed and nothing unverified;
 * - unverified: no failures, but at least one check could not be judged.
 *
 * A skip is NOT passed.
 */
export function judge({ checks = [], unverified = [] } = {}) {
  const list = Array.isArray(checks) ? checks : [];
  const unknown = Array.isArray(unverified) ? unverified : [];
  const failures = list.filter((check) => check && check.ok === false);
  if (failures.length) return { status: 'failed', failures, unverified: unknown };
  if (unknown.length) return { status: 'unverified', failures: [], unverified: unknown };
  if (!list.length) return { status: 'unverified', failures: [], unverified: ['no checks'] };
  return { status: 'passed', failures: [], unverified: [] };
}

export function assertStatus(result, expected) {
  if (!result || result.status !== expected) {
    throw new Error('eval 期望 ' + expected + '，实际 ' + (result && result.status));
  }
  return result;
}
