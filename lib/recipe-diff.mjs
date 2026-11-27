// lib/recipe-diff.mjs —— 回放差异报告：期望（expect）vs 实际（actual），证据化。
//
// 差异报告只描述“哪里和期望不一样”，不擅自重试或改写浏览器状态；
// 是否把差异升级成失败由 recipe-engine 的 expectOn=warn|fail 决定。
//
// 纯函数，零依赖：CLI、执行器、单测共用。

export const DIFF_SEVERITIES = Object.freeze(['info', 'warning', 'error']);

/** 期望里的 selector 字段需要 DOM 侧探测；url 字段用 driver.url()。 */
export function expectationProbes(expect) {
  if (!expect || typeof expect !== 'object') return [];
  const probes = [];
  const urlFields = ['urlIncludes', 'urlMatches', 'urlEquals', 'urlOrigin'];
  if (urlFields.some((field) => expect[field] !== undefined)) probes.push({ kind: 'url', fields: urlFields.filter((field) => expect[field] !== undefined) });
  const selector = expect.selector !== undefined ? String(expect.selector) : '';
  const domFields = ['selectorVisible', 'selectorText', 'selectorValue', 'selectorCount'];
  if (selector && (expect.selector !== undefined || domFields.some((field) => expect[field] !== undefined))) {
    probes.push({ kind: 'selector', selector, fields: ['selector', ...domFields.filter((field) => expect[field] !== undefined)] });
  } else if (!selector) {
    for (const field of domFields) {
      if (expect[field] !== undefined) probes.push({ kind: 'selector', selector: '', fields: [field] });
    }
  }
  if (expect.methodOk !== undefined) probes.push({ kind: 'method', fields: ['methodOk'] });
  if (expect.resultPath !== undefined) probes.push({ kind: 'result', fields: ['resultPath'] });
  return probes;
}

/** 由原始探测结果组装 actual；raw = {url, selectors: {selector: {exists, visible, text, value, count}}, resultOk}。 */
export function buildActual(expect, raw = {}) {
  const actual = {};
  if (!expect || typeof expect !== 'object') return actual;
  if (expect.urlIncludes !== undefined || expect.urlMatches !== undefined || expect.urlEquals !== undefined || expect.urlOrigin !== undefined) {
    actual.url = String(raw.url || '');
  }
  const selector = expect.selector !== undefined ? String(expect.selector) : '';
  const dom = raw.selectors && selector ? raw.selectors[selector] : null;
  if (selector && dom) {
    actual.selector = selector;
    actual.selectorExists = dom.exists === true;
    if (dom.exists) {
      actual.selectorVisible = dom.visible === true;
      actual.selectorText = dom.text === undefined ? null : String(dom.text);
      actual.selectorValue = dom.value === undefined ? null : String(dom.value);
      actual.selectorCount = Number.isInteger(dom.count) ? dom.count : 1;
    } else {
      actual.selectorVisible = false;
      actual.selectorCount = 0;
    }
  }
  if (expect.methodOk !== undefined) actual.methodOk = raw.ok === true;
  if (expect.resultPath !== undefined) actual.resultPath = pickPath(raw.result, String(expect.resultPath));
  return actual;
}

/** 简单 a.b.0.c 取值（只读；找不到返回 undefined）。 */
export function pickPath(value, pathText) {
  if (!pathText) return value;
  let current = value;
  for (const segment of String(pathText).split('.')) {
    if (current === null || current === undefined) return undefined;
    if (/^\d+$/.test(segment)) {
      current = Array.isArray(current) ? current[Number(segment)] : undefined;
      continue;
    }
    current = typeof current === 'object' ? current[segment] : undefined;
  }
  return current;
}

function sameJson(left, right) {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/**
 * 对比期望与实际。
 * @returns {{match:boolean, checked:number, mismatches:object[]}}
 */
export function compareExpectation(expect, actual) {
  const mismatches = [];
  let checked = 0;
  if (!expect || typeof expect !== 'object') return { match: true, checked, mismatches };
  const check = (field, expected, actualValue, severity = 'error', label = field) => {
    checked += 1;
    if (sameJson(expected, actualValue)) return;
    mismatches.push({ field: label, expected, actual: actualValue === undefined ? null : actualValue, severity });
  };
  if (expect.urlIncludes !== undefined) {
    checked += 1;
    if (!String(actual.url || '').includes(String(expect.urlIncludes))) {
      mismatches.push({ field: 'urlIncludes', expected: String(expect.urlIncludes), actual: actual.url || '', severity: 'error' });
    }
  }
  if (expect.urlMatches !== undefined) {
    checked += 1;
    let matched = false;
    try { matched = new RegExp(String(expect.urlMatches)).test(String(actual.url || '')); } catch { matched = false; }
    if (!matched) mismatches.push({ field: 'urlMatches', expected: String(expect.urlMatches), actual: actual.url || '', severity: 'error' });
  }
  if (expect.urlEquals !== undefined) check('urlEquals', String(expect.urlEquals), String(actual.url || ''));
  if (expect.urlOrigin !== undefined) {
    let origin = '';
    try { origin = new URL(String(actual.url || '')).origin; } catch { origin = ''; }
    check('urlOrigin', String(expect.urlOrigin), origin);
  }
  if (expect.selector !== undefined) check('selectorExists', true, actual.selectorExists === true);
  if (expect.selectorVisible !== undefined) {
    const wanted = typeof expect.selectorVisible === 'boolean'
      ? expect.selectorVisible
      : ['true', '1', 'yes', 'visible'].includes(String(expect.selectorVisible).toLowerCase());
    check('selectorVisible', wanted, actual.selectorVisible === true);
  }
  if (expect.selectorText !== undefined) check('selectorText', String(expect.selectorText), actual.selectorText === null || actual.selectorText === undefined ? null : String(actual.selectorText));
  if (expect.selectorValue !== undefined) check('selectorValue', String(expect.selectorValue), actual.selectorValue === null || actual.selectorValue === undefined ? null : String(actual.selectorValue));
  if (expect.selectorCount !== undefined) check('selectorCount', Number(expect.selectorCount), actual.selectorCount);
  if (expect.methodOk !== undefined) check('methodOk', expect.methodOk === true, actual.methodOk === true);
  // resultPath 是“取哪个字段”的声明；真正的比较在 equals/notEquals/contains/truthy 上。
  if (expect.equals !== undefined) check('equals', expect.equals, actual.resultPath);
  if (expect.notEquals !== undefined && sameJson(expect.notEquals, actual.resultPath)) {
    mismatches.push({ field: 'notEquals', expected: '≠ ' + JSON.stringify(expect.notEquals), actual: actual.resultPath, severity: 'error' });
    checked += 1;
  }
  if (expect.contains !== undefined) {
    checked += 1;
    const text = actual.resultPath === undefined || actual.resultPath === null
      ? ''
      : (typeof actual.resultPath === 'string' ? actual.resultPath : JSON.stringify(actual.resultPath));
    if (!text.includes(String(expect.contains))) {
      mismatches.push({ field: 'contains', expected: String(expect.contains), actual: actual.resultPath === undefined ? null : actual.resultPath, severity: 'error' });
    }
  }
  if (expect.truthy !== undefined) check('truthy', expect.truthy === true, Boolean(actual.resultPath));
  return { match: mismatches.length === 0, checked, mismatches };
}

/** 单步/整条回放的差异汇总（engine 产出 results 后调用）。 */
export function summarizeDifferences(results) {
  const list = [];
  for (const result of Array.isArray(results) ? results : []) {
    for (const mismatch of result && Array.isArray(result.diff) ? result.diff : []) {
      list.push({
        ref: result.ref || '',
        path: result.path || '',
        method: result.method || result.kind || '',
        field: mismatch.field,
        expected: mismatch.expected,
        actual: mismatch.actual,
        severity: mismatch.severity || 'error',
      });
    }
  }
  return list;
}

/**
 * 回放报告：给 CLI 的文本/JSON 共用。
 * 参数全部可注入，便于单测固定时间。
 */
export function buildReplayReport(options = {}) {
  const results = Array.isArray(options.results) ? options.results : [];
  const differences = summarizeDifferences(results);
  const statuses = { ok: 0, failed: 0, skipped: 0, mismatch: 0, blocked: 0 };
  const retryable = [];
  const failures = [];
  for (const result of results) {
    const status = result && result.status ? result.status : 'failed';
    if (statuses[status] === undefined) statuses[status] = 0;
    statuses[status] += 1;
    if (status === 'failed') {
      const entry = {
        ref: result.ref || '',
        path: result.path || '',
        method: result.method || result.kind || '',
        code: (result.error && result.error.code) || 'E_INTERNAL',
        message: (result.error && result.error.message) || '',
        attempts: Number(result.attempts) || 1,
        retryable: result.retryable === true,
      };
      failures.push(entry);
      if (entry.retryable) retryable.push(entry);
    }
  }
  const startedAt = Number(options.startedAt) || 0;
  const endedAt = Number(options.endedAt) || startedAt;
  return {
    version: 1,
    recipe: String(options.name || ''),
    params: options.params && typeof options.params === 'object' ? options.params : {},
    paramsFingerprint: options.paramsFingerprint || null,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    ok: options.ok === true,
    completed: Number(options.completed) || 0,
    planned: Number(options.planned) || 0,
    failedAt: options.failedAt === undefined ? null : options.failedAt,
    statuses,
    failures,
    retryable,
    differences,
    results,
  };
}

/** 差异报告的人类可读行（CLI print 逐行输出）。 */
export function renderReplayReport(report) {
  const lines = [];
  const name = report.recipe ? 'recipe ' + report.recipe : 'recipe';
  lines.push(name + '：完成 ' + report.completed + '/' + report.planned + (report.ok ? '（成功）' : '（失败）'));
  if (report.durationMs) lines.push('耗时：' + report.durationMs + 'ms');
  if (report.paramsFingerprint) lines.push('参数指纹：' + report.paramsFingerprint);
  if (report.failedAt !== null && report.failedAt !== undefined) {
    const failure = report.failures[0];
    lines.push('失败步骤：#' + report.failedAt + (failure ? ' ' + failure.method + '（' + failure.ref + '）' : ''));
    if (failure) {
      lines.push('  错误：' + failure.code + ' ' + failure.message);
      lines.push('  可否重试：' + (failure.retryable ? '可以（幂等或显式允许）' : '不可以（非幂等动作，避免重复副作用）'));
      if (failure.attempts > 1) lines.push('  已尝试：' + failure.attempts + ' 次');
    }
  }
  if (report.statuses.skipped) lines.push('跳过步骤：' + report.statuses.skipped + '（失败策略 skip）');
  if (report.differences.length) {
    lines.push('差异（期望 vs 实际）：');
    for (const diff of report.differences.slice(0, 20)) {
      lines.push('  - ' + diff.ref + ' ' + diff.method + ' ' + diff.field + '：期望 ' + JSON.stringify(diff.expected) + '，实际 ' + JSON.stringify(diff.actual));
    }
    if (report.differences.length > 20) lines.push('  … 另有 ' + (report.differences.length - 20) + ' 条差异（--json 查看全部）');
  } else if (report.ok) {
    lines.push('差异：无（所有期望都满足）');
  }
  return lines;
}
