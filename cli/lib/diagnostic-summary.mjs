// cli/lib/diagnostic-summary.mjs —— `bridge debug` / `bridge trace` 的结论化摘要。
//
// 前几轮把调试/追踪数据面做深了，但 CLI 大多是「原样打印计数」：
//   - 调试：coverage/gaps（缺口根因分类）、journal（单调 seq 环形缓冲）、
//     correlation（requestId ↔ trace ↔ 截图 ↔ journal 关联）、journalExport（checksum 校验）；
//   - Trace：span 树、关键路径、跨 frame 归属、长任务。
// 本模块把这些结构化字段统一收敛成 { findings, verdict, nextSteps }，让人和 `--json`
// 调用方都拿到「这次采集缺什么、结论是什么、下一步跑哪条命令」，而不是自己拼字段。
//
// 纯函数，不读写文件、不访问 daemon。缺口分类词表直接复用扩展侧单源
// （extension/src/lib/debug-coverage.js 的 gapCountsByCategory/classifyGapReason），
// 避免 CLI 与扩展各维护一份 reason → category 映射而漂移。

import { gapCountsByCategory, classifyGapReason } from '../../extension/src/lib/debug-coverage.js';

const SEVERITY = Object.freeze({
  OK: 'ok',
  NOTICE: 'notice',
  WARN: 'warn',
  ERROR: 'error',
});

const SEVERITY_RANK = Object.freeze({ ok: 0, notice: 1, warn: 2, error: 3 });

const GAP_CATEGORY_LABELS = Object.freeze({
  'not-subscribed': '未订阅（采集阶段没开）',
  limit: '超限截断（条数/字节上限）',
  dropped: '环形缓冲丢弃（被挤出）',
  failed: '采集失败',
  incomplete: '未完成（请求仍 pending 等）',
  unsupported: '不支持（能力缺失）',
});

/** 协议 phase 码 → 人类标签（X/B/E 为同步嵌套，b/e/n 为异步，M/I 为元数据/瞬时）。 */
const PHASE_LABELS = Object.freeze({
  X: '完整事件',
  B: '嵌套开始',
  E: '嵌套结束',
  b: '异步开始',
  e: '异步结束',
  n: '异步瞬时',
  M: '元数据',
  I: '瞬时事件',
  C: '计数器',
  O: '对象快照',
  P: '采样',
});

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function countOf(value) {
  return Array.isArray(value) ? value.length : count(value);
}

function phaseLabel(phase) {
  return PHASE_LABELS[String(phase || '')] || String(phase || '?');
}

function normalizeFinding(code, severity, label, detail = null) {
  return { code, severity, label, ...(detail ? { detail: String(detail) } : {}) };
}

/** 取最高严重度的 finding 作为 verdict；空数组返回 ok。 */
export function verdictOf(findings = []) {
  const list = listOf(findings).filter((item) => item && item.severity);
  if (!list.length) return { code: 'ok', severity: SEVERITY.OK, label: '无异常' };
  const top = list.reduce((best, item) => (
    (SEVERITY_RANK[item.severity] || 0) > (SEVERITY_RANK[best.severity] || 0) ? item : best
  ), list[0]);
  return { code: top.code, severity: top.severity, label: top.label };
}

// ---------------------------------------------------------------------------
// 调试：覆盖率 / journal / 关联 / 导出
// ---------------------------------------------------------------------------

/** 覆盖率摘要：complete / 缺口数量 / 缺口根因分类 / 阶段覆盖 / 分数。 */
export function summarizeDebugCoverage(result = {}) {
  const source = isObject(result) ? result : {};
  const coverage = isObject(source.coverage) ? source.coverage : {};
  const gaps = listOf(source.gaps);
  const categories = gapCountsByCategory(gaps);
  const phases = isObject(coverage.phases) ? coverage.phases : {};
  const phaseKeys = Object.keys(phases);
  const observed = phaseKeys.filter((key) => phases[key] && phases[key].observed === true);
  const subscribed = phaseKeys.filter((key) => phases[key] && phases[key].subscribed === true);
  const score = isObject(coverage.score) ? coverage.score : null;
  const complete = source.complete === true || coverage.complete === true;
  const coverageCounts = isObject(coverage.counts) ? coverage.counts : {};
  const requestsCount = isObject(coverageCounts.requests) ? count(coverageCounts.requests.observed) : 0;
  const consoleCount = isObject(coverageCounts.console) ? count(coverageCounts.console.observed) : 0;
  return {
    complete,
    gaps: gaps.length,
    categories,
    categoryLabels: Object.keys(categories).map((key) => ({
      category: key,
      label: GAP_CATEGORY_LABELS[key] || key,
      count: categories[key],
    })),
    score,
    phases: { total: phaseKeys.length, observed, subscribed },
    counts: {
      requests: isObject(source.requests) ? count(source.requests.total) : (requestsCount || countOf(source.requests)),
      console: isObject(source.console) ? count(source.console.total) : (consoleCount || countOf(source.console)),
      pinned: count(source.pinned),
    },
    bufferTruncated: source.bufferTruncated === true,
  };
}

/** journal 摘要：事件数/类型分布/时间跨度/截断；兼容 store 快照与 buildDebugJournal 输出。 */
export function summarizeDebugJournal(journal = {}) {
  const source = isObject(journal) ? journal : {};
  const events = listOf(source.events);
  const explicitCounts = isObject(source.counts) ? source.counts : null;
  const byType = isObject(source.byType) ? source.byType : {};
  const counts = explicitCounts
    ? {
      total: count(explicitCounts.total),
      debug: count(explicitCounts.debug),
      operation: count(explicitCounts.operation),
      request: count(explicitCounts.request),
      console: count(explicitCounts.console),
    }
    : (() => {
      // store 快照的 byType 是任意事件类型（start/stop/pin/rule_add…），不是 CLI 的 4 类；
      // 除了 request/console/operation 之外都归到 debug（动作留痕），保证总数对得上。
      const total = count(source.count) || events.length;
      const request = count(byType.request);
      const console = count(byType.console);
      const operation = count(byType.operation);
      return {
        total,
        debug: Math.max(0, total - request - console - operation),
        operation,
        request,
        console,
      };
    })();
  const times = events.map((event) => Number(event && event.at)).filter((at) => Number.isFinite(at) && at > 0);
  const timeRange = isObject(source.timeRange) ? source.timeRange : null;
  const from = timeRange && Number.isFinite(Number(timeRange.from)) && Number(timeRange.from) > 0
    ? Number(timeRange.from)
    : (times.length ? Math.min(...times) : null);
  const to = timeRange && Number.isFinite(Number(timeRange.to)) && Number(timeRange.to) > 0
    ? Number(timeRange.to)
    : (times.length ? Math.max(...times) : null);
  const evictions = source.evictions === undefined
    ? 0
    : (isObject(source.evictions) ? count(source.evictions.total) : count(source.evictions));
  return {
    total: counts.total,
    counts,
    truncated: source.truncated === true,
    evictions,
    spanMs: from != null && to != null ? Math.max(0, to - from) : null,
    from,
    to,
    bytes: source.bytes === undefined ? null : count(source.bytes),
    seq: source.seq === undefined ? null : Number(source.seq),
  };
}

/** 关联摘要：请求 ↔ trace ↔ 截图 ↔ journal 的链接覆盖。 */
export function summarizeDebugCorrelation(correlation = {}) {
  const source = isObject(correlation) ? correlation : {};
  return {
    timeAligned: source.timeAligned === true,
    requests: count(source.requests),
    linked: count(source.linked),
    unlinked: count(source.unlinked),
    traceEvents: count(source.traceEvents),
    orphanTraceEvents: count(source.orphanTraceEvents),
    screenshots: count(source.screenshots),
    linkedScreenshots: count(source.linkedScreenshots),
    journalEvents: count(source.journalEvents),
    byMethod: isObject(source.byMethod) ? { ...source.byMethod } : {},
    byStatus: isObject(source.byStatus) ? { ...source.byStatus } : {},
    slowest: listOf(source.slowest).slice(0, 3),
  };
}

/** journal 导出摘要：校验状态必须显式（verified/verifyReason）。 */
export function summarizeDebugJournalExport(journalExport = {}) {
  const source = isObject(journalExport) ? journalExport : {};
  return {
    events: count(source.events),
    requests: count(source.requests),
    gaps: count(source.gaps),
    bytes: source.bytes == null ? null : count(source.bytes),
    verified: source.verified === true,
    verifyReason: source.verifyReason == null ? null : String(source.verifyReason),
    digest: source.digest == null ? null : String(source.digest),
  };
}

function coverageFindings(coverage) {
  const findings = [];
  if (!coverage.gaps) return findings;
  for (const entry of coverage.categoryLabels) {
    const severity = entry.category === 'not-subscribed' || entry.category === 'unsupported'
      ? SEVERITY.NOTICE
      : SEVERITY.WARN;
    findings.push(normalizeFinding(
      'coverage-gap-' + entry.category,
      severity,
      '采集缺口：' + entry.label + ' ×' + entry.count,
    ));
  }
  return findings;
}

/**
 * `debug stop` 摘要：本次采集的规模、缺什么（gaps 根因）、关联与导出校验结论。
 * 输入是扩展 `debug.stop` 的 result（requests/console 为数字，record 里才是数组）。
 */
export function summarizeDebugStop(result = {}) {
  const source = isObject(result) ? result : {};
  const coverage = summarizeDebugCoverage(source);
  const correlation = summarizeDebugCorrelation(source.correlation);
  const journalExport = summarizeDebugJournalExport(source.journalExport);
  const record = isObject(source.record) ? source.record : {};
  const journal = summarizeDebugJournal(source.journalSummary || record.journalSummary || record.journal);
  const requests = countOf(source.requests) || count(record.requests);
  const consoleEntries = countOf(source.console) || count(record.console);
  const findings = coverageFindings(coverage);
  if (!requests && !consoleEntries) {
    findings.push(normalizeFinding('empty-capture', SEVERITY.NOTICE, '本次采集没有请求/控制台记录'));
  }
  if (correlation.requests > 0 && correlation.linked === 0) {
    findings.push(normalizeFinding('correlation-unlinked', SEVERITY.NOTICE, '请求没有关联上 trace/截图/journal 事件'));
  }
  if (journalExport.events > 0 && journalExport.verified !== true) {
    findings.push(normalizeFinding(
      'journal-export-unverified',
      SEVERITY.WARN,
      'journal 导出未通过校验（' + (journalExport.verifyReason || 'unknown') + '）',
    ));
  }
  if (journal.evictions > 0) {
    findings.push(normalizeFinding('journal-evicted', SEVERITY.WARN, 'journal 环形缓冲丢弃 ' + journal.evictions + ' 条事件'));
  }
  const verdict = verdictOf(findings);
  const nextSteps = [];
  if (coverage.gaps) nextSteps.push('bridge debug coverage：查看缺口根因（--json 见 gaps）');
  nextSteps.push('bridge debug journal --merged：按时间线核对请求/操作/事件');
  if (requests || consoleEntries) nextSteps.push('bridge debug archive --output debug.json：归档为可校验证据');
  nextSteps.push('bridge debug analyze：按状态/分类/慢请求得出结论');
  return {
    id: source.id == null ? null : String(source.id),
    requests,
    console: consoleEntries,
    coverage,
    correlation,
    journal,
    journalExport,
    findings,
    verdict,
    nextSteps: nextSteps.slice(0, 4),
  };
}

/**
 * `debug status`（采集中）摘要：当前规模、journal、覆盖率、关联；`--json` 直接可用。
 */
export function summarizeDebugStatus(result = {}) {
  const source = isObject(result) ? result : {};
  const coverage = summarizeDebugCoverage(source);
  const requests = listOf(source.requests);
  const consoleEntries = listOf(source.console);
  const correlation = summarizeDebugCorrelation(source.correlation);
  const journal = summarizeDebugJournal(source.journalSummary || source.journal);
  const startedAt = source.startedAt == null ? null : Number(source.startedAt);
  const finished = coverage.complete;
  const findings = coverageFindings(coverage);
  if (!requests.length && !consoleEntries.length) {
    findings.push(normalizeFinding('empty-capture', SEVERITY.NOTICE, '采集中但还没有请求/控制台记录'));
  }
  if (journal.total === 0) {
    findings.push(normalizeFinding('journal-empty', SEVERITY.NOTICE, 'journal 还没有事件（start/pin/rule 等动作会留痕）'));
  }
  const slowest = listOf(source.timeline).length ? [] : correlation.slowest;
  const verdict = verdictOf(findings);
  const nextSteps = [
    'bridge debug stop：结束采集并生成 coverage/journal 证据',
    'bridge debug requests --filter <子串>：只看关心的请求',
  ];
  if (coverage.gaps) nextSteps.unshift('bridge debug coverage：确认缺口是否影响结论');
  return {
    active: source.active === true,
    tabId: source.tabId == null ? null : Number(source.tabId),
    url: String(source.url || ''),
    title: String(source.title || ''),
    startedAt,
    requests: requests.length,
    console: consoleEntries.length,
    websockets: countOf(source.websockets),
    frames: countOf(source.frames),
    screenshots: countOf(source.screenshots),
    journal,
    coverage,
    correlation,
    slowest,
    findings,
    verdict,
    nextSteps: nextSteps.slice(0, 3),
  };
}

/** 无采集时的历史摘要（debug status 回退分支用）。 */
export function summarizeDebugHistory(history = []) {
  const entries = listOf(history);
  const latest = entries.length && isObject(entries[0]) ? entries[0] : null;
  return {
    available: entries.length,
    latest: latest
      ? {
        id: String(latest.id || ''),
        name: String(latest.name || ''),
        requests: count(latest.requests),
        console: count(latest.console),
        startedAt: latest.startedAt == null ? null : Number(latest.startedAt),
      }
      : null,
    nextSteps: entries.length
      ? ['bridge debug start：开始新的采集', 'bridge debug journal：查看最近一次采集的时间线']
      : ['bridge debug start：开始采集请求/控制台/页面变化'],
  };
}

/** `debug analyze` 摘要：把 analyzeDebugCapture 的分布收敛成结论。 */
export function summarizeDebugAnalyze(analysis = {}) {
  const source = isObject(analysis) ? analysis : {};
  const errors = listOf(source.errors);
  const duplicates = listOf(source.duplicates);
  const slow = listOf(source.slow);
  const counts = isObject(source.counts) ? source.counts : {};
  const status = isObject(source.status) ? { ...source.status } : {};
  const kinds = isObject(source.kinds) ? { ...source.kinds } : {};
  const findings = [];
  if (errors.length) {
    findings.push(normalizeFinding('http-errors', SEVERITY.WARN, '请求失败 ' + errors.length + ' 条（status=0/error）'));
  }
  if (duplicates.length) {
    findings.push(normalizeFinding('duplicate-urls', SEVERITY.NOTICE, '重复 URL ' + duplicates.length + ' 组（最高 ×' + count(duplicates[0] && duplicates[0].count) + '）'));
  }
  if (slow.length) {
    findings.push(normalizeFinding('slow-requests', SEVERITY.NOTICE, '慢请求 ' + slow.length + ' 条（可用 --min-duration 调整阈值）'));
  }
  const pending = count(status.pending);
  if (pending) findings.push(normalizeFinding('pending-requests', SEVERITY.NOTICE, '仍有 ' + pending + ' 条 pending 请求（采集尚未结束？）'));
  if (!findings.length) findings.push(normalizeFinding('analysis-ok', SEVERITY.OK, '请求/控制台分布无明显异常'));
  const nextSteps = [];
  if (errors.length) nextSteps.push('bridge debug request <id>：看失败请求的响应与 timing');
  if (duplicates.length) nextSteps.push('bridge debug duplicates --window-ms 1000：确认是否重复调用');
  if (slow.length) nextSteps.push('bridge debug aggregate --slow-ms 500：按接口聚合慢请求');
  nextSteps.push('bridge debug archive --output debug.json：保存本次证据');
  return {
    counts: { requests: count(counts.requests), console: count(counts.console) },
    status,
    kinds,
    slow: slow.length,
    errors: errors.length,
    duplicates: duplicates.length,
    groups: listOf(source.groups).length,
    findings,
    verdict: verdictOf(findings),
    nextSteps: nextSteps.slice(0, 4),
  };
}

/** `debug evidence` 摘要：证据包规模、完整性校验与下一步。 */
export function summarizeDebugEvidence(evidence = {}) {
  const source = isObject(evidence) ? evidence : {};
  const counts = isObject(source.counts) ? source.counts : {};
  const integrity = isObject(source.integrity) ? source.integrity : {};
  const operations = listOf(source.operations);
  const findings = [];
  if (!count(counts.requests) && !count(counts.console)) {
    findings.push(normalizeFinding('evidence-empty', SEVERITY.WARN, '证据包里没有请求/控制台记录'));
  }
  const unlinked = operations.filter((op) => !Array.isArray(op.requestIds) || op.requestIds.length === 0);
  if (operations.length && unlinked.length) {
    findings.push(normalizeFinding('operations-unlinked', SEVERITY.NOTICE, operations.length + ' 个操作中 ' + unlinked.length + ' 个没关联到请求'));
  }
  const hasIntegrity = ['requestsSha256', 'consoleSha256', 'performanceSha256', 'operationsSha256']
    .every((key) => typeof integrity[key] === 'string' && integrity[key].length === 64);
  if (!hasIntegrity) findings.push(normalizeFinding('integrity-missing', SEVERITY.WARN, '证据包缺少完整 sha256 摘要'));
  const verdict = verdictOf(findings);
  return {
    generatedAt: source.generatedAt == null ? null : String(source.generatedAt),
    counts: { requests: count(counts.requests), console: count(counts.console), operations: count(counts.operations) },
    integrity: {
      requestsSha256: integrity.requestsSha256 == null ? null : String(integrity.requestsSha256).slice(0, 16),
      consoleSha256: integrity.consoleSha256 == null ? null : String(integrity.consoleSha256).slice(0, 16),
      complete: hasIntegrity,
    },
    path: source.path == null ? null : String(source.path),
    findings,
    verdict,
    nextSteps: ['bridge debug archive --output debug.json：补一份可索引归档', '--output <file>：确保证据包落盘后再分享'],
  };
}

/**
 * `debug archive --output` 摘要：刚生成的归档的规模、预算截断与结论。
 * 输入是 buildDebugArchive 的结果（summary/coverage/gaps）。
 */
export function summarizeDebugArchive(archive = {}) {
  const source = isObject(archive) ? archive : {};
  const summary = isObject(source.summary) ? source.summary : {};
  const coverage = isObject(source.coverage) ? source.coverage : {};
  const budget = isObject(coverage.budget) ? coverage.budget : null;
  const kept = isObject(coverage.kept) ? coverage.kept : {};
  const dropped = isObject(coverage.dropped) ? coverage.dropped : {};
  const gaps = listOf(source.gaps);
  const findings = [];
  const droppedRequests = count(dropped.requests);
  const droppedConsole = count(dropped.console);
  if (droppedRequests || droppedConsole) {
    findings.push(normalizeFinding('archive-trimmed', SEVERITY.WARN,
      '预算截断：请求 ' + droppedRequests + ' / 控制台 ' + droppedConsole + ' 条未进入归档'));
  }
  for (const gap of gaps) {
    findings.push(normalizeFinding(
      'archive-gap-' + String((gap && (gap.category || classifyGapReason(gap.reason))) || 'unknown'),
      SEVERITY.NOTICE,
      '归档缺口：' + String((gap && (gap.kind || gap.reason)) || 'unknown'),
    ));
  }
  if (count(summary.requests) === 0 && count(summary.console) === 0) {
    findings.push(normalizeFinding('archive-empty', SEVERITY.WARN, '归档里没有请求/控制台记录'));
  }
  return {
    id: String(source.id || ''),
    createdAt: source.createdAt == null ? null : String(source.createdAt),
    expiresAt: source.expiresAt == null ? null : String(source.expiresAt),
    requests: count(summary.requests),
    console: count(summary.console),
    journal: count(summary.journal),
    bytes: count(summary.bytes),
    complete: coverage.complete === true,
    budget,
    kept: { requests: count(kept.requests), console: count(kept.console) },
    gaps: gaps.length,
    findings,
    verdict: verdictOf(findings),
    nextSteps: [
      'bridge debug archives --dir <dir>：确认归档索引与过期时间',
      'bridge debug query --dir <dir> --filter <子串>：跨归档检索',
    ],
  };
}

/** `debug journal` 摘要（CLI 本地合并结果用）：时间跨度/类型分布/截断。 */
export function summarizeDebugJournalResult(journal = {}) {
  const summary = summarizeDebugJournal(journal);
  const findings = [];
  if (!summary.total) findings.push(normalizeFinding('journal-empty', SEVERITY.NOTICE, '没有 journal 记录'));
  if (summary.truncated) findings.push(normalizeFinding('journal-truncated', SEVERITY.NOTICE, '事件超过 --limit，已截断'));
  if (summary.evictions > 0) findings.push(normalizeFinding('journal-evicted', SEVERITY.WARN, 'journal 丢弃 ' + summary.evictions + ' 条事件'));
  if (summary.spanMs != null && summary.spanMs > 0) {
    // 时间跨度只作事实记录，不作为告警。
    findings.push(normalizeFinding('journal-span', SEVERITY.OK, '时间跨度 ' + summary.spanMs + 'ms'));
  }
  return {
    ...summary,
    findings,
    verdict: verdictOf(findings),
    nextSteps: summary.total
      ? ['bridge debug stop：结束采集并固化 journal', 'bridge debug export --output <file>：导出完整调试数据']
      : ['bridge debug start：先开始采集'],
  };
}

/** `debug archives --dir` 摘要：归档数量/总量/过期/覆盖完整度。 */
export function summarizeDebugArchives(entries = [], stats = {}) {  const list = listOf(entries);
  const source = isObject(stats) ? stats : {};
  const incomplete = list.filter((entry) => entry && entry.complete !== true);
  const totalBytes = count(source.bytes) || list.reduce((sum, entry) => sum + count(entry && entry.bytes), 0);
  const totalRequests = count(source.requests) || list.reduce((sum, entry) => sum + count(entry && entry.requests), 0);
  const findings = [];
  if (!list.length) findings.push(normalizeFinding('archives-empty', SEVERITY.NOTICE, '目录里没有有效归档'));
  if (incomplete.length) {
    findings.push(normalizeFinding('archives-incomplete', SEVERITY.NOTICE, incomplete.length + ' 份归档覆盖不完整（gaps/预算截断）'));
  }
  const verdict = verdictOf(findings);
  return {
    total: list.length,
    live: count(source.live) || list.length,
    incomplete: incomplete.length,
    requests: totalRequests,
    bytes: totalBytes,
    findings,
    verdict,
    nextSteps: list.length
      ? ['bridge debug query --dir <dir> --filter <子串>：跨归档检索请求', 'bridge debug archives --dir <dir> --prune：清理过期归档']
      : ['bridge debug archive --output <dir>/debug.json：先生成一份归档'],
  };
}

/** `debug performance --insight` 摘要：把指标结论收敛成 verdict。 */
export function summarizePerformanceInsights(insights = []) {
  const list = listOf(insights);
  const warnings = list.filter((item) => item && item.level === 'warn');
  const infos = list.filter((item) => item && item.level === 'info');
  const codes = warnings.concat(infos).map((item) => String(item.code || ''));
  const findings = list.map((item) => normalizeFinding(
    'perf-' + String(item.code || 'unknown'),
    item.level === 'warn' ? SEVERITY.WARN : (item.level === 'info' ? SEVERITY.NOTICE : SEVERITY.OK),
    String(item.message || item.code || ''),
  ));
  const nextSteps = [];
  if (codes.includes('LONG_TASK')) nextSteps.push('bridge trace start → 复现 → trace stop：看长任务落在哪个 span');
  if (codes.includes('LCP') || codes.includes('DCL') || codes.includes('LOAD')) {
    nextSteps.push('bridge debug aggregate --slow-ms 500：找出拖慢首屏的接口');
  }
  if (codes.includes('BYTES') || codes.includes('REQUESTS')) nextSteps.push('bridge network list：核对资源体积/请求数');
  nextSteps.push('bridge debug performance --json：把原始指标交给调用方');
  return {
    warnings: warnings.length,
    infos: infos.length,
    findings,
    verdict: verdictOf(findings),
    nextSteps: nextSteps.slice(0, 3),
  };
}

/**
 * `debug requests` 摘要：过滤前后条数、截断标记、状态/方法分布。
 * 输入是采集里的全量请求与过滤后的请求（CLI 侧完成过滤）。
 */
export function summarizeDebugRequests(allRequests = [], filtered = [], flags = {}) {
  const all = listOf(allRequests);
  const shown = listOf(filtered);
  const limit = flags && flags.limit !== undefined ? count(flags.limit) : 0;
  const offset = flags && flags.offset !== undefined ? count(flags.offset) : 0;
  const byStatus = {};
  const byMethod = {};
  for (const entry of shown) {
    if (!isObject(entry)) continue;
    const status = entry.status == null ? 'pending' : String(entry.status);
    byStatus[status] = (byStatus[status] || 0) + 1;
    const method = String(entry.method || 'UNKNOWN').toUpperCase();
    byMethod[method] = (byMethod[method] || 0) + 1;
  }
  const truncated = offset + shown.length < all.length;
  const findings = [];
  if (!shown.length) findings.push(normalizeFinding('requests-empty', SEVERITY.NOTICE, '没有匹配的请求'));
  const pending = count(byStatus.pending);
  const failed = Object.keys(byStatus).filter((key) => Number(key) >= 400 || key === '0').reduce((sum, key) => sum + byStatus[key], 0);
  if (pending) findings.push(normalizeFinding('requests-pending', SEVERITY.NOTICE, pending + ' 条请求仍 pending'));
  if (failed) findings.push(normalizeFinding('requests-failed', SEVERITY.WARN, failed + ' 条请求失败（status>=400/0）'));
  return {
    total: all.length,
    matched: shown.length,
    truncated,
    offset,
    limit: limit || null,
    byStatus,
    byMethod,
    findings,
    verdict: verdictOf(findings),
    nextSteps: shown.length
      ? ['bridge debug request <id> --part all：看单条请求的请求/响应/headers/timing', 'bridge debug aggregate：按接口聚合慢请求']
      : ['去掉 --filter/--status 再试：bridge debug requests'],
  };
}

// ---------------------------------------------------------------------------
// Trace：状态 / 停止 / 摘要 / 差分
// ---------------------------------------------------------------------------

function traceCategoryRows(categories) {
  const rows = listOf(categories).map((item) => {
    if (!isObject(item)) return null;
    const key = item.category || item.key;
    return key == null ? null : { key: String(key), count: count(item.count) };
  }).filter(Boolean);
  return rows.sort((a, b) => b.count - a.count);
}

function traceNameRows(names) {
  return listOf(names).map((item) => {
    if (!isObject(item)) return null;
    const key = item.name || item.key;
    return key == null ? null : { key: String(key), count: count(item.count) };
  }).filter(Boolean).sort((a, b) => b.count - a.count);
}

/** `trace status` 摘要：是否在录、已收事件、类别、已录时长与下一步。 */
export function summarizeTraceStatus(result = {}, { now = Date.now() } = {}) {
  const source = isObject(result) ? result : {};
  const tracing = source.tracing === true;
  const startedAt = source.startedAt == null ? null : Number(source.startedAt);
  const elapsedMs = tracing && statsStarted(startedAt) ? Math.max(0, now - startedAt) : null;
  const events = count(source.events);
  const findings = [];
  if (tracing && events === 0) findings.push(normalizeFinding('no-events-yet', SEVERITY.NOTICE, '录制中但还没有 trace 事件（先触发一次交互）'));
  return {
    tracing,
    tabId: source.tabId == null ? null : Number(source.tabId),
    events,
    categories: source.categories == null ? null : String(source.categories),
    startedAt,
    elapsedMs,
    findings,
    verdict: verdictOf(findings),
    nextSteps: tracing
      ? ['bridge trace stop --out trace.json：结束并保存 Trace v3', 'bridge trace status --json：把事件数交给自动化轮询']
      : ['bridge trace start：开始一次性能追踪', 'bridge trace view <trace.json>：查看已有 trace'],
  };
}

function statsStarted(value) {
  return Number.isFinite(value) && value > 0;
}

/** `trace stop` 摘要：扩展侧 summary（events/spanMs/categories/topNames）+ 结论。 */
export function summarizeTraceStop(result = {}) {
  const source = isObject(result) ? result : {};
  const summary = isObject(source.summary) ? source.summary : {};
  const events = count(source.events) || count(summary.events);
  const durationMs = count(source.durationMs);
  const spanMs = summary.spanMs == null ? null : count(summary.spanMs);
  const categories = traceCategoryRows(summary.categories);
  const topNames = traceNameRows(summary.topNames).slice(0, 10);
  const findings = [];
  if (events === 0) {
    findings.push(normalizeFinding('no-events', SEVERITY.WARN, '没有采集到 trace 事件（页面可能没有活动，或 tracing 启动后立即停止）'));
  }
  const topCount = topNames.length ? topNames[0].count : 0;
  if (events > 0 && topCount / events >= 0.6) {
    findings.push(normalizeFinding('event-skew', SEVERITY.NOTICE,
      '单一事件类型占比 ' + Math.round(topCount / events * 100) + '%（' + topNames[0].key + '）'));
  }
  if (spanMs != null && durationMs > 0 && spanMs > durationMs * 1.5) {
    findings.push(normalizeFinding('clock-skew', SEVERITY.NOTICE, 'trace 时间跨度大于录制时长：可能混入其它 clock domain'));
  }
  if (source.trace === '') {
    findings.push(normalizeFinding('trace-empty-payload', SEVERITY.WARN, '返回的 trace JSON 为空，无法保存查看器'));
  }
  const nextSteps = ['bridge trace summary <trace.json>：看 span 树/关键路径', 'bridge trace view <trace.json>：离线 HTML 查看器'];
  if (findings.some((item) => item.code === 'no-events')) nextSteps.unshift('bridge trace start → 操作页面 → trace stop：先产生事件再停止');
  return {
    tabId: source.tabId == null ? null : Number(source.tabId),
    events,
    durationMs,
    spanMs,
    categories,
    topNames,
    findings,
    verdict: verdictOf(findings),
    nextSteps: nextSteps.slice(0, 3),
  };
}

/**
 * `trace summary` 报告：在 lib/trace-summary 的字段上补结论（关键路径占比/跨 frame/长任务）。
 * 输入是 summarizeTrace(trace) 的输出；不修改原对象。
 */
export function summarizeTraceReport(summary = {}) {
  const source = isObject(summary) ? summary : {};
  const events = count(source.events);
  const durationMs = count(source.durationMs);
  const longTasks = listOf(source.longTasks);
  const longTaskCount = count(source.longTaskCount);
  const longest = longTasks.length ? count(longTasks[0].durationMs) : 0;
  const spans = isObject(source.spanSummary) ? source.spanSummary : null;
  const criticalPath = spans && isObject(spans.criticalPath) ? spans.criticalPath : null;
  const criticalPathMs = criticalPath ? Number(criticalPath.totalMs) || 0 : 0;
  const frames = spans ? listOf(spans.frames) : [];
  const topPhases = spans ? listOf(spans.byPhase).slice(0, 5).map((item) => ({
    phase: String(item && item.key || '?'),
    label: phaseLabel(item && item.key),
    count: count(item && item.count),
    selfMs: Number(item && item.selfMs) || 0,
  })) : [];
  const findings = [];
  if (events === 0) {
    findings.push(normalizeFinding('no-events', SEVERITY.NOTICE, 'trace 里没有事件'));
  }
  if (longTaskCount > 0) {
    findings.push(normalizeFinding('long-tasks', SEVERITY.WARN, '长任务 ' + longTaskCount + ' 个，最长 ' + longest + 'ms'));
  }
  if (spans && (count(spans.unfinished) > 0 || count(spans.dropped) > 0 || spans.truncated === true)) {
    findings.push(normalizeFinding('incomplete-capture', SEVERITY.WARN,
      'span 树不完整（unfinished=' + count(spans.unfinished)
      + ' dropped=' + count(spans.dropped) + ' truncated=' + (spans.truncated === true) + '）'));
  }
  if (durationMs >= 100 && criticalPathMs / durationMs >= 0.6) {
    findings.push(normalizeFinding('critical-path-dominant', SEVERITY.NOTICE,
      '关键路径占时长 ' + Math.round(criticalPathMs / durationMs * 100) + '%（' + Math.round(criticalPathMs) + 'ms）'));
  }
  if (frames.length > 1) {
    findings.push(normalizeFinding('cross-frame', SEVERITY.NOTICE, '跨 ' + frames.length + ' 个 frame 有 span'));
  }
  const verdict = verdictOf(findings);
  const nextSteps = [];
  if (longTaskCount > 0) nextSteps.push('bridge trace view <trace.json>：看长任务 span 的因果链与关键路径');
  if (spans) nextSteps.push('bridge debug performance --insight：把页面指标与 trace 对照');
  nextSteps.push('bridge trace diff <base.json> <head.json>：改前后对比关键路径');
  return {
    events,
    durationMs,
    longTaskCount,
    longestTaskMs: longest,
    spans: spans
      ? {
        total: count(spans.spans),
        roots: count(spans.roots),
        unfinished: count(spans.unfinished),
        truncated: spans.truncated === true,
        dropped: count(spans.dropped),
        selfTotalMs: Number(spans.selfTotalMs) || 0,
        processCount: count(spans.processCount),
        threadCount: count(spans.threadCount),
        topPhases,
        frames: frames.slice(0, 5),
        criticalPath: criticalPath
          ? {
            totalMs: Math.round(criticalPathMs * 100) / 100,
            spanCount: count(criticalPath.spanCount),
            metric: criticalPath.metric == null ? null : String(criticalPath.metric),
            share: durationMs > 0 ? Math.round(criticalPathMs / durationMs * 1000) / 1000 : null,
          }
          : null,
      }
      : null,
    findings,
    verdict,
    nextSteps: nextSteps.slice(0, 3),
  };
}

/** `trace diff` 报告：把差分数据收敛成「是否回归」的结论。 */
export function summarizeTraceDiff(diff = {}) {
  const source = isObject(diff) ? diff : {};
  const events = isObject(source.events) ? source.events : {};
  const duration = isObject(source.durationMs) ? source.durationMs : {};
  const longTasks = isObject(source.longTaskCount) ? source.longTaskCount : {};
  const spanCount = isObject(source.spanCount) ? source.spanCount : null;
  const criticalPath = isObject(source.criticalPath) ? source.criticalPath : null;
  const findings = [];
  const durationBase = count(duration.base);
  const durationDelta = Number(duration.delta) || 0;
  if (Number(events.delta) === 0 && !durationDelta) {
    findings.push(normalizeFinding('no-change', SEVERITY.NOTICE, '事件数与时长都没有变化'));
  }
  if (durationBase >= 50 && durationDelta / durationBase >= 0.2) {
    findings.push(normalizeFinding('duration-regression', SEVERITY.WARN,
      '时长增加 ' + Math.round(durationDelta / durationBase * 100) + '%（+' + Math.round(durationDelta) + 'ms）'));
  } else if (durationBase >= 50 && durationDelta / durationBase <= -0.2) {
    findings.push(normalizeFinding('duration-improvement', SEVERITY.OK,
      '时长减少 ' + Math.round(Math.abs(durationDelta) / durationBase * 100) + '%（' + Math.round(durationDelta) + 'ms）'));
  }
  if (count(longTasks.delta) > 0) {
    findings.push(normalizeFinding('more-long-tasks', SEVERITY.WARN, '长任务增加 ' + count(longTasks.delta) + ' 个'));
  }
  if (criticalPath && Number(criticalPath.delta) >= 20) {
    findings.push(normalizeFinding('critical-path-regression', SEVERITY.WARN,
      '关键路径 ' + criticalPath.base + 'ms → ' + criticalPath.head + 'ms（+' + Math.round(Number(criticalPath.delta)) + 'ms）'));
  }
  if (spanCount && count(spanCount.head) > count(spanCount.base)) {
    findings.push(normalizeFinding('span-growth', SEVERITY.NOTICE, 'span 数 ' + spanCount.base + ' → ' + spanCount.head + '（新增异步/嵌套工作）'));
  }
  return {
    events: { base: count(events.base), head: count(events.head), delta: Number(events.delta) || 0 },
    durationMs: { base: durationBase, head: count(duration.head), delta: durationDelta },
    longTaskCount: { base: count(longTasks.base), head: count(longTasks.head), delta: Number(longTasks.delta) || 0 },
    findings,
    verdict: verdictOf(findings),
    nextSteps: [
      'bridge trace view <head.json>：在查看器里定位新增的慢 span',
      'bridge trace summary <head.json>：看关键路径与 frame 分布',
    ],
  };
}

// ---------------------------------------------------------------------------
// 文本格式化（CLI 人类输出；JSON 用上面的 summarize* 结果）
// ---------------------------------------------------------------------------

function pushFindings(lines, findings, limit = 6) {
  if (!findings.length) return;
  lines.push('  发现：');
  for (const finding of findings.slice(0, limit)) {
    lines.push('    - [' + finding.severity + '] ' + finding.label + (finding.detail ? '：' + finding.detail : ''));
  }
}

function pushNextSteps(lines, steps, limit = 4) {
  if (!steps.length) return;
  lines.push('  下一步：');
  for (const step of steps.slice(0, limit)) lines.push('    - ' + step);
}

function categoryText(categories) {
  return Object.entries(categories || {})
    .map(([key, value]) => key + '×' + value)
    .join(' ');
}

/** `debug stop` 文本追加行。 */
export function formatDebugStopLines(result = {}) {
  const summary = summarizeDebugStop(result);
  const lines = ['采集摘要：' + summary.verdict.label + '（' + summary.verdict.severity + '）'];
  lines.push('  记录：请求 ' + summary.requests + ' / 控制台 ' + summary.console + ' / journal ' + summary.journal.total
    + (summary.journal.truncated ? '（已截断）' : '')
    + ' / 关联 ' + summary.correlation.linked + '/' + summary.correlation.requests);
  lines.push('  覆盖：' + (summary.coverage.complete ? 'complete=true' : 'complete=false，缺口 ' + summary.coverage.gaps + ' 条')
    + (Object.keys(summary.coverage.categories).length ? '（' + categoryText(summary.coverage.categories) + '）' : ''));
  if (summary.journalExport.events) {
    lines.push('  journal 导出：' + summary.journalExport.events + ' 事件 / 校验 '
      + (summary.journalExport.verified ? '通过' : '未通过（' + (summary.journalExport.verifyReason || 'unknown') + '）'));
  }
  pushFindings(lines, summary.findings);
  pushNextSteps(lines, summary.nextSteps);
  return lines;
}

/** `debug status` 文本追加行。 */
export function formatDebugStatusLines(result = {}) {
  const summary = summarizeDebugStatus(result);
  const lines = ['采集摘要：' + summary.verdict.label + '（' + summary.verdict.severity + '）'];
  lines.push('  规模：请求 ' + summary.requests + ' / 控制台 ' + summary.console
    + ' / websocket ' + summary.websockets + ' / frame ' + summary.frames + ' / 截图 ' + summary.screenshots);
  lines.push('  journal：' + summary.journal.total + ' 条（debug=' + summary.journal.counts.debug
    + ' operation=' + summary.journal.counts.operation + ' request=' + summary.journal.counts.request
    + ' console=' + summary.journal.counts.console + '）');
  lines.push('  覆盖：' + (summary.coverage.complete ? 'complete=true' : 'complete=false，缺口 ' + summary.coverage.gaps + ' 条')
    + (Object.keys(summary.coverage.categories).length ? '（' + categoryText(summary.coverage.categories) + '）' : ''));
  pushFindings(lines, summary.findings);
  pushNextSteps(lines, summary.nextSteps, 3);
  return lines;
}

/** `debug status` 无采集文本追加行。 */
export function formatDebugHistoryLines(history = []) {
  const summary = summarizeDebugHistory(history);
  const lines = ['历史摘要：' + summary.available + ' 条'];
  if (summary.latest) {
    lines.push('  最近：' + summary.latest.id.slice(0, 8) + (summary.latest.name ? '(' + summary.latest.name + ')' : '')
      + '，请求 ' + summary.latest.requests + ' / 控制台 ' + summary.latest.console);
  }
  pushNextSteps(lines, summary.nextSteps, 2);
  return lines;
}

/** `debug coverage` 文本追加行。 */
export function formatDebugCoverageLines(result = {}) {
  const summary = summarizeDebugCoverage(result);
  const score = summary.score && summary.score.overall != null ? summary.score.overall : null;
  const lines = ['覆盖摘要：' + (summary.complete ? 'complete=true' : 'complete=false')
    + '（缺口 ' + summary.gaps + ' 条）' + (score != null ? '，综合分 ' + score : '')];
  if (Object.keys(summary.categories).length) {
    lines.push('  缺口分类：' + summary.categoryLabels.map((item) => item.label + '×' + item.count).join('；'));
  }
  lines.push('  阶段：观测 ' + summary.phases.observed.length + '/' + summary.phases.total
    + '，订阅 ' + summary.phases.subscribed.length + '/' + summary.phases.total);
  pushFindings(lines, coverageFindings(summary));
  return lines;
}

/** `debug analyze` 文本追加行。 */
export function formatDebugAnalyzeLines(analysis = {}) {
  const summary = summarizeDebugAnalyze(analysis);
  const lines = ['分析结论：' + summary.verdict.label + '（' + summary.verdict.severity + '）'];
  pushFindings(lines, summary.findings);
  pushNextSteps(lines, summary.nextSteps);
  return lines;
}

/** `debug evidence` 文本追加行。 */
export function formatDebugEvidenceLines(evidence = {}) {
  const summary = summarizeDebugEvidence(evidence);
  const lines = ['证据摘要：' + summary.verdict.label + '（' + summary.verdict.severity + '）'];
  lines.push('  完整性：' + (summary.integrity.complete ? 'sha256 齐全' : '缺 sha256 摘要'));
  pushFindings(lines, summary.findings);
  pushNextSteps(lines, summary.nextSteps, 2);
  return lines;
}

/** `debug requests` 文本追加行。 */
export function formatDebugRequestsLines(summary = {}) {
  const lines = ['请求摘要：匹配 ' + count(summary.matched) + ' / 共 ' + count(summary.total)
    + (summary.truncated ? '（已截断）' : '')
    + (summary.limit ? '，limit=' + summary.limit : '')];
  if (Object.keys(summary.byStatus || {}).length) {
    lines.push('  状态：' + Object.entries(summary.byStatus).map(([key, value]) => key + '×' + value).join(' '));
  }
  pushFindings(lines, summary.findings || []);
  pushNextSteps(lines, summary.nextSteps || [], 2);
  return lines;
}

/** `debug archive` 文本追加行。 */
export function formatDebugArchiveLines(archive = {}) {
  const summary = summarizeDebugArchive(archive);
  const lines = ['归档摘要：' + summary.verdict.label + '（' + summary.verdict.severity + '）'];
  lines.push('  规模：请求 ' + summary.requests + ' / 控制台 ' + summary.console + ' / journal ' + summary.journal
    + ' / ' + summary.bytes + ' 字节');
  if (summary.budget) {
    lines.push('  预算：requests≤' + count(summary.budget.maxRequests)
      + ' / console≤' + count(summary.budget.maxConsole)
      + ' / bytes≤' + count(summary.budget.maxBytes)
      + '（kept 请求 ' + summary.kept.requests + ' / 控制台 ' + summary.kept.console + '）');
  }
  pushFindings(lines, summary.findings);
  pushNextSteps(lines, summary.nextSteps, 2);
  return lines;
}

/** `debug journal` 文本追加行。 */
export function formatDebugJournalLines(journal = {}) {
  const summary = summarizeDebugJournalResult(journal);
  const lines = ['journal 摘要：' + summary.verdict.label + '（' + summary.verdict.severity + '）'];
  lines.push('  事件 ' + summary.total + '（debug=' + summary.counts.debug + ' operation=' + summary.counts.operation
    + ' request=' + summary.counts.request + ' console=' + summary.counts.console + '）'
    + (summary.spanMs != null ? '，跨度 ' + summary.spanMs + 'ms' : '')
    + (summary.truncated ? '，已截断' : ''));
  pushFindings(lines, summary.findings);
  pushNextSteps(lines, summary.nextSteps, 2);
  return lines;
}

/** `debug archives` 文本追加行。 */
export function formatDebugArchivesLines(entries = [], stats = {}) {
  const summary = summarizeDebugArchives(entries, stats);
  const lines = ['归档摘要：' + summary.total + ' 份 / 请求 ' + summary.requests + ' / 共 ' + summary.bytes + ' 字节'
    + (summary.incomplete ? '（' + summary.incomplete + ' 份覆盖不完整）' : '')];
  pushNextSteps(lines, summary.nextSteps, 2);
  return lines;
}

/** `debug performance --insight` 文本追加行。 */
export function formatDebugPerformanceLines(insights = []) {
  const summary = summarizePerformanceInsights(insights);
  const lines = ['性能结论：' + summary.verdict.label + '（' + summary.verdict.severity + '）'];
  pushNextSteps(lines, summary.nextSteps, 3);
  return lines;
}

/** `trace status` 文本追加行。 */
export function formatTraceStatusLines(result = {}) {
  const summary = summarizeTraceStatus(result);
  const lines = ['trace 摘要：' + summary.verdict.label + '（' + summary.verdict.severity + '）'];
  if (summary.tracing) {
    lines.push('  录制中：' + summary.events + ' 事件' + (summary.elapsedMs != null ? '，已录 ' + summary.elapsedMs + 'ms' : '')
      + (summary.categories ? '，类别 ' + summary.categories : ''));
  }
  pushFindings(lines, summary.findings);
  pushNextSteps(lines, summary.nextSteps, 2);
  return lines;
}

/** `trace stop` 文本追加行。 */
export function formatTraceStopLines(result = {}) {
  const summary = summarizeTraceStop(result);
  const lines = ['trace 摘要：' + summary.verdict.label + '（' + summary.verdict.severity + '）'];
  lines.push('  事件 ' + summary.events + ' / 录制 ' + summary.durationMs + 'ms'
    + (summary.spanMs != null ? ' / 跨度 ' + summary.spanMs + 'ms' : ''));
  if (summary.categories.length) {
    lines.push('  类别：' + summary.categories.slice(0, 5).map((item) => item.key + '×' + item.count).join(' '));
  }
  if (summary.topNames.length) {
    lines.push('  热点：' + summary.topNames.slice(0, 5).map((item) => item.key + '×' + item.count).join(' '));
  }
  pushFindings(lines, summary.findings);
  pushNextSteps(lines, summary.nextSteps, 2);
  return lines;
}

/** `trace summary` 文本追加行。 */
export function formatTraceSummaryLines(summary = {}) {
  const report = summarizeTraceReport(summary);
  const lines = ['trace 结论：' + report.verdict.label + '（' + report.verdict.severity + '）'];
  if (report.spans) {
    lines.push('  span 摘要：' + report.spans.total + ' spans / self ' + report.spans.selfTotalMs + 'ms'
      + ' / 进程 ' + report.spans.processCount + ' / 线程 ' + report.spans.threadCount);
    if (report.spans.topPhases.length) {
      lines.push('  阶段分布：' + report.spans.topPhases.map((item) => item.label + '×' + item.count + '(' + item.selfMs + 'ms)').join(' '));
    }
    if (report.spans.criticalPath) {
      lines.push('  关键路径：' + report.spans.criticalPath.totalMs + 'ms（' + report.spans.criticalPath.spanCount
        + ' spans，占比 ' + Math.round((report.spans.criticalPath.share || 0) * 100) + '%）');
    }
  }
  if (report.longTaskCount) lines.push('  长任务：' + report.longTaskCount + ' 个，最长 ' + report.longestTaskMs + 'ms');
  pushFindings(lines, report.findings);
  pushNextSteps(lines, report.nextSteps, 3);
  return lines;
}

/** `trace diff` 文本追加行。 */
export function formatTraceDiffLines(diff = {}) {
  const summary = summarizeTraceDiff(diff);
  const lines = ['差分结论：' + summary.verdict.label + '（' + summary.verdict.severity + '）'];
  pushFindings(lines, summary.findings);
  pushNextSteps(lines, summary.nextSteps, 2);
  return lines;
}

export const DIAGNOSTIC_SEVERITY = SEVERITY;
export const DIAGNOSTIC_GAP_LABELS = GAP_CATEGORY_LABELS;
export const classifyGap = classifyGapReason;
