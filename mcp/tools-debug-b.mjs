// mcp/tools-debug-b.mjs —— MCP 工具分组。
import fs from 'node:fs';
import path from 'node:path';
import { mcpInputSchema } from '../lib/mcp-schemas.mjs';
import { readUpdateState } from '../lib/update-state.mjs';
import { parseHarReplayEntries, findHarReplayEntry } from '../lib/har-replay.mjs';
import { summarizeTrace } from '../lib/trace-summary.mjs';

export function createDebugBTools({ rpc, ensureSession, withSession, parseDurationMs, runCliJson, HOME, state = {} }) {
  const TOOLS = [
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
        properties: { action: { type: 'string', enum: ['enable', 'disable', 'remove'] }, id: { type: 'integer' }, session: { type: 'string' } },
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
        const sessionId = args.session || state.sessionId || null;
        return rpc('video.list', sessionId ? { session: sessionId } : {});
      },
    },
    {
      name: 'browser_video_trim',
      description: '本地 MP4 裁剪（不转码）。',
      inputSchema: {
        type: 'object',
        properties: { input: { type: 'string' }, out: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' } },
        required: ['input', 'out'],
        additionalProperties: false,
      },
      async run(args) {
        const cli = ['video', 'trim', String(args.input), '--out', String(args.out)];
        if (args.start) cli.push('--start', String(args.start));
        if (args.end) cli.push('--end', String(args.end));
        return runCliJson(cli);
      },
    },
    {
      name: 'browser_video_info',
      description: '本地 MP4 信息（编码/尺寸/帧数/时长）。',
      inputSchema: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'], additionalProperties: false },
      async run(args) { return runCliJson(['video', 'info', String(args.input)]); },
    },
    {
      name: 'browser_video_split',
      description: '本地 MP4 按 GOP 分段。',
      inputSchema: {
        type: 'object',
        properties: { input: { type: 'string' }, out_dir: { type: 'string' }, parts: { type: 'integer', minimum: 2, maximum: 10 } },
        required: ['input', 'out_dir'],
        additionalProperties: false,
      },
      async run(args) {
        const cli = ['video', 'split', String(args.input), '--out-dir', String(args.out_dir)];
        if (args.parts) cli.push('--parts', String(args.parts));
        return runCliJson(cli);
      },
    },
    {
      name: 'browser_video_merge',
      description: '本地 MP4 合并（要求编码/分辨率一致，不转码）。',
      inputSchema: {
        type: 'object',
        properties: { inputs: { type: 'array', items: { type: 'string' }, minItems: 2 }, out: { type: 'string' } },
        required: ['inputs', 'out'],
        additionalProperties: false,
      },
      async run(args) {
        const inputs = (Array.isArray(args.inputs) ? args.inputs : []).map(String);
        if (inputs.length < 2) throw new Error('video merge 需要至少两个输入');
        return runCliJson(['video', 'merge', ...inputs, '--out', String(args.out)]);
      },
    },
    {
      name: 'browser_window',
      description: '窗口路由：action=list|focus|ensure|resize。',
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['list', 'focus', 'ensure', 'resize'] }, window_id: { type: 'number', minimum: 0 }, width: { type: 'number', minimum: 1 }, height: { type: 'number', minimum: 1 }, session: { type: 'string' } },
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
          id: { type: 'number', minimum: 1 }, text: { type: 'string' }, session: { type: 'string' },
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
  return TOOLS;
}
