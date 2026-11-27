// lib/vom-capture.js —— VOM 六阶段捕获漏斗（collect → resolve → filter → enrich → rank → emit）。
//
// 目标：观测“为什么少了节点”必须可解释。每个阶段固定记录
//   { name, input, output, dropped, dropReasons: [{reason,count}], ms }
// 并输出链式一致的总览 { collected, emitted, dropped, accounted, keptRate, ms }。
//
// 两类来源拼进同一套阶段：
//   - 页面侧（page-lib）只有粗粒度计数器（collected/visited/skippedTag/hidden/stealth/empty/deduped/
//     emitted/tokens/ms.*），用 `captureStagesFromPageStages` 映射；
//   - 扩展侧（tools/observation.js）用 `createCaptureTrace` 按真实阶段计时/计数；
//     没有页面计数时也能独立成立（前两阶段退化为“页面返回的节点数”）。
//
// 纯函数 + 可注入时钟，不读 DOM；单测无需浏览器。

export const VOM_CAPTURE_VERSION = 1;

/** 阶段名固定且有顺序：调用方可以按数组下标稳定对比两次观测。 */
export const VOM_CAPTURE_STAGES = Object.freeze(['collect', 'resolve', 'filter', 'enrich', 'rank', 'emit']);

/** 页面侧理由 → 统一理由名（只影响可读性，不改变计数）。 */
export const PAGE_DROP_REASONS = Object.freeze({
  skippedTag: 'skipped-tag',
  hidden: 'hidden',
  stealth: 'stealth',
  empty: 'empty',
  deduped: 'deduped',
  budget: 'budget',
});

const DROP_REASON_ORDER = [
  'skipped-tag',
  'hidden',
  'stealth',
  'empty',
  'deduped',
  'paint-hidden',
  'hidden',
  'offscreen',
  'clipped',
  'pointer-events-none',
  'occluded',
  'blocking-layer',
  'recycled-row',
  'detached',
  'semantic-group-budget',
  'min-score',
  'group-compact',
  'node-limit',
  'token-limit',
  'top-limit',
  'budget',
  'unknown',
];

function defaultNow() {
  if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') return performance.now();
  return Date.now();
}

function countOf(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

function msOf(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.round(number * 10) / 10;
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

/** 理由输入兼容三种形态：对象 {hidden:3}、数组 [{reason,count}]、Map。 */
function normalizeReasons(input) {
  const out = new Map();
  const add = (reason, count) => {
    const key = String(reason == null ? '' : reason).trim();
    if (!key) return;
    const value = countOf(count);
    if (!value) return;
    out.set(key, (out.get(key) || 0) + value);
  };
  if (input instanceof Map) {
    for (const [reason, count] of input) add(reason, count);
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item) continue;
      if (typeof item === 'string') add(item, 1);
      else add(item.reason != null ? item.reason : item.stage, item.count);
    }
  } else if (input && typeof input === 'object') {
    for (const [reason, count] of Object.entries(input)) add(reason, count);
  }
  return out;
}

function sortedReasons(map) {
  const rank = (reason) => {
    const index = DROP_REASON_ORDER.indexOf(reason);
    return index < 0 ? DROP_REASON_ORDER.length : index;
  };
  return [...map.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => rank(a[0]) - rank(b[0]) || b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([reason, count]) => ({ reason, count }));
}

function normalizeStage(name, input = {}) {
  const value = input && typeof input === 'object' ? input : {};
  const reasons = normalizeReasons(value.dropReasons || value.reasons);
  const explicitDropped = Number.isFinite(Number(value.dropped)) ? countOf(value.dropped) : null;
  const reasonTotal = [...reasons.values()].reduce((sum, count) => sum + count, 0);
  return {
    name,
    input: value.input == null ? null : countOf(value.input),
    output: value.output == null ? null : countOf(value.output),
    dropped: explicitDropped == null ? reasonTotal : Math.max(explicitDropped, reasonTotal),
    dropReasons: sortedReasons(reasons),
    ms: msOf(value.ms),
    ...(value.meta && typeof value.meta === 'object' ? { meta: { ...value.meta } } : {}),
  };
}

/**
 * 阶段输入 → 规范化报告。阶段缺失时补零；input 缺省沿用上一阶段 output，
 * output 缺省跟随 input，保证整条链可读且不会出现 input/output 断点。
 * @param {Array<object>} stageInputs
 * @param {{stageNames?:string[], version?:number}} [options]
 */
export function buildCaptureReport(stageInputs = [], { stageNames = VOM_CAPTURE_STAGES, version = VOM_CAPTURE_VERSION } = {}) {
  const order = Array.isArray(stageNames) && stageNames.length ? stageNames.slice() : VOM_CAPTURE_STAGES.slice();
  const byName = new Map();
  for (const item of Array.isArray(stageInputs) ? stageInputs : []) {
    if (!item || !item.name) continue;
    byName.set(String(item.name), item);
  }
  const stages = [];
  let previousOutput = null;
  for (const name of order) {
    const stage = normalizeStage(name, byName.get(name) || {});
    if (stage.input == null) stage.input = previousOutput == null ? 0 : previousOutput;
    if (stage.output == null) stage.output = stage.input;
    if (stage.dropped > stage.input) stage.dropped = stage.input;
    // 阶段内 output 应等于 input - dropped；页面计数偶尔有竞态，按 input-output 校正，
    // 但保留原始 dropped 的可解释性（超出部分记到 accountingGap）。
    const implied = Math.max(0, stage.input - stage.output);
    stage.impliedDropped = implied;
    previousOutput = stage.output;
    stages.push(stage);
  }
  const collected = stages[0].input;
  const emitted = stages[stages.length - 1].output;
  const dropped = Math.max(0, collected - emitted);
  const accounted = stages.reduce((sum, stage) => sum + stage.dropped, 0);
  const totalMs = stages.reduce((sum, stage) => sum + stage.ms, 0);
  return {
    version,
    stageNames: order,
    stages,
    totals: {
      collected,
      emitted,
      dropped,
      accounted,
      unaccounted: Math.max(0, dropped - accounted),
      overAccounted: Math.max(0, accounted - dropped),
      keptRate: collected ? round(emitted / collected) : 0,
      ms: msOf(totalMs),
    },
    complete: stages.every((stage) => Number.isInteger(stage.input) && Number.isInteger(stage.output)),
    consistent: accounted === dropped,
  };
}

/**
 * 页面侧粗粒度计数器 → 六阶段。
 * page-lib 的 deep-vom（41-deep.part）与文本观察（25b）字段略有差异，这里同时兼容
 * collected/visited 与 emitted/lines。
 */
export function captureStagesFromPageStages(stages = {}, { source = 'page-lib' } = {}) {
  const input = stages && typeof stages === 'object' ? stages : {};
  const count = (key) => countOf(input[key]);
  const collected = count('collected') || count('visited');
  const emitted = count('emitted');
  const skipped = count('skippedTag');
  const hidden = count('hidden');
  const stealth = count('stealth');
  const empty = count('empty');
  const deduped = count('deduped');
  const truncated = input.truncated === true;
  const known = skipped + hidden + stealth + empty + deduped;
  const resolved = Math.max(0, collected - skipped - hidden - stealth);
  const filtered = Math.max(0, resolved - empty - deduped);
  const enriched = filtered;
  const ranked = filtered;
  const budgetDrop = Math.max(0, truncated ? collected - emitted - known : ranked - emitted);
  const ms = input.ms && typeof input.ms === 'object' ? input.ms : {};
  const walkMs = msOf(ms.walk != null ? ms.walk : input.walkMs);
  const visibilityMs = msOf(ms.visibility);
  const stealthMs = msOf(ms.stealth);
  const elapsedMs = msOf(input.elapsedMs);
  const emitMs = elapsedMs > walkMs ? msOf(elapsedMs - walkMs) : 0;
  return [
    {
      name: 'collect',
      input: collected,
      output: collected,
      dropped: 0,
      dropReasons: [],
      ms: walkMs,
      meta: { source, visited: count('visited'), iframes: count('iframes') },
    },
    {
      name: 'resolve',
      input: collected,
      output: resolved,
      dropped: skipped + hidden + stealth,
      dropReasons: [
        { reason: PAGE_DROP_REASONS.skippedTag, count: skipped },
        { reason: PAGE_DROP_REASONS.hidden, count: hidden },
        { reason: PAGE_DROP_REASONS.stealth, count: stealth },
      ],
      ms: msOf(visibilityMs + stealthMs),
      meta: { visibilityMs, stealthMs },    },
    {
      name: 'filter',
      input: resolved,
      output: filtered,
      dropped: empty + deduped,
      dropReasons: [
        { reason: PAGE_DROP_REASONS.empty, count: empty },
        { reason: PAGE_DROP_REASONS.deduped, count: deduped },
      ],
      ms: 0,
    },
    {
      name: 'enrich',
      input: filtered,
      output: enriched,
      dropped: 0,
      dropReasons: [],
      ms: 0,
      meta: { refs: count('refs') },
    },
    {
      name: 'rank',
      input: enriched,
      output: ranked,
      dropped: 0,
      dropReasons: [],
      ms: 0,
      meta: { sorted: input.sorted || null },
    },
    {
      name: 'emit',
      input: ranked,
      output: emitted,
      dropped: budgetDrop,
      dropReasons: budgetDrop ? [{ reason: PAGE_DROP_REASONS.budget, count: budgetDrop }] : [],
      ms: emitMs,
      meta: { tokens: count('tokens'), truncated },
    },
  ];
}

/** 页面侧计数器直接出报告（observe --vom-deep 的诊断用）。 */
export function pageStagesCaptureReport(stages = {}, options = {}) {
  return buildCaptureReport(captureStagesFromPageStages(stages, options), options);
}

/**
 * 扩展侧逐阶段计时/计数。用法：
 *   const trace = createCaptureTrace();
 *   trace.start('collect'); ... trace.end('collect', { input, output });
 *   trace.drop('resolve', 'hidden', 3);
 *   const report = trace.report();
 * 任何阶段都可以只 record 计数（不 start/end，ms=0），未使用的阶段补零。
 */
export function createCaptureTrace({ now = defaultNow, stageNames = VOM_CAPTURE_STAGES, meta = null } = {}) {
  const order = Array.isArray(stageNames) && stageNames.length ? stageNames.slice() : VOM_CAPTURE_STAGES.slice();
  const stages = new Map();
  for (const name of order) {
    stages.set(name, { name, input: null, output: null, dropped: null, dropReasons: new Map(), ms: 0, startedAt: null, meta: {} });
  }
  const pick = (name) => {
    const stage = stages.get(String(name));
    if (!stage) throw new Error('未知捕获阶段：' + String(name));
    return stage;
  };
  const addReason = (stage, reason, amount) => {
    const key = String(reason == null ? '' : reason).trim() || 'unknown';
    const value = countOf(amount);
    if (!value) return;
    stage.dropReasons.set(key, (stage.dropReasons.get(key) || 0) + value);
  };
  return {
    stageNames: order.slice(),
    start(name, patch = {}) {
      const stage = pick(name);
      stage.startedAt = now();
      if (patch && typeof patch === 'object') this.record(name, patch);
      return this;
    },
    end(name, patch = {}) {
      const stage = pick(name);
      if (stage.startedAt != null) {
        stage.ms += msOf(now() - stage.startedAt);
        stage.startedAt = null;
      }
      if (patch && typeof patch === 'object') this.record(name, patch);
      return this;
    },
    input(name, value) {
      pick(name).input = countOf(value);
      return this;
    },
    output(name, value) {
      pick(name).output = countOf(value);
      return this;
    },
    setDropped(name, value) {
      pick(name).dropped = countOf(value);
      return this;
    },
    drop(name, reason, count = 1) {
      const stage = pick(name);
      addReason(stage, reason, count);
      return this;
    },
    dropReasons(name, reasons) {
      const stage = pick(name);
      for (const item of Array.isArray(reasons) ? reasons : []) {
        if (!item) continue;
        if (typeof item === 'string') {
          addReason(stage, item, 1);
          continue;
        }
        addReason(stage, item.reason != null ? item.reason : item.stage, item.count == null ? 1 : item.count);
      }
      return this;
    },
    setMs(name, value) {
      pick(name).ms = msOf(value);
      return this;
    },
    meta(name, patch) {
      if (patch && typeof patch === 'object') Object.assign(pick(name).meta, patch);
      return this;
    },
    record(name, patch = {}) {
      const stage = pick(name);
      const value = patch && typeof patch === 'object' ? patch : {};
      if (value.input != null) stage.input = countOf(value.input);
      if (value.output != null) stage.output = countOf(value.output);
      if (value.dropped != null) stage.dropped = countOf(value.dropped);
      if (value.ms != null) stage.ms = msOf(value.ms);
      if (value.dropReasons) this.dropReasons(name, value.dropReasons);
      if (value.reasons) this.dropReasons(name, value.reasons);
      if (value.meta && typeof value.meta === 'object') Object.assign(stage.meta, value.meta);
      return this;
    },
    report() {
      for (const stage of stages.values()) {
        if (stage.startedAt != null) {
          stage.ms += msOf(now() - stage.startedAt);
          stage.startedAt = null;
        }
      }
      const inputs = [...stages.values()].map((stage) => ({
        name: stage.name,
        input: stage.input,
        output: stage.output,
        dropped: stage.dropped == null ? undefined : stage.dropped,
        dropReasons: stage.dropReasons,
        ms: stage.ms,
        meta: Object.keys(stage.meta).length ? stage.meta : undefined,
      }));
      const report = buildCaptureReport(inputs, { stageNames: order });
      if (meta && typeof meta === 'object') report.meta = { ...meta };
      return report;
    },
  };
}

/** 人类可读的一行漏斗摘要（诊断字段 vomCapture.text）。 */
export function summarizeCaptureReport(report) {
  if (!report || !Array.isArray(report.stages)) return '';
  const parts = report.stages.map((stage) => {
    const reasons = stage.dropReasons
      .filter((item) => item.count > 0)
      .map((item) => item.reason + ':' + item.count)
      .join(',');
    const timing = stage.ms > 0 ? ' ' + stage.ms + 'ms' : '';
    return stage.name + ' ' + stage.input + '→' + stage.output + (reasons ? ' (' + reasons + ')' : '') + timing;
  });
  return parts.join(' | ');
}

/** 两段漏斗拼接：页面侧（page）→ 扩展侧（ext），只用于诊断展示。 */
export function chainCaptureReports(pageReport, extReport) {
  const page = pageReport && Array.isArray(pageReport.stages) ? pageReport : null;
  const ext = extReport && Array.isArray(extReport.stages) ? extReport : null;
  if (!page || !ext) return ext || page || null;
  return {
    version: VOM_CAPTURE_VERSION,
    stageNames: VOM_CAPTURE_STAGES.slice(),
    segments: ['page', 'extension'],
    page: {
      collected: page.totals.collected,
      emitted: page.totals.emitted,
      dropped: page.totals.dropped,
      stages: page.stages,
    },
    extension: {
      collected: ext.totals.collected,
      emitted: ext.totals.emitted,
      dropped: ext.totals.dropped,
      stages: ext.stages,
    },
    totals: { pageCollected: page.totals.collected, pageEmitted: page.totals.emitted, emitted: ext.totals.emitted },
  };
}
