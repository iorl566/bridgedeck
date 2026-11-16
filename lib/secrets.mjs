// lib/secrets.mjs —— 把敏感值留在本地环境，不让它进入模型可见的输出。
export function normalizeSecretName(value) {
  const name = String(value || '').trim().replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
  return name.slice(0, 80);
}

/**
 * value 可含 {{secret:NAME}} 占位符；secret 则直接读 BB_SECRET_<NAME>。
 * 返回值只给执行层使用，调用方必须对结果做 redact。
 */
export function resolveSecretValue({ value, secret } = {}, env = process.env) {
  if (secret !== undefined && value !== undefined) {
    throw new Error('--value 与 --secret 不能同时使用');
  }
  if (secret !== undefined) {
    const name = normalizeSecretName(secret);
    if (!name) throw new Error('--secret 需要一个变量名');
    const raw = env['BB_SECRET_' + name];
    if (raw === undefined || raw === '') throw new Error('环境变量 BB_SECRET_' + name + ' 未设置');
    return { value: String(raw), used: true, name };
  }
  const text = value === undefined ? '' : String(value);
  let used = false;
  const resolved = text.replace(/\{\{secret:([A-Za-z0-9_-]+)\}\}/g, (_match, rawName) => {
    const name = normalizeSecretName(rawName);
    const raw = env['BB_SECRET_' + name];
    if (raw === undefined || raw === '') throw new Error('环境变量 BB_SECRET_' + name + ' 未设置');
    used = true;
    return String(raw);
  });
  return { value: resolved, used, name: '' };
}

export function redactFillResult(result) {
  if (!result || typeof result !== 'object') return result;
  const next = { ...result };
  if (next.actual_value !== undefined) next.actual_value = '********';
  next.redacted = true;
  return next;
}
