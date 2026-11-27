/**
 * tools/eval/lib/report.mjs -- deterministic property-test report.
 *
 * The report is the gate's evidence artifact:
 *   - every property row is sorted (area, id) and contains no timings or
 *     absolute paths, so two runs with the same seed produce byte-identical
 *     JSON (`digest` is a hash of the body and is verified on load);
 *   - every runtime consumption point is a resolved `file:line` from the frozen
 *     tree (see `source.mjs`), grouped per symbol with the number of properties
 *     and checks that actually exercised it;
 *   - failures carry the original generated value, the 1-minimal
 *     counterexample, the shrink trace, the replay seed/case index and the
 *     exact command that reproduces it.
 */

import { fnv1a32 } from './prng.mjs';
import { stableStringify } from './shrink.mjs';
import { groupConsumes } from './source.mjs';

export const REPORT_SCHEMA = 'bridge-eval-report/1';

/** Areas that must be covered for the gate to pass. */
export const REQUIRED_AREAS = Object.freeze([
  'vom-geometry',
  'observe-diff',
  'session-queue',
  'intent-ledger',
  'protocol-state',
]);

function sortedUnique(list) {
  return [...new Set((Array.isArray(list) ? list : []).map(String))].sort();
}

function sortedResults(results) {
  return (Array.isArray(results) ? results : []).slice().sort((left, right) => {
    if (left.area !== right.area) return left.area < right.area ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/**
 * Aggregate consumption points: `symbol -> {properties, checks}`.
 * @param {Array<object>} results
 */
export function buildRuntimeTable(results) {
  const byLocation = new Map();
  for (const result of results) {
    for (const item of result.consumes || []) {
      const key = item.file + '#' + item.symbol;
      const existing = byLocation.get(key) || {
        file: item.file,
        symbol: item.symbol,
        line: item.line,
        location: item.location,
        text: item.text || '',
        properties: [],
        checks: 0,
      };
      existing.properties.push(result.id);
      existing.checks += Number(result.checksRun) || 0;
      // Prefer the smallest line for duplicate symbol declarations.
      if (item.line < existing.line) existing.line = item.line;
      byLocation.set(key, existing);
    }
  }
  return [...byLocation.values()]
    .map((entry) => Object.freeze({
      file: entry.file,
      symbol: entry.symbol,
      line: entry.line,
      location: entry.file + ':' + entry.line,
      text: entry.text,
      properties: Object.freeze(sortedUnique(entry.properties)),
      propertyCount: sortedUnique(entry.properties).length,
      checks: entry.checks,
    }))
    .sort((left, right) => {
      if (left.file !== right.file) return left.file < right.file ? -1 : 1;
      if (left.line !== right.line) return left.line - right.line;
      return left.symbol < right.symbol ? -1 : left.symbol > right.symbol ? 1 : 0;
    });
}

/**
 * Build the serializable report body (before digest).
 *
 * @param {{
 *   seed: number,
 *   cases: number,
 *   results: object[],
 *   areas: Array<{area: string, title?: string, source?: string, propertyCount?: number}>,
 *   determinism?: {verified?: boolean, mismatches?: object[]},
 *   audits?: object,
 *   gate?: object,
 * }} input
 */
export function buildReportBody({ seed, cases, results, areas, determinism = null, audits = null, gate = null }) {
  const ordered = sortedResults(results);
  const runtime = buildRuntimeTable(ordered);
  const areaRows = (Array.isArray(areas) ? areas : []).map((area) => {
    const entry = typeof area === 'string' ? { area } : area;
    const own = ordered.filter((result) => result.area === entry.area);
    return Object.freeze({
      area: entry.area,
      title: entry.title ? String(entry.title) : entry.area,
      source: entry.source ? String(entry.source) : null,
      properties: own.length,
      passed: own.filter((result) => result.status === 'passed').length,
      failed: own.filter((result) => result.status === 'failed').length,
      checks: own.reduce((sum, result) => sum + (Number(result.checksRun) || 0), 0),
    });
  }).sort((left, right) => (left.area < right.area ? -1 : left.area > right.area ? 1 : 0));

  const failures = [];
  for (const result of ordered) {
    for (const failure of result.failures || []) {
      failures.push(Object.freeze({
        property: result.id,
        area: result.area,
        kind: failure.kind,
        caseIndex: failure.caseIndex,
        caseSeed: failure.caseSeed,
        example: failure.example || null,
        error: failure.error,
        original: failure.original,
        originalSize: failure.originalSize,
        minimal: failure.minimal,
        minimalSize: failure.minimalSize,
        shrinks: failure.shrinks,
        candidatesTested: failure.candidatesTested,
        minimalVerified: failure.minimalVerified,
        replay: failure.replay,
      }));
    }
  }

  const summary = Object.freeze({
    properties: ordered.length,
    passed: ordered.filter((result) => result.status === 'passed').length,
    failed: ordered.filter((result) => result.status === 'failed').length,
    checks: ordered.reduce((sum, result) => sum + (Number(result.checksRun) || 0), 0),
    examples: ordered.reduce((sum, result) => sum + (Number(result.examples) || 0), 0),
    failures: failures.length,
    shrunk: ordered.reduce((sum, result) => sum + (result.failures || []).filter((item) => item.minimalized).length, 0),
    minimalityViolations: ordered.reduce((sum, result) => sum + (result.failures || []).filter((item) => item.minimalVerified === false).length, 0),
    areas: areaRows.length,
    runtimeModules: new Set(runtime.map((item) => item.file)).size,
    runtimeSymbols: runtime.length,
  });

  const body = {
    schema: REPORT_SCHEMA,
    seed,
    cases,
    summary,
    areas: areaRows,
    gate: gate || null,
    determinism: determinism || { verified: false, mismatches: [] },
    audits: audits || null,
    runtime,
    properties: ordered.map((result) => ({
      id: result.id,
      title: result.title,
      area: result.area,
      status: result.status,
      source: result.source,
      generator: result.generator,
      checksRun: result.checksRun,
      examples: result.examples,
      failureCount: result.failureCount,
      tags: result.tags || [],
      consumeLocations: (result.consumes || []).map((item) => item.location),
    })),
    failures,
  };
  return body;
}

/** Compute the digest of a report body (stable across runs). */
export function reportDigest(body) {
  return fnv1a32(stableStringify(body));
}

/** Build the final report including its digest. */
export function buildReport(input) {
  const body = buildReportBody(input);
  const digest = reportDigest(body);
  return Object.freeze({ ...body, digest });
}

/** Verify the digest recorded in a report. */
export function verifyDigest(report) {
  const { digest, ...body } = report || {};
  const expected = reportDigest(body);
  return { ok: digest === expected, expected, actual: digest };
}

/**
 * Structural gate verification. Returns issues (empty = pass).
 * Property *results* are checked separately by the runner; this validates the
 * report itself so a corrupted/partial artifact can never pass CI.
 */
export function verifyReport(report) {
  const issues = [];
  const push = (code, message, detail = null) => issues.push({ code, message, detail });
  if (!report || typeof report !== 'object') {
    return [{ code: 'E_REPORT_SHAPE', message: '报告不是对象', detail: null }];
  }
  if (report.schema !== REPORT_SCHEMA) push('E_REPORT_SCHEMA', '报告 schema 不符：' + String(report.schema));
  const digest = verifyDigest(report);
  if (!digest.ok) push('E_REPORT_DIGEST', '报告 digest 不符', digest);
  const summary = report.summary || {};
  if (Number(summary.failed) !== 0) push('E_REPORT_FAILED', '存在失败的 property：' + summary.failed);
  if (Number(summary.minimalityViolations) !== 0) push('E_REPORT_MINIMALITY', '存在非 1-minimal 反例：' + summary.minimalityViolations);
  const ids = new Set();
  for (const result of report.properties || []) {
    if (ids.has(result.id)) push('E_REPORT_DUPLICATE', '重复 property id：' + result.id);
    ids.add(result.id);
    if (!Array.isArray(result.consumeLocations) || result.consumeLocations.length === 0) {
      push('E_REPORT_NO_RUNTIME', 'property 没有 runtime 消费点：' + result.id);
    }
  }
  if (!report.determinism || report.determinism.verified !== true) {
    push('E_REPORT_DETERMINISM', '确定性自检未通过');
  }
  const areaNames = new Set((report.areas || []).map((area) => area.area));
  for (const area of REQUIRED_AREAS) {
    if (!areaNames.has(area)) push('E_REPORT_AREA_MISSING', '缺少必需 area：' + area);
  }
  for (const item of report.runtime || []) {
    if (!item.file || !Number.isInteger(item.line) || item.line < 1) {
      push('E_REPORT_LOCATION', 'runtime 消费点没有有效 file:line', item);
    }
  }
  return issues;
}

function codeFence(value) {
  return '```json\n' + stableStringify(value) + '\n```';
}

/** Render the human report (deterministic; no timestamps). */
export function renderMarkdown(report) {
  const lines = [];
  lines.push('# BridgeDeck eval property report');
  lines.push('');
  lines.push('- schema: `' + report.schema + '`');
  lines.push('- seed: `' + report.seed + '` (0x' + Number(report.seed).toString(16) + ')');
  lines.push('- cases/property: `' + report.cases + '`');
  lines.push('- digest: `' + report.digest + '`');
  lines.push('');
  const summary = report.summary || {};
  lines.push('## Summary');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('| --- | --- |');
  for (const key of ['properties', 'passed', 'failed', 'checks', 'examples', 'failures', 'shrunk', 'minimalityViolations', 'areas', 'runtimeModules', 'runtimeSymbols']) {
    lines.push('| ' + key + ' | ' + String(summary[key] === undefined ? 0 : summary[key]) + ' |');
  }
  lines.push('');
  lines.push('## Area coverage');
  lines.push('');
  lines.push('| area | properties | passed | failed | checks | source |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const area of report.areas || []) {
    lines.push('| ' + area.area + ' | ' + area.properties + ' | ' + area.passed + ' | ' + area.failed + ' | ' + area.checks + ' | ' + (area.source || '') + ' |');
  }
  lines.push('');
  lines.push('## Runtime consumption points (file:line)');
  lines.push('');
  lines.push('| location | symbol | properties | checks |');
  lines.push('| --- | --- | --- | --- |');
  for (const item of report.runtime || []) {
    lines.push('| `' + item.location + '` | `' + item.symbol + '` | ' + item.propertyCount + ' | ' + item.checks + ' |');
  }
  lines.push('');
  lines.push('## Properties');
  lines.push('');
  lines.push('| property | area | status | checks | source | runtime |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const property of report.properties || []) {
    lines.push('| `' + property.id + '` | ' + property.area + ' | ' + property.status + ' | ' + property.checksRun + ' | ' + (property.source || '') + ' | ' + (property.consumeLocations || []).join('<br>') + ' |');
  }
  lines.push('');
  if ((report.failures || []).length) {
    lines.push('## Failures');
    lines.push('');
    for (const failure of report.failures) {
      lines.push('### `' + failure.property + '` case ' + failure.caseIndex + (failure.example ? ' (example ' + failure.example + ')' : ''));
      lines.push('');
      lines.push('- seed: `' + report.seed + '`');
      lines.push('- caseSeed: `' + failure.caseSeed + '`');
      lines.push('- replay: `node tools/eval/run.mjs --property ' + failure.property + ' --seed ' + report.seed + ' --cases ' + (failure.caseIndex + 1) + '`');
      lines.push('- error: `' + (failure.error && failure.error.code ? failure.error.code + ': ' : '') + String(failure.error && failure.error.message) + '`');
      lines.push('- shrinks: ' + failure.shrinks + ' (candidates tested: ' + failure.candidatesTested + ', minimal verified: ' + String(failure.minimalVerified) + ')');
      lines.push('');
      lines.push('Original (' + failure.originalSize + '):');
      lines.push(codeFence(failure.original));
      lines.push('');
      if (failure.minimal !== null && failure.minimal !== undefined) {
        lines.push('Minimal (' + failure.minimalSize + '):');
        lines.push(codeFence(failure.minimal));
        lines.push('');
      }
    }
  }
  lines.push('## Determinism');
  lines.push('');
  lines.push('- verified: `' + Boolean(report.determinism && report.determinism.verified) + '`');
  lines.push('- mismatches: ' + ((report.determinism && report.determinism.mismatches) || []).length);
  if (report.audits) {
    lines.push('');
    lines.push('## Source audits');
    lines.push('');
    lines.push('- forbidden calls: ' + ((report.audits.forbiddenCalls || []).length));
    for (const item of report.audits.forbiddenCalls || []) lines.push('  - `' + item.file + ':' + item.line + '` ' + item.pattern);
    lines.push('- files scanned: ' + String(report.audits.filesScanned === undefined ? 0 : report.audits.filesScanned));
  }
  lines.push('');
  return lines.join('\n');
}

/** Render the compact console summary. */
export function renderSummary(report) {
  const summary = report.summary || {};
  const lines = [];
  lines.push('[eval] seed=' + report.seed + ' (0x' + Number(report.seed).toString(16) + ') cases=' + report.cases + ' digest=' + report.digest);
  for (const area of report.areas || []) {
    lines.push('[eval] ' + area.area.padEnd(16) + ' properties=' + String(area.properties).padStart(3)
      + ' passed=' + String(area.passed).padStart(3) + ' failed=' + String(area.failed).padStart(2)
      + ' checks=' + String(area.checks).padStart(6));
  }
  lines.push('[eval] runtime=' + summary.runtimeSymbols + ' symbols / ' + summary.runtimeModules + ' modules, checks=' + summary.checks
    + ', failures=' + summary.failures + ', shrunk=' + summary.shrunk);
  lines.push('[eval] verdict=' + (Number(summary.failed) === 0 && Number(summary.minimalityViolations) === 0 ? 'PASS' : 'FAIL'));
  return lines.join('\n');
}
