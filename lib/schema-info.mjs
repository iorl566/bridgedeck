// lib/schema-info.mjs —— 协议方法的可发现描述（CLI `bridge schema` 使用）。
import { METHOD_EFFECT } from './protocol.mjs';
import { isMutating, methodScope } from './methods.mjs';
import { METHOD_SCHEMAS } from './schemas.mjs';

/** 单个方法的 scope/effect/mutating/schema；未知方法返回 null。 */
export function describeMethod(method) {
  const name = String(method || '');
  if (!Object.prototype.hasOwnProperty.call(METHOD_EFFECT, name)) return null;
  return {
    method: name,
    scope: methodScope(name) || 'extension',
    effect: METHOD_EFFECT[name],
    mutating: isMutating(name),
    schema: METHOD_SCHEMAS[name] || null,
  };
}

/** 全部方法，按名称排序。 */
export function listMethods() {
  return Object.keys(METHOD_EFFECT).sort().map((method) => describeMethod(method));
}

/** schema 属性 → CLI flag（camelCase → kebab-case；少数 CLI 别名单独列出）。 */
const FLAG_ALIASES = { waitTimeoutMs: '--wait-timeout' };

function flagFor(key) {
  return FLAG_ALIASES[key] || '--' + key.replace(/[A-Z]/g, (char) => '-' + char.toLowerCase()).replace(/_/g, '-');
}

export function schemaFlags(method) {
  const info = describeMethod(method);
  const properties = info && info.schema && info.schema.properties;
  if (!properties) return [];
  return Object.keys(properties).map(flagFor);
}

function valueLabel(property) {
  const type = property && property.type;
  if (type === 'boolean') return '';
  if (type === 'integer' || type === 'number') return ' <n>';
  if (type === 'object' || type === 'array') return ' <json>';
  return ' <text>';
}

/** 单方法帮助文本（由 schema 生成）；未知方法返回 null。 */
export function renderMethodHelp(method) {
  const info = describeMethod(method);
  if (!info) return null;
  const schema = info.schema || {};
  const properties = schema.properties || {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const flags = Object.keys(properties).map((key) => flagFor(key) + valueLabel(properties[key]) + (required.has(key) ? '' : '?'));
  return [
    info.method + '  scope=' + info.scope + ' effect=' + info.effect + ' mutating=' + info.mutating,
    'flags: ' + (flags.length ? flags.join(' ') : '(none)'),
  ].join('\n');
}

const POSITIONAL_FLAGS = new Set(['--ref', '--selector']);
const TYPE_HINTS = { integer: ' <n>', number: ' <n>', object: ' <json>', array: ' <json>', string: ' <text>' };

/** 生成 `[--flag <type>]` 片段，供 CLI 帮助复用；ref/selector 视为位置参数。 */
export function renderFlagUsage(method, options = {}) {
  const info = describeMethod(method);
  const properties = info && info.schema && info.schema.properties;
  if (!properties) return [];
  const exclude = new Set(options.exclude || []);
  const flags = schemaFlags(method);
  return Object.keys(properties).map((key, index) => ({ key, flag: flags[index] }))
    .filter(({ key, flag }) => !POSITIONAL_FLAGS.has(flag) && !exclude.has(key))
    .map(({ key, flag }) => {
      const hint = TYPE_HINTS[properties[key] && properties[key].type] || '';
      return '[' + flag + hint + ']';
    });
}
