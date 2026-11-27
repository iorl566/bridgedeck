// src/inject.js —— 向页面注入执行代码。
// 注意：下面标了「注入函数」的函数会被 chrome.scripting.executeScript 序列化后在页面里执行，
// 因此它们必须自包含（只能引用自身参数和页面全局对象），不能引用本模块其它变量。
import { bridgeError, mapChromeError } from './errors.js';
import { log } from './log.js';
import { acquire, release, send as cdpSend } from './debugger.js';
import { ensureHooks } from './page-hooks.js';
import { restrictedUrlReason } from './lib/page-policy.js';

const MAIN_FRAME = 0;
/** 页面能力库版本；必须与 injected/page-lib.js 的 LIB_VERSION 同步。 */
const PAGE_LIB_VERSION = 53;

/** 注入函数：调用页面侧能力库 __BB_PAGE__。 */
export function pageCallFunc(name, args, requiredVersion) {
  const api = globalThis.__BB_PAGE__;
  if (!api || typeof api.handle !== 'function' || Number(api.version || 0) < Number(requiredVersion || 0)) {
    return { __bbMissing: true };
  }
  try {
    return api.handle(name, args || {});
  } catch (error) {
    return {
      ok: false,
      error: { code: 'E_INTERNAL', message: String((error && error.message) || error) },
    };
  }
}

/** 注入函数：在主世界执行表达式（evaluate 命令）。 */
export function evalMainFunc(expression) {
  try {
    if (typeof expression !== 'string' || !expression.trim()) {
      return { ok: false, error: { code: 'E_BAD_ARG', message: 'expression 不能为空' } };
    }
    // 间接 eval 在页面主世界作用域执行，可访问页面的全局变量
    const value = (0, eval)(expression);
    if (value === undefined) {
      return { ok: true, value: null, note: '表达式结果为 undefined' };
    }
    const seen = new WeakSet();
    const json = JSON.stringify(value, (key, item) => {
      if (typeof item === 'bigint') return `${item}n`;
      if (typeof item === 'function') return undefined;
      if (typeof item === 'symbol') return undefined;
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    });
    if (json === undefined) {
      return { ok: true, value: null, note: '结果不可 JSON 序列化（function/symbol）' };
    }
    return { ok: true, value: JSON.parse(json) };
  } catch (error) {
    const firstLine = String((error && error.stack) || error).split('\n')[0];
    return { ok: false, error: { code: 'E_JS_ERROR', message: firstLine } };
  }
}

/** 注入函数：读取主世界的 console 缓冲（console 命令）。 */
export function consoleMainFunc(since, limit, maxTextChars) {
  try {
    const entries = globalThis.__BB_MAIN_LOG__;
    if (!Array.isArray(entries)) {
      return { ok: true, result: { entries: [], total: 0, nextCursor: null } };
    }
    const maxChars = Number.isFinite(Number(maxTextChars)) && Number(maxTextChars) > 0 ? Math.floor(Number(maxTextChars)) : 0;
    let list = entries.slice().map((item) => {
      if (!maxChars || !item || typeof item.text !== 'string' || item.text.length <= maxChars) return item;
      return { ...item, text: item.text.slice(0, maxChars) + '…', truncated: true, textLength: item.text.length };
    });
    if (Number.isFinite(since) && since > 0) {
      // since 约定：> 1e11 视为 epoch 毫秒；否则视为「跳过前 N 条」的下标
      list = since > 1e11 ? list.filter((item) => item.ts > since) : list.slice(Math.min(Math.floor(since), list.length));
    }
    const total = list.length;
    let nextCursor = null;
    if (Number.isInteger(limit) && limit > 0 && list.length > limit) {
      list = list.slice(0, limit);
      nextCursor = since > 1e11 ? null : Math.floor(since || 0) + list.length;
    }
    return { ok: true, result: { entries: list, total, nextCursor } };
  } catch (error) {
    return { ok: false, error: { code: 'E_INTERNAL', message: String((error && error.message) || error) } };
  }
}

/** 执行一次注入脚本，返回 InjectionResult.result；注入失败抛协议错误。 */
function mapInjectionError(error, fallback) {
  const mapped = mapChromeError(error, fallback);
  const message = String((mapped && mapped.message) || error || '');
  if (/showing error page|Cannot access contents of url|No frame with given id|Frame with ID/i.test(message)) {
    return bridgeError('E_PAGE_ERROR', '页面不可用（错误页/受限页/帧已失效）：' + message);
  }
  return mapped;
}

async function runInjection(tabId, world, func, args, frameId = 0) {
  // Chrome 的 injection args 不接受顶层 undefined（会报 Value is unserializable），统一换成 null
  const safeArgs = (args || []).map((value) => (value === undefined ? null : value));
  let injections;
  try {
    injections = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world,
      func,
      args: safeArgs,
    });
  } catch (error) {
    throw mapInjectionError(error, 'chrome.scripting.executeScript 失败');
  }
  const first = Array.isArray(injections) ? injections[0] : null;
  if (!first) throw bridgeError('E_INTERNAL', '注入脚本没有返回结果');
  if (first.error) {
    const message = String((first.error && first.error.message) || first.error || '注入脚本抛异常');
    throw mapInjectionError(new Error(message), '注入脚本失败');
  }
  return first.result;
}

/** 等页面完成两帧渲染；用于输入前证明可见性已真正提交，而不是只读到 visibilityState。 */
export async function waitForPaint(tabId, frameId = 0) {
  const result = await runInjection(tabId, 'ISOLATED', async () => new Promise((resolve) => {
    const done = () => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
    done();
  }), [], frameId);
  return result === true;
}

/** 补注入页面侧能力库（content script 缺失时，例如扩展重载后的旧页面）。 */
export async function injectPageLib(tabId, frameId = 0) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'ISOLATED',
      files: ['injected/page-lib.js'],
    });
  } catch (error) {
    throw mapChromeError(error, '注入页面能力库失败');
  }
}

/** 浏览器内部页/扩展页不允许注入或执行页面动作。 */
async function assertInspectableTab(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return; // 让后续 chrome API 给出更准确的错误
  }
  const reason = restrictedUrlReason((tab && (tab.url || tab.pendingUrl)) || '');
  if (reason) {
    throw bridgeError('E_FORBIDDEN', '当前页面受限（' + reason + '）：BridgeDeck 不操作浏览器内部或扩展页面');
  }
}

/** 调用页面侧能力库上的方法；返回 result 或抛协议错误。 */
export async function execPage(tabId, name, args, frameId = 0) {
  await assertInspectableTab(tabId);
  let raw = await runInjection(tabId, 'ISOLATED', pageCallFunc, [name, args || {}, PAGE_LIB_VERSION], frameId);
  if (raw && raw.__bbMissing) {
    log(`tab ${tabId} 缺少/过期页面能力库，补注入后重试 ${name}`);
    await injectPageLib(tabId, frameId);
    raw = await runInjection(tabId, 'ISOLATED', pageCallFunc, [name, args || {}, PAGE_LIB_VERSION], frameId);
    if (raw && raw.__bbMissing) {
      throw bridgeError('E_INTERNAL', '页面能力库注入失败（可能是受限页面或扩展刚被重载）');
    }
  }
  if (!raw || typeof raw !== 'object') {
    throw bridgeError('E_INTERNAL', '页面侧返回了非法结果');
  }
  if (raw.ok === false) {
    const code = raw.error && raw.error.code ? raw.error.code : 'E_INTERNAL';
    throw bridgeError(code, (raw.error && raw.error.message) || '页面侧执行失败', raw.error ? raw.error.data : undefined);
  }
  return raw.result;
}

/** 页面 CSP 禁止 eval 时的错误特征（GitHub、Bing 等的 script-src 不含 unsafe-eval）。 */
const CSP_EVAL_HINT = /Content Security Policy|unsafe-eval/i;

function isCspEvalBlocked(error) {
  return Boolean(error) && error.code === 'E_JS_ERROR' && CSP_EVAL_HINT.test(String(error.message || ''));
}

/** 页面主世界执行表达式；CSP 禁止 eval 时回退到 CDP Runtime.evaluate（不经过页面 CSP）。 */
export async function evalInMain(tabId, expression) {
  try {
    const raw = await runInjection(tabId, 'MAIN', evalMainFunc, [expression]);
    if (!raw || typeof raw !== 'object') throw bridgeError('E_INTERNAL', '主世界执行无返回');
    if (raw.ok === false) {
      throw bridgeError(raw.error.code, raw.error.message);
    }
    return raw.note ? { value: raw.value, note: raw.note } : { value: raw.value };
  } catch (error) {
    if (!isCspEvalBlocked(error)) throw error;
    log('页面 CSP 禁止 eval，改用 CDP Runtime.evaluate tab=' + tabId);
    return evalByCdp(tabId, expression);
  }
}

/** CDP Runtime.evaluate：绕过页面 CSP，按值返回结果。 */
export async function evalByCdp(tabId, expression) {
  const feature = 'evaluate';
  await acquire(tabId, feature);
  try {
    const reply = await cdpSend(tabId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (reply && reply.exceptionDetails) {
      const details = reply.exceptionDetails;
      const text = (details.exception && (details.exception.description || details.exception.value)) || details.text || '页面脚本异常';
      throw bridgeError('E_JS_ERROR', String(text).split('\n')[0]);
    }
    const result = (reply && reply.result) || {};
    if (result.type === 'undefined') return { value: null, note: '表达式结果为 undefined' };
    if (result.type === 'function' || result.type === 'symbol') {
      return { value: null, note: '结果不可 JSON 序列化（function/symbol）' };
    }
    if (result.unserializableValue !== undefined) return { value: result.unserializableValue };
    return { value: result.value === undefined ? null : result.value };
  } finally {
    await release(tabId, feature);
  }
}

/** 读取主世界 console 缓冲；钩子按需注入（默认不 patch 页面原生函数）。 */
export async function readConsole(tabId, since, limit, maxTextChars) {
  // 首次读取时才注入：注入后只能拿到注入之后的条目，页面加载早期的日志
  // 由 debug 采集的 CDP 管线（Runtime.consoleAPICalled）覆盖。
  const hooked = await ensureHooks(tabId);
  const raw = await runInjection(tabId, 'MAIN', consoleMainFunc, [since, limit, maxTextChars]);
  if (!raw || typeof raw !== 'object') throw bridgeError('E_INTERNAL', '读取 console 无返回');
  if (raw.ok === false) throw bridgeError(raw.error.code, raw.error.message);
  return hooked ? raw.result : { ...raw.result, hooked: false };
}

/** 在所有 frame（含跨源 OOPIF）执行 page-lib 方法。可传 { frameIds } 只扫指定 frame。 */
export async function execPageAllFrames(tabId, name, args, options = {}) {
  await assertInspectableTab(tabId);
  const safeArgs = [name, args || {}, PAGE_LIB_VERSION].map((value) => (value === undefined ? null : value));
  const frameIds = options && Array.isArray(options.frameIds) ? options.frameIds.filter((id) => Number.isInteger(id)) : [];
  const target = frameIds.length ? { tabId, frameIds } : { tabId, allFrames: true };
  async function run() {
    try {
      return await chrome.scripting.executeScript({
        target,
        world: 'ISOLATED',
        func: pageCallFunc,
        args: safeArgs,
      });
    } catch (error) {
      throw mapChromeError(error, 'chrome.scripting.executeScript(allFrames) 失败');
    }
  }
  let injections = await run();
  const missing = (injections || []).some((item) => item && item.result && item.result.__bbMissing);
  if (missing) {
    try {
      await chrome.scripting.executeScript({
        target,
        world: 'ISOLATED',
        files: ['injected/page-lib.js'],
      });
    } catch {
      // 某些受限 frame 注入失败，忽略
    }
    injections = await run();
  }
  return (injections || []).map((item) => {
    if (!item) return { frameId: -1, error: 'empty injection' };
    if (item.error) return { frameId: item.frameId, error: String((item.error && item.error.message) || item.error) };
    const raw = item.result;
    if (!raw || typeof raw !== 'object') return { frameId: item.frameId, error: '页面侧返回非法结果' };
    if (raw.__bbMissing) return { frameId: item.frameId, error: '缺少页面能力库' };
    if (raw.ok === false) {
      return { frameId: item.frameId, error: (raw.error && raw.error.message) || '页面侧执行失败', code: raw.error && raw.error.code };
    }
    return { frameId: item.frameId, result: raw.result };
  });
}
