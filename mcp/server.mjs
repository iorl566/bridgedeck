#!/usr/bin/env node
// mcp/server.mjs —— 把BridgeDeck暴露成 MCP（stdio，newline-delimited JSON-RPC 2.0）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readUpdateState } from '../lib/update-state.mjs';
import { mcpInputSchema } from '../lib/mcp-schemas.mjs';
import { resolveSessionByScope } from '../lib/session-scope.mjs';

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'bridge.mjs');

async function runCliJson(args) {
  const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, ...args, '--json'], { env: process.env, maxBuffer: 10 * 1024 * 1024 });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error('CLI 输出不是 JSON：' + String(stdout).slice(0, 200));
  }
}

const VERSION = '0.1.1';
const HOME = process.env.BB_HOME || path.join(os.homedir(), '.browser-bridge');
const DAEMON_JSON = path.join(HOME, 'daemon.json');
const state = { sessionId: process.env.BB_SESSION || null, sessionScope: process.env.BB_SESSION_SCOPE || null };

function daemonInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(DAEMON_JSON, 'utf8'));
    if (!info || typeof info.port !== 'number' || typeof info.token !== 'string') return null;
    return info;
  } catch {
    return null;
  }
}

async function rpc(method, params = {}, timeoutMs = 60000) {
  const info = daemonInfo();
  if (!info) {
    const error = new Error('daemon 未运行（' + DAEMON_JSON + ' 不存在）；先运行 bridge status');
    error.code = 'E_DAEMON';
    throw error;
  }
  const response = await fetch('http://127.0.0.1:' + info.port + '/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': info.token },
    body: JSON.stringify({ method, params, timeoutMs }),
  });
  const body = await response.json();
  if (!body.ok) {
    const error = new Error((body.error && body.error.message) || 'daemon 返回失败');
    error.code = (body.error && body.error.code) || 'E_INTERNAL';
    throw error;
  }
  return body.result;
}

async function ensureSession(args) {
  if (args && args.session) return String(args.session);
  if (args && args.session_scope) {
    state.sessionScope = String(args.session_scope);
    state.sessionId = null;
  }
  if (state.sessionId) return state.sessionId;
  if (state.sessionScope) {
    const listed = await rpc('session.list', {});
    const resolved = resolveSessionByScope(listed.sessions || [], state.sessionScope);
    if (resolved.error) {
      const error = new Error(resolved.message);
      error.code = resolved.error;
      throw error;
    }
    state.sessionId = resolved.session.sessionId;
    return state.sessionId;
  }
  const result = await rpc('session.start', {});
  state.sessionId = result.sessionId;
  return state.sessionId;
}

function withSession(sessionId, params) {
  return { ...params, session: sessionId };
}

/** "3s"/"500ms"/"2m"/数字 → 毫秒；无法解析返回 null。 */
function parseDurationMs(value) {
  if (Number.isInteger(value) && value >= 0) return value;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(String(value || '').trim());
  if (!match) return null;
  const unit = String(match[2] || 's').toLowerCase();
  const factor = unit === 'ms' ? 1 : (unit === 'm' ? 60000 : (unit === 'h' ? 3600000 : 1000));
  return Math.round(Number(match[1]) * factor);
}

const TOOLS = [
  {
    name: 'browser_brief',
    description: '面向 agent 的页面简报：URL/标题、带 @eN ref 的观察、截断信息、待处理对话框与下一步建议。',
    inputSchema: {
      type: 'object',
      properties: { session: { type: 'string' } },
      additionalProperties: false,
    },
    async run(args) {
      const sessionId = await ensureSession(args);
      const observation = await rpc('observe', withSession(sessionId, { maxTokens: 1200, probeHover: false }));
      let dialog = null;
      try {
        const status = await rpc('dialog.status', withSession(sessionId, {}), 5000);
        dialog = { pending: status.pending === true, armed: status.armed === true, type: status.type || null };
      } catch {
        dialog = null;
      }
      const next = dialog && dialog.pending ? ['dialog accept', 'dialog dismiss'] : ['click @eN', 'fill @eN --value <text>', 'observe'];
      if (observation.truncated) next.push('observe --cursor <cursor>');
      return {
        session: sessionId,
        page: { url: observation.url || '', title: observation.title || '' },
        observation: {
          text: String(observation.observation || ''),
          refs: Number(observation.refs) || 0,
          truncated: observation.truncated === true,
          cursor: observation.cursor || null,
        },
        dialog,
        next,
        hint: dialog && dialog.pending ? '页面有待处理对话框，先 accept/dismiss 再继续。' : '使用 @eN ref 操作；导航后旧 ref 失效，重新 observe。',
      };
    },
  },
  {
    name: 'browser_update_state',
    description: '读取最近的 update check/fetch/stage/apply/rollback 与 auto 检查状态。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      return readUpdateState(path.join(HOME, 'update-state.json'));
    },
  },
  {
    name: 'browser_session_start',
    description: '创建新的浏览器会话并返回 sessionId。',
    inputSchema: {
      type: 'object',
      properties: { browser: { type: 'string' }, tab: { type: 'number' }, focus: { type: 'boolean' }, incognito: { type: 'boolean' } },
      additionalProperties: false,
    },
    async run(args) {
      const params = {};
      if (args.browser) params.browser = String(args.browser);
      if (args.tab) params.tab = args.tab;
      if (args.focus === true) params.noFocus = false; else params.noFocus = true;
      if (args.incognito) params.incognito = true;
      const result = await rpc('session.start', params);
      state.sessionId = result.sessionId;
      return result;
    },
  },
  {
    name: 'browser_session_stop',
    description: '结束浏览器会话。',
    inputSchema: { type: 'object', properties: { session: { type: 'string' }, keep: { type: 'boolean' } }, additionalProperties: false },
    async run(args) {
      const sessionId = args.session || state.sessionId;
      const result = await rpc('session.stop', { session: sessionId, keep: args.keep === true });
      if (state.sessionId === sessionId) state.sessionId = null;
      return result;
    },
  },
  {
    name: 'browser_audit',
    description: '读取操作审计。',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' }, offset: { type: 'number' } }, additionalProperties: false },
    async run(args) {
      const params = {};
      if (args.limit) params.limit = args.limit;
      if (args.offset) params.offset = args.offset;
      return rpc('audit.list', params);
    },
  },
  {
    name: 'browser_settings',
    description: '读取或更新扩展设置（action=get|set）。',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string' }, settings: { type: 'object' } },
      required: ['action'],
      additionalProperties: false,
    },
    async run(args) {
      if (String(args.action) === 'get') return rpc('settings.get', {});
      if (String(args.action) === 'set') return rpc('settings.set', { patch: args.settings || {} });
      throw new Error('action 只能是 get|set');
    },
  },
  {
    name: 'browser_pair',
    description: '远程配对：action=create|list|redeem|revoke。',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string' }, code: { type: 'string' }, ttl: { type: 'string' }, label: { type: 'string' } },
      required: ['action'],
      additionalProperties: false,
    },
    async run(args) {
      const action = String(args.action || '');
      if (action === 'create') {
        const params = {};
        if (args.ttl) params.ttl = args.ttl;
        if (args.label) params.label = args.label;
        return rpc('pair.create', params);
      }
      if (action === 'list') return rpc('pair.list', {});
      if (action === 'redeem' || action === 'revoke') {
        if (!args.code) throw new Error(action + ' 需要 code');
        return rpc('pair.' + action, { code: args.code });
      }
      throw new Error('action 只能是 create|list|redeem|revoke');
    },
  },
  {
    name: 'browser_install_skill',
    description: '把内嵌技能安装到指定 Agent 目录（默认 dsh）。',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string' }, dir: { type: 'string' }, force: { type: 'boolean' } },
      additionalProperties: false,
    },
    async run(args) {
      const argv = ['install-skill'];
      if (args.target) argv.push('--target', String(args.target));
      if (args.dir) argv.push('--dir', String(args.dir));
      if (args.force === true) argv.push('--force');
      return runCliJson(argv);
    },
  },
  {
    name: 'browser_recipe',
    description: 'Recipe：action=list|show|save|approve|run|rm。run 可传 params。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        name: { type: 'string' },
        file: { type: 'string' },
        params: { type: 'object' },
        confirm_human: { type: 'boolean' },
        by: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async run(args) {
      const action = String(args.action || '');
      const argv = ['recipe', action];
      if (args.name) argv.push(String(args.name));
      if (args.file) argv.push('--file', String(args.file));
      if (args.by) argv.push('--by', String(args.by));
      if (args.confirm_human === true) argv.push('--confirm-human');
      if (args.params && typeof args.params === 'object') {
        for (const [key, value] of Object.entries(args.params)) argv.push('--param', key + '=' + String(value));
      }
      return runCliJson(argv);
    },
  },
  {
    name: 'browser_update',
    description: '更新：action=state|check|fetch|auto。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        source: { type: 'string' },
        out: { type: 'string' },
        key: { type: 'string' },
        enable: { type: 'boolean' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async run(args) {
      const action = String(args.action || '');
      const argv = ['update', action];
      if (args.source) argv.push('--source', String(args.source));
      if (args.out) argv.push('--out', String(args.out));
      if (args.key) argv.push('--key', String(args.key));
      if (args.enable === true) argv.push('--enable');
      if (args.enable === false) argv.push('--disable');
      return runCliJson(argv);
    },
  },
  {
    name: 'browser_record_start',
    description: '开始记录当前标签页的用户操作。',
    inputSchema: mcpInputSchema('record.start'),
    async run(args) {
      const sessionId = await ensureSession(args);
      const params = withSession(sessionId, {});
      if (args.purpose) params.purpose = String(args.purpose);
      if (Number.isInteger(args.max_page_tokens)) params.maxPageTokens = args.max_page_tokens;
      return rpc('record.start', params);
    },
  },
  {
    name: 'browser_record_stop',
    description: '停止记录并返回录制摘要。',
    inputSchema: mcpInputSchema('record.stop'),
    async run(args) {
      const sessionId = await ensureSession(args);
      return rpc('record.stop', withSession(sessionId, {}));
    },
  },
  {
    name: 'browser_record_list',
    description: '列出录制历史。',
    inputSchema: mcpInputSchema('record.list'),
    async run(args) {
      const sessionId = await ensureSession(args);
      return rpc('record.list', withSession(sessionId, {}));
    },
  },
  {
    name: 'browser_status',
    description: '查看 daemon/browser/session 状态。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() { return rpc('status', {}); },
  },
  {
    name: 'browser_plan',
    description: '一次串行执行多个已决定的动作；首个未完成的步骤即停止，不自动重试。',
    inputSchema: {
      type: 'object',
      properties: {
        steps: { type: 'array', description: '[{ "method": "click", "params": { "ref": "@e1" } }, ...]' },
        session: { type: 'string' },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    async run(args) {
      if (!Array.isArray(args.steps) || args.steps.length === 0) throw new Error('steps 需要非空数组');
      const sessionId = await ensureSession(args);
      return rpc('plan', withSession(sessionId, { steps: args.steps }), 120000);
    },
  },
  {
    name: 'browser_observe',
    description: '观察当前页面，返回带 @eN ref 的语义树；vom=true 时额外返回结构化节点。',
    inputSchema: mcpInputSchema('observe', { omit: ['sessionId', 'tabId'] }),
    async run(args) {
      const sessionId = await ensureSession(args);
      const params = withSession(sessionId, {});
      const mapping = {
        probe_hover: 'probeHover', debug_surfaces: 'debugSurfaces', closed_shadow: 'closedShadow',
        vom: 'vom', ax: 'ax', max_tokens: 'maxTokens', max_depth: 'maxDepth', cursor: 'cursor',
      };
      for (const [arg, param] of Object.entries(mapping)) {
        if (args[arg] !== undefined) params[param] = args[arg];
      }
      return rpc('observe', params);
    },
  },
  {
    name: 'browser_navigate',
    description: '导航到 URL（等待加载完成）。',
    inputSchema: mcpInputSchema('navigate', { omit: ['sessionId', 'tabId'] }),
    async run(args) {
      const sessionId = await ensureSession(args);
      return rpc('navigate', withSession(sessionId, { url: String(args.url) }));
    },
  },
  {
    name: 'browser_click',
    description: '点击元素（ref 或 CSS selector）。',
    inputSchema: mcpInputSchema('click'),
    async run(args) {
      const sessionId = await ensureSession(args);
      const params = args.ref ? { ref: String(args.ref) } : { selector: String(args.selector) };
      if (args.trusted !== undefined) params.trusted = args.trusted === true;
      if (args.force !== undefined) params.force = args.force === true;
      if (args.wait_timeout !== undefined) params.waitTimeoutMs = Number(args.wait_timeout);
      return rpc('click', withSession(sessionId, params));
    },
  },
  {
    name: 'browser_fill',
    description: '向输入框填值（ref 或 selector）。',
    inputSchema: mcpInputSchema('fill'),
    async run(args) {
      const sessionId = await ensureSession(args);
      const target = args.ref ? { ref: String(args.ref) } : { selector: String(args.selector) };
      const params = { ...target, value: String(args.value), noClear: args.no_clear === true };
      if (args.trusted !== undefined) params.trusted = args.trusted === true;
      if (args.force !== undefined) params.force = args.force === true;
      if (args.wait_timeout !== undefined) params.waitTimeoutMs = Number(args.wait_timeout);
      return rpc('fill', withSession(sessionId, params));
    },
  },
  {
    name: 'browser_read',
    description: '读取元素文本。',
    inputSchema: mcpInputSchema('read', { omit: ['sessionId', 'tabId'] }),
    async run(args) {
      const sessionId = await ensureSession(args);
      const params = args.ref ? { ref: String(args.ref) } : { selector: String(args.selector) };
      if (args.all !== undefined) params.all = args.all === true;
      if (args.fields_json !== undefined) params.fieldsJson = String(args.fields_json);
      return rpc('read', withSession(sessionId, params));
    },
  },
  {
    name: 'browser_extract',
    description: '从容器元素提取结构化数据。',
    inputSchema: mcpInputSchema('extract', { omit: ['sessionId', 'tabId'], required: ['selector'] }),
    async run(args) {
      const sessionId = await ensureSession(args);
      const params = args.ref ? { ref: String(args.ref) } : { selector: String(args.selector) };
      if (args.max_rows !== undefined) params.maxRows = Number(args.max_rows);
      if (args.max_bytes !== undefined) params.maxBytes = Number(args.max_bytes);
      return rpc('extract', withSession(sessionId, params));
    },
  },
  {
    name: 'browser_evaluate',
    description: '在页面主世界执行表达式。',
    inputSchema: mcpInputSchema('evaluate', { omit: ['sessionId', 'tabId'] }),
    async run(args) {
      const sessionId = await ensureSession(args);
      return rpc('evaluate', withSession(sessionId, { expression: String(args.expression) }));
    },
  },
  {
    name: 'browser_screenshot',
    description: '截图并保存到 out 路径。',
    inputSchema: {
      type: 'object',
      properties: {
        out: { type: 'string' }, full_page: { type: 'boolean' }, scope: { type: 'string' },
        selector: { type: 'string' }, region: { type: ['string', 'object'] }, annotate: { type: 'boolean' }, overlap: { type: 'number' },
        session: { type: 'string' },
      },
      required: ['out'],
      additionalProperties: false,
    },
    async run(args) {
      const sessionId = await ensureSession(args);
      const params = withSession(sessionId, { fullPage: args.full_page === true });
      if (args.scope) params.scope = String(args.scope);
      if (args.selector) params.selector = String(args.selector);
      if (args.annotate === true) params.annotate = true;
      if (Number.isFinite(args.overlap) && args.overlap >= 0) params.overlap = args.overlap;
      if (args.region) {
        if (typeof args.region === 'string') {
          const [x, y, width, height] = String(args.region).split(',').map(Number);
          params.region = { x, y, width, height };
        } else {
          params.region = args.region;
        }
      }
      const result = await rpc('screenshot', params, 120000);
      const dataUrl = String(result.dataUrl || '');
      const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
      const target = path.resolve(process.cwd(), String(args.out));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(base64, 'base64'));
      return { ok: true, path: target, width: result.width, height: result.height, bytes: fs.statSync(target).size };
    },
  },
  {
    name: 'browser_tabs',
    description: '列出标签页。',
    inputSchema: mcpInputSchema('tab.list'),
    async run(args) { return rpc('tab.list', args.scope ? { scope: String(args.scope) } : {}); },
  },
  {
    name: 'browser_tab_new',
    description: '新建标签页；可打开到新窗口。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, new_window: { type: 'boolean' }, no_focus: { type: 'boolean' }, session: { type: 'string' } },
      additionalProperties: false,
    },
    async run(args) {
      const sessionId = await ensureSession(args);
      const params = withSession(sessionId, { noFocus: args.no_focus === true });
      if (args.url) params.url = args.url;
      if (args.new_window) params.newWindow = true;
      return rpc('tab.new', params);
    },
  },
  {
    name: 'browser_tab_close',
    description: '关闭标签页。',
    inputSchema: mcpInputSchema('tab.close', { required: ['tab_id'] }),
    async run(args) { return rpc('tab.close', { tabId: args.tab_id }); },
  },
  {
    name: 'browser_tab_select',
    description: '激活标签页。',
    inputSchema: mcpInputSchema('tab.select', { required: ['tab_id'] }),
    async run(args) { return rpc('tab.select', { tabId: args.tab_id }); },
  },
  {
    name: 'browser_tab_move',
    description: '把标签页移动到指定窗口。',
    inputSchema: mcpInputSchema('tab.move', { required: ['tab_id', 'window_id'] }),
    async run(args) {
      const params = { tabId: args.tab_id, windowId: args.window_id };
      if (Number.isInteger(args.index)) params.index = args.index;
      return rpc('tab.move', params);
    },
  },
  {
    name: 'browser_debug_start',
    description: '开始调试采集（请求/控制台/页面/性能）。',
    inputSchema: mcpInputSchema('debug.start'),
    async run(args) {
      const sessionId = await ensureSession(args);
      const params = withSession(sessionId, {});
      if (args.name) params.name = String(args.name);
      if (args.bodies === true) params.bodies = true;
      return rpc('debug.start', params);
    },
  },
  {
    name: 'browser_debug_stop',
    description: '停止调试采集并返回统计。',
    inputSchema: mcpInputSchema('debug.stop'),
    async run(args) {
      const sessionId = await ensureSession(args);
      return rpc('debug.stop', withSession(sessionId, {}));
    },
  },
  {
    name: 'browser_debug_analyze',
    description: '分析当前调试采集：状态/方法/慢请求/错误/重复 URL/commandId 分组。',
    inputSchema: { type: 'object', properties: { file: { type: 'string' }, session: { type: 'string' } }, additionalProperties: false },
    async run(args) {
      const sessionId = await ensureSession(args);
      const argv = ['debug', 'analyze'];
      if (args.file) argv.push('--file', String(args.file));
      argv.push('--session', sessionId);
      return runCliJson(argv);
    },
  },
  {
    name: 'browser_debug_evidence',
    description: '生成调试证据包（可指定离线归档文件）。',
    inputSchema: {
      type: 'object',
      properties: { out: { type: 'string' }, file: { type: 'string' }, session: { type: 'string' } },
      required: ['out'],
      additionalProperties: false,
    },
    async run(args) {
      const argv = ['debug', 'evidence', '--output', String(args.out)];
      if (args.file) argv.push('--file', String(args.file));
      else argv.push('--session', await ensureSession(args));
      return runCliJson(argv);
    },
  },
  {
    name: 'browser_debug_journal',
    description: '读取请求/控制台/操作合并的调试时间线。',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' }, session: { type: 'string' } }, additionalProperties: false },
    async run(args) {
      const sessionId = await ensureSession(args);
      const argv = ['debug', 'journal', '--session', sessionId];
      if (args.limit) argv.push('--limit', String(args.limit));
      return runCliJson(argv);
    },
  },
  {
    name: 'browser_debug_query',
    description: '离线查询调试归档（file/filter）。',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string' }, filter: { type: 'string' }, session: { type: 'string' } },
      required: ['file'],
      additionalProperties: false,
    },
    async run(args) {
      const argv = ['debug', 'query', '--file', String(args.file)];
      if (args.filter) argv.push('--filter', String(args.filter));
      return runCliJson(argv);
    },
  },
  {
    name: 'browser_debug_archive',
    description: '把当前调试采集写成归档文件。',
    inputSchema: {
      type: 'object',
      properties: { out: { type: 'string' }, session: { type: 'string' } },
      required: ['out'],
      additionalProperties: false,
    },
    async run(args) {
      const sessionId = await ensureSession(args);
      return runCliJson(['debug', 'archive', '--output', String(args.out), '--session', sessionId]);
    },
  },
  {
    name: 'browser_debug_archives',
    description: '列出目录中的调试归档及保留期。',
    inputSchema: {
      type: 'object',
      properties: { dir: { type: 'string' }, prune: { type: 'boolean' }, session: { type: 'string' } },
      required: ['dir'],
      additionalProperties: false,
    },
    async run(args) {
      const argv = ['debug', 'archives', '--dir', String(args.dir)];
      if (args.prune === true) argv.push('--prune');
      return runCliJson(argv);
    },
  },
  {
    name: 'browser_network_list',
    description: '列出网络采集记录。',
    inputSchema: mcpInputSchema('network.list', { extra: { filter_text: { type: 'string', description: '按 URL 子串过滤（便捷写法）' } } }),
    async run(args) {
      const sessionId = await ensureSession(args);
      const params = withSession(sessionId, {});
      if (typeof args.filter === 'string') params.filter = { urlContains: String(args.filter) };
      else if (args.filter && typeof args.filter === 'object') params.filter = args.filter;
      if (args.filter_text) params.filter = { ...(params.filter || {}), urlContains: String(args.filter_text) };
      if (args.since != null) params.since = args.since;
      if (args.limit != null) params.limit = args.limit;
      return rpc('network.list', params);
    },
  },
  {
    name: 'browser_rule_list',
    description: '列出当前标签页的调试规则。',
    inputSchema: mcpInputSchema('debug.rule_list'),
    async run(args) { return rpc('debug.rule_list', withSession(await ensureSession(args), {})); },
  },
  {
    name: 'browser_rule_add',
    description: '添加调试规则（match/effect）。',
    inputSchema: mcpInputSchema('debug.rule_add', { required: ['rule'] }),
    async run(args) {
      return rpc('debug.rule_add', withSession(await ensureSession(args), { rule: args.rule }));
    },
  },
  {
    name: 'browser_rule_clear',
    description: '清空当前标签页的调试规则。',
    inputSchema: mcpInputSchema('debug.rule_clear'),
    async run(args) { return rpc('debug.rule_clear', withSession(await ensureSession(args), {})); },
  },
  {
    name: 'browser_rule_set',
    description: '启用/停用/删除调试规则：action=enable|disable|remove。',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string' }, id: { type: 'number' }, session: { type: 'string' } },
      required: ['action', 'id'],
      additionalProperties: false,
    },
    async run(args) {
      const action = String(args.action || '');
      if (!['enable', 'disable', 'remove'].includes(action)) throw new Error('action 只能是 enable|disable|remove');
      return rpc('debug.rule_' + action, withSession(await ensureSession(args), { id: args.id }));
    },
  },
  {
    name: 'browser_video_start',
    description: '开始录制当前标签页视频。',
    inputSchema: mcpInputSchema('video.start', { extra: { duration: { type: 'string', description: '如 30s / 500ms；与 duration_ms 二选一' } } }),
    async run(args) {
      const sessionId = await ensureSession(args);
      const params = withSession(sessionId, {});
      const durationMs = Number.isInteger(args.duration_ms) ? args.duration_ms : parseDurationMs(args.duration);
      if (Number.isInteger(durationMs)) params.durationMs = durationMs;
      if (args.quality) params.quality = String(args.quality);
      return rpc('video.start', params);
    },
  },
  {
    name: 'browser_video_stop',
    description: '停止视频录制。',
    inputSchema: mcpInputSchema('video.stop', { extra: { recording_id: { type: 'string', description: '录制 id；省略则停当前录制' } } }),
    async run(args) {
      const params = {};
      const recording = args.recording || args.recording_id;
      if (recording) params.recording = String(recording);
      return rpc('video.stop', params);
    },
  },
  {
    name: 'browser_video_recover',
    description: '从已持久化的录制分片恢复视频。',
    inputSchema: { type: 'object', properties: { session: { type: 'string' } }, additionalProperties: false },
    async run(args) { return rpc('video.recover', withSession(await ensureSession(args), {})); },
  },
  {
    name: 'browser_video_status',
    description: '查看当前视频录制状态。',
    inputSchema: mcpInputSchema('video.status'),
    async run(args) {
      const sessionId = await ensureSession(args);
      const params = withSession(sessionId, {});
      if (args.recording) params.recording = String(args.recording);
      return rpc('video.status', params);
    },
  },
  {
    name: 'browser_video_list',
    description: '列出已保存的视频录制。',
    inputSchema: mcpInputSchema('video.list'),
    async run(args) {
      const sessionId = args.session || state.sessionId;
      return rpc('video.list', sessionId ? { session: sessionId } : {});
    },
  },
  {
    name: 'browser_window',
    description: '窗口路由：action=list|focus|ensure|resize。',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string' }, window_id: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, session: { type: 'string' } },
      required: ['action'],
      additionalProperties: false,
    },
    async run(args) {
      const action = String(args.action || '');
      if (action === 'list') return rpc('window.list', {});
      if (action === 'ensure') return rpc('window.ensureAgent', withSession(await ensureSession(args), {}));
      if (action === 'focus') {
        if (!Number.isInteger(args.window_id)) throw new Error('focus 需要 window_id');
        return rpc('window.focus', { windowId: args.window_id });
      }
      if (action === 'resize') {
        if (!Number.isInteger(args.width) || !Number.isInteger(args.height)) throw new Error('resize 需要 width/height');
        const params = { width: args.width, height: args.height };
        if (Number.isInteger(args.window_id)) params.windowId = args.window_id;
        return rpc('window.resize', params);
      }
      throw new Error('action 只能是 list|focus|ensure|resize');
    },
  },
  {
    name: 'browser_wait_for',
    description: '等待元素出现/可见。',
    inputSchema: mcpInputSchema('wait-for-element'),
    async run(args) {
      const sessionId = await ensureSession(args);
      const target = args.ref ? { ref: args.ref } : { selector: args.selector };
      const params = withSession(sessionId, { ...target, timeoutMs: args.timeout_ms || 5000 });
      if (args.state) params.state = String(args.state);
      if (args.operation_id) params.operationId = String(args.operation_id);
      return rpc('wait-for-element', params);
    },
  },
  {
    name: 'browser_cooperate_sync',
    description: '签发 context/observation 收据。',
    inputSchema: { type: 'object', properties: { session: { type: 'string' } }, additionalProperties: false },
    async run(args) {
      const sessionId = await ensureSession(args);
      return rpc('cooperate.sync', { session: sessionId });
    },
  },
  {
    name: 'browser_dialog',
    description: '处理原生对话框：action=status|accept|dismiss|arm|list。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'accept', 'dismiss', 'arm', 'list'] },
        id: { type: 'number' }, text: { type: 'string' }, session: { type: 'string' },
        alert: { type: 'string' }, confirm: { type: 'string' }, prompt: { type: 'string' }, prompt_text: { type: 'string' }, queue: { type: 'boolean' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async run(args) {
      const sessionId = await ensureSession(args);
      const action = String(args.action);
      if (action === 'status') return rpc('dialog.status', { session: sessionId });
      if (action === 'list') return rpc('dialog.list', { session: sessionId });
      if (action === 'arm') {
        const params = { session: sessionId };
        for (const key of ['alert', 'confirm', 'prompt']) if (args[key]) params[key] = String(args[key]);
        if (args.prompt_text) params.promptText = String(args.prompt_text);
        if (args.queue === true) params.queue = true;
        return rpc('dialog.arm', params);
      }
      const method = action === 'accept' ? 'dialog.accept' : 'dialog.dismiss';
      return rpc(method, { session: sessionId, id: args.id, text: args.text });
    },
  },
];

const TOOL_METHODS = {
  browser_brief: ['observe', 'dialog.status'],
  browser_update_state: [],
  browser_session_start: ['session.start'],
  browser_session_stop: ['session.stop'],
  browser_audit: ['audit.list'],
  browser_settings: ['settings.get', 'settings.set'],
  browser_pair: ['pair.list', 'pair.create', 'pair.redeem', 'pair.revoke'],
  browser_install_skill: [],
  browser_recipe: [],
  browser_update: [],
  browser_record_start: ['record.start'],
  browser_record_stop: ['record.stop'],
  browser_record_list: ['record.list'],
  browser_status: ['status'],
  browser_plan: ['plan'],
  browser_observe: ['observe'],
  browser_navigate: ['navigate'],
  browser_click: ['click'],
  browser_fill: ['fill'],
  browser_read: ['read'],
  browser_extract: ['extract'],
  browser_evaluate: ['evaluate'],
  browser_screenshot: ['screenshot'],
  browser_tabs: ['tab.list'],
  browser_tab_new: ['tab.new'],
  browser_tab_close: ['tab.close'],
  browser_tab_select: ['tab.select'],
  browser_tab_move: ['tab.move'],
  browser_debug_start: ['debug.start'],
  browser_debug_stop: ['debug.stop'],
  browser_debug_analyze: [],
  browser_debug_evidence: [],
  browser_debug_journal: [],
  browser_debug_query: [],
  browser_debug_archive: [],
  browser_debug_archives: [],
  browser_network_list: ['network.list'],
  browser_rule_list: ['debug.rule_list'],
  browser_rule_add: ['debug.rule_add'],
  browser_rule_clear: ['debug.rule_clear'],
  browser_rule_set: ['debug.rule_add', 'debug.rule_enable', 'debug.rule_disable', 'debug.rule_remove'],
  browser_video_start: ['video.start'],
  browser_video_stop: ['video.stop'],
  browser_video_recover: ['video.recover'],
  browser_video_status: ['video.status'],
  browser_video_list: ['video.list'],
  browser_window: ['window.list', 'window.focus', 'window.ensureAgent', 'window.resize'],
  browser_wait_for: ['wait-for-element'],
  browser_cooperate_sync: ['cooperate.sync'],
  browser_dialog: ['dialog.arm', 'dialog.status', 'dialog.accept', 'dialog.dismiss', 'dialog.list', 'dialog.handle'],
};
for (const tool of TOOLS) {
  const methods = TOOL_METHODS[tool.name];
  if (!Array.isArray(methods)) throw new Error('MCP 工具缺少协议方法映射：' + tool.name);
  tool.methods = methods;
}
export { TOOLS };

const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]));

function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
function ok(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(request) {
  const { id, method, params } = request;
  if (method === 'initialize') {
    ok(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'browser-bridge', version: VERSION },
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') { ok(id, {}); return; }
  if (method === 'tools/list') {
    ok(id, {
      tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    });
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const tool = TOOL_MAP.get(name);
    if (!tool) {
      ok(id, { content: [{ type: 'text', text: '未知工具：' + name }], isError: true });
      return;
    }
    try {
      const result = await tool.run((params && params.arguments) || {});
      ok(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: false });
    } catch (error) {
      ok(id, {
        content: [{ type: 'text', text: ((error && error.code) || 'E_INTERNAL') + ': ' + ((error && error.message) || error) }],
        isError: true,
      });
    }
    return;
  }
  if (method === 'shutdown' || method === 'exit') { ok(id, {}); process.exit(0); }
  fail(id, -32601, 'Method not found: ' + method);
}

// 作为脚本（node mcp/server.mjs）运行时才启动 stdio 读循环；被单测 import 时只导出 TOOLS。
const IS_MAIN = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let request = null;
    try { request = JSON.parse(text); } catch { fail(null, -32700, 'Parse error'); return; }
    handle(request).catch((error) => fail(request && request.id, -32603, String((error && error.message) || error)));
  });
  rl.on('close', () => {
    if (state.sessionId) rpc('session.stop', { session: state.sessionId }).catch(() => {});
    process.exit(0);
  });
}
