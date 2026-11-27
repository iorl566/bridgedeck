/**
 * lib/eval-e2e-corpus.mjs —— eval 语料分层模型：结构与元数据校验、离线层执行、结果归一化。
 *
 * 语料分三层（layer）：
 *   offline —— fake adapter 驱动 DSH 插件工具（不连 daemon、不开浏览器），oracleLevel=offline-fake；
 *   dom     —— 真实 headless Chromium 里的 deterministic DOM 事实（tools/lib/overlay-dom-harness.mjs），
 *              oracleLevel=dom-real；
 *   e2e     —— 真实浏览器 E2E 的 PASS/FAIL 行派生（见 lib/eval-e2e.mjs），oracleLevel=e2e-real。
 *
 * 每个 case 归一化后必须带：id / capability / oracleLevel / expectedStatus / evidence 规则。
 * 兼容层：tests/eval/cases/fake-core.json（W4/W5 遗留语料）只有 mode/expect/assert，缺元数据时按
 * 工具名与错误码确定性推导，不改写原文件、也不把缺失元数据当成 pass。
 */
import fs from 'node:fs';
import path from 'node:path';
import { judge } from './eval-oracle.mjs';
import { EXPECTED_STATUSES, isExpectedStatus } from './eval-e2e-metrics.mjs';

/** 语料/结构错误：报告器据此 exit≠0（并打印可复现的诊断），而不是静默跳过 case。 */
export class CorpusError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CorpusError';
    this.code = details.code || 'E_EVAL_CORPUS';
    this.details = details;
  }
}

/** oracle level 的等级与含义。数字只用于排序，不参与判定。 */
export const ORACLE_LEVELS = Object.freeze({
  'offline-fake': { rank: 1, description: '进程内 fake adapter：确定、无浏览器、无网络' },
  'dom-real': { rank: 2, description: '真实 headless Chromium 的 DOM 事实（可复现夹具）' },
  'e2e-real': { rank: 3, description: '真实浏览器端到端 E2E 的真实 PASS/FAIL 行' },
});

export const ORACLE_LEVEL_IDS = Object.freeze(Object.keys(ORACLE_LEVELS));

/**
 * capability 目录：报告按它分组，语料只能引用这里登记的值。
 * 新增能力必须先登记（防止“随便写个字符串”式注水）。
 */
export const CAPABILITIES = Object.freeze({
  'plugin.tool-contract': '插件工具成功路径：输出字段归一化与工具契约',
  'plugin.rpc-routing': '会话直连：sessionId → 协议方法 + 参数映射',
  'plugin.cli-mapping': 'CLI 兜底/本地能力：argv 映射与结果透传',
  'plugin.error-mapping': 'daemon 业务错误码原样上抛，不被 CLI 兜底吞掉',
  'plugin.offline-fallback': '仅 E_DAEMON/E_DIRECT_RPC_DISABLED 回退 CLI',
  'plugin.timeout': '超时 E_TIMEOUT 传播（fake adapter 真实计时）',
  'plugin.evidence': '证据缺失必须降级 unverified（skip 不算 pass）',
  'plugin.negative-selfcheck': '负向自检：harness 确实能抓到错误结果',
  'overlay.top-layer': '原生 dialog top-layer：模态层挡住背景',
  'overlay.hit-testing': 'fixed 浮层命中测试（elementFromPoint）',
  'overlay.pointer-through': 'pointer-events:none 浮层点击穿透',
  'overlay.stacking': 'z-index 层序决定命中顺序',
  'overlay.toast': 'toast 生命周期：class 驱动 opacity 0↔1',
  'overlay.rtl': 'RTL 逻辑方向：direction / margin-inline 映射',
  'overlay.focus': '模态内焦点不逃逸',
  'overlay.shadow': 'closed shadow DOM：外部不可见、命中重定向到 host',
  'overlay.sticky': 'sticky 顶栏滚动后贴顶',
  'dom.negative-selfcheck': 'DOM oracle 负向自检：事实不符必须 failed',
  'e2e.observe': '真实浏览器：observe/VOM/语义观察',
  'e2e.action': '真实浏览器：点击/填写/按键/滚动等动作事务',
  'e2e.capture.screenshot': '真实浏览器：截图/长截图/差分/PDF',
  'e2e.capture.video': '真实浏览器：视频录制/编码/恢复',
  'e2e.record': '真实浏览器：语义操作录制',
  'e2e.network': '真实浏览器：网络/调试/控制台/trace',
  'e2e.cooperation': '真实浏览器：协作/借用/人工协助/控制权',
  'e2e.session': '真实浏览器：会话/标签页/窗口/焦点/scope',
  'e2e.iframe': '真实浏览器：跨帧/iframe/OOPIF 投影',
  'e2e.protocol': '真实浏览器：协议错误码/stale/安全策略',
  'e2e.pairing': '真实浏览器：远程配对/TLS',
  'e2e.extract': '真实浏览器：read/extract/view 数据读取',
  'e2e.rtl': '真实浏览器：RTL 界面真实渲染',
  'e2e.plugin': '真实浏览器：MCP/插件/技能面',
  'e2e.exec': '真实浏览器：bridge exec / QuickJS 沙箱',
  'e2e.recipe': '真实浏览器：recipe/ledger/plan/run log',
  'e2e.ui': '真实浏览器：UI 渲染/弹窗/可访问性/面板',
  'e2e.general': '真实浏览器：未细分类的端到端能力',
});

export const CAPABILITY_IDS = Object.freeze(Object.keys(CAPABILITIES));

/** E2E 语料的 capability 推导规则（按顺序首个命中；e2e-metadata.json 是权威来源）。 */
const CAPABILITY_RULES = Object.freeze([
  { id: 'e2e.capture.video', pattern: /视频|录像|录制页|force-frames|完帧|逐帧编码/i },
  { id: 'e2e.record', pattern: /record|记录器/i },
  { id: 'e2e.rtl', pattern: /RTL|ar\/he/i },
  { id: 'e2e.plugin', pattern: /MCP|插件|技能|WebMCP|skill/i },
  { id: 'e2e.exec', pattern: /exec|QuickJS|脚本|沙箱/i },
  { id: 'e2e.recipe', pattern: /recipe|ledger|run log|\bplan\b|意图账本|草稿/i },
  { id: 'e2e.cooperation', pattern: /cooperat|协作|借用|borrow|help|人工|交还|handoff|controller|authority|归因|frameState|共享|转交|控制权/i },
  { id: 'e2e.network', pattern: /network|console|debug|HAR|trace|coverage|请求|调试|Fetch|DNR|waterfall|规则|子资源/i },
  { id: 'e2e.observe', pattern: /observe|VOM|vom|语义|observation|观察|稳定身份|paint-order|命中|对比度|关系图|facts|节点/i },
  { id: 'e2e.session', pattern: /session|\btab\b|window|标签页|窗口|焦点|readOnly|read-only|keepOpen|alias|tab group|会话恢复/i },
  { id: 'e2e.extract', pattern: /extract|\bread\b|\bview\b|表格|字段|max-bytes|预算/i },
  { id: 'e2e.iframe', pattern: /iframe|OOPIF|owner\b|跨帧|跨源|\bframe\b/i },
  { id: 'e2e.capture.screenshot', pattern: /screenshot|截图|capture|长截图|分片|分段|分块|拼接|DPR|annotate|footer|差分|YIQ|printToPDF|PDF|PNG/i },
  { id: 'e2e.action', pattern: /click|fill|select|press|scroll|drag|hover|动作|输入|wait-for-element|expect|settle|depends-on|点击|填写|悬停|按键|滚动|target|fail-closed|actionable/i },
  { id: 'e2e.pairing', pattern: /pair|配对|TLS|证书|remote|远程/i },
  { id: 'e2e.protocol', pattern: /stale|context|E_[A-Z_]+|协议|安全|策略|security|禁止|拒绝|恢复|重启|过期|篡改|超时|satisfied/i },
  { id: 'e2e.ui', pattern: /界面|弹窗|渲染|可访问性|a11y|accessibility|面板|调试页|popup|UI/i },
]);

/** 依据标题推导 capability（只用于缺元数据的兼容路径；显式元数据优先）。 */
export function inferCapability(id, title = '') {
  const text = String(title || '') + ' ' + String(id || '');
  for (const rule of CAPABILITY_RULES) {
    if (rule.pattern.test(text)) return rule.id;
  }
  return 'e2e.general';
}

/** 遗留 fake-core 的工具 → capability 推导（仅用于缺元数据时）。 */
export function inferOfflineCapability(item) {
  if (item && item.negative === true) return 'plugin.negative-selfcheck';
  if (item && item.script && item.script.unavailable === true) return 'plugin.offline-fallback';
  const code = item && item.expectError ? String(item.expectError) : '';
  if (code === 'E_TIMEOUT') return 'plugin.timeout';
  if (code === 'E_DAEMON' || code === 'E_DIRECT_RPC_DISABLED') return 'plugin.offline-fallback';
  if (code) return 'plugin.error-mapping';
  if (item && item.mode === 'rpc') return 'plugin.rpc-routing';
  return 'plugin.tool-contract';
}

const PLUGIN_TOOL_CACHE = { names: null };
/** 插件工具名集合（懒加载：只有离线语料校验/执行才需要 dsh-plugin，DOM/指标层不依赖它）。 */
export async function loadPluginToolNames() {
  if (!PLUGIN_TOOL_CACHE.names) {
    const { buildToolSpecs } = await import('../dsh-plugin/lib/tools.mjs');
    const specs = buildToolSpecs(async () => ({ ok: true }));
    PLUGIN_TOOL_CACHE.names = new Set(specs.map((spec) => spec.name));
  }
  return PLUGIN_TOOL_CACHE.names;
}

function describeEvidenceRule(item) {
  const evidence = Array.isArray(item.evidence) ? item.evidence.filter((value) => typeof value === 'string' && value) : [];
  if (item.negative === true) {
    return '负向自检：断言的 actual 与期望不符必须产出 failed，并保留 ' + (evidence.length ? evidence.join(', ') : '失败检查的 expected/actual') + ' 证据';
  }
  if (item.expectError) {
    return '错误码证据：实际 error.code 必须等于 ' + item.expectError + '，且 daemon 业务错误不得被兜底替换';
  }
  if (evidence.length) return '输出证据路径必须非空：' + evidence.join(', ') + '；缺一即降级 unverified';
  return 'assert/contains 检查的 expected/actual 与 fake-adapter 调用序列即为证据';
}

/**
 * 归一化一个 case。保留原始字段（评估器要用），补上必需元数据。
 * @param {object} raw 原始 case
 * @param {{ layer?: string, source?: string, expectedLevel?: string }} [options]
 */
export function normalizeCase(raw, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CorpusError('eval case 必须是对象', { case: raw });
  }
  const layer = options.layer || raw.layer || 'offline';
  const oracleLevel = raw.oracleLevel || options.expectedLevel || defaultOracleLevel(layer);
  // E2E 派生语料默认“真实 PASS 行 = passed”；DOM/离线层必须显式声明，缺失由 validateCases 拒绝。
  const expectedStatus = raw.expectedStatus || raw.expect || (layer === 'e2e' ? 'passed' : undefined);
  const capability = raw.capability || (layer === 'e2e'
    ? inferCapability(raw.id, raw.title)
    : inferOfflineCapability(raw));
  return {
    ...raw,
    layer,
    source: options.source || raw.source || null,
    capability,
    oracleLevel,
    expectedStatus,
    evidence: Array.isArray(raw.evidence) ? raw.evidence.slice() : [],
    evidenceRule: typeof raw.evidenceRule === 'string' && raw.evidenceRule.trim()
      ? raw.evidenceRule.trim()
      : describeEvidenceRule(raw),
    negative: raw.negative === true,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : String(raw.id || ''),
  };
}

export function defaultOracleLevel(layer) {
  if (layer === 'dom') return 'dom-real';
  if (layer === 'e2e') return 'e2e-real';
  return 'offline-fake';
}

/** 逐 case 校验；返回问题列表（空数组=通过）。 */
export function validateCases(cases, options = {}) {
  const problems = [];
  const { layer = null, source = null, seenIds = null, knownTools = null } = options;
  const ids = seenIds || new Set();
  for (const item of Array.isArray(cases) ? cases : []) {
    const label = source ? source + '#' + (item && item.id ? item.id : '?') : String(item && item.id);
    if (!item || typeof item !== 'object') {
      problems.push(label + ': case 必须是对象');
      continue;
    }
    if (typeof item.id !== 'string' || !item.id.trim()) {
      problems.push(label + ': 缺少非空 id');
      continue;
    }
    if (ids.has(item.id)) problems.push(label + ': id 重复：' + item.id);
    ids.add(item.id);
    if (!CAPABILITIES[item.capability]) problems.push(label + ': 未登记的 capability：' + item.capability);
    if (!ORACLE_LEVELS[item.oracleLevel]) problems.push(label + ': 非法 oracleLevel：' + item.oracleLevel);
    if (!isExpectedStatus(item.expectedStatus)) problems.push(label + ': 非法 expectedStatus：' + item.expectedStatus);
    if (!Array.isArray(item.evidence)) problems.push(label + ': evidence 需要数组');
    else if (item.evidence.some((entry) => typeof entry !== 'string' || !entry.trim())) problems.push(label + ': evidence 路径需要非空字符串');
    if (typeof item.evidenceRule !== 'string' || !item.evidenceRule.trim()) problems.push(label + ': 缺少 evidenceRule');
    if (!item.title) problems.push(label + ': 缺少 title');
    if (layer === 'offline' || item.layer === 'offline') {
      if (!['tool', 'rpc'].includes(item.mode)) problems.push(label + ': mode 只能是 tool | rpc');
      if (!isExpectedStatus(item.expect)) problems.push(label + ': 缺少 expect（== expectedStatus）');
      else if (item.expect !== item.expectedStatus) problems.push(label + ': expect 与 expectedStatus 不一致');
      if (item.expect === 'failed' && item.negative !== true) problems.push(label + ': 期望 failed 必须显式 negative=true');
      if (item.mode === 'tool') {
        if (typeof item.tool !== 'string' || !item.tool) problems.push(label + ': tool 模式需要 tool');
        else if (knownTools && !knownTools.has(item.tool)) problems.push(label + ': 引用了不存在的插件工具：' + item.tool);
      }
      if (item.mode === 'rpc' && (!item.rpc || typeof item.rpc.method !== 'string' || !item.rpc.method)) problems.push(label + ': rpc 模式需要 rpc.method');
      for (const entry of Array.isArray(item.expectRpc) ? item.expectRpc : []) {
        if (!entry || typeof entry.method !== 'string' || !entry.method) problems.push(label + ': expectRpc 需要 method');
      }
      for (const entry of Array.isArray(item.expectCli) ? item.expectCli : []) {
        if (!Array.isArray(entry) || entry.length === 0) problems.push(label + ': expectCli 需要非空 argv 数组');
      }
      for (const key of ['expectCallCount', 'expectCliCount']) {
        if (item[key] !== undefined && (!Number.isInteger(item[key]) || item[key] < 0)) {
          problems.push(label + ': ' + key + ' 需要非负整数');
        }
      }
    }
  }
  return problems;
}

/** 严格校验：有问题即抛 CorpusError（含全部问题清单，便于一次修完）。 */
export function assertCases(cases, options = {}) {
  const problems = validateCases(cases, { ...options, knownTools: options.knownTools || PLUGIN_TOOL_CACHE.names });
  if (problems.length) {
    throw new CorpusError('eval 语料校验失败（' + problems.length + ' 项）：\n  - ' + problems.join('\n  - '), { problems });
  }
  return cases;
}

/** 读取一个语料文件：裸数组，或 {schema, cases:[...]}。 */
export function loadCorpusFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new CorpusError('读取语料失败：' + filePath + '（' + (error && error.message) + '）', { file: filePath });
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new CorpusError('语料不是合法 JSON：' + filePath + '（' + (error && error.message) + '）', { file: filePath });
  }
  let list;
  if (Array.isArray(data)) list = data;
  else if (data && Array.isArray(data.cases)) list = data.cases;
  else throw new CorpusError('语料需要数组或 { cases: [...] }：' + filePath, { file: filePath });
  if (!list.length) throw new CorpusError('语料为空：' + filePath, { file: filePath });
  return list;
}

/**
 * 加载分层语料并做全局校验（跨文件 id 不得重复）。
 * @param {Array<{layer:string, file:string, source?:string}>} specs
 */
export function loadCorpusLayers(root, specs, options = {}) {
  const seenIds = new Set();
  const layers = [];
  for (const spec of Array.isArray(specs) ? specs : []) {
    const file = path.isAbsolute(spec.file) ? spec.file : path.join(root, spec.file);
    const label = spec.source || path.relative(root, file).replace(/\\/g, '/');
    const raw = loadCorpusFile(file);
    const normalized = raw.map((item) => normalizeCase(item, { layer: spec.layer, source: label }));
    assertCases(normalized, {
      layer: spec.layer,
      source: label,
      seenIds,
      knownTools: (options.knownTools || PLUGIN_TOOL_CACHE.names) || null,
    });
    layers.push({ layer: spec.layer, source: label, file, cases: normalized });
  }
  return layers;
}

function deepEqualValue(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((value, index) => deepEqualValue(value, b[index]));
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => deepEqualValue(a[key], b[key]));
}

/** expected 是 actual 的子集（对象递归子集、数组全等）。 */
export function matchesSubset(actual, expected) {
  if (expected === null || typeof expected !== 'object') return deepEqualValue(actual, expected);
  if (Array.isArray(expected)) return deepEqualValue(actual, expected);
  if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
  return Object.keys(expected).every((key) => matchesSubset(actual[key], expected[key]));
}

function extraChecksFor(item, base) {
  const checks = [];
  const adapter = base && base.adapter ? base.adapter : null;
  const calls = adapter && Array.isArray(adapter.calls) ? adapter.calls : [];
  const cliCalls = Array.isArray(base && base.cliCalls) ? base.cliCalls : [];
  for (const expected of Array.isArray(item.expectRpc) ? item.expectRpc : []) {
    const wanted = { status: 'ok', ...expected };
    const match = calls.find((call) => call.method === wanted.method
      && (!wanted.status || call.status === wanted.status)
      && matchesSubset(call.params || {}, wanted.params || {}));
    checks.push({
      id: item.id + ':rpc:' + wanted.method,
      ok: Boolean(match),
      evidence: {
        method: wanted.method,
        expectedParams: wanted.params || {},
        actualCalls: calls.map((call) => ({ method: call.method, status: call.status, params: call.params })),
      },
      evidenceRequired: true,
    });
  }
  for (const expectedArgv of Array.isArray(item.expectCli) ? item.expectCli : []) {
    const match = cliCalls.some((argv) => deepEqualValue(argv, expectedArgv));
    checks.push({
      id: item.id + ':cli:' + expectedArgv.join(' '),
      ok: match,
      evidence: { expectedArgv, actualCliCalls: cliCalls },
      evidenceRequired: true,
    });
  }
  if (Number.isInteger(item.expectCallCount)) {
    checks.push({
      id: item.id + ':call-count',
      ok: calls.length === item.expectCallCount,
      evidence: { expected: item.expectCallCount, actual: calls.length, methods: calls.map((call) => call.method) },
      evidenceRequired: true,
    });
  }
  if (Number.isInteger(item.expectCliCount)) {
    checks.push({
      id: item.id + ':cli-count',
      ok: cliCalls.length === item.expectCliCount,
      evidence: { expected: item.expectCliCount, actual: cliCalls.length, cliCalls },
      evidenceRequired: true,
    });
  }
  return checks;
}

function runnerFailure(item, error) {
  return {
    id: item.id,
    title: item.title,
    layer: item.layer,
    source: item.source,
    capability: item.capability,
    oracleLevel: item.oracleLevel,
    expectedStatus: item.expectedStatus,
    status: 'failed',
    checks: [{
      id: item.id + ':runner',
      ok: false,
      reason: 'runner error',
      evidence: { error: String((error && error.message) || error) },
      evidenceRequired: true,
    }],
    unverified: [],
    evidence: {},
    evidenceRule: item.evidenceRule,
    negative: item.negative,
    error: { code: (error && error.code) || 'E_EVAL_RUNNER', message: String((error && error.message) || error) },
    runnerError: String((error && error.message) || error),
    adapterCalls: [],
    cliCalls: [],
    durationMs: 0,
  };
}

function judgedChecks(verdict) {
  return (verdict.items || []).map((check) => ({ ...check, ok: check.status === 'pass' }));
}

function buildResult(item, base, checks, verdict, durationMs) {
  return {
    id: item.id,
    title: item.title,
    layer: item.layer,
    source: item.source,
    capability: item.capability,
    oracleLevel: item.oracleLevel,
    expectedStatus: item.expectedStatus,
    status: verdict.status,
    checks: judgedChecks(verdict),
    unverified: verdict.unverified,
    evidence: base && base.evidence ? base.evidence : {},
    evidenceRule: item.evidenceRule,
    negative: item.negative,
    error: base && base.error ? base.error : null,
    adapterCalls: base && base.adapter && Array.isArray(base.adapter.calls)
      ? base.adapter.calls.map((call) => ({ method: call.method, status: call.status, params: call.params }))
      : [],
    cliCalls: base && Array.isArray(base.cliCalls) ? base.cliCalls : [],
    counts: verdict.counts,
    durationMs,
  };
}

/**
 * 跑离线层：fake adapter + 插件工具，再叠加 case 级 expectRpc/expectCli/expectCallCount 断言。
 * `evaluate` 可注入（单测用），默认用 tools/eval-fake.mjs 的 evaluateCase。
 */
export async function runOfflineLayer(cases, options = {}) {
  const evaluate = typeof options.evaluate === 'function'
    ? options.evaluate
    : (await import('../tools/eval-fake.mjs')).evaluateCase;
  const results = [];
  for (const item of cases) {
    const startedAt = Date.now();
    let base;
    try {
      base = await evaluate(item);
    } catch (error) {
      results.push(runnerFailure(item, error));
      continue;
    }
    if (!base || typeof base !== 'object') {
      results.push(runnerFailure(item, new Error('evaluator 未返回结果')));
      continue;
    }
    const checks = [...(Array.isArray(base.checks) ? base.checks : []), ...extraChecksFor(item, base)];
    const verdict = judge({ checks, unverified: base.unverified });
    results.push(buildResult(item, base, checks, verdict, Date.now() - startedAt));
  }
  return results;
}

/** 供报告器使用的语料摘要（不含执行）。 */
export function summarizeCorpus(layers) {
  const cases = [];
  for (const layer of Array.isArray(layers) ? layers : []) cases.push(...layer.cases);
  const byLayer = {};
  const byCapability = {};
  const byOracleLevel = {};
  const byExpectedStatus = { passed: 0, failed: 0, unverified: 0 };
  for (const item of cases) {
    byLayer[item.layer] = (byLayer[item.layer] || 0) + 1;
    byCapability[item.capability] = (byCapability[item.capability] || 0) + 1;
    byOracleLevel[item.oracleLevel] = (byOracleLevel[item.oracleLevel] || 0) + 1;
    byExpectedStatus[item.expectedStatus] = (byExpectedStatus[item.expectedStatus] || 0) + 1;
  }
  const sorted = (map) => Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
  return {
    total: cases.length,
    byLayer: sorted(byLayer),
    byCapability: sorted(byCapability),
    byOracleLevel: sorted(byOracleLevel),
    byExpectedStatus,
    files: (Array.isArray(layers) ? layers : []).map((layer) => layer.source),
  };
}

/** 校验结果集合（执行后自检）：三态合法、id 唯一、expectedStatus 合法。 */
export function validateResults(results) {
  const problems = [];
  const ids = new Set();
  for (const item of Array.isArray(results) ? results : []) {
    if (!item || typeof item !== 'object') {
      problems.push('结果不是对象');
      continue;
    }
    if (ids.has(item.id)) problems.push('结果 id 重复：' + item.id);
    ids.add(item.id);
    if (!EXPECTED_STATUSES.includes(item.status)) problems.push(item.id + ': 非法 status ' + item.status);
    if (!isExpectedStatus(item.expectedStatus)) problems.push(item.id + ': 非法 expectedStatus ' + item.expectedStatus);
  }
  return problems;
}
