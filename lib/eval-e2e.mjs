/**
 * 从 E2E 的 PASS/FAIL 行提取 case 结果，再与 case 清单比对。
 * 这是 eval corpus 的“真实浏览器执行器”，不做假绿：缺失 case = unverified。
 */
export function parseE2EResults(text) {
  const results = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^\s*(PASS|FAIL)\s+([0-9A-Za-z_.-]+)\.\s+(.*)$/.exec(line);
    if (!match) continue;
    const [, status, id, detail] = match;
    results.set(id, { id, ok: status === 'PASS', detail: detail.trim() });
  }
  return results;
}

export function summarizeCases(cases, results) {
  const checks = [];
  const unverified = [];
  for (const item of Array.isArray(cases) ? cases : []) {
    const id = typeof item === 'string' ? item : item && item.id;
    if (!id) continue;
    const result = results.get(id);
    if (!result) {
      unverified.push({ id, reason: 'missing' });
      continue;
    }
    checks.push({ id, ok: result.ok, detail: result.detail });
  }
  return { checks, unverified };
}
