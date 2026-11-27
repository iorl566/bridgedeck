/**
 * lib/eval-e2e-dom.mjs —— DOM 层 oracle：真实 headless Chromium 事实 → 三态判定。
 *
 * 夹具（tests/eval/dom/eval-dom-cases.html + .js）只负责把浏览器真实计算结果写进
 * <script type="application/json" id="eval-facts">；断言与期望写在语料
 * tests/eval/cases/dom-cases.json 里。夹具与 oracle 分离，负向 case 才能真的 failed，
 * 而不是“夹具自己断言自己”。
 *
 * 复现方式：tools/eval-report.mjs 默认执行本层；单测可注入 runPage/extractFacts 不启动浏览器。
 */
import path from 'node:path';
import { judge } from './eval-oracle.mjs';
import { runHeadlessPage, findBrowser } from '../tools/lib/overlay-dom-harness.mjs';

export const DEFAULT_DOM_PAGE = 'tests/eval/dom/eval-dom-cases.html';
export const DOM_OK_MARKER = 'EVAL_DOM_OK:';
export const DOM_FAIL_MARKER = 'EVAL_DOM_FAIL:';
const FACTS_PATTERN = /<script type="application\/json" id="eval-facts">([\s\S]*?)<\/script>/;

/** DOM 层基础设施错误（不是 case 失败）：浏览器缺失/夹具崩溃/事实缺失 → 报告器 exit 2。 */
export class DomHarnessError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DomHarnessError';
    this.code = details.code || 'E_EVAL_DOM';
    this.details = details;
  }
}

function excerpt(text, limit = 1200) {
  const value = String(text || '');
  return value.length > limit ? value.slice(0, limit) + '…（截断）' : value;
}

/** 从 `--dump-dom` 输出里取出 facts JSON；结构不对即抛 DomHarnessError。 */
export function extractDomFacts(result) {
  const title = String((result && result.title) || '');
  if (!title.startsWith(DOM_OK_MARKER)) {
    throw new DomHarnessError('DOM 夹具没有产出成功标记（title=' + JSON.stringify(title) + '）', {
      code: title.startsWith(DOM_FAIL_MARKER) ? 'E_EVAL_DOM_FIXTURE' : 'E_EVAL_DOM_NO_MARKER',
      title,
      code2: result && result.code,
      stdout: excerpt(result && result.stdout),
      stderr: excerpt(result && result.stderr),
    });
  }
  const match = FACTS_PATTERN.exec(String((result && result.stdout) || ''));
  if (!match) {
    throw new DomHarnessError('DOM 输出里找不到 #eval-facts JSON', {
      code: 'E_EVAL_DOM_NO_FACTS',
      title,
      stdout: excerpt(result && result.stdout),
      stderr: excerpt(result && result.stderr),
    });
  }
  let facts;
  try {
    facts = JSON.parse(match[1]);
  } catch (error) {
    throw new DomHarnessError('DOM facts 不是合法 JSON（' + (error && error.message) + '）', {
      code: 'E_EVAL_DOM_BAD_JSON',
      raw: excerpt(match[1], 800),
      stderr: excerpt(result && result.stderr),
    });
  }
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) {
    throw new DomHarnessError('DOM facts 需要 JSON 对象', { code: 'E_EVAL_DOM_BAD_FACTS', raw: excerpt(match[1], 800) });
  }
  if (typeof facts.__error === 'string' && facts.__error) {
    throw new DomHarnessError('DOM 夹具内部异常：' + facts.__error, {
      code: 'E_EVAL_DOM_FIXTURE',
      stack: excerpt(facts.__stack, 1600),
      stderr: excerpt(result && result.stderr),
    });
  }
  return facts;
}

/** 读取点号路径（支持平铺字面 key 与嵌套对象）；缺失返回 undefined。 */
export function readFact(facts, dotted) {
  const key = String(dotted);
  if (facts && typeof facts === 'object' && Object.prototype.hasOwnProperty.call(facts, key)) return facts[key];
  let current = facts;
  for (const part of key.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function deepEqualValue(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((value, index) => deepEqualValue(value, b[index]));
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => deepEqualValue(a[key], b[key]));
}

function hasEvidence(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** 单 case 断言（纯函数，可单测）：facts 来自真实浏览器或注入。 */
export function evaluateDomCase(item, facts) {
  const checks = [];
  for (const [dotted, expected] of Object.entries(item.assert || {})) {
    const actual = readFact(facts, dotted);
    checks.push({
      id: item.id + ':' + dotted,
      ok: deepEqualValue(actual, expected),
      evidence: { path: dotted, expected, actual },
      evidenceRequired: true,
    });
  }
  for (const [dotted, needle] of Object.entries(item.contains || {})) {
    const actual = readFact(facts, dotted);
    const text = typeof actual === 'string' ? actual : JSON.stringify(actual);
    checks.push({
      id: item.id + ':' + dotted,
      ok: typeof text === 'string' && text.includes(String(needle)),
      evidence: { path: dotted, needle, actual },
      evidenceRequired: true,
    });
  }
  const unverified = [];
  const evidence = {};
  for (const dotted of Array.isArray(item.evidence) ? item.evidence : []) {
    const value = readFact(facts, dotted);
    if (!hasEvidence(value)) unverified.push({ id: item.id + ':' + dotted, reason: 'missing dom fact' });
    else evidence[dotted] = value;
  }
  return { checks, unverified, evidence };
}

/** 把单个 case 的断言结果归一化成与离线层一致的结果结构。 */
export function buildDomResult(item, evaluation, durationMs) {
  const verdict = judge({ checks: evaluation.checks, unverified: evaluation.unverified });
  return {
    id: item.id,
    title: item.title,
    layer: 'dom',
    source: item.source || null,
    capability: item.capability,
    oracleLevel: item.oracleLevel,
    expectedStatus: item.expectedStatus,
    status: verdict.status,
    checks: (verdict.items || []).map((check) => ({ ...check, ok: check.status === 'pass' })),
    unverified: verdict.unverified,
    evidence: evaluation.evidence,
    evidenceRule: item.evidenceRule,
    negative: item.negative === true,
    error: null,
    adapterCalls: [],
    cliCalls: [],
    counts: verdict.counts,
    durationMs,
  };
}

/** 对已取得的 facts 跑整层 DOM 语料（不启动浏览器，供单测/报告复用）。 */
export function evaluateDomLayer(cases, facts) {
  const startedAt = Date.now();
  return (Array.isArray(cases) ? cases : []).map((item) => buildDomResult(item, evaluateDomCase(item, facts), Date.now() - startedAt));
}

/**
 * 跑 DOM 层：真实 headless Chromium（tools/lib/overlay-dom-harness.mjs）→ facts → 三态。
 * @param {Array} cases dom 语料（已归一化）
 * @param {{ runPage?: Function, pagePath?: string, timeoutMs?: number, extractFacts?: Function }} [options]
 */
export async function runDomLayer(cases, options = {}) {
  if (!Array.isArray(cases)) throw new DomHarnessError('DOM 语料需要数组', { code: 'E_EVAL_DOM_ARGS' });
  if (!cases.length) return [];
  const pagePath = options.pagePath || DEFAULT_DOM_PAGE;
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 20000;
  let facts;
  if (typeof options.runPage === 'function') {
    const result = await options.runPage(pagePath, { timeoutMs });
    facts = typeof options.extractFacts === 'function' ? options.extractFacts(result) : extractDomFacts(result);
  } else {
    if (!findBrowser()) {
      throw new DomHarnessError('未找到 Edge/Chrome：DOM 层需要真实 headless 浏览器（设置 BRIDGE_EDGE/BRIDGE_CHROME 或安装 Edge）', {
        code: 'E_EVAL_DOM_NO_BROWSER',
        page: pagePath,
      });
    }
    let result;
    try {
      result = await runHeadlessPage(pagePath, { timeoutMs });
    } catch (error) {
      throw new DomHarnessError('启动 headless 浏览器失败：' + ((error && error.message) || error), {
        code: 'E_EVAL_DOM_SPAWN',
        page: pagePath,
      });
    }
    facts = extractDomFacts(result);
    if (typeof options.onFacts === 'function') options.onFacts(facts, result);
  }
  return evaluateDomLayer(cases, facts);
}

/** 报告器/调试用：相对仓库根的默认夹具路径。 */
export function domPagePath(root) {
  return path.join(root, DEFAULT_DOM_PAGE);
}
