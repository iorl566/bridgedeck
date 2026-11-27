// tools/gen-protocol.mjs —— 从 lib/method-catalog.mjs（单一目录）生成扩展侧协议常量、
// 方法状态机与 docs/PROTOCOL-METHODS.md 索引。
//
// 事实链：lib/method-catalog.mjs（方法/owner/effect/floor/五维状态）
//        → 本生成器 → extension/src/generated/protocol.js + docs/PROTOCOL-METHODS.md
// schema 键与参数别名由 lib/schemas.mjs 的 buildSchemaKeyTable()/buildParamAliases() 派生，
// 生成器不再自己推导一份（避免“生成逻辑”成为第二个源）。
//
// 用法：
//   node tools/gen-protocol.mjs           # 写入两个生成物
//   node tools/gen-protocol.mjs --check   # 只校验，不写入（CI/门禁用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DAEMON_METHODS,
  DAEMON_ONLY_METHODS,
  EXTENSION_METHODS,
  FEATURE_FLOORS,
  FEATURE_META,
  FEATURE_METHODS,
  FEATURE_NAMES,
  METHOD_COUNT,
  METHOD_EFFECT_TABLE,
  METHOD_FEATURE,
  METHOD_FEATURE_FLOOR,
  METHOD_OWNER_TABLE,
  METHOD_PARTIAL,
  METHOD_RECONCILE,
  METHOD_STATE,
  METHOD_UNKNOWN,
  OWNER_METHODS,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
  RECONCILE_STRATEGIES,
  SORTED_METHOD_NAMES,
  isMutatingInCatalog,
} from '../lib/method-catalog.mjs';
import { buildParamAliases, buildSchemaKeyTable } from '../lib/schemas.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const GENERATED_PROTOCOL_PATH = path.join(ROOT, 'extension', 'src', 'generated', 'protocol.js');
export const GENERATED_DOCS_PATH = path.join(ROOT, 'docs', 'PROTOCOL-METHODS.md');

const mutating = SORTED_METHOD_NAMES.filter((method) => isMutatingInCatalog(method) === true);
const schemas = buildSchemaKeyTable();
const aliases = buildParamAliases();

const banner = '// 由 tools/gen-protocol.mjs 生成，请勿手改；运行 node tools/gen-protocol.mjs 重新生成。';

/** 渲染生成物全文（生成写入与审计逐字节比对共用）。 */
export function renderProtocolSource() {
  return [
    banner,
    'export const GENERATED_PROTOCOL = true;',
    'export const METHOD_EFFECT = ' + JSON.stringify(METHOD_EFFECT_TABLE, null, 2) + ';',
    'export const METHODS = ' + JSON.stringify(SORTED_METHOD_NAMES, null, 2) + ';',
    'export const MUTATING_METHODS = new Set(' + JSON.stringify(mutating, null, 2) + ');',
    'export const LOCAL_METHODS = new Set(' + JSON.stringify([...DAEMON_METHODS].sort(), null, 2) + ');',
    'export const SESSION_METHODS = new Set(' + JSON.stringify([...OWNER_METHODS.session].sort(), null, 2) + ');',
    'export const INSTANCE_METHODS = new Set(' + JSON.stringify([...OWNER_METHODS.instance].sort(), null, 2) + ');',
    'export const EXT_METHODS = new Set(' + JSON.stringify([...EXTENSION_METHODS].sort(), null, 2) + ');',
    'export const METHOD_COUNT = ' + JSON.stringify(METHOD_COUNT) + ';',
    'export const METHOD_OWNER = ' + JSON.stringify(METHOD_OWNER_TABLE, null, 2) + ';',
    'export const METHOD_FEATURE_FLOOR = ' + JSON.stringify(METHOD_FEATURE_FLOOR, null, 2) + ';',
    'export const METHOD_FEATURE = ' + JSON.stringify(METHOD_FEATURE, null, 2) + ';',
    'export const FEATURE_MIN_PROTOCOL = ' + JSON.stringify(FEATURE_FLOORS, null, 2) + ';',
    'export const FEATURE_NAMES = ' + JSON.stringify([...FEATURE_NAMES], null, 2) + ';',
    'export const FEATURE_METHODS = ' + JSON.stringify(FEATURE_METHODS, null, 2) + ';',
    'export const FEATURE_LABELS = ' + JSON.stringify(Object.fromEntries(Object.entries(FEATURE_META).map(([feature, meta]) => [feature, meta.label])), null, 2) + ';',
    'export const PROTOCOL_BASELINE = ' + JSON.stringify(PROTOCOL_BASELINE) + ';',
    'export const PROTOCOL_CURRENT = ' + JSON.stringify(PROTOCOL_CURRENT) + ';',
    'export const RECONCILE_STRATEGIES = ' + JSON.stringify([...RECONCILE_STRATEGIES], null, 2) + ';',
    'export const METHOD_STATE = ' + JSON.stringify(METHOD_STATE, null, 2) + ';',
    'export const METHOD_PARTIAL = ' + JSON.stringify([...METHOD_PARTIAL], null, 2) + ';',
    'export const METHOD_UNKNOWN = ' + JSON.stringify([...METHOD_UNKNOWN], null, 2) + ';',
    'export const METHOD_RECONCILE = ' + JSON.stringify(METHOD_RECONCILE, null, 2) + ';',
    'export const DAEMON_ONLY_METHODS = ' + JSON.stringify([...DAEMON_ONLY_METHODS], null, 2) + ';',
    'export const METHOD_SCHEMA_KEYS = ' + JSON.stringify(schemas, null, 2) + ';',
    'export const PARAM_ALIASES = ' + JSON.stringify(aliases, null, 2) + ';',
    '',
    'export function methodEffect(method) { return METHOD_EFFECT[method] || null; }',
    'export function isKnownMethod(method) { return Object.prototype.hasOwnProperty.call(METHOD_EFFECT, method); }',
    '',
    '/** 方法五维状态（owner/effect/partial/unknown/reconcile）；未知方法返回 null。 */',
    'export function methodState(method) { return METHOD_STATE[method] || null; }',
    '',
    '/** 方法要求的协议版本（无方法级特性门返回 null）。 */',
    'export function methodFloor(method) { return METHOD_FEATURE_FLOOR[method] || null; }',
    '',
    '/** 把 snake_case 别名归一化为协议 camelCase；未知方法/未知键原样返回。 */',
    'export function normalizeParams(method, params) {',
    '  if (!params || typeof params !== "object" || Array.isArray(params)) return params;',
    '  const map = PARAM_ALIASES[method];',
    '  if (!map) return params;',
    '  let changed = false;',
    '  const out = { ...params };',
    '  for (const [snake, camel] of Object.entries(map)) {',
    '    if (out[camel] === undefined && out[snake] !== undefined) {',
    '      out[camel] = out[snake];',
    '      delete out[snake];',
    '      changed = true;',
    '    }',
    '  }',
    '  return changed ? out : params;',
    '}',
    '',
  ].join('\n');
}

function docsRow(method, mutatingValue, scope) {
  return '| `' + method + '` | ' + (mutatingValue ? 'mutation' : 'read') + ' | ' + scope + ' |';
}

function featureTrigger(feature) {
  const meta = FEATURE_META[feature] || { methods: [], params: [] };
  const parts = [];
  if (meta.methods && meta.methods.length) parts.push('方法级 ' + meta.methods.length + ' 个');
  if (meta.params && meta.params.length) parts.push('参数 ' + meta.params.join('/'));
  return parts.length ? parts.join(' + ') : '方法级';
}

/** 渲染 docs/PROTOCOL-METHODS.md 全文（生成写入与审计逐字节比对共用）。 */
export function renderMethodsDoc() {
  const local = [...OWNER_METHODS.local, ...DAEMON_ONLY_METHODS].sort();
  const daemonOnly = new Set(DAEMON_ONLY_METHODS);
  const lines = [
    '# 协议方法索引（自动生成）',
    '',
    '由 `node tools/gen-protocol.mjs` 生成（`tools/protocol-sections.mjs --write` 等价）；新增/删除方法后重新生成，不要手改。',
    '单一源：`lib/method-catalog.mjs`（owner/effect/feature floor/五维状态）；schema 键由 `lib/schemas.mjs` 派生。',
    '本文件的索引表是 `tools/protocol-single-source.mjs` 的审计对象；特性门与方法状态机为只读快照。',
    '',
    '## daemon 本地方法（owner=local）',
    '',
    '| 方法 | 副作用 | scope |',
    '| --- | --- | --- |',
  ];
  for (const method of local) {
    // daemon-only 生命周期方法不进入 canonical 目录，协议口径一律按只读展示（与旧文档一致）。
    lines.push(docsRow(method, daemonOnly.has(method) ? false : isMutatingInCatalog(method), 'local'));
  }
  lines.push('');
  for (const [title, owner] of [['会话方法（owner=session → 扩展）', 'session'], ['实例方法（owner=instance → 扩展）', 'instance']]) {
    lines.push('## ' + title, '', '| 方法 | 副作用 | scope |', '| --- | --- | --- |');
    for (const method of [...OWNER_METHODS[owner]].sort()) {
      lines.push(docsRow(method, isMutatingInCatalog(method), owner));
    }
    lines.push('');
  }
  lines.push(
    '## 特性门与最低协议版本（' + FEATURE_NAMES.length + ' 个，当前协议 ' + PROTOCOL_CURRENT + '，兼容基线 ' + PROTOCOL_BASELINE + '）',
    '',
    '| 特性 | 最低协议 | 标签 | 触发 |',
    '| --- | --- | --- | --- |',
  );
  for (const feature of FEATURE_NAMES) {
    lines.push('| `' + feature + '` | ' + FEATURE_FLOORS[feature] + ' | ' + (FEATURE_META[feature] ? FEATURE_META[feature].label : feature) + ' | ' + featureTrigger(feature) + ' |');
  }
  lines.push(
    '',
    '## 方法状态机（五维快照）',
    '',
    'partial=结果可能部分返回；unknown=派发后可能无法证明是否生效；reconcile=unknown 后的收敛策略。',
    '',
    '| 方法 | owner | effect | partial | unknown | reconcile |',
    '| --- | --- | --- | --- | --- | --- |',
  );
  const stateMethods = [...SORTED_METHOD_NAMES];
  for (const method of stateMethods) {
    const state = METHOD_STATE[method];
    const reconcile = METHOD_RECONCILE[method] || 'none';
    lines.push('| `' + method + '` | ' + state.owner + ' | ' + state.effect + ' | '
      + (state.partial ? 'yes' : 'no') + ' | ' + (state.unknown ? 'yes' : 'no') + ' | ' + reconcile + ' |');
  }
  lines.push('');
  return lines.join('\n');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isMain = invokedPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (isMain) {
  const artifacts = [
    { file: GENERATED_PROTOCOL_PATH, content: renderProtocolSource, label: 'extension/src/generated/protocol.js' },
    { file: GENERATED_DOCS_PATH, content: renderMethodsDoc, label: 'docs/PROTOCOL-METHODS.md' },
  ];
  if (process.argv.includes('--check')) {
    let stale = 0;
    for (const artifact of artifacts) {
      const current = fs.existsSync(artifact.file) ? fs.readFileSync(artifact.file, 'utf8') : '';
      const expected = artifact.content();
      if (current !== expected) {
        console.error('generated artifact is stale: ' + artifact.label);
        stale += 1;
      }
    }
    if (stale) {
      console.error('运行 node tools/gen-protocol.mjs 重新生成协议产物');
      process.exit(1);
    }
    console.log('protocol generated artifacts are up to date（protocol.js + docs/PROTOCOL-METHODS.md）');
  } else {
    for (const artifact of artifacts) {
      fs.mkdirSync(path.dirname(artifact.file), { recursive: true });
      fs.writeFileSync(artifact.file, artifact.content());
    }
    console.log(JSON.stringify({
      ok: true,
      out: artifacts.map((artifact) => path.relative(ROOT, artifact.file)),
      methods: SORTED_METHOD_NAMES.length,
      schemas: Object.keys(schemas).length,
      floors: FEATURE_NAMES.length,
      states: Object.keys(METHOD_STATE).length,
      partial: METHOD_PARTIAL.length,
      unknown: METHOD_UNKNOWN.length,
    }, null, 2));
  }
}
