#!/usr/bin/env node
// tools/release-preflight.mjs —— 发布前只读检查：一致性闸门 + 制品哈希 + 签名状态。
//
// 不签名、不上传；只把阻塞项列清楚。W4 起从“只看制品哈希”升级为四类硬一致性检查：
//   1) 版本一致性：package.json / extension/manifest.json / dist/release.json / 制品名
//   2) 协议版本：daemon/server.mjs 的 PROTOCOL_VERSION、lib/method-catalog 的
//      PROTOCOL_CURRENT/PROTOCOL_BASELINE、生成物 extension/src/generated/protocol.js
//   3) 方法面：方法总数（165）、生成物 METHODS、docs/PROTOCOL-METHODS.md 索引表/状态表
//   4) 特性门：FEATURE_FLOORS ↔ 生成物 FEATURE_MIN_PROTOCOL ↔ 文档特性门表（生成器产出）
//   5) 错误码/SDK 覆盖：lib/error-codes ↔ Node SDK ↔ Python SDK ↔ 扩展 KNOWN_CODES ↔
//      DSH 插件恢复映射；E_PROTOCOL_UNSUPPORTED 与其兼容别名 E_UNSUPPORTED_CAPABILITY 必须同时登记
//   6) 包体积一致性：release.json 制品 bytes/sha256、dist/SHA256SUMS、总体积/单制品上限
//
// 任一项漂移 → blocker → exit 1。一致性检查逻辑全部是导出函数（单测直接喂合成数据），
// 主流程只负责读文件 + spawn 既有门禁（vendor-leak / source-guard / 质量单测 / 性能预算）。
//
// 用法：
//   node tools/release-preflight.mjs            # 默认检查（等价 --check）
//   node tools/release-preflight.mjs --json     # 机器可读
//   node tools/release-preflight.mjs --key <pem>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DAEMON_ONLY_METHODS,
  FEATURE_FLOORS,
  FEATURE_META,
  FEATURE_NAMES,
  METHOD_COUNT,
  METHOD_FEATURE,
  METHOD_NAMES,
  OWNER_METHODS,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
} from '../lib/method-catalog.mjs';
import { ERROR_CODE_LIST, ERROR_CODES, ERROR_RECOVERY } from '../lib/error-codes.mjs';
import { LEGACY_CAPABILITY_UNSUPPORTED, PROTOCOL_UNSUPPORTED, PROTOCOL_UNSUPPORTED_ALIASES } from '../lib/protocol-features.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'dist', 'release.json');
const SHA_SUMS = path.join(ROOT, 'dist', 'SHA256SUMS');
const GENERATED_PROTOCOL = path.join(ROOT, 'extension', 'src', 'generated', 'protocol.js');
const METHODS_DOC = path.join(ROOT, 'docs', 'PROTOCOL-METHODS.md');
const SELF = fileURLToPath(import.meta.url);
const BRAND_SCAN = path.join(ROOT, 'tools', 'release-brand-scan.mjs');

/** 包体积上限：可被 BB_RELEASE_MAX_TOTAL_BYTES / BB_RELEASE_MAX_ARTIFACT_BYTES 覆盖。 */
export const PACKAGE_LIMITS = Object.freeze({
  minArtifacts: 6,
  maxTotalBytes: 300 * 1024 * 1024,
  maxArtifactBytes: 200 * 1024 * 1024,
});

export const SIGNATURE_ALGS = Object.freeze(['ed25519', 'hmac-sha256']);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJson(file) {
  const text = readText(file);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function list(value) {
  const items = [...new Set((Array.isArray(value) ? value : []).map((item) => String(item)))].sort();
  return { items, text: items.slice(0, 8).join(', ') + (items.length > 8 ? ' …(共 ' + items.length + ')' : '') };
}

function diff(expected, actual, label) {
  const left = list(expected);
  const right = list(actual);
  const missing = left.items.filter((item) => !right.items.includes(item));
  const extra = right.items.filter((item) => !left.items.includes(item));
  if (!missing.length && !extra.length) return null;
  return label + ' 漂移：缺 [' + list(missing).text + '] 多 [' + list(extra).text + ']';
}

function check(id, label, ok, detail, data) {
  return { id, label, ok: Boolean(ok), detail: ok ? (detail || 'ok') : detail, ...(data ? { data } : {}) };
}

/** 从任意源码文本提取 E_* 错误码集合。 */
export function extractErrorCodes(text) {
  return [...new Set(String(text || '').match(/\bE_[A-Z0-9_]+\b/g) || [])].sort();
}

/** 解析 docs/PROTOCOL-METHODS.md 的四张生成表（索引/特性门/状态机）。 */
export function parseMethodsDoc(text) {
  const source = String(text || '');
  const sections = source.split(/^## /m).slice(1).map((chunk) => {
    const lines = chunk.split('\n');
    return { title: (lines[0] || '').trim(), body: lines.slice(1).join('\n') };
  });
  const rowsOf = (section) => [...(section ? section.body : '').matchAll(/^\| `([^`]+)` \| ([^|]+) \| ([^|]+) \|/gm)]
    .map((match) => ({ name: match[1], col2: match[2].trim(), col3: match[3].trim() }));
  const find = (predicate) => sections.find((section) => predicate(section.title)) || null;
  const indexSections = sections.filter((section) => /方法（owner=/.test(section.title));
  const indexRows = indexSections.flatMap((section) => rowsOf(section));
  const state = find((title) => title.startsWith('方法状态机'));
  const features = find((title) => title.startsWith('特性门'));
  const local = find((title) => title.includes('owner=local'));
  const session = find((title) => title.includes('owner=session'));
  const instance = find((title) => title.includes('owner=instance'));
  return {
    indexNames: indexRows.map((row) => row.name),
    indexRows,
    stateNames: rowsOf(state).map((row) => row.name),
    featureRows: rowsOf(features).map((row) => ({ feature: row.name, floor: row.col2, label: row.col3 })),
    counts: {
      local: rowsOf(local).length,
      session: rowsOf(session).length,
      instance: rowsOf(instance).length,
    },
  };
}

/** 解析 dist/SHA256SUMS：name → sha256。 */
export function parseShaSums(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s{1,2}(.+?)\s*$/.exec(line);
    if (match) map.set(path.basename(match[2]), match[1].toLowerCase());
  }
  return map;
}

/** 解析 DSH 插件显式声明的自有错误码（PLUGIN_ONLY_CODES），它们不属于 daemon 协议码。 */
export function parsePluginOnlyCodes(text) {
  const match = /PLUGIN_ONLY_CODES\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(String(text || ''));
  return match ? extractErrorCodes(match[1]) : [];
}

// ---------------------------------------------------------------------------
// 一致性检查（纯函数；输入都是已读出的文本/对象，便于单测喂合成数据）
// ---------------------------------------------------------------------------

/** 1) 版本一致性：package = extension manifest = release.json = 制品名版本。 */
export function checkVersionConsistency({ packageVersion, extensionVersion, releaseVersion, artifactNames = [] } = {}) {
  const problems = [];
  if (!packageVersion) problems.push('package.json 缺少 version');
  if (!extensionVersion) problems.push('extension/manifest.json 缺少 version');
  if (!releaseVersion) problems.push('dist/release.json 缺少 version');
  for (const [label, value] of [['extension/manifest.json', extensionVersion], ['dist/release.json', releaseVersion]]) {
    if (value && packageVersion && String(value) !== String(packageVersion)) {
      problems.push(label + ' 版本 ' + value + ' ≠ package.json ' + packageVersion);
    }
  }
  const artifactVersions = new Set();
  for (const name of artifactNames) {
    const match = /(\d+\.\d+\.\d+)/.exec(String(name || ''));
    if (match) artifactVersions.add(match[1]);
  }
  if (artifactVersions.size > 1) problems.push('制品版本混合：' + [...artifactVersions].join(', '));
  if (artifactVersions.size === 1 && packageVersion && !artifactVersions.has(String(packageVersion))) {
    problems.push('制品名版本 ' + [...artifactVersions][0] + ' ≠ package.json ' + packageVersion);
  }
  if (!artifactNames.length) problems.push('release.json 没有 artifacts');
  return check('version.consistency', '版本一致性（package/extension/release/制品名）', problems.length === 0,
    problems.length ? problems.join('；') : 'package/extension/release/制品名 均为 ' + packageVersion,
    { packageVersion, extensionVersion, releaseVersion, artifactVersions: [...artifactVersions] });
}

/** 2) 协议版本一致性：daemon 握手常量、目录单源、生成物三处一致。 */
export function checkProtocolVersions({ daemonSource, catalogCurrent, catalogBaseline, generatedCurrent, generatedBaseline } = {}) {
  const problems = [];
  const match = /PROTOCOL_VERSION\s*=\s*['"](\d+(?:\.\d+)?)['"]/.exec(String(daemonSource || ''));
  const daemonVersion = match ? match[1] : null;
  if (!daemonVersion) problems.push('daemon/server.mjs 里找不到 PROTOCOL_VERSION 常量');
  if (daemonVersion && daemonVersion !== String(catalogCurrent)) {
    problems.push('daemon PROTOCOL_VERSION ' + daemonVersion + ' ≠ method-catalog PROTOCOL_CURRENT ' + catalogCurrent);
  }
  if (generatedCurrent === undefined) problems.push('生成物 protocol.js 缺少 PROTOCOL_CURRENT');
  else if (String(generatedCurrent) !== String(catalogCurrent)) {
    problems.push('生成物 PROTOCOL_CURRENT ' + generatedCurrent + ' ≠ 目录 ' + catalogCurrent);
  }
  if (generatedBaseline === undefined) problems.push('生成物 protocol.js 缺少 PROTOCOL_BASELINE');
  else if (String(generatedBaseline) !== String(catalogBaseline)) {
    problems.push('生成物 PROTOCOL_BASELINE ' + generatedBaseline + ' ≠ 目录 ' + catalogBaseline);
  }
  // 基线必须低于或等于当前协议，且同 major（同 major minor 偏斜是兼容模型的前提）。
  if (catalogBaseline && catalogCurrent) {
    const base = String(catalogBaseline).split('.').map(Number);
    const current = String(catalogCurrent).split('.').map(Number);
    if (base[0] !== current[0]) problems.push('兼容基线 major ' + catalogBaseline + ' 与当前协议 ' + catalogCurrent + ' 不同 major');
    if (base[1] > current[1]) problems.push('兼容基线 ' + catalogBaseline + ' 高于当前协议 ' + catalogCurrent);
  }
  return check('protocol.versions', '协议版本（daemon/目录/生成物）', problems.length === 0,
    problems.length ? problems.join('；') : 'daemon ' + daemonVersion + '、目录 ' + catalogCurrent + '（基线 ' + catalogBaseline + '）、生成物一致',
    { daemonVersion, catalogCurrent, catalogBaseline, generatedCurrent, generatedBaseline });
}

/** 3) 方法面：165 方法在目录/生成物/文档索引/状态表四处一致。 */
export function checkMethodSurface({ catalogCount, catalogNames, generatedCount, generatedNames, docs, daemonOnlyNames = [] } = {}) {
  const problems = [];
  if (catalogCount !== METHOD_COUNT) problems.push('目录方法数 ' + catalogCount + ' ≠ METHOD_COUNT ' + METHOD_COUNT);
  if (generatedCount !== catalogCount) problems.push('生成物 METHOD_COUNT ' + generatedCount + ' ≠ 目录 ' + catalogCount);
  if (Array.isArray(generatedNames) && generatedNames.length !== catalogCount) {
    problems.push('生成物 METHODS 长度 ' + generatedNames.length + ' ≠ 目录 ' + catalogCount);
  }
  const nameDiff = Array.isArray(generatedNames) ? diff(catalogNames, generatedNames, '生成物 METHODS') : '生成物缺少 METHODS 列表';
  if (nameDiff) problems.push(nameDiff);
  if (!docs || !Array.isArray(docs.indexNames)) {
    problems.push('缺少 docs/PROTOCOL-METHODS.md 索引表');
  } else {
    const expectedIndex = [...catalogNames, ...daemonOnlyNames];
    const indexDiff = diff(expectedIndex, docs.indexNames, '文档方法索引');
    if (indexDiff) problems.push(indexDiff);
    if (new Set(docs.indexNames).size !== docs.indexNames.length) problems.push('文档方法索引存在重复方法名');
    const stateDiff = diff(catalogNames, docs.stateNames || [], '文档方法状态机');
    if (stateDiff) problems.push(stateDiff);
    const expectedLocal = (OWNER_METHODS.local || []).length + daemonOnlyNames.length;
    const expectedSession = (OWNER_METHODS.session || []).length;
    const expectedInstance = (OWNER_METHODS.instance || []).length;
    if (docs.counts.local !== expectedLocal) problems.push('文档本地方法表 ' + docs.counts.local + ' 行 ≠ 期望 ' + expectedLocal);
    if (docs.counts.session !== expectedSession) problems.push('文档会话方法表 ' + docs.counts.session + ' 行 ≠ 期望 ' + expectedSession);
    if (docs.counts.instance !== expectedInstance) problems.push('文档实例方法表 ' + docs.counts.instance + ' 行 ≠ 期望 ' + expectedInstance);
    if (docs.indexNames.length !== expectedIndex.length) {
      problems.push('文档索引行数 ' + docs.indexNames.length + ' ≠ 期望 ' + expectedIndex.length + '（canonical + daemon-only）');
    }
  }
  return check('methods.surface', '方法面（目录/生成物/文档索引/状态机）', problems.length === 0,
    problems.length ? problems.join('；') : catalogCount + ' 方法（含 ' + daemonOnlyNames.length + ' 个 daemon-only）四处一致',
    { catalogCount, generatedCount, docsRows: docs ? docs.indexNames.length : null });
}

/** 4) 特性门：目录 floor ↔ 生成物 ↔ 文档特性门表（生成器产出）三方一致。 */
export function checkFeatureTable({ catalogFloors, catalogMeta, catalogMethods, generatedFloors, generatedFeatureNames, generatedMethods, docsFeatureRows, currentProtocol = PROTOCOL_CURRENT } = {}) {
  const problems = [];
  const expectedFeatures = [...FEATURE_NAMES];
  const floors = catalogFloors || FEATURE_FLOORS;
  const floorNames = Object.keys(floors);
  const featureDiff = diff(expectedFeatures, floorNames, '目录 FEATURE_FLOORS');
  if (featureDiff) problems.push(featureDiff);
  for (const feature of expectedFeatures) {
    const floor = String(floors[feature] || '');
    if (!/^\d+(?:\.\d+)?$/.test(floor)) { problems.push('特性 ' + feature + ' floor 非法：' + floor); continue; }
    const parsed = floor.split('.').map(Number);
    const current = String(currentProtocol).split('.').map(Number);
    if (parsed[0] !== current[0] || parsed[1] > current[1]) problems.push('特性 ' + feature + ' floor ' + floor + ' 高于当前协议 ' + currentProtocol);
  }
  if (generatedFloors && typeof generatedFloors === 'object') {
    const generatedDiff = diff(floorNames, Object.keys(generatedFloors), '生成物 FEATURE_MIN_PROTOCOL');
    if (generatedDiff) problems.push(generatedDiff);
    for (const feature of floorNames) {
      if (generatedFloors[feature] !== undefined && String(generatedFloors[feature]) !== String(floors[feature])) {
        problems.push('生成物特性 ' + feature + ' floor ' + generatedFloors[feature] + ' ≠ 目录 ' + floors[feature]);
      }
    }
  } else {
    problems.push('生成物缺少 FEATURE_MIN_PROTOCOL');
  }
  if (Array.isArray(generatedFeatureNames)) {
    const namesDiff = diff(expectedFeatures, generatedFeatureNames, '生成物 FEATURE_NAMES');
    if (namesDiff) problems.push(namesDiff);
  }
  if (generatedMethods && typeof generatedMethods === 'object') {
    const expectedMap = {};
    for (const [feature, meta] of Object.entries(catalogMeta || FEATURE_META)) {
      for (const method of meta.methods || []) expectedMap[method] = feature;
    }
    const mapDiff = diff(Object.keys(expectedMap), Object.keys(generatedMethods), '生成物 METHOD_FEATURE');
    if (mapDiff) problems.push(mapDiff);
    for (const method of Object.keys(expectedMap)) {
      if (generatedMethods[method] !== undefined && generatedMethods[method] !== expectedMap[method]) {
        problems.push('生成物方法级特性 ' + method + ' = ' + generatedMethods[method] + ' ≠ 目录 ' + expectedMap[method]);
      }
    }
    for (const method of Object.keys(generatedMethods)) {
      if (!(catalogMethods || METHOD_NAMES).includes(method)) problems.push('生成物方法级特性引用了目录外方法：' + method);
    }
  }
  if (!Array.isArray(docsFeatureRows)) {
    problems.push('缺少文档特性门表');
  } else {
    const expectedRows = expectedFeatures.map((feature) => ({
      feature,
      floor: String(floors[feature]),
      label: (catalogMeta || FEATURE_META)[feature] ? (catalogMeta || FEATURE_META)[feature].label : feature,
    }));
    if (docsFeatureRows.length !== expectedRows.length) {
      problems.push('文档特性门表 ' + docsFeatureRows.length + ' 行 ≠ 期望 ' + expectedRows.length);
    }
    for (const expected of expectedRows) {
      const row = docsFeatureRows.find((item) => item.feature === expected.feature);
      if (!row) { problems.push('文档特性门表缺少 ' + expected.feature); continue; }
      if (String(row.floor) !== expected.floor) problems.push('文档特性 ' + expected.feature + ' floor ' + row.floor + ' ≠ 目录 ' + expected.floor);
      if (row.label !== expected.label) problems.push('文档特性 ' + expected.feature + ' 标签 "' + row.label + '" ≠ 目录 "' + expected.label + '"');
    }
    for (const row of docsFeatureRows) {
      if (!expectedFeatures.includes(row.feature)) problems.push('文档特性门表多出 ' + row.feature);
    }
  }
  return check('features.table', '特性门表（目录/生成物/文档）', problems.length === 0,
    problems.length ? problems.join('；') : expectedFeatures.length + ' 个特性门三方一致（floor 全部 ' + currentProtocol + '）',
    { features: expectedFeatures.length });
}

/** 5) 错误码与 SDK 覆盖：注册表 ↔ Node SDK ↔ Python SDK ↔ 扩展 ↔ 插件恢复映射。 */
export function checkErrorCoverage({ registeredCodes, sdkNodeCodes, sdkPythonCodes, extensionCodes, pluginCodes, pluginOnlyCodes = [], recoveryKeys = [] } = {}) {
  const problems = [];
  const registered = [...new Set(registeredCodes || ERROR_CODE_LIST)].sort();
  if (!registered.length) problems.push('lib/error-codes.mjs 没有错误码');
  const requireSet = (label, codes, { subset = false, required = [], allow = [] } = {}) => {
    if (!Array.isArray(codes) || !codes.length) { problems.push(label + ' 未解析到错误码'); return; }
    const set = new Set(codes);
    const allowed = new Set(allow);
    const unknown = subset ? codes.filter((code) => !registered.includes(code) && !allowed.has(code)) : [];
    if (unknown.length) problems.push(label + ' 含未登记错误码：' + list(unknown).text);
    if (!subset) {
      const missing = registered.filter((code) => !set.has(code));
      if (missing.length) problems.push(label + ' 缺少错误码：' + list(missing).text);
    }
    for (const code of required) {
      if (!set.has(code)) problems.push(label + ' 缺少必需错误码 ' + code);
    }
  };
  requireSet('Node SDK（sdk/index.mjs）', sdkNodeCodes);
  requireSet('Python SDK（sdk/python/browser_bridge.py）', sdkPythonCodes);
  requireSet('扩展 KNOWN_CODES（extension/src/errors.js）', extensionCodes, { subset: true });
  // 插件有明确声明的 PLUGIN_ONLY_CODES（E_ABORTED/E_FAKE 是插件自有码，不属于 daemon 协议）。
  requireSet('DSH 插件恢复映射（dsh-plugin/lib/error-recovery.mjs）', pluginCodes, {
    subset: true,
    allow: pluginOnlyCodes,
    required: [PROTOCOL_UNSUPPORTED, LEGACY_CAPABILITY_UNSUPPORTED],
  });
  const unknownRecovery = (Array.isArray(recoveryKeys) ? recoveryKeys : []).filter((code) => !registered.includes(code));
  if (unknownRecovery.length) problems.push('ERROR_RECOVERY 含未登记错误码：' + list(unknownRecovery).text);
  return check('errors.coverage', '错误码与 SDK 覆盖（lib/Node/Python/扩展/插件）', problems.length === 0,
    problems.length ? problems.join('；') : registered.length + ' 个错误码五方覆盖一致（插件自有码 ' + pluginOnlyCodes.length + ' 个已声明）',
    { registered: registered.length, pluginOnly: pluginOnlyCodes });
}

/**
 * 6) 协议门禁接线：新码与兼容别名同时登记，daemon 派发点使用共享 assertProtocolCompatible，
 *    且 daemon 不再自己维护 featureShortfall 逻辑（防止“门禁只在库里、派发点没接”）。
 */
export function checkProtocolGateWiring({ registeredCodes, daemonSource, aliases = PROTOCOL_UNSUPPORTED_ALIASES } = {}) {
  const problems = [];
  const registered = new Set(registeredCodes || ERROR_CODE_LIST);
  if (!registered.has(PROTOCOL_UNSUPPORTED)) problems.push('错误码表缺少 ' + PROTOCOL_UNSUPPORTED);
  if (!registered.has(LEGACY_CAPABILITY_UNSUPPORTED)) problems.push('错误码表缺少兼容别名 ' + LEGACY_CAPABILITY_UNSUPPORTED);
  const aliasList = [...(aliases || [])];
  if (aliasList[0] !== PROTOCOL_UNSUPPORTED) problems.push('别名表首位必须是 ' + PROTOCOL_UNSUPPORTED + '，实际 ' + aliasList[0]);
  if (!aliasList.includes(LEGACY_CAPABILITY_UNSUPPORTED)) problems.push('别名表缺少 ' + LEGACY_CAPABILITY_UNSUPPORTED);
  const source = String(daemonSource || '');
  if (!source) problems.push('daemon/server.mjs 未读取到源码');
  else {
    if (!/assertProtocolCompatible\s*\(/.test(source)) problems.push('daemon 派发点没有使用 assertProtocolCompatible（协议门禁未接线）');
    if (/featureShortfall\s*\(\s*instance/.test(source)) problems.push('daemon 仍在手写 featureShortfall 判定（应与 lib/protocol-features 单源）');
    if (!/E_UNSUPPORTED_CAPABILITY/.test(source)) problems.push('daemon 丢失能力位旧码 E_UNSUPPORTED_CAPABILITY（兼容语义被删）');
  }
  return check('errors.protocol-gate', '协议门禁接线（新码 + 兼容别名 + daemon 派发点）', problems.length === 0,
    problems.length ? problems.join('；') : PROTOCOL_UNSUPPORTED + ' 与别名 ' + LEGACY_CAPABILITY_UNSUPPORTED + ' 已登记，daemon 使用共享闸门',
    { aliases: aliasList });
}

/**
 * 7) 制品与包体积一致性：存在/大小/sha256/签名/SHA256SUMS/体积上限。
 * @param {{manifest:object|null, actual:Array<{name:string,file:string,exists:boolean,bytes?:number,sha256?:string}>, shaSumsText?:string|null, limits?:object}} input
 */
export function checkArtifacts({ manifest, actual = [], shaSumsText = null, limits = PACKAGE_LIMITS } = {}) {
  const problems = [];
  const warnings = [];
  const artifacts = Array.isArray(actual) ? actual : [];
  const declared = manifest && Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  if (!manifest) problems.push('release.json 不存在或不是合法 JSON');
  if (!declared.length) problems.push('release.json 没有 artifacts');
  if (!artifacts.length) problems.push('没有可校验的制品');
  const totalBytes = artifacts.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
  for (const item of artifacts) {
    if (!item.exists) { problems.push('缺少制品：' + item.name); continue; }
    if (!Number.isFinite(item.bytes) || item.bytes <= 0) problems.push('制品为空：' + item.name);
    if (Number(item.bytes) > Number(limits.maxArtifactBytes)) {
      problems.push('制品超过单包体积上限：' + item.name + ' ' + item.bytes + 'B > ' + limits.maxArtifactBytes + 'B');
    }
  }
  if (artifacts.length < Number(limits.minArtifacts)) {
    problems.push('制品数量 ' + artifacts.length + ' 少于下限 ' + limits.minArtifacts);
  }
  if (totalBytes > Number(limits.maxTotalBytes)) {
    problems.push('发布包总体积 ' + totalBytes + 'B 超过上限 ' + limits.maxTotalBytes + 'B');
  }
  // 声明与实测逐项对齐（大小 + sha256）。
  for (const item of declared) {
    const name = item.name || path.basename(item.file || '');
    const found = artifacts.find((candidate) => candidate.name === name);
    if (!found || !found.exists) continue; // 缺制品已在上面报 blocker
    if (Number(item.bytes) !== Number(found.bytes)) {
      problems.push('大小不一致：' + name + ' 期望 ' + item.bytes + ' 实际 ' + found.bytes);
    }
    if (String(item.sha256 || '').toLowerCase() !== String(found.sha256 || '').toLowerCase()) {
      problems.push('sha256 不一致：' + name);
    }
  }
  // SHA256SUMS 与 release.json/实测三方对齐。
  const sums = parseShaSums(shaSumsText);
  if (shaSumsText == null) warnings.push('缺少 dist/SHA256SUMS（无法做第三方校验清单比对）');
  else {
    if (sums.size !== artifacts.length) problems.push('SHA256SUMS 条目 ' + sums.size + ' ≠ 制品数 ' + artifacts.length);
    for (const item of artifacts) {
      const recorded = sums.get(item.name);
      if (!recorded) { problems.push('SHA256SUMS 缺少 ' + item.name); continue; }
      if (String(recorded) !== String(item.sha256 || '').toLowerCase()) problems.push('SHA256SUMS 哈希不一致：' + item.name);
    }
    for (const name of sums.keys()) {
      if (!artifacts.some((item) => item.name === name)) problems.push('SHA256SUMS 多出不存在的制品：' + name);
    }
  }
  // 关键制品类型必须存在（防“少打一个平台包也能过”）。
  const required = [
    ['extension 包', /extension/i],
    ['dsh-plugin 包', /dsh-plugin/i],
    ['CLI bundle', /cli-bundle/i],
    ['Setup 安装器', /setup/i],
  ];
  for (const [label, pattern] of required) {
    if (!artifacts.some((item) => pattern.test(item.name))) problems.push('缺少' + label);
  }
  const platformCount = artifacts.filter((item) => /cli-\d/.test(item.name)).length;
  if (platformCount < 4) problems.push('CLI 平台制品只有 ' + platformCount + ' 个（至少 4 个平台）');
  // 签名。
  if (!manifest || !manifest.signature) problems.push('release.json 缺少签名（先运行 node tools/release.mjs --sign-ed25519 <key.pem>）');
  else if (!SIGNATURE_ALGS.includes(manifest.signature.alg)) problems.push('未知签名算法：' + manifest.signature.alg);
  return check('packages.consistency', '制品与包体积一致性（大小/sha256/SHA256SUMS/签名/上限）', problems.length === 0,
    problems.length ? problems.join('；') : artifacts.length + ' 个制品，总体积 ' + (totalBytes / 1024 / 1024).toFixed(1) + 'MB',
    { artifacts: artifacts.length, totalBytes, warnings });
}

// ---------------------------------------------------------------------------
// 读取真实仓库 → 汇总检查
// ---------------------------------------------------------------------------

async function importGenerated(file) {
  try {
    const stat = fs.statSync(file);
    const module = await import(pathToFileURL(file).href + '?mtime=' + stat.mtimeMs);
    return module;
  } catch {
    return null;
  }
}

/**
 * 收集全部一致性检查（不 spawn 外部门禁、不 exit），便于测试与复用。
 * @param {{root?:string}} [options]
 */
export async function collectChecks({ root = ROOT } = {}) {
  const dist = path.join(root, 'dist');
  const read = (relative) => readText(path.join(root, relative));
  const pkg = readJson(path.join(root, 'package.json')) || {};
  const extensionManifest = readJson(path.join(root, 'extension', 'manifest.json')) || {};
  const releaseManifest = readJson(path.join(dist, 'release.json'));
  const generated = await importGenerated(path.join(root, 'extension', 'src', 'generated', 'protocol.js'));
  const docsText = read(path.join('docs', 'PROTOCOL-METHODS.md'));
  const docs = docsText == null ? null : parseMethodsDoc(docsText);
  const daemonSource = read(path.join('daemon', 'server.mjs'));
  const sdkNodeText = read(path.join('sdk', 'index.mjs'));
  const sdkNodeBlock = (() => {
    const text = String(sdkNodeText || '');
    const begin = text.indexOf('// error-codes:begin');
    const end = text.indexOf('// error-codes:end');
    return begin >= 0 && end > begin ? text.slice(begin, end) : text;
  })();
  const sdkPythonText = read(path.join('sdk', 'python', 'browser_bridge.py'));
  const extensionErrorsText = read(path.join('extension', 'src', 'errors.js'));
  const pluginRecoveryText = read(path.join('dsh-plugin', 'lib', 'error-recovery.mjs'));
  const shaSumsText = read(path.join('dist', 'SHA256SUMS'));

  const artifactNames = (releaseManifest && Array.isArray(releaseManifest.artifacts) ? releaseManifest.artifacts : []).map((item) => item.name || '');
  const actual = (releaseManifest && Array.isArray(releaseManifest.artifacts) ? releaseManifest.artifacts : []).map((item) => {
    const file = path.resolve(root, item.file || '');
    const exists = fs.existsSync(file);
    return {
      name: item.name || path.basename(file),
      file,
      exists,
      ...(exists ? { bytes: fs.statSync(file).size, sha256: sha256(file) } : {}),
    };
  });

  const checks = [
    checkVersionConsistency({
      packageVersion: pkg.version,
      extensionVersion: extensionManifest.version,
      releaseVersion: releaseManifest && releaseManifest.version,
      artifactNames,
    }),
    checkProtocolVersions({
      daemonSource,
      catalogCurrent: PROTOCOL_CURRENT,
      catalogBaseline: PROTOCOL_BASELINE,
      generatedCurrent: generated ? generated.PROTOCOL_CURRENT : undefined,
      generatedBaseline: generated ? generated.PROTOCOL_BASELINE : undefined,
    }),
    checkMethodSurface({
      catalogCount: METHOD_COUNT,
      catalogNames: METHOD_NAMES,
      generatedCount: generated ? generated.METHOD_COUNT : NaN,
      generatedNames: generated ? generated.METHODS : null,
      daemonOnlyNames: DAEMON_ONLY_METHODS,
      docs,
    }),
    checkFeatureTable({
      catalogFloors: FEATURE_FLOORS,
      catalogMeta: FEATURE_META,
      catalogMethods: METHOD_NAMES,
      generatedFloors: generated ? generated.FEATURE_MIN_PROTOCOL : null,
      generatedFeatureNames: generated ? generated.FEATURE_NAMES : null,
      generatedMethods: generated ? generated.METHOD_FEATURE : null,
      docsFeatureRows: docs ? docs.featureRows : null,
      currentProtocol: PROTOCOL_CURRENT,
    }),
    checkErrorCoverage({
      registeredCodes: ERROR_CODE_LIST,
      sdkNodeCodes: extractErrorCodes(sdkNodeBlock),
      sdkPythonCodes: extractErrorCodes(sdkPythonText),
      extensionCodes: extractErrorCodes(extensionErrorsText),
      pluginCodes: extractErrorCodes(pluginRecoveryText),
      pluginOnlyCodes: parsePluginOnlyCodes(pluginRecoveryText),
      recoveryKeys: Object.keys(ERROR_RECOVERY),
    }),
    checkProtocolGateWiring({ registeredCodes: ERROR_CODE_LIST, daemonSource }),
    checkArtifacts({ manifest: releaseManifest, actual, shaSumsText }),
  ];
  return { checks, ok: checks.every((item) => item.ok) };
}

// ---------------------------------------------------------------------------
// 主流程：一致性检查 + 既有外部门禁（vendor/源码/质量单测/性能预算）+ 制品报告
// ---------------------------------------------------------------------------

function runChild(name, args, options = {}) {
  const run = spawnSync(process.execPath, args, { cwd: options.cwd || ROOT, encoding: 'utf8', timeout: options.timeout || 300000 });
  return { name, ok: run.status === 0, status: run.status, stderr: String(run.stderr || '').split('\n')[0], stdout: String(run.stdout || '') };
}

/** 外部门禁（全部是既有 gate，本工具只调用、不修改其语义）。 */
export function runExternalGates({ root = ROOT } = {}) {
  const gates = [];
  const add = (name, args) => {
    gates.push(runChild(name, args));
  };
  add('vendor-leak', [path.join(root, 'tools', 'check-vendor-leak.mjs')]);
  add('source-guard', [path.join(root, 'tools', 'source-guard.mjs')]);
  for (const file of ['architecture-guards.test.mjs', 'performance-budgets.test.mjs', 'fault-injection.test.mjs', 'method-catalog.test.mjs']) {
    add('quality:' + file, ['--test', path.join(root, 'tests', 'unit', file)]);
  }
  add('performance-budget', [path.join(root, 'tools', 'performance-budget.mjs'), '--json']);
  return gates;
}

export function parseArgs(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  const options = { json: false, check: true, keyPath: process.env.BB_RELEASE_PRIVATE_KEY || '', root: ROOT };
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index]);
    if (arg === '--json') options.json = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--key') {
      options.keyPath = args[index + 1] || '';
      index += 1;
    } else if (arg.startsWith('--key=')) options.keyPath = arg.slice('--key='.length);
    else if (arg === '--root') {
      options.root = path.resolve(String(args[index + 1] || ROOT));
      index += 1;
    } else if (arg.startsWith('--root=')) options.root = path.resolve(arg.slice('--root='.length));
    else if (arg === '-h' || arg === '--help') options.help = true;
    else throw new Error('未知参数：' + arg);
  }
  return options;
}

function printUsage() {
  return `发布前检查（只读）

用法：
  node tools/release-preflight.mjs [--json] [--key <pem>] [--root <dir>]

检查：版本/协议版本/方法面/特性门表/错误码与 SDK/协议门禁接线/制品与包体积
外部门禁：vendor-leak、source-guard（含协议生成物同步）、质量单测、性能预算`;
}

/** 汇总结果 → 可读报告（纯函数）。 */
export function formatPreflight(result) {
  const lines = [];
  lines.push('release preflight v' + (result.version || '?'));
  lines.push('一致性检查：');
  for (const item of result.checks || []) {
    lines.push('  ' + (item.ok ? '[ok]' : '[!!]') + ' ' + item.id.padEnd(22) + (item.ok ? item.label : item.label + '：' + item.detail));
  }
  lines.push('外部门禁：');
  for (const gate of result.gates || []) {
    lines.push('  ' + (gate.ok ? '[ok]' : '[!!]') + ' ' + gate.name + (gate.ok ? '' : '（' + (gate.stderr || 'status ' + gate.status) + '）'));
  }
  lines.push('release 制品：');
  for (const artifact of result.artifacts || []) {
    lines.push('  ' + (artifact.exists && artifact.hashMatch ? '[ok]' : '[!!]') + ' ' + artifact.name + ' ' + (artifact.bytes || 0) + 'B');
  }
  for (const warning of result.warnings || []) lines.push('  warn: ' + warning);
  for (const blocker of result.blockers || []) lines.push('  blocker: ' + blocker);
  lines.push(result.ok ? 'PREFLIGHT PASS' : 'PREFLIGHT BLOCKED');
  return lines.join('\n');
}

/** 主流程（返回退出码，便于测试调用）。 */
export async function main(argv = [], io = {}) {
  {
    const brand = spawnSync(process.execPath, [BRAND_SCAN], { cwd: ROOT, encoding: 'utf8' });
    if (brand.status !== 0) {
      console.error((brand.stdout || '') + (brand.stderr || ''));
      console.error('BLOCKER: 发布范围存在品牌字眼');
      return 1;
    }
  }
  const stdout = io.stdout || ((text) => process.stdout.write(text + '\n'));
  const stderr = io.stderr || ((text) => process.stderr.write(text + '\n'));
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stderr(String((error && error.message) || error));
    return 2;
  }
  if (options.help) { stdout(printUsage()); return 0; }

  const collected = await collectChecks({ root: options.root });
  const blockers = [];
  const warnings = [];
  for (const item of collected.checks) if (!item.ok) blockers.push(item.id + '：' + item.detail);
  for (const item of collected.checks) for (const warning of (item.data && item.data.warnings) || []) warnings.push(item.id + '：' + warning);

  let gates = [];
  try {
    gates = runExternalGates({ root: options.root });
  } catch (error) {
    blockers.push('外部门禁执行失败：' + String((error && error.message) || error));
  }
  for (const gate of gates) if (!gate.ok) blockers.push('外部门禁失败：' + gate.name);

  const manifest = readJson(path.join(options.root, 'dist', 'release.json'));
  const artifactRows = (manifest && Array.isArray(manifest.artifacts) ? manifest.artifacts : []).map((item) => {
    const file = path.resolve(options.root, item.file || '');
    return {
      name: item.name || path.basename(file),
      file: item.file,
      version: item.version || null,
      exists: fs.existsSync(file),
      bytes: fs.existsSync(file) ? fs.statSync(file).size : 0,
      hashMatch: fs.existsSync(file) ? String(item.sha256 || '').toLowerCase() === sha256(file) : false,
    };
  });

  if (options.keyPath) {
    if (!fs.existsSync(options.keyPath)) blockers.push('私钥不存在：' + options.keyPath);
    else {
      try {
        const key = crypto.createPrivateKey(fs.readFileSync(options.keyPath));
        if (key.asymmetricKeyType !== 'ed25519') warnings.push('私钥不是 Ed25519：' + key.asymmetricKeyType);
      } catch (error) {
        blockers.push('私钥无法解析：' + ((error && error.message) || error));
      }
    }
  }

  const result = {
    ok: blockers.length === 0,
    version: manifest && manifest.version,
    generatedAt: manifest && manifest.generatedAt,
    signed: Boolean(manifest && manifest.signature),
    checks: collected.checks,
    gates: gates.map((gate) => ({ name: gate.name, ok: gate.ok, status: gate.status })),
    artifacts: artifactRows,
    warnings,
    blockers,
  };
  if (options.json) stdout(JSON.stringify(result, null, 2));
  else stdout(formatPreflight(result));
  return result.ok ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isMain = invokedPath.toLowerCase() === SELF.toLowerCase();
if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((error) => {
    console.error(String((error && error.message) || error));
    process.exit(1);
  });
}
