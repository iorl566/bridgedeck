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
const state = { sessionId: process.env.BB_SESSION || null };

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
  if (state.sessionId) return state.sessionId;
  const result = await rpc('session.start', {});
  state.sessionId = result.sessionId;
  return state.sessionId;
}

function withSession(sessionId, params) {
  return { ...params, session: sessionId };
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
    inputSchema: { type: 'object', properties: { session: { type: 'string' } }, additionalProperties: false },
    async run(args) {
      const sessionId = await ensureSession(args);
      return rpc('record.start', { session: sessionId });
    },
  },
  {
    name: 'browser_record_stop',
    description: '停止记录并返回录制摘要。',
    inputSchema: { type: 'object', properties: { session: { type: 'string' } }, additionalProperties: false },
    async run(args) {
      const sessionId = await ensureSession(args);
      return rpc('record.stop', { session: sessionId });
    },
  },
  {
    name: 'browser_record_list',
    description: '列出录制历史。',
    inputSchema: { type: 'object', properties: { session: { type: 'string' } }, additionalProperties: false },
    async run(args) {
      const sessionId = await ensureSession(args);
      return rpc('record.list', { session: sessionId });
    },
  },
  {
    name: 'browser_status',
    description: '查看 daemon/browser/session 状态。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() { return rpc('status', {}); },
  },
  {
    name: 'browser_observe',
    description: '观察当前页面，返回带 @eN ref 的语义树；vom=true 时额外返回结构化节点。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string' },
        max_tokens: { type: 'number' },
        vom: { type: 'boolean', description: '返回结构化节点数组（role/name/rect/inputState 等）。' },
      },
      additionalProperties: false,
    },
    async run(args) {
      const sessionId = await ensureSession(args);
      const params = withSession(sessionId, {});
      if (args.max_tokens) params.maxTokens = args.max_tokens;
      if (args.vom) params.vom = true;
      return rpc('observe', params);
    },
  },
  {
    name: 'browser_navigate',
    description: '导航到 URL（等待加载完成）。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, session: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
    async run(args) {
      const sessionId = await ensureSession(args);
      return rpc('navigate', withSession(sessionId, { url: String(args.url) }));
    },
  },
  {
    name: 'browser_click',
    description: '点击元素（ref 或 CSS selector）。',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, selector: { type: 'string' }, session: { type: 'string' } },
      additionalProperties: false,
    },
    async run(args) {
      const sessionId = await ensureSession(args);
      return rpc('click', withSession(sessionId, args.ref ? { ref: args.ref } : { selector: args.selector }));
    },
  },
  {
    name: 'browser_fill',
    description: '向输入框填值（ref 或 selector）。',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' }, selector: { type: 'string' }, value: { type: 'string' },
        no_clear: { type: 'boolean' }, session: { type: 'string' },
      },
      required: ['value'],
      additionalProperties: false,
    },
    async run(args) {
      const sessionId = await ensureSession(args);
      const target = args.ref ? { ref: args.ref } : { selector: args.selector };
      return rpc('fill', withSession(sessionId, { ...target, value: String(args.value), noClear: args.no_clear === true }));
    },
  },
  {
    name: 'browser_read',
    description: '读取元素文本。',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, selector: { type: 'string' }, session: { type: 'string' } },
      additionalProperties: false,
    },
    async run(args) {
      const sessionId = await ensureSession(args);
      return rpc('read', withSession(sessionId, args.ref ? { ref: args.ref } : { selector: args.selector }));
    },
  },
  {
    name: 'browser_extract',
    description: '从容器元素提取结构化数据。',
    inputSchema: {
      type: 'object',
      properties: { selector: { type: 'string' }, session: { type: 'string' } },
      required: ['selector'],
      additionalProperties: false,
    },
    async run(args) {
      const sessionId = await ensureSession(args);
      return rpc('extract', withSession(sessionId, { selector: String(args.selector) }));
    },
  },
  {
    name: 'browser_evaluate',
    description: '在页面主世界执行表达式。',
    inputSchema: {
      type: 'object',
      properties: { expression: { type: 'string' }, session: { type: 'string' } },
      required: ['expression'],
      additionalProperties: false,
    },
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
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() { return rpc('tab.list', {}); },
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
    inputSchema: { type: 'object', properties: { tab_id: { type: 'number' }, session: { type: 'string' } }, required: ['tab_id'], additionalProperties: false },
    async run(args) { return rpc('tab.close', { tabId: args.tab_id }); },
  },
  {
    name: 'browser_tab_select',
    description: '激活标签页。',
    inputSchema: { type: 'object', properties: { tab_id: { type: 'number' }, session: { type: 'string' } }, required: ['tab_id'], additionalProperties: false },
    async run(args) { return rpc('tab.select', { tabId: args.tab_id }); },
  },
  {
    name: 'browser_tab_move',
    description: '把标签页移动到指定窗口。',
    inputSchema: {
      type: 'object',
      properties: { tab_id: { type: 'number' }, window_id: { type: 'number' }, index: { type: 'number' }, session: { type: 'string' } },
      required: ['tab_id', 'window_id'],
      additionalProperties: false,
    },
    async run(args) {
      const params = { tabId: args.tab_id, windowId: args.window_id };
      if (Number.isInteger(args.index)) params.index = args.index;
      return rpc('tab.move', params);
    },
  },
  {
    name: 'browser_debug_start',
    description: '开始调试采集（请求/控制台/页面/性能）。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, bodies: { type: 'boolean' }, session: { type: 'string' } },
      additionalProperties: false,
    },
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
    inputSchema: { type: 'object', properties: { session: { type: 'string' } }, additionalProperties: false },
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
    inputSchema: {
      type: 'object',
      properties: { filter: { type: 'string' }, limit: { type: 'number' }, session: { type: 'string' } },
      additionalProperties: false,
    },
    async run(args) {
      const sessionId = await ensureSession(args);
      const params = withSession(sessionId, {});
      if (args.filter) params.filter = { urlContains: args.filter };
      if (args.limit) params.limit = args.limit;
      return rpc('network.list', params);
    },
  },
  {
    name: 'browser_rule_list',
    description: '列出当前标签页的调试规则。',
    inputSchema: { type: 'object', properties: { session: { type: 'string' } }, additionalProperties: false },
    async run(args) { return rpc('debug.rule_list', withSession(await ensureSession(args), {})); },
  },
  {
    name: 'browser_rule_add',
    description: '添加调试规则（match/effect）。',
    inputSchema: {
      type: 'object',
      properties: { rule: { type: 'object' }, session: { type: 'string' } },
      required: ['rule'],
      additionalProperties: false,
    },
    async run(args) {
      return rpc('debug.rule_add', withSession(await ensureSession(args), { rule: args.rule }));
    },
  },
  {
    name: 'browser_rule_clear',
    description: '清空当前标签页的调试规则。',
    inputSchema: { type: 'object', properties: { session: { type: 'string' } }, additionalProperties: false },
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
    inputSchema: {
      type: 'object',
      properties: { duration: { type: 'string' }, quality: { type: 'string' }, session: { type: 'string' } },
      additionalProperties: false,
    },
    async run(args) {
      const sessionId = await ensureSession(args);
      const params = withSession(sessionId, {});
      if (args.duration) params.duration = String(args.duration);
      if (args.quality) params.quality = String(args.quality);
      return rpc('video.start', params);
    },
  },
  {
    name: 'browser_video_stop',
    description: '停止视频录制。',
    inputSchema: {
      type: 'object',
      properties: { recording_id: { type: 'string' }, session: { type: 'string' } },
      additionalProperties: false,
    },
    async run(args) {
      const params = {};
      if (args.recording_id) params.recordingId = String(args.recording_id);
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
    inputSchema: { type: 'object', properties: { session: { type: 'string' } }, additionalProperties: false },
    async run(args) { return rpc('video.status', withSession(await ensureSession(args), {})); },
  },
  {
    name: 'browser_video_list',
    description: '列出已保存的视频录制。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() { return rpc('video.list', {}); },
  },
  {
    name: 'browser_window',
    description: '窗口路由：action=list|focus|ensure。',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string' }, window_id: { type: 'number' }, session: { type: 'string' } },
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
      throw new Error('action 只能是 list|focus|ensure');
    },
  },
  {
    name: 'browser_wait_for',
    description: '等待元素出现/可见。',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' }, selector: { type: 'string' }, timeout_ms: { type: 'number' }, session: { type: 'string' },
      },
      additionalProperties: false,
    },
    async run(args) {
      const sessionId = await ensureSession(args);
      const target = args.ref ? { ref: args.ref } : { selector: args.selector };
      return rpc('wait-for-element', withSession(sessionId, { ...target, timeoutMs: args.timeout_ms || 5000 }));
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
    description: '处理原生对话框：status / accept / dismiss。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'accept', 'dismiss'] },
        id: { type: 'number' }, text: { type: 'string' }, session: { type: 'string' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async run(args) {
      const sessionId = await ensureSession(args);
      const action = String(args.action);
      if (action === 'status') return rpc('dialog.status', { session: sessionId });
      const method = action === 'accept' ? 'dialog.accept' : 'dialog.dismiss';
      return rpc(method, { session: sessionId, id: args.id, text: args.text });
    },
  },
];

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
