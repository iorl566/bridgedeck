// cli/lib/args.mjs —— CLI 纯参数校验/解析（无 I/O、无全局状态）。

/** 参数错误：退出码 2。 */
export class ArgError extends Error {}

export function intFlag(flags, name, { min = 0 } = {}) {
  if (flags[name] === undefined) return undefined;
  const text = String(flags[name]);
  if (!/^-?\d+$/.test(text)) throw new ArgError(`--${name} 需要整数，收到 "${text}"`);
  const value = Number(text);
  if (value < min) throw new ArgError(`--${name} 必须 >= ${min}`);
  return value;
}

export function requirePos(pos, index, label) {
  const value = pos[index];
  if (value === undefined || value === '') throw new ArgError(`缺少参数 ${label}`);
  return value;
}

/** 解析 500ms / 20s / 2m / 1h / 30d 这类时长，返回毫秒。 */
export function parseDurationMs(text, fallback) {
  if (text === undefined || text === null || text === '') return fallback;
  const value = String(text).trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(value);
  if (!match) throw new ArgError('时间格式应为 500ms / 20s / 2m / 1h / 30d，收到 "' + value + '"');
  const amount = Number(match[1]);
  const unit = match[2] || 'ms';
  const factor = unit === 'ms' ? 1
    : unit === 's' ? 1000
      : unit === 'm' ? 60000
        : unit === 'h' ? 3600000
          : 86400000;
  return Math.round(amount * factor);
}

export function parseOnOff(value, name) {
  const text = String(value).toLowerCase();
  if (['on', 'true', '1', 'yes'].includes(text)) return true;
  if (['off', 'false', '0', 'no'].includes(text)) return false;
  throw new ArgError('--' + name + ' 需要 on|off，收到 "' + value + '"');
}
