// eval 用例之外失败的 E2E 检查：不能因为“用例全过”就静默重试。
export function findNonCaseFailures(cases, results) {
  const ids = new Set((Array.isArray(cases) ? cases : [])
    .map((item) => (typeof item === 'string' ? item : item && item.id))
    .filter(Boolean));
  return [...results.values()]
    .filter((result) => result && result.ok === false && !ids.has(result.id))
    .map((result) => ({ id: result.id, detail: result.detail }));
}
