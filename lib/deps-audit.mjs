// 依赖治理：许可证白名单、vendored 副本与 node_modules 同步校验。纯函数。
export const ALLOWED_LICENSES = ['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Unlicense', 'MPL-2.0', 'Remix Icon License 1.0'];

export function normalizeLicense(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.replace(/^\(|\)$/g, '').split(/\s+(?:OR|AND)\s+/i)[0].trim();
}

export function auditLicenses(packages, allowed = ALLOWED_LICENSES) {
  const allowedSet = new Set(allowed);
  const problems = [];
  const rows = [];
  for (const item of Array.isArray(packages) ? packages : []) {
    const name = String((item && item.name) || '');
    if (!name) continue;
    const license = normalizeLicense(item.license);
    rows.push({ name, version: String(item.version || ''), license: license || '(none)' });
    if (!license) problems.push(name + ' 缺少 license 字段');
    else if (!allowedSet.has(license)) problems.push(name + ' 许可证不在白名单：' + license);
  }
  return { ok: problems.length === 0, problems, rows };
}

export function vendorDrift(entries) {
  const problems = [];
  const rows = [];
  for (const item of Array.isArray(entries) ? entries : []) {
    const path = String((item && item.path) || '');
    const expected = String((item && item.expectedHash) || '');
    const actual = String((item && item.actualHash) || '');
    if (!path) continue;
    rows.push({ path, match: Boolean(expected) && expected === actual });
    if (!expected) problems.push(path + ' 没有源哈希');
    else if (expected !== actual) problems.push(path + ' 与 node_modules 副本不一致');
  }
  return { ok: problems.length === 0, problems, rows };
}
