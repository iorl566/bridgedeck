// sdk/index.mjs —— BrowserBridge Node SDK
//
// 定位：给 Node/TypeScript 调用方一个 Playwright 风格的薄封装，直接走 daemon 的
// HTTP /rpc（不经过 CLI 进程），保留错误码、session 与观测/截图能力。
//
// 用法：
//   import { connect } from './sdk/index.mjs';
//   const bb = await connect();                    // 读 ~/.browser-bridge/daemon.json，必要时拉起 daemon
//   const page = await bb.newPage();               // session.start
//   await page.goto('https://example.com');
//   await page.fill('#q', 'browser bridge');
//   await page.press('Enter');
//   console.log(await page.observe());
//   await page.close();
//
// 零依赖：只用 node:http / node:https / node:fs / node:child_process。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SDK_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SDK_DIR, '..');
const DEFAULT_TIMEOUT_MS = 60_000;
const START_TIMEOUT_MS = 12_000;

// error-codes:begin
/** 协议错误码清单；调用方按码分支，不要依赖文案。 */
export const ERROR_CODES = Object.freeze({
  E_BAD_ARG: "参数缺失/冲突（如 ref 与 selector 同时给）",
  E_NOT_FOUND: "ref/selector 找不到元素",
  E_NOT_ACTIONABLE: "目标存在但不可操作（不可见 / 禁用 / 尺寸为 0）",
  E_STALE_REF: "ref 指向的元素已不在文档里，需重新 observe",
  E_OPTION_NOT_FOUND: "select 的目标选项不存在",
  E_OPTION_AMBIGUOUS: "select 的选项文本匹配到多个",
  E_UNKNOWN_METHOD: "未知 method",
  E_NO_SESSION: "没有活动会话",
  E_SESSION_BUSY: "同一会话已有进行中的操作",
  E_SESSION_PAUSED: "会话已被人工接管（暂停）",
  E_SESSION_STOPPED: "会话已结束",
  E_QUEUE_FULL: "daemon 队列已满",
  E_RATE_LIMITED: "请求过于频繁",
  E_CANCELLED: "操作被取消",
  E_REQUEST_CANCELLED: "请求在排队阶段被取消",
  E_INPUT_BUSY: "输入通道被占用",
  E_NO_TAB: "tabId 不存在（tab 被关闭）",
  E_NO_BROWSER: "没有可用的浏览器实例",
  E_START_PENDING: "会话启动中，操作尚未就绪",
  E_START_NOT_READY: "会话尚未就绪，稍后重试",
  E_OBSERVATION_STALE: "观测结果已过期，需重新 observe",
  E_CURSOR_STALE: "分页游标已过期",
  E_CONTEXT_REQUIRED: "该动作要求先提供上下文",
  E_CONTEXT_STALE: "上下文与当前页面不一致",
  E_DEPENDS_FAILED: "前置依赖步骤未成功",
  E_EXPECT_FAILED: "expect 断言不匹配",
  E_OBSERVATION_CHANGED: "页面在观测后已变化（观测代数不符）",
  E_OCCLUDED: "目标被遮挡（浮层/弹窗）",
  E_OBSCURED: "视觉坐标落点被铺满视口的元素遮住",
  E_TARGET_MISMATCH: "视觉坐标落点不属于预期的候选目标",
  E_CAPTURE_STALE: "截图 capture 不存在或已过期",
  E_BAD_MODE: "动作模式取值不支持",
  E_DIALOG_PENDING: "有未处理的页面原生弹窗",
  E_EXISTS: "同名资源已存在",
  E_CACHE_EMPTY: "缓存为空",
  E_TOO_LARGE: "结果超过大小上限",
  E_RESULT_TOO_LARGE: "结果超过协议允许的大小",
  E_JS_ERROR: "页面内 JS 抛异常",
  E_NAV_FAIL: "导航失败",
  E_TIMEOUT: "等待类命令超时",
  E_DEBUGGER_BUSY: "调试器被其它会话占用",
  E_UNSUPPORTED_CAPABILITY: "当前版本不支持该能力",
  E_UNSUPPORTED_REMOTE: "远程连接不支持该能力",
  E_PROTOCOL_UNSUPPORTED: "协议版本不兼容",
  E_AUTH: "本机鉴权失败",
  E_AUTH_BUSY: "鉴权通道正被另一请求占用",
  E_AUTH_CHALLENGE: "鉴权挑战无效",
  E_AUTH_EXPIRED: "鉴权挑战已过期",
  E_AUTH_FAILED: "鉴权证明不匹配",
  E_AUTH_PROOF: "鉴权证明格式或签名字段无效",
  E_AUTH_STATE: "鉴权状态机不允许该操作",
  E_PAIR_INVALID: "配对码无效或已使用",
  E_PAIR_REQUIRED: "需要先完成本机配对",
  E_PAUSED_MANUAL: "会话因人工接管而暂停",
  E_LEDGER_PENDING: "有未确认的意图账本记录",
  E_DAEMON: "daemon 不可用（未启动或连接失败，客户端侧码）",
  E_NO_DAEMON: "连不上 daemon",
  E_DAEMON_TIMEOUT: "daemon 在限定时间内没有响应",
  E_DISCONNECTED: "连接已断开",
  E_EXTENSION_GONE: "浏览器扩展已断开",
  E_LISTEN: "daemon 端口监听失败",
  E_SPAWN: "子进程启动失败",
  E_ENV: "运行环境不满足要求",
  E_CONFIG_INVALID: "配置项取值无效",
  E_BAD_JSON: "请求或文件不是合法 JSON",
  E_BAD_REQUEST: "请求格式不合法",
  E_INVALID_PARAMS: "参数无效",
  E_DIRECT_RPC_DISABLED: "直连 RPC 已被关闭",
  E_RPC: "RPC 调用失败",
  E_OUTPUT: "输出写入失败",
  E_TARGET_NOT_FILLABLE: "目标不可填写（不是输入框/可编辑区）",
  E_NOT_SELECT: "目标不是 select 元素",
  E_BROWSER: "浏览器侧操作失败",
  E_PAGE_ERROR: "页面内执行出错",
  E_OBSERVE_FAILED: "观察采集失败",
  E_FOLLOW_FAILED: "跟随新标签页失败",
  E_RELEASE_INVALID: "发布信息校验失败",
  E_UPDATE: "更新流程失败",
  E_MCP_CONFLICT: "MCP 服务端口/进程冲突",
  E_APP_SSO_FAILED: "应用单点登录失败",
  E_TRANSFER_NOT_FOUND: "传输任务不存在",
  E_TRANSFER_STATE: "传输任务状态不允许该操作",
  E_BORROW_DENIED: "借用标签页被拒绝",
  E_BORROW_TIMEOUT: "借用标签页超时",
  E_HELP_DISABLED: "人工协助不可用",
  E_NO_DOWNLOAD: "没有可用的下载",
  E_DOWNLOAD_FAILED: "下载失败",
  E_NO_FILE_CHOOSER: "没有可用的文件选择器",
  E_TRANSFER_OFFSET: "传输偏移不匹配",
  E_TRANSFER_LIMIT: "传输超过大小限制",
  E_TRANSFER_INCOMPLETE: "传输未完成",
  E_INCOGNITO_UNAVAILABLE: "无痕窗口不可用",
  E_RECIPE_NOT_APPROVED: "配方未获批",
  E_RECIPE_CHANGED: "配方内容已变更",
  E_RECIPE_EXPIRED: "配方已过期",
  E_RECIPE_LOCKED: "配方正在被另一个进程回放",
  E_FORBIDDEN: "当前策略禁止该操作",
  E_INTERNAL: "其它异常",
});
// error-codes:end

/** 未知码统一落到 E_INTERNAL，避免调用方拿到无法分支的字符串。 */
export function normalizeErrorCode(code) {
  return Object.hasOwn(ERROR_CODES, code) ? code : 'E_INTERNAL';
}

/** daemon 的业务错误；code 为 PROTOCOL 错误码，data 保留结构化细节。 */
export class BridgeRpcError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ data?: unknown, method?: string }} [options]
   */
  constructor(code, message, options = {}) {
    super(message || 'browser-bridge rpc failed');
    this.name = 'BridgeRpcError';
    this.code = normalizeErrorCode(code);
    this.data = options.data;
    this.method = options.method || null;
    // 与协议对齐：超时/断连时 effect_state 可能是 unknown，调用方据此决定是否重放。
    this.effectState = options.data && (options.data.effect_state || options.data.effectState) || null;
  }
}

/** 默认状态目录：BB_HOME > ~/.browser-bridge。 */
export function defaultHome() {
  return process.env.BB_HOME && process.env.BB_HOME.trim()
    ? path.resolve(process.env.BB_HOME.trim())
    : path.join(os.homedir(), '.browser-bridge');
}

export function daemonInfoPath(home = defaultHome()) {
  return path.join(home, 'daemon.json');
}

/** 读取 daemon.json；不存在/损坏返回 null。 */
export function readDaemonInfo(home = defaultHome()) {
  try {
    const info = JSON.parse(fs.readFileSync(daemonInfoPath(home), 'utf8'));
    if (info && Number.isInteger(info.port) && typeof info.token === 'string') return info;
  } catch {
    // 没启动或文件正在替换
  }
  return null;
}

function requestJson(info, method, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const transport = info.tls === true ? https : http;
    const request = transport.request({
      host: '127.0.0.1',
      port: info.port,
      path: method,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-bridge-token': info.token,
      },
      ...(info.tls === true ? { rejectUnauthorized: false } : {}),
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: response.statusCode || 0, json: JSON.parse(text) });
        } catch {
          reject(new BridgeRpcError('E_DAEMON', 'daemon 返回非 JSON 响应（HTTP ' + response.statusCode + '）'));
        }
      });
    });
    request.on('error', (error) => {
      if (error instanceof BridgeRpcError) reject(error);
      else reject(new BridgeRpcError('E_DAEMON', '连接 daemon 失败：' + (error && error.message ? error.message : error)));
    });
    request.setTimeout(timeoutMs, () => request.destroy(new BridgeRpcError('E_TIMEOUT', 'RPC 超时（' + timeoutMs + 'ms）')));
    request.end(body);
  });
}

async function healthOk(info) {
  return new Promise((resolve) => {
    const transport = info.tls === true ? https : http;
    const request = transport.request({
      host: '127.0.0.1',
      port: info.port,
      path: '/health',
      method: 'GET',
      ...(info.tls === true ? { rejectUnauthorized: false } : {}),
    }, (response) => {
      response.resume();
      resolve((response.statusCode || 0) === 200);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(800, () => request.destroy());
    request.end();
  });
}

/** 没有 daemon 时以 detached 模式拉起 workspace 的 daemon/server.mjs。 */
export function startDaemon({ home = defaultHome(), timeoutMs = START_TIMEOUT_MS } = {}) {
  const serverPath = path.join(REPO_ROOT, 'daemon', 'server.mjs');
  if (!fs.existsSync(serverPath)) {
    throw new BridgeRpcError('E_DAEMON', '找不到 daemon/server.mjs：' + serverPath);
  }
  const child = spawn(process.execPath, [serverPath, '--foreground'], {
    cwd: REPO_ROOT,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, BB_HOME: home },
  });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      const info = readDaemonInfo(home);
      if (info && await healthOk(info)) return info;
    }
    throw new BridgeRpcError('E_DAEMON', 'daemon 在 ' + timeoutMs + 'ms 内未就绪；请运行 bridge status 查看日志');
  })();
}

/** Playwright 风格的目标参数：'@e1' → ref，其他字符串 → selector。 */
export function targetParams(target) {
  if (!target) throw new BridgeRpcError('E_BAD_ARG', '缺少 target（@ref 或 CSS selector）');
  if (typeof target === 'object') {
    if (target.ref) return { ref: String(target.ref) };
    if (target.selector) return { selector: String(target.selector) };
    throw new BridgeRpcError('E_BAD_ARG', 'target 需要 ref 或 selector');
  }
  const text = String(target);
  return text.startsWith('@') ? { ref: text } : { selector: text };
}

/**
 * 一个浏览器会话（≈ Playwright 的 Page）。所有方法自动带 session。
 */
export class Page {
  /** @param {BrowserBridge} bridge @param {{sessionId:string, tabId?:number, windowId?:number, instanceId?:string}} info */
  constructor(bridge, info) {
    this.bridge = bridge;
    this.id = info.sessionId;
    this.tabId = info.tabId ?? null;
    this.windowId = info.windowId ?? null;
    this.instanceId = info.instanceId ?? null;
  }

  async call(method, params = {}) {
    return this.bridge.rpc(method, { session: this.id, ...params });
  }

  async goto(url, options = {}) {
    return this.call('navigate', { url: String(url), ...options });
  }
  async reload(options = {}) { return this.call('reload', options); }
  async back(options = {}) { return this.call('navigate-back', options); }
  async forward(options = {}) { return this.call('navigate-forward', options); }

  async click(target, options = {}) {
    return this.call('click', { ...targetParams(target), ...options });
  }
  async clickBackend(backendNodeId, options = {}) {
    return this.call('click-backend', { backendId: Number(backendNodeId), ...options });
  }
  async hover(target, options = {}) {
    return this.call('hover', { ...targetParams(target), ...options });
  }
  async fill(target, value, options = {}) {
    return this.call('fill', { ...targetParams(target), value: String(value), ...options });
  }
  async press(key, options = {}) {
    const params = { key: String(key), ...options };
    if (options.target) {
      Object.assign(params, targetParams(options.target));
      delete params.target;
    }
    return this.call('press', params);
  }
  async select(target, value, options = {}) {
    return this.call('select', { ...targetParams(target), value: String(value), ...options });
  }
  async focus(target) { return this.call('focus', targetParams(target)); }
  async scrollTo(target) { return this.call('scroll-to', targetParams(target)); }
  async read(target) {
    return this.call('read', target ? targetParams(target) : {});
  }
  async evaluate(expression, options = {}) {
    const params = { expression: String(expression) };
    if (options.unverified === true) params.unverified = true;
    return this.call('evaluate', params);
  }
  async observe(options = {}) { return this.call('observe', options); }
  async snapshot() { return this.call('snapshot', {}); }
  async waitForElement(target, options = {}) {
    return this.call('wait-for-element', { ...targetParams(target), ...options });
  }
  async waitForNavigation(options = {}) { return this.call('wait-for-navigation', options); }
  async waitMs(ms) { return this.call('wait-ms', { ms: Number(ms) }); }

  async screenshot(options = {}) {
    const { path: outputPath, ...params } = options;
    const result = await this.call('screenshot', params);
    if (outputPath && result && typeof result.dataUrl === 'string') {
      const base64 = result.dataUrl.slice(result.dataUrl.indexOf(',') + 1);
      fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
      fs.writeFileSync(path.resolve(outputPath), Buffer.from(base64, 'base64'));
    }
    return result;
  }

  async pause(reason = 'sdk') {
    return this.call('session.pause', { paused: true, reason });
  }
  async resume() {
    return this.call('session.pause', { paused: false });
  }
  async close({ keep = false } = {}) {
    return this.bridge.rpc('session.stop', { session: this.id, keep });
  }
}

/**
 * daemon 连接（≈ Playwright 的 Browser）。默认自动拉起 daemon。
 */
export class BrowserBridge {
  /**
   * @param {{port:number, token:string, tls?:boolean}} info
   * @param {{home?:string, timeoutMs?:number}} [options]
   */
  constructor(info, options = {}) {
    this.info = { port: info.port, token: info.token, tls: info.tls === true };
    this.home = options.home || defaultHome();
    this.timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  }

  /** @param {{home?:string, timeoutMs?:number, autoStart?:boolean}} [options] */
  static async connect(options = {}) {
    const home = options.home || defaultHome();
    let info = readDaemonInfo(home);
    if (!info) {
      if (options.autoStart === false) throw new BridgeRpcError('E_DAEMON', 'daemon 未运行，且 autoStart=false：' + daemonInfoPath(home));
      info = await startDaemon({ home, timeoutMs: options.startTimeoutMs });
    }
    return new BrowserBridge(info, { home, timeoutMs: options.timeoutMs });
  }

  async rpc(method, params = {}, options = {}) {
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : this.timeoutMs;
    const response = await requestJson(this.info, '/rpc', { method, params, timeoutMs }, timeoutMs + 1_000);
    if (response.status === 401) {
      throw new BridgeRpcError('E_AUTH', 'daemon token 无效；daemon 可能已重启，请重新 connect', { method });
    }
    if (!response.json || typeof response.json !== 'object') {
      throw new BridgeRpcError('E_DAEMON', 'daemon 响应格式不正确', { method });
    }
    if (response.json.ok !== true) {
      const error = response.json.error || {};
      throw new BridgeRpcError(error.code || 'E_INTERNAL', error.message || 'rpc failed', { data: error.data, method });
    }
    return response.json.result;
  }

  async status() { return this.rpc('status'); }
  async sessions() { return (await this.rpc('session.list')).sessions || []; }
  async browsers() { return (await this.rpc('browsers')).browsers || []; }

  /** 新建会话（≈ browser.newPage）。给 url 时自动导航。 */
  async newPage(options = {}) {
    const params = {};
    if (options.browser) params.browser = String(options.browser);
    if (options.tab !== undefined) params.tab = Number(options.tab);
    if (options.noFocus === true) params.noFocus = true;
    if (options.incognito === true) params.incognito = true;
    if (options.controller) params.controller = options.controller;
    const info = await this.rpc('session.start', params, { timeoutMs: options.timeoutMs });
    const page = new Page(this, info);
    if (options.url) await page.goto(options.url, { timeoutMs: options.timeoutMs });
    return page;
  }

  /** 按 sessionId 取 Page；不存在时抛 E_NO_SESSION。 */
  async page(sessionId) {
    const sessions = await this.sessions();
    const found = sessions.find((item) => item.sessionId === String(sessionId));
    if (!found) throw new BridgeRpcError('E_NO_SESSION', 'session "' + sessionId + '" 不存在');
    return new Page(this, found);
  }

  /** 当前所有会话的 Page 视图。 */
  async pages() {
    return (await this.sessions()).map((item) => new Page(this, item));
  }

  async stopDaemon() {
    try {
      await this.rpc('daemon.stop', {}, { timeoutMs: 3_000 });
    } catch {
      // daemon 会在回包前退出，连接错误视为已停止
    }
  }
}

/** 便捷入口：connect + newPage。 */
export async function connect(options = {}) {
  return BrowserBridge.connect(options);
}

/** 写一张截图到文件（独立函数，便于调用方不想持有 Page 时使用）。 */
export function writeDataUrl(outputPath, dataUrl) {
  const marker = String(dataUrl || '').indexOf(',');
  if (marker < 0) throw new BridgeRpcError('E_INTERNAL', '截图结果不是 dataUrl');
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(path.resolve(outputPath), Buffer.from(String(dataUrl).slice(marker + 1), 'base64'));
  return path.resolve(outputPath);
}
