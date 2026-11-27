// mcp/tools-core-b.mjs —— MCP 工具分组。
import fs from 'node:fs';
import path from 'node:path';
import { mcpInputSchema } from '../lib/mcp-schemas.mjs';
import { readUpdateState } from '../lib/update-state.mjs';
import { parseHarReplayEntries, findHarReplayEntry } from '../lib/har-replay.mjs';
import { summarizeTrace } from '../lib/trace-summary.mjs';

export function createCoreBTools({ rpc, ensureSession, withSession, parseDurationMs, runCliJson, HOME }) {
  const TOOLS = [
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
        const params = { expression: String(args.expression) };
        if (args.unverified === true) params.unverified = true;
        return rpc('evaluate', withSession(sessionId, params));
      },
    },
    {
      name: 'browser_screenshot',
      description: '截图并保存到 out 路径。',
      inputSchema: {
        type: 'object',
        properties: {
          out: { type: 'string' }, full_page: { type: 'boolean' }, scope: { type: 'string', enum: ['viewport', 'full', 'follow', 'current'] },
          tile_size: { type: 'integer', minimum: 256, maximum: 8192 }, stale_attempts: { type: 'integer', minimum: 1, maximum: 3 }, segmented: { type: 'boolean' },
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
        if (Number.isFinite(args.tile_size)) params.tileSize = Math.max(256, Math.min(8192, Math.round(args.tile_size)));
        if (Number.isFinite(args.stale_attempts)) params.staleAttempts = Math.max(1, Math.min(3, Math.round(args.stale_attempts)));
        if (args.segmented === false) params.segmented = false;
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
        return { ok: true, path: target, width: result.width, height: result.height, bytes: fs.statSync(target).size, tile_size: result.tile_size ?? (Number.isFinite(params.tileSize) ? params.tileSize : null), tiles: result.tiles, segments: result.segments, complete: result.complete, longshot_id: result.longshot_id };
      },
    },
    {
      name: 'browser_longshot_recover',
      description: '从落盘 tile 恢复长截图并保存到 out 路径。',
      inputSchema: {
        type: 'object',
        properties: { longshot_id: { type: 'string' }, out: { type: 'string' }, session: { type: 'string' } },
        required: ['longshot_id', 'out'],
        additionalProperties: false,
      },
      async run(args) {
        const sessionId = await ensureSession(args);
        const result = await rpc('longshot.recover', withSession(sessionId, { longshotId: String(args.longshot_id) }), 120000);
        const dataUrl = String(result.dataUrl || '');
        const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
        if (!base64) throw new Error('longshot.recover 没有返回数据');
        const target = path.resolve(process.cwd(), String(args.out));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.from(base64, 'base64'));
        return { ok: true, path: target, width: result.width, height: result.height, tiles: result.tiles, complete: result.complete, bytes: fs.statSync(target).size };
      },
    },
    {
      name: 'browser_download',
      description: '点击下载目标或按 URL 下载到 out 路径。',
      inputSchema: {
        type: 'object',
        properties: { target: { type: 'string' }, url: { type: 'string' }, out: { type: 'string' }, overwrite: { type: 'boolean' }, session: { type: 'string' } },
        additionalProperties: false,
      },
      async run(args) {
        const cli = ['download'];
        if (args.target) cli.push(String(args.target));
        else if (args.url) cli.push('--url', String(args.url));
        else throw new Error('download 需要 target 或 url');
        if (args.out) cli.push('--out', String(args.out));
        if (args.overwrite === true) cli.push('--overwrite');
        if (args.session) cli.push('--session', String(args.session));
        return runCliJson(cli);
      },
    },
    {
      name: 'browser_upload',
      description: '把本地文件写入 input[type=file]（ref 或 selector）。',
      inputSchema: {
        type: 'object',
        properties: { target: { type: 'string' }, files: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 }, session: { type: 'string' } },
        required: ['target', 'files'],
        additionalProperties: false,
      },
      async run(args) {
        const sessionId = await ensureSession(args);
        const files = args.files.map((item) => {
          const file = path.resolve(process.cwd(), String(item));
          const data = fs.readFileSync(file);
          return { name: path.basename(file), base64: data.toString('base64') };
        });
        const target = String(args.target);
        const params = target.startsWith('@e') ? { ref: target } : { selector: target };
        return rpc('upload', withSession(sessionId, { ...params, files, paths: args.files.map((item) => path.resolve(process.cwd(), String(item))) }));
      },
    },
    {
      name: 'browser_pdf',
      description: '导出当前页面为 PDF 并保存到 out 路径。',
      inputSchema: {
        type: 'object',
        properties: {
          out: { type: 'string' },
          landscape: { type: 'boolean' },
          print_background: { type: 'boolean' },
          page_ranges: { type: 'string', description: '如 "1-3,5"' },
          margins: { type: 'object', description: '{ top, right, bottom, left }（英寸）' },
          scale: { type: 'number', minimum: 0.1, maximum: 2 },
          session: { type: 'string' },
        },
        required: ['out'],
        additionalProperties: false,
      },
      async run(args) {
        const sessionId = await ensureSession(args);
        const params = withSession(sessionId, {
          landscape: args.landscape === true,
          printBackground: args.print_background !== false,
        });
        if (args.page_ranges) params.pages = String(args.page_ranges);
        if (args.margins) params.margins = args.margins;
        if (Number.isFinite(args.scale)) params.scale = args.scale;
        const result = await rpc('pdf', params, 60000);
        const base64 = String(result.base64 || '');
        if (!base64) throw new Error('pdf 没有返回数据');
        const target = path.resolve(process.cwd(), String(args.out));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, Buffer.from(base64, 'base64'));
        return { ok: true, path: target, bytes: fs.statSync(target).size };
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
      name: 'browser_refs_negotiate',
      description: '按 stableRef 重新确认引用是否仍指向当前文档节点。',
      inputSchema: {
        type: 'object',
        properties: { stable_refs: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 }, session: { type: 'string' } },
        required: ['stable_refs'],
        additionalProperties: false,
      },
      async run(args) {
        const sessionId = await ensureSession(args);
        return rpc('refs.negotiate', withSession(sessionId, { stableRefs: args.stable_refs.map(String).slice(0, 50) }));
      },
    },
    {
      name: 'browser_trace_start',
      description: '开始 CDP 性能追踪（trace.start）。',
      inputSchema: mcpInputSchema('trace.start', { extra: { categories: { type: 'string', description: 'CDP categories，默认 devtools.timeline,v8.execute,blink.user_timing' } } }),
      async run(args) {
        const sessionId = await ensureSession(args);
        const params = withSession(sessionId, {});
        if (args.categories) params.categories = String(args.categories);
        return rpc('trace.start', params);
      },
    },
    {
      name: 'browser_trace_stop',
      description: '停止性能追踪，返回 summary；可把 Trace JSON 写到本地文件。',
      inputSchema: mcpInputSchema('trace.stop', { extra: { output: { type: 'string', description: '可选：trace JSON 输出路径' } } }),
      async run(args) {
        const sessionId = await ensureSession(args);
        const result = await rpc('trace.stop', withSession(sessionId, {}));
        const { trace, ...rest } = result || {};
        if (args.output && trace) {
          const target = path.resolve(process.cwd(), String(args.output));
          fs.writeFileSync(target, trace, 'utf8');
          return { ...rest, path: target, bytes: Buffer.byteLength(trace) };
        }
        return rest;
      },
    },
    {
      name: 'browser_trace_summary',
      description: '离线分析 Trace JSON：事件数/时长/分类/热点/长任务。',
      inputSchema: { type: 'object', properties: { file: { type: 'string', description: 'Trace JSON 路径' } }, required: ['file'], additionalProperties: false },
      async run(args) {
        const trace = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), String(args.file)), 'utf8'));
        return summarizeTrace(trace);
      },
    },
  ];
  return TOOLS;
}
