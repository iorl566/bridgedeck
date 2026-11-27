// CLI QuickJS sandbox: page host calls are asyncified into a QuickJS WASM runtime.
//
// 契约（与 vm 沙箱不同，必须写在这里避免踩坑）：
// - QuickJS 侧 page/locator 是**同步** API：host 调用是 asyncified 的，会在 WASM 栈上
//   挂起/恢复并同步返回结果，所以脚本里**不要写 await**（需要 await/Playwright 风格用默认 vm）。
// - host 回调内部可以 await 真正的异步 RPC；这是 asyncify 的标准用法。
// - 之前“QuickJS locator 触发 WASM 断言”的根因是旧的“async 用户脚本 + 手写
//   getPromiseState/executePendingJobs 轮询”驱动方式：该 vendored 0.32.0 asyncify 构建在
//   多调用后推进 job 队列会触发 QuickJS refcount 断言。改为同步脚本 + 直接 dump
//   evalCodeAsync 的结果后，25 次连续调用稳定通过。
// - 失败以结构化对象跨边界（code/message/data），脚本可 catch 到 e.code。
import { newQuickJSAsyncWASMModuleFromVariant } from '../vendor/quickjs/core/dist/index.mjs';
import variant from '../vendor/quickjs/async/dist/index.mjs';
import { pageSurface } from '../lib/exec-page.mjs';

let modulePromise = null;

async function getModule() {
  if (!modulePromise) modulePromise = newQuickJSAsyncWASMModuleFromVariant(variant);
  return modulePromise;
}

function toJson(value) {
  try { return JSON.stringify(value === undefined ? null : value); } catch { return 'null'; }
}

function quickJSError(message, code) {
  const error = new Error(message);
  error.code = code || 'E_EXEC_FAILED';
  return error;
}

/** 生成 QuickJS 侧的 page/console prelude（同步 API；方法清单来自 lib/exec-page.mjs）。 */
export function buildPrelude() {
  const surface = pageSurface();
  const lines = [
    'const call = (name, args) => {',
    '  const raw = JSON.parse(__bbPage(name, JSON.stringify(args)));',
    '  if (raw && raw.ok === false) {',
    '    const info = raw.error || {};',
    '    const err = new Error(info.message || "bridge 调用失败");',
    '    err.code = info.code || "E_EXEC_FAILED";',
    '    if (info.data !== null && info.data !== undefined) err.data = info.data;',
    '    throw err;',
    '  }',
    '  return raw && raw.ok === true && Object.prototype.hasOwnProperty.call(raw, "value") ? raw.value : null;',
    '};',
    'const page = {',
  ];
  for (const name of surface.methods) {
    if (name === 'locator' || name === 'webmcp') continue;
    lines.push('  ' + name + ': (...a) => call(' + JSON.stringify(name) + ', a),');
  }
  lines.push('  locator: (target) => {');
  lines.push('    const op = (name) => (...a) => call("locator." + name, [target, a]);');
  lines.push('    return {');
  for (const name of surface.locator) {
    lines.push('      ' + name + ': op(' + JSON.stringify(name) + '),');
  }
  lines.push('    };');
  lines.push('  },');
  lines.push('  webmcp: { list: () => call("webmcp.list", []), call: (name, input) => call("webmcp.call", [name, input || {}]) },');
  lines.push('};');
  lines.push('const console = {');
  lines.push('  log: (...a) => __bbLog("log", a.map((v) => typeof v === "string" ? v : JSON.stringify(v)).join(" ")),');
  lines.push('  warn: (...a) => __bbLog("warn", a.map((v) => typeof v === "string" ? v : JSON.stringify(v)).join(" ")),');
  lines.push('  error: (...a) => __bbLog("error", a.map((v) => typeof v === "string" ? v : JSON.stringify(v)).join(" ")),');
  lines.push('};');
  return lines.join('\n');
}

/**
 * @param {{code:string,page:object,timeoutMs?:number}} options
 * @returns {Promise<{result:any,logs:{level:string,text:string}[]}>}
 */
export async function runQuickJS({ code, page, timeoutMs = 30000 }) {
  if (typeof code !== 'string' || !code.trim()) throw new Error('exec 需要脚本内容');
  const source = String(code);
  // QuickJS 沙箱是同步 API：async 函数会产生无法 await 的 Promise，提前给出明确错误。
  if (/\basync\s+(function\b|\(|[A-Za-z_$][\w$]*\s*=>)/.test(source)) {
    throw quickJSError('QuickJS 沙箱使用同步 page API：脚本里不要写 await/async function（host 调用会阻塞返回）。去掉 await，或改用默认 vm 沙箱。', 'E_BAD_ARG');
  }
  const mod = await getModule();
  const runtime = mod.newRuntime();
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 30000);
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const ctx = runtime.newContext();
  const logs = [];

  async function invokeHost(name, args) {
    const dotted = String(name);
    if (dotted.startsWith('locator.')) {
      const op = dotted.slice('locator.'.length);
      const [target, opArgs] = args;
      const loc = page.locator(target);
      const fn = loc && loc[op];
      if (typeof fn !== 'function') throw quickJSError('未知 locator 方法：' + op, 'E_BAD_ARG');
      return await fn.apply(loc, Array.isArray(opArgs) ? opArgs : []);
    }
    let target = page;
    for (const part of dotted.split('.')) target = target && target[part];
    if (typeof target !== 'function') throw quickJSError('未知 page 方法：' + dotted, 'E_BAD_ARG');
    return await target.apply(page, args);
  }

  const host = ctx.newAsyncifiedFunction('__bbPage', async (nameHandle, argsHandle) => {
    const name = ctx.getString(nameHandle);
    let args = [];
    try { args = JSON.parse(ctx.getString(argsHandle) || '[]'); } catch { args = []; }
    if (!Array.isArray(args)) args = [args];
    try {
      const value = await invokeHost(name, args);
      return ctx.newString(toJson({ ok: true, value: value === undefined ? null : value }));
    } catch (error) {
      return ctx.newString(toJson({
        ok: false,
        error: {
          code: (error && error.code) || 'E_EXEC_FAILED',
          message: String((error && error.message) || error),
          data: (error && error.data) === undefined ? null : error.data,
        },
      }));
    }
  });
  ctx.setProp(ctx.global, '__bbPage', host);
  host.dispose();

  const logFn = ctx.newAsyncifiedFunction('__bbLog', async (levelHandle, textHandle) => {
    logs.push({ level: ctx.getString(levelHandle), text: ctx.getString(textHandle) });
  });
  ctx.setProp(ctx.global, '__bbLog', logFn);
  logFn.dispose();

  const setup = ctx.evalCode(buildPrelude());
  if (setup.error) throw quickJSError('QuickJS 初始化失败：' + toJson(ctx.dump(setup.error)));
  setup.value.dispose();

  // 同步 IIFE：用户 return 值 / 异常都收成结果对象，一次 eval 取回（不做 promise 轮询）。
  const program = [
    '(() => {',
    '  try {',
    '    const value = (() => {',
    source,
    '    })();',
    '    return { kind: "ok", value: value === undefined ? null : value };',
    '  } catch (e) {',
    '    return { kind: "error", error: {',
    '      code: e && e.code ? String(e.code) : "",',
    '      message: e && e.message ? String(e.message) : String(e),',
    '      data: e && e.data !== undefined ? e.data : null,',
    '    } };',
    '  }',
    '})()',
  ].join('\n');

  const evaluated = await ctx.evalCodeAsync(program);
  if (evaluated.error) {
    const dumped = ctx.dump(evaluated.error);
    const message = dumped && dumped.message ? String(dumped.message) : toJson(dumped);
    if (/interrupted/i.test(message)) throw quickJSError('exec 超时（' + timeoutMs + 'ms）');
    // QuickJS 是同步 API：脚本里写 await 会变成语法错误（“expecting ';'”），这里给出可操作的提示。
    if (/\bawait\s|\basync\s+function\b|\basync\s*\(/.test(source)) {
      throw quickJSError('QuickJS 沙箱使用同步 page API：脚本里不要写 await/async function（host 调用会阻塞返回）。去掉 await，或改用默认 vm 沙箱。', 'E_BAD_ARG');
    }
    throw quickJSError('QuickJS 执行失败：' + message);
  }
  const outcome = ctx.dump(evaluated.value);
  // 保留 runtime/context 引用：避免 GC 在结果被使用前释放 wasm 侧对象（历史上会在退出期触发
  // refcount 断言）。CLI 侧输出后 process.exit(0)；同进程复用（单测）已验证稳定。
  const keep = globalThis.__bbQuickJSKeepAlive || (globalThis.__bbQuickJSKeepAlive = []);
  keep.push({ mod, runtime, ctx });
  if (outcome && outcome.kind === 'error') {
    const info = outcome.error && typeof outcome.error === 'object' ? outcome.error : {};
    const error = quickJSError(info.message ? String(info.message) : 'exec 失败', info.code || 'E_EXEC_FAILED');
    if (info.data !== null && info.data !== undefined) error.data = info.data;
    throw error;
  }
  return { result: outcome && outcome.kind === 'ok' ? outcome.value : null, logs };
}
