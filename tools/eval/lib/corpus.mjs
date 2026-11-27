/**
 * tools/eval/lib/corpus.mjs -- load, validate and run the invariant corpus.
 *
 * Corpus layout:
 *   tools/eval/corpus/index.mjs        manifest: which modules belong to the gate
 *   tools/eval/corpus/<area>.mjs       default export { area, title, properties }
 *
 * Loading is strict on purpose: duplicate property ids, missing generators,
 * missing `consumes` declarations and unresolvable `file:line` points are
 * infrastructure errors (exit code 2), not silent skips. The corpus is the
 * contract between the gate and the frozen tree.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runProperty } from './property.mjs';
import {
  ROOT,
  locatePropertySource,
  relativePosix,
  resolveConsumes,
  resolveRepoFile,
} from './source.mjs';
import { REQUIRED_AREAS } from './report.mjs';

export const CORPUS_MANIFEST = 'tools/eval/corpus/index.mjs';
/** Gate policy: minimum properties per required area. */
export const MIN_PROPERTIES_PER_AREA = 3;
/** Gate policy: minimum total property count. */
export const MIN_TOTAL_PROPERTIES = 40;

const AREA_PATTERN = /^[a-z][a-z0-9-]*$/;

function assertAreaModule(entry, index, { root }) {
  if (!entry || typeof entry !== 'object') throw new Error('corpus 清单第 ' + index + ' 项不是对象');
  const moduleFile = String(entry.module || '');
  if (!moduleFile.endsWith('.mjs')) throw new Error('corpus 清单项缺少 module .mjs 路径：' + String(entry.module));
  const absolute = resolveRepoFile(moduleFile, { root });
  const loaded = entry.loaded;
  if (!loaded || typeof loaded !== 'object') throw new Error('corpus 模块没有加载结果：' + moduleFile);
  const area = String(loaded.area || '');
  if (!AREA_PATTERN.test(area)) throw new Error('corpus area 名不合法：' + JSON.stringify(area) + '（' + moduleFile + '）');
  const properties = loaded.properties;
  if (!Array.isArray(properties) || properties.length === 0) {
    throw new Error('corpus area 没有 properties：' + area + '（' + moduleFile + '）');
  }
  return { moduleFile, absolute, loaded, area, properties };
}

/**
 * Load the corpus manifest and validate every property declaration.
 * @param {{manifestUrl?: URL|string, root?: string}} [options]
 * @returns {Promise<{root:string, manifest:string, areas:object[], properties:object[], modules:string[]}>}
 */
export async function loadCorpus({ manifestUrl = null, root = ROOT } = {}) {
  const manifestHref = manifestUrl === null
    ? pathToFileURL(path.resolve(root, CORPUS_MANIFEST)).href
    : (typeof manifestUrl === 'string' ? manifestUrl : manifestUrl.href);
  const manifestModule = await import(manifestHref);
  const rawAreas = manifestModule.AREAS || manifestModule.default;
  if (!Array.isArray(rawAreas) || rawAreas.length === 0) {
    throw new Error('corpus 清单没有导出 AREAS 数组：' + manifestHref);
  }
  const seenAreas = new Set();
  const seenIds = new Set();
  const areas = [];
  const properties = [];
  const modules = [];
  for (let index = 0; index < rawAreas.length; index += 1) {
    const entry = assertAreaModule(rawAreas[index], index, { root });
    if (seenAreas.has(entry.area)) throw new Error('corpus area 重复：' + entry.area);
    seenAreas.add(entry.area);
    modules.push(entry.moduleFile);
    const enriched = [];
    for (const property of entry.properties) {
      if (!property || typeof property !== 'object' || typeof property.check !== 'function' || !property.gen) {
        throw new Error('area ' + entry.area + ' 里有非法 property：' + JSON.stringify(property && property.id));
      }
      if (seenIds.has(property.id)) throw new Error('corpus property id 重复：' + property.id);
      seenIds.add(property.id);
      if (!Array.isArray(property.consumes) || property.consumes.length === 0) {
        throw new Error('property 没有 consumes 运行时消费点：' + property.id);
      }
      const located = locatePropertySource(entry.moduleFile, property.id, { root });
      if (!located) throw new Error('在 ' + entry.moduleFile + ' 找不到 property id 定义行：' + property.id);
      let resolvedConsumes;
      try {
        resolvedConsumes = resolveConsumes(property.consumes, { root, strict: true });
      } catch (error) {
        throw new Error('property ' + property.id + ' 的运行时消费点解析失败：' + String(error && error.message));
      }
      const frozen = Object.freeze({
        ...property,
        area: property.area || entry.area,
        source: located.location,
        consumes: Object.freeze(resolvedConsumes),
      });
      enriched.push(frozen);
      properties.push(frozen);
    }
    areas.push(Object.freeze({
      area: entry.area,
      title: String(entry.loaded.title || entry.area),
      module: entry.moduleFile,
      source: relativePosix(root, entry.absolute),
      properties: Object.freeze(enriched),
    }));
  }
  return Object.freeze({
    root,
    manifest: relativePosix(root, path.resolve(root, CORPUS_MANIFEST)),
    areas: Object.freeze(areas),
    properties: Object.freeze(properties),
    modules: Object.freeze(modules),
  });
}

/** Select properties by id / area / tag (single or arrays, all optional). */
export function selectProperties(corpus, {
  property = null,
  area = null,
  tag = null,
  properties = null,
  areas = null,
} = {}) {
  const wantedIds = Array.isArray(properties) && properties.length
    ? new Set(properties.map(String))
    : property
      ? new Set([String(property)])
      : null;
  const wantedAreas = Array.isArray(areas) && areas.length
    ? new Set(areas.map(String))
    : area
      ? new Set([String(area)])
      : null;
  return corpus.properties.filter((item) => {
    if (wantedIds && !wantedIds.has(item.id)) return false;
    if (wantedAreas && !wantedAreas.has(item.area)) return false;
    if (tag && !(item.tags || []).includes(tag)) return false;
    return true;
  });
}

/** Corpus shape summary for reports / CLI. */
export function corpusSummary(corpus) {
  return {
    areas: corpus.areas.map((entry) => ({
      area: entry.area,
      title: entry.title,
      source: entry.source,
      properties: entry.properties.length,
    })),
    properties: corpus.properties.length,
    modules: corpus.modules.length,
    consumes: new Set(corpus.properties.flatMap((item) => item.consumes.map((consume) => consume.location))).size,
  };
}

/**
 * Gate coverage policy check.
 * @returns {Array<{code:string, message:string, detail?:unknown}>}
 */
export function assertCorpusCoverage(corpus, {
  requiredAreas = REQUIRED_AREAS,
  minPerArea = MIN_PROPERTIES_PER_AREA,
  minTotal = MIN_TOTAL_PROPERTIES,
} = {}) {
  const issues = [];
  const byArea = new Map(corpus.areas.map((entry) => [entry.area, entry]));
  for (const area of requiredAreas) {
    const entry = byArea.get(area);
    if (!entry) {
      issues.push({ code: 'E_CORPUS_AREA_MISSING', message: 'corpus 缺少必需 area：' + area });
      continue;
    }
    if (entry.properties.length < minPerArea) {
      issues.push({
        code: 'E_CORPUS_AREA_THIN',
        message: 'area ' + area + ' 只有 ' + entry.properties.length + ' 个 property（至少 ' + minPerArea + '）',
      });
    }
  }
  if (corpus.properties.length < minTotal) {
    issues.push({
      code: 'E_CORPUS_TOO_SMALL',
      message: 'corpus 只有 ' + corpus.properties.length + ' 个 property（至少 ' + minTotal + '）',
    });
  }
  return issues;
}

/**
 * Run selected properties.
 *
 * @param {object} corpus result of loadCorpus
 * @param {{seed?:number|string, cases?:number, shrink?:boolean, property?:string, area?:string, tag?:string}} [options]
 * @returns {Promise<{results: object[], selected: object[], errors: object[]}>}
 */
export async function runCorpus(corpus, options = {}) {
  const selected = selectProperties(corpus, options);  const results = [];
  const errors = [];
  for (const property of selected) {
    try {
      const result = await runProperty(property, {
        seed: options.seed,
        cases: options.cases,
        shrink: options.shrink,
        maxShrinks: options.maxShrinks,
        maxCandidates: options.maxCandidates,
        maxFailures: options.maxFailures,
      });
      results.push(result);
    } catch (error) {
      errors.push({
        property: property.id,
        code: error && error.code ? String(error.code) : 'E_EVAL_RUN',
        message: String((error && error.message) || error),
      });
    }
  }
  return { results, selected, errors };
}
