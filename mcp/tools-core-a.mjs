// mcp/tools-core-a.mjs —— MCP 工具分组。
import fs from 'node:fs';
import path from 'node:path';
import { mcpInputSchema } from '../lib/mcp-schemas.mjs';
import { readUpdateState } from '../lib/update-state.mjs';
import { parseHarReplayEntries, findHarReplayEntry } from '../lib/har-replay.mjs';
import { summarizeTrace } from '../lib/trace-summary.mjs';

export function createCoreATools({ rpc, ensureSession, withSession, parseDurationMs, runCliJson, HOME, state = {} }) {
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
      inputSchema: { type: 'object', properties: { limit: { type: 'number', minimum: 1, maximum: 500 }, offset: { type: 'number' } }, additionalProperties: false },
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
        properties: { action: { type: 'string', enum: ['get', 'set'] }, settings: { type: 'object' } },
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
        properties: { action: { type: 'string', enum: ['create', 'list', 'redeem', 'revoke'] }, code: { type: 'string' }, ttl: { type: 'string' }, label: { type: 'string' } },
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
          action: { type: 'string', enum: ['list', 'show', 'save', 'approve', 'run', 'rm'] },
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
          action: { type: 'string', enum: ['state', 'check', 'fetch', 'auto'] },
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
      description: '观察当前页面，返回带 @eN ref 的语义树；vom=true 时额外返回结构化节点；facts=true 时附加 DOMSnapshot 几何/可见性/表单事实；ax=true 时附加 tables/unmappedAx。',
      inputSchema: mcpInputSchema('observe', { omit: ['sessionId', 'tabId'] }),
      async run(args) {
        const sessionId = await ensureSession(args);
        const params = withSession(sessionId, {});
        const mapping = {
          probe_hover: 'probeHover', debug_surfaces: 'debugSurfaces', closed_shadow: 'closedShadow',
          vom: 'vom', ax: 'ax', facts: 'facts', fallback_ax: 'fallbackAx', max_tokens: 'maxTokens', max_depth: 'maxDepth', cursor: 'cursor',
          vom_deep: 'vomDeep', vom_tree: 'vomTree', vom_rank: 'vomRank', vom_top: 'vomTop',
          vom_min_score: 'vomMinScore', vom_max_nodes: 'vomMaxNodes', vom_max_tokens: 'vomMaxTokens',
          vom_profile: 'vomProfile', vom_explain: 'vomExplain', vom_exclude_hidden: 'vomExcludeHidden', vom_per_group: 'vomPerGroup', vom_group_tokens: 'vomGroupTokens', vom_billing_model: 'vomBillingModel', vom_semantic_max_groups: 'vomSemanticMaxGroups', vom_semantic_min_score: 'vomSemanticMinScore', vom_semantic_max_tokens: 'vomSemanticMaxTokens', vom_group_context: 'vomGroupContext',
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
      name: 'browser_click_backend',
      description: '按 backendNodeId 点击 AX/DOMSnapshot 发现但没有 @eN ref 的元素（closed shadow、page-lib 漏掉的节点）。先用 observe --ax --vom 从 unmappedAx 取 backendNodeId。',
      inputSchema: mcpInputSchema('click-backend', { omit: ['sessionId', 'tabId'] }),
      async run(args) {
        const sessionId = await ensureSession(args);
        const backendId = Number(args.backend_id);
        return rpc('click-backend', withSession(sessionId, { backendId }));
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
  ];
  return TOOLS;
}
