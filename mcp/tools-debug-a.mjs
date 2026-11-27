// mcp/tools-debug-a.mjs —— MCP 工具分组。
import fs from 'node:fs';
import path from 'node:path';
import { mcpInputSchema } from '../lib/mcp-schemas.mjs';
import { readUpdateState } from '../lib/update-state.mjs';
import { parseHarReplayEntries, findHarReplayEntry } from '../lib/har-replay.mjs';
import { summarizeTrace } from '../lib/trace-summary.mjs';

export function createDebugATools({ rpc, ensureSession, withSession, parseDurationMs, runCliJson, HOME }) {
  const TOOLS = [
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
      name: 'browser_network_replay_har',
      description: '从本地 HAR 选择一条请求，通过页面 fetch 重放。',
      inputSchema: {
        type: 'object',
        properties: { file: { type: 'string' }, entry: { type: 'integer', minimum: 0 }, filter: { type: 'string' }, session: { type: 'string' } },
        required: ['file'],
        additionalProperties: false,
      },
      async run(args) {
        const har = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), String(args.file)), 'utf8'));
        const entries = parseHarReplayEntries(har);
        if (!entries.length) throw new Error('HAR 没有可重放请求');
        const entry = findHarReplayEntry(entries, {
          index: Number.isInteger(args.entry) ? args.entry : null,
          urlContains: args.filter ? String(args.filter) : '',
        });
        if (!entry) throw new Error('没有匹配的 HAR 请求');
        const sessionId = await ensureSession(args);
        const request = { url: entry.url, method: entry.method, headers: entry.headers, ...(entry.body != null ? { body: entry.body } : {}) };
        return rpc('network.replay', withSession(sessionId, { request, id: entry.index }), 120000);
      },
    },
    {
      name: 'browser_debug_har',
      description: '把当前调试采集导出为 HAR 1.2。',
      inputSchema: { type: 'object', properties: { out: { type: 'string' }, session: { type: 'string' } }, required: ['out'], additionalProperties: false },
      async run(args) {
        const sessionId = await ensureSession(args);
        return runCliJson(['debug', 'har', '--output', String(args.out), '--session', sessionId]);
      },
    },
    {
      name: 'browser_debug_har_import',
      description: '把本地 HAR 导入为 debug archive 快照。',
      inputSchema: {
        type: 'object',
        properties: { file: { type: 'string' }, out: { type: 'string' }, name: { type: 'string' } },
        required: ['file', 'out'],
        additionalProperties: false,
      },
      async run(args) {
        const cli = ['debug', 'har-import', String(args.file), '--output', String(args.out)];
        if (args.name) cli.push('--name', String(args.name));
        return runCliJson(cli);
      },
    },
    {
      name: 'browser_network_waterfall',
      description: '把当前网络采集转成相对时间轴/慢请求/分类/错误统计。',
      inputSchema: mcpInputSchema('network.waterfall', { extra: { limit: { type: 'integer', minimum: 1, maximum: 2000 } } }),
      async run(args) {
        const sessionId = await ensureSession(args);
        const params = withSession(sessionId, {});
        if (Number.isFinite(args.limit) && args.limit > 0) params.limit = Math.min(Number(args.limit), 2000);
        return rpc('network.waterfall', params);
      },
    },
  ];
  return TOOLS;
}
