/**
 * lib/eval-e2e.mjs —— 真实 E2E 结果解析 + eval 清单（含 capability/oracle level 元数据）派生。
 *
 * 兼容性：`parseE2EResults` 与 `summarizeCases(cases, results)` 的既有返回结构保持不变
 * （`{ checks, unverified }`），127 条 E2E eval 语料（tests/eval/cases/core.json）不需要改动。
 * 新增能力：
 * - `loadE2EManifest`：读取 core.json + tests/eval/cases/e2e-metadata.json，把每条 case 归一化成
 *   带 capability / oracleLevel / expectedStatus / evidenceRule 的结构；
 * - 元数据缺失时按标题确定性推导 capability（不静默丢 case，并在 warnings/fallbacks 里报告）；
 * - `summarizeCases` 的 checks/unverified 额外携带元数据，供报告器按能力面聚合与分类 fp/fn。
 */
import fs from 'node:fs';
import path from 'node:path';
import { inferCapability, CAPABILITIES, ORACLE_LEVELS, CorpusError } from './eval-e2e-corpus.mjs';
import { isExpectedStatus } from './eval-e2e-metrics.mjs';

export const DEFAULT_E2E_MANIFEST = 'tests/eval/cases/core.json';
export const DEFAULT_E2E_METADATA = 'tests/eval/cases/e2e-metadata.json';
export const E2E_METADATA_SCHEMA = 'bdeval-e2e-metadata/1';
export const DEFAULT_E2E_EVIDENCE_RULE = '真实 E2E 必须输出 "PASS <id>." 行；缺行 = unverified，FAIL = failed（unverified 绝不算 pass）';

/** 解析 E2E 输出里的 `PASS  23p3. detail` / `FAIL  35d. detail` 行（既有行为不变）。 */
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

function manifestEntry(raw) {
  if (typeof raw === 'string') return { id: raw, title: '' };
  if (raw && typeof raw === 'object') return { id: raw.id, title: raw.title || '' };
  return { id: null, title: '' };
}

/**
 * 归一化单条 E2E case。
 * @param {string|object} raw 清单条目（字符串或 {id,title}）
 * @param {object} [meta] e2e-metadata.json 里的对应条目
 */
export function normalizeE2ECase(raw, meta = {}) {
  const entry = manifestEntry(raw);
  if (typeof entry.id !== 'string' || !entry.id) throw new CorpusError('E2E eval case 缺少 id', { case: raw });
  const metadata = meta && typeof meta === 'object' ? meta : {};
  const capability = metadata.capability || (raw && raw.capability) || inferCapability(entry.id, entry.title);
  const oracleLevel = metadata.oracleLevel || (raw && raw.oracleLevel) || 'e2e-real';
  const expectedStatus = metadata.expectedStatus || (raw && raw.expectedStatus) || 'passed';
  const evidenceRule = metadata.evidenceRule || (raw && raw.evidenceRule) || DEFAULT_E2E_EVIDENCE_RULE;
  const problems = [];
  if (!CAPABILITIES[capability]) problems.push(entry.id + ': 未登记的 capability ' + capability);
  if (!ORACLE_LEVELS[oracleLevel]) problems.push(entry.id + ': 非法 oracleLevel ' + oracleLevel);
  if (!isExpectedStatus(expectedStatus)) problems.push(entry.id + ': 非法 expectedStatus ' + expectedStatus);
  return {
    id: entry.id,
    title: entry.title,
    layer: 'e2e',
    capability,
    oracleLevel,
    expectedStatus,
    evidenceRule,
    adversarial: metadata.adversarial === true || /adversarial/i.test(entry.title),
    metadataDeclared: Boolean(metadata.capability || metadata.oracleLevel || metadata.expectedStatus),
    problems,
  };
}

function readJson(filePath, label) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new CorpusError('读取 ' + label + ' 失败：' + filePath + '（' + (error && error.message) + '）', { file: filePath });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CorpusError(label + ' 不是合法 JSON：' + filePath + '（' + (error && error.message) + '）', { file: filePath });
  }
}

/** 读取元数据文件：支持 {cases:{id:meta}} 与 {id:meta} 两种形态。 */
export function loadE2EMetadata(metadataPath) {
  const data = readJson(metadataPath, 'E2E 元数据');
  const cases = data && typeof data === 'object' && data.cases && typeof data.cases === 'object' ? data.cases : data;
  if (!cases || typeof cases !== 'object' || Array.isArray(cases)) {
    throw new CorpusError('E2E 元数据需要 {cases:{id:meta}} 或 {id:meta}：' + metadataPath, { file: metadataPath });
  }
  return { schema: data && data.schema ? String(data.schema) : null, cases, file: metadataPath };
}

/**
 * 加载 E2E 清单 + 元数据，生成带元数据的 case 列表。
 * 兼容：元数据文件不存在或缺少某些 id 时回退确定性推导，并把数量写进 fallbacks。
 */
export function loadE2EManifest(options = {}) {
  const root = options.root || process.cwd();
  const manifestPath = path.isAbsolute(options.manifestPath || DEFAULT_E2E_MANIFEST)
    ? options.manifestPath
    : path.join(root, options.manifestPath || DEFAULT_E2E_MANIFEST);
  const metadataPath = path.isAbsolute(options.metadataPath || DEFAULT_E2E_METADATA)
    ? options.metadataPath
    : path.join(root, options.metadataPath || DEFAULT_E2E_METADATA);
  const manifest = readJson(manifestPath, 'E2E eval 清单');
  if (!Array.isArray(manifest) || !manifest.length) throw new CorpusError('E2E eval 清单需要非空数组：' + manifestPath, { file: manifestPath });
  const metadataExists = fs.existsSync(metadataPath);
  const metadata = metadataExists ? loadE2EMetadata(metadataPath) : { schema: null, cases: {}, file: metadataPath };
  const declaredIds = new Set(manifest.map((raw) => manifestEntry(raw).id).filter(Boolean));
  const warnings = [];
  for (const id of Object.keys(metadata.cases)) {
    if (!declaredIds.has(id)) warnings.push('元数据里有清单之外的 case：' + id);
  }
  const cases = [];
  const problems = [];
  let fallbacks = 0;
  const seen = new Set();
  for (const raw of manifest) {
    const entry = manifestEntry(raw);
    if (!entry.id) {
      problems.push('清单条目缺少 id：' + JSON.stringify(raw));
      continue;
    }
    if (seen.has(entry.id)) problems.push('清单 id 重复：' + entry.id);
    seen.add(entry.id);
    const meta = metadata.cases[entry.id];
    const normalized = normalizeE2ECase(raw, meta);
    if (!meta) fallbacks += 1;
    problems.push(...normalized.problems);
    cases.push(normalized);
  }
  if (problems.length) {
    throw new CorpusError('E2E eval 清单/元数据校验失败（' + problems.length + ' 项）：\n  - ' + problems.join('\n  - '), { problems });
  }
  return {
    manifestPath,
    metadataPath: metadataExists ? metadataPath : null,
    metadataSchema: metadata.schema,
    cases,
    fallbacks,
    warnings,
    total: cases.length,
  };
}

/**
 * 清单 → 元数据文件内容（`tools/eval-from-e2e.mjs --print-metadata` 用）。
 * 显式声明的元数据原样保留，缺失项按确定性规则补齐，便于把推导结果固化成文件再评审。
 */
export function buildE2EMetadataPayload(manifest) {
  const cases = {};
  for (const item of manifest.cases) {
    cases[item.id] = {
      capability: item.capability,
      oracleLevel: item.oracleLevel,
      expectedStatus: item.expectedStatus,
      evidenceRule: item.evidenceRule,
      ...(item.adversarial ? { adversarial: true } : {}),
    };
  }
  return {
    schema: E2E_METADATA_SCHEMA,
    source: path.basename(manifest.manifestPath),
    oracleLevel: 'e2e-real',
    count: manifest.cases.length,
    cases,
  };
}

function caseMeta(item) {
  const source = typeof item === 'string' ? { id: item } : item && typeof item === 'object' ? item : { id: null };
  return {
    id: source.id === undefined || source.id === null ? null : String(source.id),
    capability: source.capability || null,
    oracleLevel: source.oracleLevel || 'e2e-real',
    expectedStatus: source.expectedStatus || 'passed',
    evidenceRule: source.evidenceRule || DEFAULT_E2E_EVIDENCE_RULE,
  };
}

/**
 * 将 case 清单与 E2E 结果对照。
 * 既有返回：{ checks, unverified }；新增 entries（带三态与元数据，供指标/报告使用）。
 * 缺失 case 仍记为 unverified（缺行 ≠ pass）。
 */
export function summarizeCases(cases, results) {
  const checks = [];
  const unverified = [];
  const entries = [];
  for (const item of Array.isArray(cases) ? cases : []) {
    const meta = caseMeta(item);
    if (!meta.id) continue;
    const result = results.get(meta.id);
    if (!result) {
      const missing = { id: meta.id, reason: 'missing', ...meta };
      unverified.push(missing);
      entries.push({
        id: meta.id,
        title: typeof item === 'object' && item ? item.title || '' : '',
        layer: 'e2e',
        capability: meta.capability,
        oracleLevel: meta.oracleLevel,
        expectedStatus: meta.expectedStatus,
        status: 'unverified',
        checks: [],
        unverified: [{ id: meta.id, reason: 'missing' }],
        evidence: {},
        evidenceRule: meta.evidenceRule,
        detail: null,
      });
      continue;
    }
    const detail = typeof result.detail === 'string' ? result.detail : '';
    const check = { id: meta.id, ok: result.ok === true, detail, ...meta };
    checks.push(check);
    entries.push({
      id: meta.id,
      title: typeof item === 'object' && item ? item.title || '' : '',
      layer: 'e2e',
      capability: meta.capability,
      oracleLevel: meta.oracleLevel,
      expectedStatus: meta.expectedStatus,
      status: result.ok === true ? 'passed' : 'failed',
      checks: [{
        id: meta.id + ':e2e-line',
        ok: result.ok === true,
        evidence: { id: meta.id, line: (result.ok === true ? 'PASS' : 'FAIL') + ' ' + meta.id, detail },
        evidenceRequired: false,
      }],
      unverified: [],
      evidence: { detail },
      evidenceRule: meta.evidenceRule,
      detail,
    });
  }
  return { checks, unverified, entries };
}
