import vm from 'node:vm';

/**
 * 受限脚本执行：只暴露 page/console/timers/args，不暴露 require/process/fs/net。
 * 注意：Node vm 不是安全边界，只用于用户显式执行自己的脚本。
 */
export async function runScript({ code, page, timeoutMs = 30000, args = {}, filename = 'bridge-exec.js' } = {}) {
  if (typeof code !== 'string' || !code.trim()) throw new Error('exec 需要脚本内容');
  const logs = [];
  const record = (level) => (...items) => {
    logs.push({ level, text: items.map((item) => {
      if (typeof item === 'string') return item;
      try { return JSON.stringify(item); } catch { return String(item); }
    }).join(' ') });
  };
  const sandbox = {
    page,
    args,
    console: { log: record('log'), info: record('log'), warn: record('warn'), error: record('error') },
    setTimeout,
    clearTimeout,
  };
  const context = vm.createContext(sandbox);
  const script = new vm.Script('(async () => {\n' + code + '\n})()', { filename });
  let timer;
  try {
    const run = Promise.resolve(script.runInContext(context, { timeout: Math.max(1000, Math.min(Number(timeoutMs) || 30000, 120000)) }));
    run.catch(() => {});
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('exec 超时（' + timeoutMs + 'ms）')), Math.max(1000, Number(timeoutMs) || 30000));
    });
    const result = await Promise.race([run, timeout]);
    return { result: result === undefined ? null : result, logs };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
