// packages/protocol/scripts/gen.mjs —— 从 JS 单一源生成 TypeScript 单源模块。
//
// 单一源原则（docs/ARCH-TRACK.md §4 / docs/上游-PARITY-PROGRAM.md §3）：
//   lib/method-catalog.mjs  →  extension/src/generated/protocol.js   （既有 JS 生成物）
//                           →  packages/protocol/src/generated.ts    （本脚本，协议目录）
//   lib/schemas.mjs         →  extension/src/generated/protocol.js   （METHOD_SCHEMA_KEYS / PARAM_ALIASES）
//                           →  packages/protocol/src/generated-schemas.ts（本脚本，schema 单源）
// 生成物只允许由本脚本产出：手改生成物会在 `--check` 下立刻漂移失败。
//
// 用法：
//   node packages/protocol/scripts/gen.mjs            # 重写两份生成物
//   node packages/protocol/scripts/gen.mjs --check    # 只校验，干净 exit 0，漂移 exit 1
//   node packages/protocol/scripts/gen.mjs --help
//
// 生成前会校验 JS 源自身的五维状态不变量（复用 lib/method-catalog.mjs 的
// validateMethodStates 以及本脚本的交叉检查：特性门反向表、收敛目标只读、owner 分桶
// 覆盖等），并校验 schema 单源自洽（覆盖、信封派生、required 引用、别名映射、
// schemaDriftReport.ok）。源不合法时拒绝生成，避免把坏数据固化进 TS 栈。

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(PACKAGE_DIR, '..', '..');
const CATALOG_PATH = join(REPO_ROOT, 'lib', 'method-catalog.mjs');
const SCHEMAS_PATH = join(REPO_ROOT, 'lib', 'schemas.mjs');
const OUTPUT_PATH = join(PACKAGE_DIR, 'src', 'generated.ts');
const SCHEMAS_OUTPUT_PATH = join(PACKAGE_DIR, 'src', 'generated-schemas.ts');

const BANNER = [
  '// AUTO-GENERATED FILE — DO NOT EDIT.',
  '//',
  '// 源：lib/method-catalog.mjs（165 canonical 方法 / 9 feature floor / 五维状态）',
  '// 生成器：packages/protocol/scripts/gen.mjs',
  '// 重生成：node packages/protocol/scripts/gen.mjs',
  '// 漂移校验：node packages/protocol/scripts/gen.mjs --check',
  '//',
  '// 本文件是 TS 栈的协议数据单源投影；任何语义改动都必须落在 JS 单一源后重新生成。',
];

const SCHEMAS_BANNER = [
  '// AUTO-GENERATED FILE — DO NOT EDIT.',
  '//',
  '// 源：lib/schemas.mjs（方法参数 schema 单源：137 方法 / 公共请求信封键 / camelCase 参数别名）',
  '// 生成器：packages/protocol/scripts/gen.mjs',
  '// 重生成：node packages/protocol/scripts/gen.mjs',
  '// 漂移校验：node packages/protocol/scripts/gen.mjs --check',
  '//',
  '// 本文件是 TS 栈的 schema 数据单源投影；schema 语义只允许改 lib/schemas.mjs 后重新生成。',
];


/** 稳定 JSON：对象键排序、数组保序，保证同一份源永远得到同一签名。 */
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalJson(item)).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** 目录签名：覆盖所有被生成的数据，源漂移必然改签名。 */
function signatureOf(snapshot) {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

function fail(message) {
  const error = new Error(message);
  error.code = 'E_PROTOCOL_GEN';
  throw error;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 从 lib/method-catalog.mjs 收集一份纯数据快照（签名与渲染都基于它）。
 * @param {string} [catalogPath] 允许测试指向同一份源的副本（默认仓库内单一源）
 */
export async function buildSnapshot(catalogPath = CATALOG_PATH) {
  const moduleUrl = pathToFileURL(catalogPath).href;
  const catalog = await import(moduleUrl);
  const snapshot = collectSnapshot(catalog);
  validateSnapshot(snapshot, catalog);
  const signature = signatureOf(snapshot);
  return { snapshot, signature, catalogPath };
}

/** 把模块导出投影成纯 JSON 数据（不保留 frozen/函数）。 */
function collectSnapshot(catalog) {
  const methodNames = plain(catalog.METHOD_NAMES);
  const states = {};
  for (const row of catalog.METHOD_CATALOG) {
    states[row.method] = {
      owner: row.owner,
      effect: row.effect,
      partial: row.partial,
      unknown: row.unknown,
      reconcile: {
        strategy: row.reconcile.strategy,
        method: row.reconcile.method || null,
      },
    };
  }
  return {
    methodCount: catalog.METHOD_COUNT,
    methodNames,
    sortedMethodNames: plain(catalog.SORTED_METHOD_NAMES),
    protocolBaseline: catalog.PROTOCOL_BASELINE,
    protocolCurrent: catalog.PROTOCOL_CURRENT,
    featureNames: plain(catalog.FEATURE_NAMES),
    featureFloors: plain(catalog.FEATURE_FLOORS),
    featureMeta: plain(catalog.FEATURE_META),
    featureMethods: plain(catalog.FEATURE_METHODS),
    methodFeature: plain(catalog.METHOD_FEATURE),
    featureParamRules: plain(catalog.FEATURE_PARAM_RULES),
    receiptEffects: plain(catalog.RECEIPT_EFFECTS),
    mutatingOverrides: plain(catalog.MUTATING_OVERRIDES),
    requestEnvelopeKeys: plain(catalog.REQUEST_ENVELOPE_KEYS),
    partialMethods: plain(catalog.PARTIAL_METHODS),
    reconcileStrategies: plain(catalog.RECONCILE_STRATEGIES),
    reconcileDefault: plain(catalog.RECONCILE_DEFAULT),
    reconcileOverrides: plain(catalog.RECONCILE_OVERRIDES),
    daemonOnlyMethods: plain(catalog.DAEMON_ONLY_METHODS),
    catalog: plain(catalog.METHOD_CATALOG),
    methodEffectTable: plain(catalog.METHOD_EFFECT_TABLE),
    methodOwnerTable: plain(catalog.METHOD_OWNER_TABLE),
    methodFeatureFloor: plain(catalog.METHOD_FEATURE_FLOOR),
    ownerMethods: plain(catalog.OWNER_METHODS),
    daemonMethods: plain(catalog.DAEMON_METHODS),
    extensionMethods: plain(catalog.EXTENSION_METHODS),
    states,
  };
}

/**
 * 生成前校验：单一源必须自洽。任何一条失败都拒绝生成（避免坏数据进 TS 栈）。
 */
export function validateSnapshot(snapshot, catalog) {
  const errors = [];
  const push = (message) => errors.push(message);

  // 1) JS 源自己的五维状态不变量。
  const stateErrors = typeof catalog.validateMethodStates === 'function'
    ? catalog.validateMethodStates()
    : [];
  for (const message of stateErrors) push('源状态不变量：' + message);

  // 2) 方法名唯一且和目录行数量一致。
  const nameSet = new Set(snapshot.methodNames);
  if (nameSet.size !== snapshot.methodNames.length) push('方法名有重复');
  if (snapshot.methodCount !== snapshot.methodNames.length) {
    push('METHOD_COUNT=' + snapshot.methodCount + ' 与名称数量 ' + snapshot.methodNames.length + ' 不一致');
  }
  if (snapshot.catalog.length !== snapshot.methodCount) {
    push('目录行数 ' + snapshot.catalog.length + ' 与 METHOD_COUNT ' + snapshot.methodCount + ' 不一致');
  }

  // 3) 五维状态覆盖每个方法，且与方法目录逐字段一致。
  const stateNames = Object.keys(snapshot.states);
  if (stateNames.length !== snapshot.methodNames.length) {
    push('状态表数量 ' + stateNames.length + ' 与名称数量 ' + snapshot.methodNames.length + ' 不一致');
  }
  for (const name of snapshot.methodNames) {
    if (!snapshot.states[name]) push('方法缺少状态行：' + name);
  }
  for (const row of snapshot.catalog) {
    const state = snapshot.states[row.method];
    if (!state) continue;
    if (row.owner !== state.owner) push(row.method + ' 目录 owner 与状态表不一致');
    if (row.effect !== state.effect) push(row.method + ' 目录 effect 与状态表不一致');
    if (row.partial !== state.partial) push(row.method + ' 目录 partial 与状态表不一致');
    if (row.unknown !== state.unknown) push(row.method + ' 目录 unknown 与状态表不一致');
    if (row.reconcile.strategy !== state.reconcile.strategy) push(row.method + ' 目录 reconcile 与状态表不一致');
    if ((row.reconcile.method || null) !== state.reconcile.method) push(row.method + ' 目录 reconcile 目标与状态表不一致');
  }

  // 4) 特性门：名称、floor、元数据、反向方法表必须闭合。
  const featureSet = new Set(snapshot.featureNames);
  if (featureSet.size !== snapshot.featureNames.length) push('特性门名称有重复');
  if (snapshot.featureNames.join(',') !== Object.keys(snapshot.featureFloors).join(',')) {
    push('FEATURE_NAMES 与 FEATURE_FLOORS 键顺序不一致');
  }
  for (const feature of snapshot.featureNames) {
    const floor = snapshot.featureFloors[feature];
    if (typeof floor !== 'string' || !/^\d+\.\d+$/.test(floor)) {
      push('特性门 ' + feature + ' 的 floor 非法：' + String(floor));
    }
    const meta = snapshot.featureMeta[feature];
    if (!meta) {
      push('特性门缺少元数据：' + feature);
      continue;
    }
    for (const method of meta.methods) {
      if (!nameSet.has(method)) push('特性门 ' + feature + ' 引用了未知方法：' + method);
      if (snapshot.methodFeature[method] !== feature) {
        push('方法 ' + method + ' 的特性门反向表不是 ' + feature);
      }
    }
    if (snapshot.featureMethods[feature].join(',') !== meta.methods.join(',')) {
      push('特性门 ' + feature + ' 的反向方法表与元数据不一致');
    }
  }
  const declaredMethodFeatures = Object.values(snapshot.featureMeta)
    .reduce((total, meta) => total + meta.methods.length, 0);
  if (Object.keys(snapshot.methodFeature).length !== declaredMethodFeatures) {
    push('METHOD_FEATURE 条目数 ' + Object.keys(snapshot.methodFeature).length
      + ' 与方法级特性总数 ' + declaredMethodFeatures + ' 不一致');
  }

  // 5) 参数规则：特性必须存在，作用域方法必须存在。
  for (const rule of snapshot.featureParamRules) {
    if (!featureSet.has(rule.feature)) push('参数规则引用了未知特性：' + rule.feature);
    if (!['true', 'defined', 'non-empty-array'].includes(rule.kind)) {
      push('参数规则 ' + rule.feature + '/' + rule.param + ' kind 非法：' + rule.kind);
    }
    for (const method of rule.methods || []) {
      if (!nameSet.has(method)) push('参数规则 ' + rule.feature + ' 作用域引用了未知方法：' + method);
    }
  }

  // 6) 收敛策略：覆盖必须是目录内方法，status 目标必须是只读方法。
  for (const [method, value] of Object.entries(snapshot.reconcileOverrides)) {
    if (!nameSet.has(method)) push('收敛覆盖引用了未知方法：' + method);
    const [strategy, target] = String(value).split(':');
    if (!snapshot.reconcileStrategies.includes(strategy)) {
      push(method + ' 收敛策略非法：' + strategy);
    }
    if (strategy === 'status') {
      if (!target) push(method + ' 的 status 收敛缺少目标方法');
      else if (!nameSet.has(target)) push(method + ' 的收敛目标不在目录：' + target);
    }
    if (snapshot.states[method] && snapshot.states[method].reconcile.strategy !== strategy) {
      push(method + ' 的收敛覆盖与状态表不一致');
    }
    if (snapshot.states[method] && (snapshot.states[method].reconcile.method || null) !== (target || null)) {
      push(method + ' 的收敛目标与状态表不一致');
    }
  }
  for (const effect of snapshot.receiptEffects) {
    if (!(effect in snapshot.reconcileDefault)) push('回执 effect 缺少默认收敛策略：' + effect);
  }
  for (const method of snapshot.mutatingOverrides) {
    if (!nameSet.has(method)) push('变异覆盖引用了未知方法：' + method);
  }

  // 7) owner 分桶必须恰好覆盖全量方法。
  const bucketNames = [
    ...snapshot.ownerMethods.local,
    ...snapshot.ownerMethods.session,
    ...snapshot.ownerMethods.instance,
  ];
  if (bucketNames.length !== snapshot.methodCount) {
    push('owner 分桶数量 ' + bucketNames.length + ' 与方法总数 ' + snapshot.methodCount + ' 不一致');
  }
  for (const name of snapshot.methodNames) {
    if (!bucketNames.includes(name)) push('方法未进入任何 owner 分桶：' + name);
  }
  for (const bucket of ['local', 'session', 'instance']) {
    for (const name of snapshot.ownerMethods[bucket]) {
      if (snapshot.states[name] && snapshot.states[name].owner !== bucket) {
        push(name + ' 出现在错误的 owner 分桶：' + bucket);
      }
    }
  }
  if (snapshot.daemonMethods.length !== snapshot.ownerMethods.local.length + snapshot.daemonOnlyMethods.length) {
    push('DAEMON_METHODS 数量与 local + daemon-only 不一致');
  }
  if (snapshot.extensionMethods.length !== snapshot.ownerMethods.session.length + snapshot.ownerMethods.instance.length) {
    push('EXTENSION_METHODS 数量与 session + instance 不一致');
  }

  // 8) 派生表必须与目录一致（防止 JS 侧派生逻辑漂移）。
  for (const row of snapshot.catalog) {
    if (snapshot.methodEffectTable[row.method] !== row.effect) push(row.method + ' effect 派生表不一致');
    if (snapshot.methodOwnerTable[row.method] !== row.owner) push(row.method + ' owner 派生表不一致');
    if (row.floor) {
      if (snapshot.methodFeatureFloor[row.method] !== row.floor) push(row.method + ' floor 派生表不一致');
    } else if (row.method in snapshot.methodFeatureFloor) {
      push(row.method + ' 无特性门却在 floor 派生表里');
    }
  }

  // 9) 协议版本必须可比较且 current >= baseline。
  const versionPattern = /^(\d+)\.(\d+)$/;
  const baselineMatch = versionPattern.exec(snapshot.protocolBaseline);
  const currentMatch = versionPattern.exec(snapshot.protocolCurrent);
  if (!baselineMatch) push('PROTOCOL_BASELINE 非法：' + snapshot.protocolBaseline);
  if (!currentMatch) push('PROTOCOL_CURRENT 非法：' + snapshot.protocolCurrent);
  if (baselineMatch && currentMatch) {
    const baselineRank = Number(baselineMatch[1]) * 1000 + Number(baselineMatch[2]);
    const currentRank = Number(currentMatch[1]) * 1000 + Number(currentMatch[2]);
    if (currentRank < baselineRank) push('PROTOCOL_CURRENT 低于 PROTOCOL_BASELINE');
  }

  if (errors.length) {
    fail('lib/method-catalog.mjs 未通过生成前校验（' + errors.length + ' 项）：\n  - ' + errors.join('\n  - '));
  }
}

// ---------------------------------------------------------------------------
// schema 单源（lib/schemas.mjs → src/generated-schemas.ts）
// ---------------------------------------------------------------------------

/**
 * 从 lib/schemas.mjs 收集 schema 快照（签名与渲染都基于它）。
 * @param {string} [schemasPath] 允许测试指向同一份源的副本（默认仓库内单一源）
 */
export async function buildSchemaSnapshot(schemasPath = SCHEMAS_PATH) {
  const moduleUrl = pathToFileURL(schemasPath).href;
  const schemasModule = await import(moduleUrl);
  const catalogModule = await import(pathToFileURL(CATALOG_PATH).href);
  const snapshot = collectSchemaSnapshot(schemasModule);
  validateSchemaSnapshot(snapshot, { extensionMethods: plain(catalogModule.EXTENSION_METHODS) });
  const signature = signatureOf(snapshot);
  return { snapshot, signature, schemasPath };
}

/** 把 schema 模块导出投影成纯 JSON 数据（不保留 frozen/函数）。 */
function collectSchemaSnapshot(schemasModule) {
  const schemas = plain(schemasModule.METHOD_SCHEMAS);
  const envelopeKeys = plain(schemasModule.ENVELOPE_SCHEMA_KEYS);
  const keyTable = plain(schemasModule.buildSchemaKeyTable());
  const aliases = plain(schemasModule.buildParamAliases());
  const coverage = plain(schemasModule.schemaCoverageSummary());
  const drift = plain(schemasModule.schemaDriftReport());
  const methodNames = Object.keys(schemas);
  // 信封字段的 schema 定义：lib/schemas.mjs 内部的 ENVELOPE_PROPERTY_SCHEMAS 未导出，
  // 这里从各方法 schema 里按同一个键反查，并要求所有出现处逐字节一致（否则拒绝生成）。
  const envelopeProperties = {};
  for (const key of envelopeKeys) {
    const occurrences = [];
    for (const method of methodNames) {
      const properties = schemas[method] && schemas[method].properties;
      if (properties && properties[key] !== undefined) occurrences.push({ method, schema: properties[key] });
    }
    if (!occurrences.length) fail('信封键 ' + key + ' 在所有方法 schema 中都没有定义');
    const canonical = canonicalJson(occurrences[0].schema);
    for (const occurrence of occurrences) {
      if (canonicalJson(occurrence.schema) !== canonical) {
        fail('信封键 ' + key + ' 在 ' + occurrences[0].method + ' 与 ' + occurrence.method + ' 的 schema 定义不一致');
      }
    }
    envelopeProperties[key] = occurrences[0].schema;
  }
  return {
    methodCount: methodNames.length,
    methodNames,
    envelopeKeys,
    envelopeProperties,
    schemas,
    schemaKeyTable: keyTable,
    paramAliases: aliases,
    coverage,
    drift,
  };
}

/**
 * 生成前校验 schema 单源自洽。任何一条失败都拒绝生成。
 * @param {object} snapshot collectSchemaSnapshot 的返回值
 * @param {{extensionMethods?: string[], allowedExtraSchemas?: string[]}} [options]
 *        extensionMethods 省略时跳过“扩展方法覆盖/未知方法”这两项交叉校验。
 */
export function validateSchemaSnapshot(snapshot, options = {}) {
  const errors = [];
  const push = (message) => errors.push(message);
  const methods = snapshot.methodNames;
  const methodSet = new Set(methods);
  const allowedExtra = new Set(options.allowedExtraSchemas || ['status', 'browsers']);

  // 1) 方法名唯一，且与派生表数量一致。
  if (methodSet.size !== methods.length) push('schema 方法名有重复');
  if (!methods.length) push('schema 表为空');
  if (Object.keys(snapshot.schemaKeyTable).length !== methods.length) {
    push('schemaKeyTable 条目数 ' + Object.keys(snapshot.schemaKeyTable).length + ' 与方法数 ' + methods.length + ' 不一致');
  }
  if (snapshot.coverage.schemas !== methods.length) {
    push('coverage.schemas=' + snapshot.coverage.schemas + ' 与方法数 ' + methods.length + ' 不一致');
  }
  // 1b) 与扩展方法集的交叉校验（extensionMethods 省略时跳过）。
  const extensionMethods = Array.isArray(options.extensionMethods)
    ? options.extensionMethods.map((method) => String(method))
    : null;
  if (extensionMethods) {
    const extensionSet = new Set(extensionMethods);
    const present = extensionMethods.filter((method) => methodSet.has(method));
    const missing = extensionMethods.filter((method) => !methodSet.has(method)).sort();
    const withoutEnvelope = present
      .filter((method) => {
        const properties = (snapshot.schemas[method] && snapshot.schemas[method].properties) || {};
        return !snapshot.envelopeKeys.every((key) => key in properties);
      })
      .sort();
    if (snapshot.coverage.methods !== extensionMethods.length) {
      push('coverage.methods=' + snapshot.coverage.methods + ' 与扩展方法数 ' + extensionMethods.length + ' 不一致');
    }
    if (snapshot.coverage.covered !== present.length) {
      push('coverage.covered=' + snapshot.coverage.covered + ' 与已覆盖方法数 ' + present.length + ' 不一致');
    }
    if ((snapshot.coverage.missing || []).join(',') !== missing.join(',')) {
      push('coverage.missing 与扩展方法集不一致：' + missing.join(', '));
    }
    if ((snapshot.coverage.withoutEnvelope || []).join(',') !== withoutEnvelope.join(',')) {
      push('coverage.withoutEnvelope 与 schema 实际缺字段不一致');
    }
    const expectedUnknown = methods
      .filter((method) => !extensionSet.has(method) && !allowedExtra.has(method))
      .sort();
    if ((snapshot.drift.unknownSchemas || []).join(',') !== expectedUnknown.join(',')) {
      push('drift.unknownSchemas 与 schema 表不一致：' + expectedUnknown.join(', '));
    }
    if (snapshot.drift.methods !== extensionMethods.length) {
      push('drift.methods=' + snapshot.drift.methods + ' 与扩展方法数不一致');
    }
  }

  // 2) 每个 schema 的结构与 key 表/别名表一致。
  for (const method of methods) {
    const schema = snapshot.schemas[method];
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
      push(method + ' schema 不是对象');
      continue;
    }
    if (schema.type !== 'object') push(method + ' schema.type 不是 object');
    const properties = schema.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
      push(method + ' schema.properties 缺失或类型错误');
      continue;
    }
    for (const [key, value] of Object.entries(properties)) {
      if (!key) push(method + ' schema 存在空字段名');
      if (!value || typeof value !== 'object' || Array.isArray(value)) push(method + '.' + key + ' 属性不是对象');
    }
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!(key in properties)) push(method + ' required 引用了未声明字段：' + key);
    }
    const row = snapshot.schemaKeyTable[method];
    if (!row) {
      push(method + ' 缺少 key 表条目');
      continue;
    }
    const expectedProperties = Object.keys(properties).sort();
    if (row.properties.join(',') !== expectedProperties.join(',')) push(method + ' key 表 properties 与 schema 不一致');
    const expectedRequired = (Array.isArray(schema.required) ? [...schema.required] : []).sort();
    if (row.required.join(',') !== expectedRequired.join(',')) push(method + ' key 表 required 与 schema 不一致');
    const aliases = snapshot.paramAliases[method];
    if (aliases) {
      for (const [snake, camel] of Object.entries(aliases)) {
        if (!(camel in properties)) push(method + ' 别名 ' + snake + ' 指向未声明字段 ' + camel);
        if (!/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(snake)) push(method + ' 别名 ' + snake + ' 不是 snake_case');
        const derived = camel.replace(/[A-Z]/g, (char) => '_' + char.toLowerCase());
        if (derived !== snake) push(method + ' 别名 ' + snake + ' 与 ' + camel + ' 的换形规则不一致');
      }
    } else if (Object.keys(properties).some((key) => /[A-Z]/.test(key))) {
      push(method + ' 有驼峰字段但别名表缺失');
    }
  }
  for (const method of Object.keys(snapshot.paramAliases)) {
    if (!methodSet.has(method)) push('别名表引用了未知方法：' + method);
  }
  for (const method of Object.keys(snapshot.schemaKeyTable)) {
    if (!methodSet.has(method)) push('key 表引用了未知方法：' + method);
  }

  // 3) 信封键来源与派生一致。
  if (snapshot.envelopeKeys.join(',') !== snapshot.coverage.envelope.join(',')) {
    push('ENVELOPE_SCHEMA_KEYS 与 coverage.envelope 不一致');
  }
  for (const key of snapshot.envelopeKeys) {
    if (!snapshot.envelopeProperties[key]) push('信封键缺少属性 schema：' + key);
  }
  for (const key of Object.keys(snapshot.envelopeProperties)) {
    if (!snapshot.envelopeKeys.includes(key)) push('信封属性表含未声明键：' + key);
  }

  // 4) schemaDriftReport 必须 clean（unknownSchemas 允许非空：daemon 侧 transfer.* / session.*
  //    等 schema 不在扩展方法集里，属于正常形态；其一致性已在 1b 里交叉校验）。
  if (snapshot.drift.ok !== true) push('schemaDriftReport.ok=false：' + (snapshot.drift.problems || []).join('；'));
  if ((snapshot.drift.problems || []).length) push('schemaDriftReport 有问题：' + snapshot.drift.problems.join('；'));
  if (snapshot.drift.derived.schemaKeys !== methods.length) {
    push('drift.derived.schemaKeys=' + snapshot.drift.derived.schemaKeys + ' 与方法数不一致');
  }
  if (snapshot.drift.derived.paramAliases !== Object.keys(snapshot.paramAliases).length) {
    push('drift.derived.paramAliases 与别名表数量不一致');
  }
  const propertyCount = Object.values(snapshot.schemaKeyTable)
    .reduce((sum, row) => sum + row.properties.length, 0);
  if (snapshot.coverage.propertyCount !== propertyCount) {
    push('coverage.propertyCount 与 key 表字段总数不一致');
  }
  if (snapshot.coverage.aliasedMethods !== Object.keys(snapshot.paramAliases).length) {
    push('coverage.aliasedMethods 与别名表数量不一致');
  }

  if (errors.length) {
    fail('lib/schemas.mjs 未通过生成前校验（' + errors.length + ' 项）：\n  - ' + errors.join('\n  - '));
  }
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

/** TS 单引号字符串字面量。 */
function quote(value) {
  return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

/** 数组字面量：短则一行，长则每项一行（决定论输出，便于 diff）。 */
function arrayLiteral(items, indent = '') {
  const tokens = items.map((item) => (typeof item === 'string' ? quote(item) : String(item)));
  const inline = '[' + tokens.join(', ') + ']';
  if (indent.length + inline.length <= 116) return inline;
  const pad = indent + '  ';
  return '[\n' + tokens.map((token) => pad + token + ',').join('\n') + '\n' + indent + ']';
}

/** 对象字面量（键按传入顺序）。 */
function recordLiteral(entries, indent = '') {
  const lines = entries.map(([key, value]) => indent + '  ' + key + ': ' + value + ',');
  return '{\n' + lines.join('\n') + '\n' + indent + '}';
}

function booleanText(value) {
  return value ? 'true' : 'false';
}

function nullableQuote(value) {
  return value ? quote(value) : 'null';
}

function reconcileLiteral(reconcile) {
  return '{ strategy: ' + quote(reconcile.strategy) + ', method: ' + nullableQuote(reconcile.method) + ' }';
}

/**
 * 渲染完整的 generated.ts 文本。导出给测试用（测试断言“文件内容 == 重渲染结果”，
 * 因此不存在手改生成物还能过测试的路径）。
 */
export function renderProtocolModule(snapshot, signature) {
  const lines = [];
  const push = (line = '') => lines.push(line);

  for (const line of BANNER) push(line);
  push('//');
  push('// 目录签名：sha256:' + signature);
  push('// 统计：' + snapshot.methodCount + ' 方法 / ' + snapshot.featureNames.length + ' 特性门 / '
    + snapshot.catalog.filter((row) => row.partial).length + ' partial / '
    + snapshot.catalog.filter((row) => row.unknown).length + ' unknown / '
    + Object.keys(snapshot.methodFeature).length + ' 方法级特性');
  push('');
  push("import type { CatalogRow, FeatureMeta, FeatureParamRule, MethodEffect, MethodOwner, MethodState, ReconcileStrategy } from './types.ts';");
  push('');

  push('/** 目录签名：sha256(canonical snapshot)，用于与 JS 单源做漂移比对。 */');
  push('export const CATALOG_SIGNATURE = ' + quote('sha256:' + signature) + ';');
  push('');
  push('export const PROTOCOL_BASELINE = ' + quote(snapshot.protocolBaseline) + ';');
  push('export const PROTOCOL_CURRENT = ' + quote(snapshot.protocolCurrent) + ';');
  push('export const METHOD_COUNT = ' + snapshot.methodCount + ';');
  push('');

  // MethodName
  push('export type MethodName =');
  snapshot.methodNames.forEach((name, index) => {
    push('  | ' + quote(name) + (index === snapshot.methodNames.length - 1 ? ';' : ''));
  });
  push('');
  push('export const METHOD_NAMES: readonly MethodName[] = '
    + arrayLiteral(snapshot.methodNames) + ';');
  push('export const METHOD_NAMES_SORTED: readonly MethodName[] = '
    + arrayLiteral(snapshot.sortedMethodNames) + ';');
  push('');

  // Feature names / floors
  push('export type FeatureName =');
  snapshot.featureNames.forEach((name, index) => {
    push('  | ' + quote(name) + (index === snapshot.featureNames.length - 1 ? ';' : ''));
  });
  push('');
  push('export const FEATURE_NAMES: readonly FeatureName[] = '
    + arrayLiteral(snapshot.featureNames) + ';');
  push('');
  push('/** 特性门 → 对端扩展至少需要的协议版本（唯一源）。 */');
  push('export const FEATURE_FLOORS: Readonly<Record<FeatureName, string>> = {');
  for (const feature of snapshot.featureNames) {
    push('  ' + quote(feature) + ': ' + quote(snapshot.featureFloors[feature]) + ',');
  }
  push('};');
  push('');

  // Feature meta
  push('/** 特性元数据：由什么触发、人类可读标签。 */');
  push('export const FEATURE_META: Readonly<Record<FeatureName, FeatureMeta>> = {');
  for (const feature of snapshot.featureNames) {
    const meta = snapshot.featureMeta[feature];
    push('  ' + quote(feature) + ': { label: ' + quote(meta.label)
      + ', kind: ' + quote(meta.kind)
      + ', params: ' + arrayLiteral(meta.params, '  ') 
      + ', methods: ' + arrayLiteral(meta.methods, '  ') + ' },');
  }
  push('};');
  push('');

  // Feature -> methods
  push('/** 特性门 → 方法（按目录顺序）。 */');
  push('export const FEATURE_METHODS: Readonly<Record<FeatureName, readonly MethodName[]>> = {');
  for (const feature of snapshot.featureNames) {
    push('  ' + quote(feature) + ': ' + arrayLiteral(snapshot.featureMethods[feature], '  ') + ',');
  }
  push('};');
  push('');

  // Method -> feature
  push('/** 方法 → 方法级特性门（由 FEATURE_META.methods 反向派生）。 */');
  push('export const METHOD_FEATURE: Readonly<Partial<Record<MethodName, FeatureName>>> = {');
  for (const method of snapshot.methodNames) {
    const feature = snapshot.methodFeature[method];
    if (!feature) continue;
    push('  ' + quote(method) + ': ' + quote(feature) + ',');
  }
  push('};');
  push('');

  // Param rules
  push('/** 参数级特性门：满足参数形态即要求该特性。 */');
  push('export const FEATURE_PARAM_RULES: readonly FeatureParamRule[] = [');
  for (const rule of snapshot.featureParamRules) {
    let text = '  { feature: ' + quote(rule.feature) + ', param: ' + quote(rule.param)
      + ', kind: ' + quote(rule.kind);
    if (rule.methods) text += ', methods: ' + arrayLiteral(rule.methods, '  ');
    push(text + ' },');
  }
  push('];');
  push('');

  // Receipt / mutating / envelope
  push('/** 需要回执（意图账本）的 effect。 */');
  push('export const RECEIPT_EFFECTS: readonly MethodEffect[] = '
    + arrayLiteral(snapshot.receiptEffects) + ';');
  push('');
  push('/** 历史遗留：少量 control_plane 方法仍要预写意图账本。 */');
  push('export const MUTATING_OVERRIDES: readonly MethodName[] = '
    + arrayLiteral(snapshot.mutatingOverrides) + ';');
  push('');
  push('/** daemon 注入的公共请求信封字段。 */');
  push('export const REQUEST_ENVELOPE_KEYS: readonly string[] = '
    + arrayLiteral(snapshot.requestEnvelopeKeys) + ';');
  push('');

  // Partial / reconcile
  push('/** 结果可能被截断/分页/分段的方法。 */');
  push('export const PARTIAL_METHODS: readonly MethodName[] = '
    + arrayLiteral(snapshot.partialMethods) + ';');
  push('');
  push('export const RECONCILE_STRATEGIES: readonly ReconcileStrategy[] = '
    + arrayLiteral(snapshot.reconcileStrategies) + ';');
  push('');
  push('/** effect → 默认收敛策略（覆盖优先）。 */');
  push('export const RECONCILE_DEFAULT: Readonly<Record<MethodEffect, ReconcileStrategy>> = {');
  for (const [effect, strategy] of Object.entries(snapshot.reconcileDefault)) {
    push('  ' + quote(effect) + ': ' + quote(strategy) + ',');
  }
  push('};');
  push('');
  push('/** 方法级收敛覆盖；status 形态为 "status:<只读方法>"。 */');
  push('export const RECONCILE_OVERRIDES: Readonly<Partial<Record<MethodName, string>>> = {');
  for (const [method, value] of Object.entries(snapshot.reconcileOverrides)) {
    push('  ' + quote(method) + ': ' + quote(value) + ',');
  }
  push('};');
  push('');

  // Five-dim states
  push('/** 五维状态表（与方法目录同序）：owner / effect / partial / unknown / reconcile。 */');
  push('export const METHOD_STATES: Readonly<Record<MethodName, MethodState<MethodName>>> = {');
  for (const method of snapshot.methodNames) {
    const state = snapshot.states[method];
    push('  ' + quote(method) + ': { owner: ' + quote(state.owner)
      + ', effect: ' + quote(state.effect)
      + ', partial: ' + booleanText(state.partial)
      + ', unknown: ' + booleanText(state.unknown)
      + ', reconcile: ' + reconcileLiteral(state.reconcile) + ' },');
  }
  push('};');
  push('');

  // Catalog rows
  push('/** 方法目录：方法名 + 五维状态 + receipt/floor 派生位。 */');
  push('export const METHOD_CATALOG: readonly CatalogRow<MethodName>[] = [');
  for (const row of snapshot.catalog) {
    push('  { method: ' + quote(row.method)
      + ', owner: ' + quote(row.owner)
      + ', effect: ' + quote(row.effect)
      + ', receipt: ' + booleanText(row.receipt)
      + ', floor: ' + nullableQuote(row.floor)
      + ', partial: ' + booleanText(row.partial)
      + ', unknown: ' + booleanText(row.unknown)
      + ', reconcile: ' + reconcileLiteral(row.reconcile) + ' },');
  }
  push('];');
  push('');

  // Tables
  push('export const METHOD_EFFECT_TABLE: Readonly<Record<MethodName, MethodEffect>> = {');
  for (const method of snapshot.methodNames) {
    push('  ' + quote(method) + ': ' + quote(snapshot.states[method].effect) + ',');
  }
  push('};');
  push('');
  push('export const METHOD_OWNER_TABLE: Readonly<Record<MethodName, MethodOwner>> = {');
  for (const method of snapshot.methodNames) {
    push('  ' + quote(method) + ': ' + quote(snapshot.states[method].owner) + ',');
  }
  push('};');
  push('');
  push('export const METHOD_FEATURE_FLOOR: Readonly<Partial<Record<MethodName, string>>> = {');
  for (const method of snapshot.methodNames) {
    const floor = snapshot.methodFeatureFloor[method];
    if (!floor) continue;
    push('  ' + quote(method) + ': ' + quote(floor) + ',');
  }
  push('};');
  push('');
  push('export const METHOD_PARTIAL: readonly MethodName[] = '
    + arrayLiteral(snapshot.catalog.filter((row) => row.partial).map((row) => row.method)) + ';');
  push('export const METHOD_UNKNOWN: readonly MethodName[] = '
    + arrayLiteral(snapshot.catalog.filter((row) => row.unknown).map((row) => row.method)) + ';');
  push('');

  // Owner buckets
  push('/** owner → 方法（按目录顺序）。 */');
  push('export const OWNER_METHODS: Readonly<Record<MethodOwner, readonly MethodName[]>> = {');
  for (const bucket of ['local', 'session', 'instance']) {
    push('  ' + quote(bucket) + ': ' + arrayLiteral(snapshot.ownerMethods[bucket], '  ') + ',');
  }
  push('};');
  push('');
  push('/** daemon 内部生命周期/账本方法：不进入扩展 wire 协议，不计入 canonical 方法数。 */');
  push('export const DAEMON_ONLY_METHODS: readonly string[] = '
    + arrayLiteral(snapshot.daemonOnlyMethods) + ';');
  push('export const DAEMON_METHODS: readonly string[] = '
    + arrayLiteral(snapshot.daemonMethods) + ';');
  push('export const EXTENSION_METHODS: readonly MethodName[] = '
    + arrayLiteral(snapshot.extensionMethods) + ';');
  push('');

  return lines.join('\n');
}

/** 单行 JSON 字面量（用于判断能否内联）；不可内联（含非有限数/函数）返回 null。 */
function inlineJsonLiteral(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = [];
    for (const item of value) {
      const text = inlineJsonLiteral(item);
      if (text == null) return null;
      parts.push(text);
    }
    return '[' + parts.join(', ') + ']';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    const parts = [];
    for (const key of keys) {
      const text = inlineJsonLiteral(value[key]);
      if (text == null) return null;
      parts.push(quote(key) + ': ' + text);
    }
    return '{ ' + parts.join(', ') + ' }';
  }
  return null;
}

/**
 * JSON 值 → TS 字面量（键一律加引号；短结构内联、长结构逐层缩进）。
 * 同一份快照永远渲染成同一段文本，因此 `--check` 只需要逐字符比较。
 */
function jsonLiteral(value, indent = '') {
  if (value === null) return 'null';
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('schema 快照含非有限数字：' + String(value));
    return String(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    const inline = inlineJsonLiteral(value);
    if (inline != null && indent.length + inline.length <= 110) return inline;
    const pad = indent + '  ';
    if (Array.isArray(value)) {
      if (!value.length) return '[]';
      return '[\n' + value.map((item) => pad + jsonLiteral(item, pad) + ',').join('\n') + '\n' + indent + ']';
    }
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    return '{\n'
      + keys.map((key) => pad + quote(key) + ': ' + jsonLiteral(value[key], pad) + ',').join('\n')
      + '\n' + indent + '}';
  }
  fail('schema 快照含不可渲染值：' + String(value));
}

/**
 * 渲染完整的 generated-schemas.ts 文本。导出给测试用（测试断言“文件内容 == 重渲染结果”，
 * 因此不存在手改生成物还能过测试的路径）。
 */
export function renderSchemaModule(snapshot, signature) {
  const lines = [];
  const push = (line = '') => lines.push(line);
  const propertyCount = Object.values(snapshot.schemaKeyTable)
    .reduce((sum, row) => sum + row.properties.length, 0);

  for (const line of SCHEMAS_BANNER) push(line);
  push('//');
  push('// schema 目录签名：sha256:' + signature);
  push('// 统计：' + snapshot.methodCount + ' 方法 schema / ' + snapshot.envelopeKeys.length + ' 信封键 / '
    + Object.keys(snapshot.paramAliases).length + ' 方法含别名 / ' + propertyCount + ' 参数键');
  push('');
  push("import type { JsonSchema, SchemaCoverageSummary, SchemaKeyRow } from './schema-types.ts';");
  push('');
  push('/** schema 目录签名：sha256(canonical snapshot)，用于与 JS 单源做漂移比对。 */');
  push('export const SCHEMA_SIGNATURE = ' + quote('sha256:' + signature) + ';');
  push('');
  push('export const SCHEMA_METHOD_COUNT = ' + snapshot.methodCount + ';');
  push('');
  push('/** 请求公共信封键（来自 lib/method-catalog.mjs 的 REQUEST_ENVELOPE_KEYS）。 */');
  push('export const ENVELOPE_SCHEMA_KEYS: readonly string[] = '
    + arrayLiteral(snapshot.envelopeKeys) + ';');
  push('');
  push('/** 信封键 → 参数 schema（未单列方法的通用校验用；所有出现处定义必须一致）。 */');
  push('export const ENVELOPE_PROPERTY_SCHEMAS: Readonly<Record<string, JsonSchema>> = {');
  for (const key of snapshot.envelopeKeys) {
    push('  ' + quote(key) + ': ' + jsonLiteral(snapshot.envelopeProperties[key], '  ') + ',');
  }
  push('};');
  push('');
  push('/** 有显式 schema 的方法名（索引签名与调用方补全用）。 */');
  push('export type SchemaMethodName =');
  snapshot.methodNames.forEach((name, index) => {
    push('  | ' + quote(name) + (index === snapshot.methodNames.length - 1 ? ';' : ''));
  });
  push('');
  push('/** 方法 → {required, properties} 的 key 表（两个数组均已排序，决定论输出）。 */');
  push('export const METHOD_SCHEMA_KEYS: Readonly<Record<SchemaMethodName, SchemaKeyRow>> = {');
  for (const method of snapshot.methodNames) {
    const row = snapshot.schemaKeyTable[method];
    push('  ' + quote(method) + ': { required: ' + arrayLiteral(row.required, '  ')
      + ', properties: ' + arrayLiteral(row.properties, '  ') + ' },');
  }
  push('};');
  push('');
  push('/** camelCase → snake_case 参数别名（只列有驼峰字段的方法）。 */');
  push('export const PARAM_ALIASES: Readonly<Partial<Record<SchemaMethodName, Readonly<Record<string, string>>>>> = {');
  for (const method of snapshot.methodNames) {
    const aliases = snapshot.paramAliases[method];
    if (!aliases) continue;
    const entries = Object.entries(aliases);
    const inline = '  ' + quote(method) + ': { '
      + entries.map(([snake, camel]) => quote(snake) + ': ' + quote(camel)).join(', ') + ' },';
    if (inline.length <= 116) {
      push(inline);
      continue;
    }
    push('  ' + quote(method) + ': {');
    for (const [snake, camel] of entries) push('    ' + quote(snake) + ': ' + quote(camel) + ',');
    push('  },');
  }
  push('};');
  push('');
  push('/** 全量方法 schema（验证器与漂移审计共用同一份数据，不在 TS 侧重写语义）。 */');
  push('export const METHOD_SCHEMAS: Readonly<Record<SchemaMethodName, JsonSchema>> = {');
  for (const method of snapshot.methodNames) {
    push('  ' + quote(method) + ': ' + jsonLiteral(snapshot.schemas[method], '  ') + ',');
  }
  push('};');
  push('');
  push('/** schema 覆盖摘要（生成时快照；运行时可直接读，不需要重算派生表）。 */');
  push('export const SCHEMA_COVERAGE: Readonly<SchemaCoverageSummary> = {');
  push('  methods: ' + snapshot.coverage.methods + ',');
  push('  schemas: ' + snapshot.coverage.schemas + ',');
  push('  covered: ' + snapshot.coverage.covered + ',');
  push('  missing: ' + arrayLiteral(snapshot.coverage.missing) + ',');
  push('  withoutEnvelope: ' + arrayLiteral(snapshot.coverage.withoutEnvelope) + ',');
  push('  validatedMethods: ' + snapshot.coverage.validatedMethods + ',');
  push('  propertyCount: ' + snapshot.coverage.propertyCount + ',');
  push('  aliasedMethods: ' + snapshot.coverage.aliasedMethods + ',');
  push('  envelope: ' + arrayLiteral(snapshot.coverage.envelope) + ',');
  push('};');
  push('');
  return lines.join('\n');
}

/** 一行 diff 摘要：返回首个差异行号（1 基）与上下文。 */
export function describeDrift(expected, actual) {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const total = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < total; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      return {
        line: index + 1,
        expected: expectedLines[index] === undefined ? '<文件已结束>' : expectedLines[index],
        actual: actualLines[index] === undefined ? '<文件已结束>' : actualLines[index],
        expectedCount: expectedLines.length,
        actualCount: actualLines.length,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = [
  '用法：node packages/protocol/scripts/gen.mjs [--check]',
  '',
  '  （无参数）   重新生成两份单源投影：',
  '               packages/protocol/src/generated.ts         （来自 lib/method-catalog.mjs）',
  '               packages/protocol/src/generated-schemas.ts （来自 lib/schemas.mjs）',
  '  --check      只校验生成物是否与单源一致；全部一致 exit 0（输出 clean），任一漂移 exit 1',
  '  --help       显示本帮助',
].join('\n');

/** 校验单个生成物是否与重渲染结果逐字符一致；返回是否一致（漂移时打印首个差异）。 */
function checkGenerated(label, expected, outputPath) {
  let current;
  try {
    current = readFileSync(outputPath, 'utf8');
  } catch {
    console.error('protocol gen: 生成物不存在：' + label + '（先运行 node packages/protocol/scripts/gen.mjs）');
    return false;
  }
  if (current === expected) return true;
  const drift = describeDrift(expected, current);
  console.error('protocol gen: 生成物漂移（' + label + '）' + (drift ? '，首个差异在第 ' + drift.line + ' 行' : ''));
  if (drift) {
    console.error('  期望: ' + drift.expected);
    console.error('  实际: ' + drift.actual);
    console.error('  行数: 期望 ' + drift.expectedCount + ' / 实际 ' + drift.actualCount);
  }
  return false;
}

async function main(argv) {
  const args = new Set(argv.slice(2));
  const unknown = [...args].filter((arg) => arg !== '--check' && arg !== '--help');
  if (unknown.length) {
    console.error('protocol gen: 未知参数 ' + unknown.join(' '));
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (args.has('--help')) {
    console.log(USAGE);
    return;
  }

  const { snapshot, signature } = await buildSnapshot();
  const protocolContent = renderProtocolModule(snapshot, signature);
  const protocolLabel = relative(REPO_ROOT, OUTPUT_PATH).replace(/\\/g, '/');
  const protocolStats = snapshot.methodCount + ' 方法 / ' + snapshot.featureNames.length + ' 特性门 / sha256:'
    + signature.slice(0, 16);

  const { snapshot: schemaSnapshot, signature: schemaSignature } = await buildSchemaSnapshot();
  const schemaContent = renderSchemaModule(schemaSnapshot, schemaSignature);
  const schemasLabel = relative(REPO_ROOT, SCHEMAS_OUTPUT_PATH).replace(/\\/g, '/');
  const schemaStats = schemaSnapshot.methodCount + ' 方法 schema / ' + schemaSnapshot.envelopeKeys.length
    + ' 信封键 / sha256:' + schemaSignature.slice(0, 16);

  if (args.has('--check')) {
    const protocolClean = checkGenerated(protocolLabel, protocolContent, OUTPUT_PATH);
    const schemaClean = checkGenerated(schemasLabel, schemaContent, SCHEMAS_OUTPUT_PATH);
    if (protocolClean && schemaClean) {
      console.log('protocol gen: clean（' + protocolLabel + '，' + protocolStats + '；'
        + schemasLabel + '，' + schemaStats + '）');
      return;
    }
    console.error('  → 运行 node packages/protocol/scripts/gen.mjs 重生成，不要手改生成物');
    process.exitCode = 1;
    return;
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, protocolContent, 'utf8');
  mkdirSync(dirname(SCHEMAS_OUTPUT_PATH), { recursive: true });
  writeFileSync(SCHEMAS_OUTPUT_PATH, schemaContent, 'utf8');
  console.log('protocol gen: wrote ' + protocolLabel + '（' + protocolContent.split('\n').length
    + ' 行，' + protocolStats + '）');
  console.log('protocol gen: wrote ' + schemasLabel + '（' + schemaContent.split('\n').length
    + ' 行，' + schemaStats + '）');
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  const selfPath = fileURLToPath(import.meta.url);
  const normalize = (value) => resolve(value).replace(/\\/g, '/').toLowerCase();
  return normalize(entry) === normalize(selfPath);
}

if (isMainModule()) {
  main(process.argv).catch((error) => {
    console.error('protocol gen: ' + (error && error.message ? error.message : String(error)));
    process.exitCode = 1;
  });
}

export {
  CATALOG_PATH,
  OUTPUT_PATH,
  REPO_ROOT,
  SCHEMAS_OUTPUT_PATH,
  SCHEMAS_PATH,
  canonicalJson,
  signatureOf,
};
