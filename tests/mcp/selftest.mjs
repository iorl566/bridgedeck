#!/usr/bin/env node
// tests/mcp/selftest.mjs —— MCP server 协议面自测（不需要浏览器）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-mcp-test-'));
const server = spawn(process.execPath, [path.join(ROOT, 'mcp', 'server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, BB_HOME: home, BB_MCP_APPROVAL: 'required' },
});

const pending = new Map();
const rawMessages = [];
const notifications = [];
let seq = 0;
const rl = readline.createInterface({ input: server.stdout });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  rawMessages.push(message);
  if (message.id === undefined || message.id === null) {
    notifications.push(message);
    return;
  }
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  entry(message);
});

function sendRaw(message) {
  server.stdin.write(JSON.stringify(message) + '\n');
}

/** 原样写一行（用于构造非法 JSON 等信封边界用例）。 */
function sendRawLine(text) {
  server.stdin.write(String(text) + '\n');
}

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitFor(predicate, timeoutMs = 3000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(intervalMs);
  }
  return false;
}

/** fake daemon：记录 RPC、把 observe 拖慢 1200ms、支持 inflight.list/command.cancel。 */
const daemonState = { requests: [], inflight: new Map(), observeResponses: 0, seq: 0, server: null };

function startFakeDaemon() {
  return new Promise((resolve, reject) => {
    daemonState.server = http.createServer((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        let payload = {};
        try { payload = JSON.parse(body || '{}'); } catch { /* 忽略非法 JSON */ }
        const method = String(payload.method || '');
        const params = payload.params || {};
        daemonState.requests.push({ method, params });
        const reply = (result) => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true, result }));
        };
        if (method === 'session.start') return reply({ sessionId: 's-fake' });
        if (method === 'session.stop') return reply({ stopped: true });
        if (method === 'status') return reply({ ok: true, daemon: 'fake' });
        if (method === 'dialog.status') return reply({ pending: false, armed: false });
        if (method === 'inflight.list') return reply({ inflight: [...daemonState.inflight.values()] });
        if (method === 'command.cancel') {
          const entry = daemonState.inflight.get(params.id);
          if (!entry) return reply({ id: params.id, forwarded: false, accepted: false });
          daemonState.inflight.delete(params.id);
          return reply({ id: params.id, forwarded: true, accepted: true });
        }
        if (method === 'observe') {
          const id = 'cmd-' + (daemonState.seq += 1);
          daemonState.inflight.set(id, { id, instanceId: 'inst-fake', method: 'observe', tabId: 1, startedAt: Date.now() });
          setTimeout(() => {
            daemonState.inflight.delete(id);
            daemonState.observeResponses += 1;
            reply({ session: 's-fake', url: 'https://fake.test/', title: 'Fake Page', refs: 2, observation: '@e1 fake button', truncated: false });
          }, 1200);
          return undefined;
        }
        return reply({ ok: true, method });
      });
    });
    daemonState.server.on('error', reject);
    daemonState.server.listen(0, '127.0.0.1', () => resolve(daemonState.server.address().port));
  });
}

/** 用同一个 BB_HOME 另起一个 MCP server，读取若干请求后退出（验证重启恢复）。 */
function runOneShotMcpServer(lines, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'mcp', 'server.mjs')], {
      cwd: ROOT,
      env: { ...process.env, BB_HOME: home },
    });
    const messages = [];
    const childReader = readline.createInterface({ input: child.stdout });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('一次性 MCP server 超时'));
    }, timeoutMs);
    const maybeDone = () => {
      if (messages.filter((message) => message.id !== undefined && message.id !== null).length < lines.length) return;
      clearTimeout(timer);
      try { child.stdin.end(); } catch { /* 忽略 */ }
      child.kill();
      childReader.close();
      resolve({ messages });
    };
    childReader.on('line', (line) => {
      if (!line.trim()) return;
      try { messages.push(JSON.parse(line)); } catch { /* 忽略 */ }
      maybeDone();
    });
    for (const line of lines) child.stdin.write(JSON.stringify(line) + '\n');
  });
}

function rpc(method, params) {
  const id = ++seq;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MCP 响应超时: ' + method)), 10000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return promise;
}

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail });
  console.log((condition ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' — ' + detail : ''));
}

const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest' } });
check('initialize 返回 serverInfo', init.result && init.result.serverInfo && init.result.serverInfo.name === 'browser-bridge', JSON.stringify(init.result && init.result.serverInfo));
check('initialize 声明 tools 能力', Boolean(init.result && init.result.capabilities && init.result.capabilities.tools));

const list = await rpc('tools/list', {});
const tools = (list.result && list.result.tools) || [];
check('tools/list 至少 10 个工具', tools.length >= 10, String(tools.length));
check('包含 plan 工具', tools.some((tool) => tool.name === 'browser_plan'));
check('包含 trace 工具', tools.some((tool) => tool.name === 'browser_trace_start') && tools.some((tool) => tool.name === 'browser_trace_stop'));
check('包含 download 工具', tools.some((tool) => tool.name === 'browser_download'));
check('包含 upload 工具', tools.some((tool) => tool.name === 'browser_upload'));
check('包含 debug_har 工具', tools.some((tool) => tool.name === 'browser_debug_har') && tools.some((tool) => tool.name === 'browser_debug_har_import'));
check('包含 refs_negotiate 工具', tools.some((tool) => tool.name === 'browser_refs_negotiate'));
check('包含 network_replay_har 工具', tools.some((tool) => tool.name === 'browser_network_replay_har'));
check('包含 video_recover 工具', tools.some((tool) => tool.name === 'browser_video_recover'));
check('包含 video_merge 工具', tools.some((tool) => tool.name === 'browser_video_merge'));
check('包含 longshot_recover 工具', tools.some((tool) => tool.name === 'browser_longshot_recover'));
check('包含 network_waterfall 工具', tools.some((tool) => tool.name === 'browser_network_waterfall'));
check('包含 pdf 工具', tools.some((tool) => tool.name === 'browser_pdf'));
check('每个工具都有 inputSchema', tools.every((tool) => tool.inputSchema && tool.inputSchema.type === 'object'));

// M6-P0①：兼容基线 MCP 直接动作入口（press/hover/select/drag/scroll_to/wheel/focus/blur、
// back/forward/reload/console、tracked session request_*、tab borrow/return）必须在
// tools/list 里出现，且 schema/审批分级与 mcp/tool-policy.mjs 的派生一致。
const M6_INPUT_TOOLS = ['browser_press', 'browser_hover', 'browser_select', 'browser_drag', 'browser_scroll_to', 'browser_wheel', 'browser_focus', 'browser_blur'];
const M6_NAV_TOOLS = ['browser_back', 'browser_forward', 'browser_reload', 'browser_console'];
const M6_REQUEST_TOOLS = ['browser_session_request_prepare', 'browser_session_request_status', 'browser_session_request_claim', 'browser_session_request_cancel'];
const M6_TAB_TOOLS = ['browser_tab_borrow', 'browser_tab_return'];
const M6_NEW_TOOLS = [...M6_INPUT_TOOLS, ...M6_NAV_TOOLS, ...M6_REQUEST_TOOLS, ...M6_TAB_TOOLS];
// M6-P0②：剩余 MCP 动作入口（inspect:html / assist 4 个 action / session browsers+list）。
const M6B_INSPECT_TOOLS = ['browser_inspect_html'];
const M6B_ASSIST_TOOLS = ['browser_assist_emulate', 'browser_assist_request_help', 'browser_assist_operation_await', 'browser_assist_operation_cancel'];
const M6B_SESSION_TOOLS = ['browser_session_browsers', 'browser_session_list'];
const M6B_NEW_TOOLS = [...M6B_INSPECT_TOOLS, ...M6B_ASSIST_TOOLS, ...M6B_SESSION_TOOLS];
const listedToolNames = new Set(tools.map((tool) => tool.name));
const m6Tool = (name) => tools.find((tool) => tool.name === name);
check('MCP 工具总数为 92（67 既有 + 18 M6-P0① + 7 M6-P0②）', tools.length === 92, String(tools.length));
check('包含 M6 输入工具（press/hover/select/drag/scroll_to/wheel/focus/blur）', M6_INPUT_TOOLS.every((name) => listedToolNames.has(name)));
check('包含 M6 导航/观测工具（back/forward/reload/console）', M6_NAV_TOOLS.every((name) => listedToolNames.has(name)));
check('包含 M6 tracked session 请求工具（prepare/status/claim/cancel）', M6_REQUEST_TOOLS.every((name) => listedToolNames.has(name)));
check('包含 M6 tab 借用/归还工具（borrow/return）', M6_TAB_TOOLS.every((name) => listedToolNames.has(name)));
check('包含 M6-P0② 剩余动作工具（inspect html / assist / session 查询）', M6B_NEW_TOOLS.every((name) => listedToolNames.has(name)));
check('M6 新工具 inputSchema 都是封闭对象', [...M6_NEW_TOOLS, ...M6B_NEW_TOOLS].every((name) => {
  const tool = m6Tool(name);
  return Boolean(tool) && tool.inputSchema.type === 'object' && tool.inputSchema.additionalProperties === false
    && tool.inputSchema.properties && typeof tool.inputSchema.properties === 'object';
}));
check('M6 新工具审批分级：输入/导航 mutate、console/request_status read', [
  ...M6_INPUT_TOOLS, ...M6_REQUEST_TOOLS.filter((name) => name !== 'browser_session_request_status'),
  'browser_tab_borrow', 'browser_tab_return', 'browser_back', 'browser_forward', 'browser_reload',
].every((name) => {
  const tool = m6Tool(name);
  return Boolean(tool) && tool._meta && tool._meta['browser-bridge/policy'] && tool._meta['browser-bridge/policy'].tier === 'mutate';
}) && ['browser_console', 'browser_session_request_status'].every((name) => {
  const tool = m6Tool(name);
  return Boolean(tool) && tool._meta && tool._meta['browser-bridge/policy'] && tool._meta['browser-bridge/policy'].tier === 'read';
}));
check('M6-P0② 新工具审批分级：emulate/request_help/operation_cancel mutate、inspect_html/operation_await/browsers/list read',
  ['browser_assist_emulate', 'browser_assist_request_help', 'browser_assist_operation_cancel'].every((name) => {
    const tool = m6Tool(name);
    return Boolean(tool) && tool._meta && tool._meta['browser-bridge/policy'] && tool._meta['browser-bridge/policy'].tier === 'mutate';
  }) && ['browser_inspect_html', 'browser_assist_operation_await', 'browser_session_browsers', 'browser_session_list'].every((name) => {
    const tool = m6Tool(name);
    return Boolean(tool) && tool._meta && tool._meta['browser-bridge/policy'] && tool._meta['browser-bridge/policy'].tier === 'read';
  }));
check('M6-P0② request_help 必填 reason', (() => {
  const tool = m6Tool('browser_assist_request_help');
  return Boolean(tool) && Array.isArray(tool.inputSchema.required) && tool.inputSchema.required.includes('reason');
})());
check('M6 新工具带审批分级与超时元数据', M6_NEW_TOOLS.every((name) => {
  const tool = m6Tool(name);
  const policy = tool && tool._meta && tool._meta['browser-bridge/policy'];
  return Boolean(policy) && typeof policy.timeoutMs === 'number' && policy.timeoutMs > 0
    && ['none', 'confirm', 'mandatory'].includes(policy.approvalGrade);
}));

const unknown = await rpc('tools/nope', {});
check('未知方法返回 -32601', unknown.error && unknown.error.code === -32601, JSON.stringify(unknown.error));

const unknownTool = await rpc('tools/call', { name: 'browser_nope', arguments: {} });
check('未知工具 isError', unknownTool.result && unknownTool.result.isError === true);

const status = await rpc('tools/call', { name: 'browser_status', arguments: {} });
const statusText = status.result && status.result.content && status.result.content[0].text;
check('无 daemon 时 browser_status 返回 E_DAEMON', status.result.isError === true && String(statusText).includes('E_DAEMON'), String(statusText).slice(0, 120));
const statusErrorMeta = status.result && status.result._meta && status.result._meta['browser-bridge/error'];
check('工具错误 _meta 带结构化恢复映射', Boolean(statusErrorMeta)
  && statusErrorMeta.category === 'transport'
  && statusErrorMeta.terminal === true
  && statusErrorMeta.retryable === false
  && statusErrorMeta.retryReason === 'non-retryable-code'
  && statusErrorMeta.jsonRpcCode === -32603
  && statusErrorMeta.tool === 'browser_status', JSON.stringify(statusErrorMeta));

const ping = await rpc('ping', {});
check('ping 返回空结果', ping.result && Object.keys(ping.result).length === 0);

// ---------------------------------------------------------------------------
// 第十批-B：信封层边界 / 协议版本协商 / completion / 新能力声明
// ---------------------------------------------------------------------------
check('initialize 声明 completions 能力', Boolean(init.result && init.result.capabilities && init.result.capabilities.completions));
check('initialize 声明 wire 扩展（batch=false / 默认协议版本）', Boolean(init.result.capabilities.experimental['browser-bridge/wire'])
  && init.result.capabilities.experimental['browser-bridge/wire'].batch === false
  && init.result.capabilities.experimental['browser-bridge/wire'].defaultProtocolVersion === '2024-11-05'
  && init.result.capabilities.experimental['browser-bridge/wire'].jsonrpc === '2.0',
  JSON.stringify(init.result.capabilities.experimental['browser-bridge/wire'] && init.result.capabilities.experimental['browser-bridge/wire'].defaultProtocolVersion));
const newExperimentalKeys = ['browser-bridge/list-pagination', 'browser-bridge/resource-index', 'browser-bridge/approval', 'browser-bridge/error-map', 'browser-bridge/completions'];
check('initialize 声明第十批-B 的五个扩展能力', newExperimentalKeys.every((key) => Boolean(init.result.capabilities.experimental[key]))
  && init.result.capabilities.experimental['browser-bridge/error-map'].metaKey === 'browser-bridge/error',
  JSON.stringify(newExperimentalKeys.filter((key) => !init.result.capabilities.experimental[key])));
check('initialize 声明 resources.listPagination', Boolean(init.result.capabilities.resources.listPagination)
  && init.result.capabilities.resources.listPagination.cursorParam === 'cursor'
  && init.result.capabilities.resources.listPagination.opaque === true);
check('initialize 声明审批分级快照', Boolean(init.result.capabilities.experimental['browser-bridge/approval'])
  && init.result.capabilities.experimental['browser-bridge/approval'].mandatory.includes('browser_update')
  && init.result.capabilities.experimental['browser-bridge/approval'].grades.NONE === 'none');

const negotiated = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'selftest-negotiate' } });
check('协议版本协商：支持版本原样返回', negotiated.result && negotiated.result.protocolVersion === '2025-03-26'
  && negotiated.result.capabilities.experimental['browser-bridge/wire'].negotiated.supported === true,
  negotiated.result && negotiated.result.protocolVersion);
const negotiatedUnknown = await rpc('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'selftest-negotiate' } });
check('协议版本协商：未知版本回退默认并标记 fallback', negotiatedUnknown.result.protocolVersion === '2024-11-05'
  && negotiatedUnknown.result.capabilities.experimental['browser-bridge/wire'].negotiated.fallback === true);

const completionEnum = await rpc('completion/complete', {
  ref: { type: 'ref/prompt', name: 'har_analysis' },
  argument: { name: 'focus', value: '' },
});
check('completion/complete 返回 prompt 枚举候选', completionEnum.result && completionEnum.result.completion
  && completionEnum.result.completion.values.length >= 2
  && completionEnum.result.completion.values.includes('errors'), JSON.stringify(completionEnum.result && completionEnum.result.completion));
const completionFiltered = await rpc('completion/complete', {
  ref: { type: 'ref/prompt', name: 'har_analysis' },
  argument: { name: 'focus', value: 'err' },
});
check('completion/complete 按前缀过滤', completionFiltered.result.completion.values.length === 1
  && completionFiltered.result.completion.values[0] === 'errors');
const completionFree = await rpc('completion/complete', {
  ref: { type: 'ref/prompt', name: 'browser_task_brief' },
  argument: { name: 'task', value: 'x' },
});
check('completion/complete 自由文本参数返回空候选 + freeForm', completionFree.result.completion.values.length === 0
  && completionFree.result._meta['browser-bridge/completion'].freeForm === true);
const completionSkill = await rpc('completion/complete', {
  ref: { type: 'ref/resource', uri: 'bridge://skill/references/{name}' },
  argument: { name: 'name', value: '' },
});
check('completion/complete 补全技能参考名', completionSkill.result.completion.values.includes('environment.md')
  && completionSkill.result._meta['browser-bridge/completion'].source === 'skill-references');
const completionUnknown = await rpc('completion/complete', {
  ref: { type: 'ref/prompt', name: 'nope_prompt' },
  argument: { name: 'x', value: '' },
});
check('completion/complete 未知 prompt 返回 -32602', completionUnknown.error && completionUnknown.error.code === -32602 && /E_NOT_FOUND/.test(completionUnknown.error.message), JSON.stringify(completionUnknown.error));
const completionWrongArg = await rpc('completion/complete', {
  ref: { type: 'ref/resource', uri: 'bridge://observation/{session}' },
  argument: { name: 'wrong', value: '' },
});
check('completion/complete 变量名不匹配返回 -32602', completionWrongArg.error && completionWrongArg.error.code === -32602);

// 信封层边界：直接用原始行驱动（批量/坏 JSON/params 形状/通知不回帧）。
const envelopeBaseline = rawMessages.length;
sendRaw([{ jsonrpc: '2.0', id: 501, method: 'ping' }]);
sendRawLine('{not json');
sendRaw({ jsonrpc: '2.0', id: 502, method: 'ping', params: [1, 2] });
const gotEnvelopeErrors = await waitFor(() => {
  const frame = rawMessages.slice(envelopeBaseline);
  return frame.some((message) => message.error && message.error.code === -32600)
    && frame.some((message) => message.error && message.error.code === -32700)
    && frame.some((message) => message.error && message.error.code === -32602);
}, 4000);
const envelopeFrames = rawMessages.slice(envelopeBaseline);
check('批量数组按 -32600 拒绝', gotEnvelopeErrors && envelopeFrames.some((message) => message.error
  && message.error.code === -32600 && /batch/.test(message.error.message)), JSON.stringify(envelopeFrames.map((message) => message.error && message.error.code)));
check('坏 JSON 行按 -32700 拒绝（id=null）', envelopeFrames.some((message) => message.error && message.error.code === -32700 && message.id === null));
check('params 非对象按 -32602 拒绝', envelopeFrames.some((message) => message.error && message.error.code === -32602));
sendRaw({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
sendRaw({ jsonrpc: '2.0', method: 'notifications/unknown', params: {} });
sendRaw({ jsonrpc: '2.0', id: 503, method: 'ping', params: {} });
const gotPingAfterNotifications = await waitFor(() => rawMessages.some((message) => message.id === 503), 3000);
await delay(120);
const framesAfterNotifications = rawMessages.filter((message) => message.id === 503 || message.id === 504);
check('通知不回帧（未知通知静默忽略）', gotPingAfterNotifications && framesAfterNotifications.length === 1
  && framesAfterNotifications[0].id === 503, JSON.stringify(framesAfterNotifications.map((message) => message.id)));

// ---------------------------------------------------------------------------
// W4-A：工具分级 / annotations / 审批 / 运行时参数校验
// ---------------------------------------------------------------------------
check('initialize 声明 resources 能力', Boolean(init.result && init.result.capabilities && init.result.capabilities.resources));
check('initialize 声明 prompts 能力', Boolean(init.result && init.result.capabilities && init.result.capabilities.prompts));
check('initialize 带 instructions', typeof (init.result && init.result.instructions) === 'string' && init.result.instructions.includes('approval'));

const annotated = tools.filter((tool) => tool.annotations && typeof tool.annotations === 'object');
check('tools/list 每个工具都有 annotations', annotated.length === tools.length, annotated.length + '/' + tools.length);
check('annotations 含四个 hint', tools.every((tool) => ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].every((key) => typeof tool.annotations[key] === 'boolean')));
check('annotations 有可读 title', tools.every((tool) => typeof tool.annotations.title === 'string' && tool.annotations.title.length > 0));
const observeTool = tools.find((tool) => tool.name === 'browser_observe');
const evaluateTool = tools.find((tool) => tool.name === 'browser_evaluate');
check('browser_observe 是 readOnly', observeTool && observeTool.annotations.readOnlyHint === true && observeTool.annotations.destructiveHint === false);
check('browser_evaluate 是 destructive', evaluateTool && evaluateTool.annotations.destructiveHint === true && evaluateTool.annotations.readOnlyHint === false);
check('没有工具同时 readOnly 与 destructive', tools.every((tool) => !(tool.annotations.readOnlyHint && tool.annotations.destructiveHint)));

// 第十批-B：审批分级（none/confirm/mandatory）与顶层分级统计
const gradeOf = (name) => {
  const tool = tools.find((row) => row.name === name);
  return tool && tool._meta['browser-bridge/policy'].approvalGrade;
};
check('tools/list 每个工具带 approvalGrade', tools.every((tool) => ['none', 'confirm', 'mandatory'].includes(tool._meta['browser-bridge/policy'].approvalGrade)));
check('browser_update 是 mandatory 级审批', gradeOf('browser_update') === 'mandatory');
check('browser_evaluate 是 confirm 级审批且可绕过', gradeOf('browser_evaluate') === 'confirm'
  && tools.find((tool) => tool.name === 'browser_evaluate')._meta['browser-bridge/policy'].approvalBypassable === true);
check('browser_observe 是 none 级审批', gradeOf('browser_observe') === 'none');
const gradeMeta = list.result._meta['browser-bridge/policy'];
check('tools/list 汇总审批分级统计', Boolean(gradeMeta && gradeMeta.approvalGrades)
  && gradeMeta.approvalGrades.none === 85 && gradeMeta.approvalGrades.confirm === 6 && gradeMeta.approvalGrades.mandatory === 1
  && gradeMeta.mandatoryApprovals.includes('browser_update'), JSON.stringify(gradeMeta && gradeMeta.approvalGrades));
check('tools/list 带审批能力快照', Boolean(list.result._meta['browser-bridge/approval'])
  && list.result._meta['browser-bridge/approval'].total === tools.length
  && list.result._meta['browser-bridge/approval'].metaKey === 'browser-bridge/approval');

const policyMeta = list.result && list.result._meta && list.result._meta['browser-bridge/policy'];
check('tools/list 带分档统计', policyMeta && policyMeta.total === tools.length && policyMeta.byTier.read + policyMeta.byTier.mutate + policyMeta.byTier.destructive === tools.length, JSON.stringify(policyMeta && policyMeta.byTier));
check('destructive 工具进入审批清单', policyMeta && policyMeta.approvals.includes('browser_update') && policyMeta.approvals.includes('browser_evaluate'), policyMeta ? String(policyMeta.approvals.length) : 'none');
check('read 工具带 timeoutMs 策略', observeTool && observeTool._meta && observeTool._meta['browser-bridge/policy'].timeoutMs > 0);

const badArgs = await rpc('tools/call', { name: 'browser_status', arguments: { bogus: 1 } });
const badArgsText = badArgs.result && badArgs.result.content && badArgs.result.content[0].text;
check('未声明参数被运行时校验拒绝', badArgs.result && badArgs.result.isError === true && String(badArgsText).includes('E_ARG_UNEXPECTED'), String(badArgsText).slice(0, 100));
check('运行时校验错误 _meta 带 machine-readable errorCode', badArgs.result._meta
  && badArgs.result._meta['browser-bridge/errorCode'] === 'E_ARG_UNEXPECTED'
  && Array.isArray(badArgs.result._meta['browser-bridge/validation']));

const missingArgs = await rpc('tools/call', { name: 'browser_evaluate', arguments: {} });
check('缺必填参数返回 E_ARG_MISSING', missingArgs.result && missingArgs.result.isError === true && String(missingArgs.result.content[0].text).includes('E_ARG_MISSING'));

const gated = await rpc('tools/call', { name: 'browser_evaluate', arguments: { expression: '1 + 1' } });
const gatedText = gated.result && gated.result.content && gated.result.content[0].text;
check('destructive 工具未审批返回 E_HUMAN_GATE', gated.result && gated.result.isError === true && String(gatedText).includes('E_HUMAN_GATE'), String(gatedText).slice(0, 100));
check('审批提示带 _meta 重试说明', gated.result && gated.result._meta && gated.result._meta['browser-bridge/approval'] && gated.result._meta['browser-bridge/approval'].required === true);

const approved = await rpc('tools/call', { name: 'browser_evaluate', arguments: { expression: '1 + 1' }, _meta: { 'browser-bridge/approval': 'confirmed' } });
const approvedText = approved.result && approved.result.content && approved.result.content[0].text;
check('审批确认后放行到 daemon（无 daemon 报 E_DAEMON）', approved.result && approved.result.isError === true && String(approvedText).includes('E_DAEMON'), String(approvedText).slice(0, 100));

const readOnlyCall = await rpc('tools/call', { name: 'browser_observe', arguments: {} });
check('read 工具不需要审批（直接执行到 daemon）', readOnlyCall.result && readOnlyCall.result.isError === true && String(readOnlyCall.result.content[0].text).includes('E_DAEMON'));

// ---------------------------------------------------------------------------
// W4-A：resources（只读、按需；技能文档真实读盘）
// ---------------------------------------------------------------------------
const resources = await rpc('resources/list', {});
const resourceList = (resources.result && resources.result.resources) || [];
check('resources/list 至少 5 个资源', resourceList.length >= 5, String(resourceList.length));
check('resources 暴露技能主文档', resourceList.some((item) => item.uri === 'bridge://skill/SKILL.md' && item.mimeType === 'text/markdown'));
check('resources 暴露协议摘要', resourceList.some((item) => item.uri === 'bridge://protocol/summary'));
check('resources 暴露观察快照入口', resourceList.some((item) => item.uri === 'bridge://observation/latest'));
check('resources 暴露调试 journal 入口', resourceList.some((item) => item.uri === 'bridge://debug/journal/latest'));
check('resources 都带 annotations', resourceList.every((item) => item.annotations && Array.isArray(item.annotations.audience)));
const resourceMeta = resources.result && resources.result._meta && resources.result._meta['browser-bridge/resources'];
check('resources/list 声明 subscribe=true', resourceMeta && resourceMeta.subscribe === true, JSON.stringify(resourceMeta && resourceMeta.subscribe));
check('resources/list 声明订阅通知与上限', Boolean(resourceMeta && resourceMeta.subscription
  && resourceMeta.subscription.notification === 'notifications/resources/updated'
  && resourceMeta.subscription.uriScoped === true
  && resourceMeta.subscription.maxSubscriptions >= 1
  && resourceMeta.subscription.active === 0), JSON.stringify(resourceMeta && resourceMeta.subscription));
check('resources/list 声明分页参数', resourceMeta && resourceMeta.pagination && resourceMeta.pagination.cursorParam === 'cursor' && resourceMeta.pagination.maxLimit === 65536, JSON.stringify(resourceMeta && resourceMeta.pagination));
check('initialize 声明 resources.subscribe=true', init.result.capabilities.resources.subscribe === true && init.result.capabilities.resources.pagination.cursorParam === 'cursor');
check('initialize 声明资源订阅扩展能力', Boolean(init.result.capabilities.experimental
  && init.result.capabilities.experimental['browser-bridge/resource-subscriptions']
  && init.result.capabilities.experimental['browser-bridge/resource-subscriptions'].supported === true
  && init.result.capabilities.experimental['browser-bridge/resource-subscriptions'].notification === 'notifications/resources/updated'
  && init.result.capabilities.experimental['browser-bridge/resource-subscriptions'].cleanupOnDisconnect === true));
check('initialize instructions 提到 resources/subscribe', init.result.instructions.includes('resources/subscribe'));

const templates = await rpc('resources/templates/list', {});
const templateList = (templates.result && templates.result.resourceTemplates) || [];
check('resources/templates/list 暴露技能参考模板', templateList.some((item) => item.uriTemplate === 'bridge://skill/references/{name}'));
check('resources/templates/list 暴露观察快照模板', templateList.some((item) => item.uriTemplate === 'bridge://observation/{session}'));
check('resources/templates/list 暴露调试 journal 模板', templateList.some((item) => item.uriTemplate === 'bridge://debug/journal/{session}'));

// ---------------------------------------------------------------------------
// W7-C：resources/subscribe 变更推送（能力升级：subscribe=true；旧版是 -32601）
// ---------------------------------------------------------------------------
const staticSubscribe = await rpc('resources/subscribe', { uri: 'bridge://protocol/summary' });
const staticSubMeta = staticSubscribe.result && staticSubscribe.result._meta && staticSubscribe.result._meta['browser-bridge/subscription'];
check('resources/subscribe 成功并返回订阅报告', Boolean(staticSubMeta && staticSubMeta.added === true
  && staticSubMeta.uri === 'bridge://protocol/summary' && staticSubMeta.active === 1), JSON.stringify(staticSubMeta));
check('订阅报告声明通知方法与上限', Boolean(staticSubMeta
  && staticSubMeta.notification === 'notifications/resources/updated'
  && staticSubMeta.maxSubscriptions >= 1));
const staticSubscribeAgain = await rpc('resources/subscribe', { uri: 'bridge://protocol/summary' });
check('重复订阅幂等（added=false）', staticSubscribeAgain.result._meta['browser-bridge/subscription'].added === false);
const staticUnsubscribe = await rpc('resources/unsubscribe', { uri: 'bridge://protocol/summary' });
check('resources/unsubscribe 成功并移除订阅', staticUnsubscribe.result._meta['browser-bridge/subscription'].found === true
  && staticUnsubscribe.result._meta['browser-bridge/subscription'].active === 0);
const unknownUnsubscribe = await rpc('resources/unsubscribe', { uri: 'bridge://observation/never-subscribed' });
check('取消未订阅资源仍成功（found=false）', unknownUnsubscribe.result
  && unknownUnsubscribe.result._meta['browser-bridge/subscription'].found === false);
const subscribeUnknown = await rpc('resources/subscribe', { uri: 'bridge://nope' });
check('订阅未知资源返回 -32002', subscribeUnknown.error && subscribeUnknown.error.code === -32002, JSON.stringify(subscribeUnknown.error));
const subscribeBadQuery = await rpc('resources/subscribe', { uri: 'bridge://protocol/summary?limit=0' });
check('订阅非法分页参数返回 -32602', subscribeBadQuery.error && subscribeBadQuery.error.code === -32602, JSON.stringify(subscribeBadQuery.error));
const subscribeNoUri = await rpc('resources/subscribe', {});
check('订阅缺 uri 返回 -32602', subscribeNoUri.error && subscribeNoUri.error.code === -32602);
// 订阅会随快照写入收到通知的 URI（会话级 + latest 别名）。
const subscribeSession = await rpc('resources/subscribe', { uri: 'bridge://observation/s-fake' });
const subscribeLatest = await rpc('resources/subscribe', { uri: 'bridge://observation/latest' });
check('可订阅尚未产生的会话级快照 URI', subscribeSession.result._meta['browser-bridge/subscription'].added === true
  && subscribeLatest.result._meta['browser-bridge/subscription'].added === true);
const listWithSubscriptions = await rpc('resources/list', {});
check('resources/list 报告活动订阅数', listWithSubscriptions.result._meta['browser-bridge/resources'].subscription.active === 2,
  JSON.stringify(listWithSubscriptions.result._meta['browser-bridge/resources'].subscription.active));

const skillDoc = await rpc('resources/read', { uri: 'bridge://skill/SKILL.md' });
const skillText = skillDoc.result && skillDoc.result.contents && skillDoc.result.contents[0] && skillDoc.result.contents[0].text;
check('resources/read 读到技能主文档', typeof skillText === 'string' && skillText.length > 200, skillText ? String(skillText.length) + ' chars' : 'none');
const reference = await rpc('resources/read', { uri: 'bridge://skill/references/environment.md' });
check('resources/read 读到技能参考文档', reference.result && reference.result.contents && reference.result.contents[0].text.includes('环境'));
const traversal = await rpc('resources/read', { uri: 'bridge://skill/references/..%2F..%2Fpackage.json' });
check('resources/read 拒绝路径穿越', traversal.error && traversal.error.code === -32602, JSON.stringify(traversal.error));
const missingResource = await rpc('resources/read', { uri: 'bridge://observation/latest' });
check('无快照时 observation/latest 返回 -32002', missingResource.error && missingResource.error.code === -32002, JSON.stringify(missingResource.error));
const missingJournal = await rpc('resources/read', { uri: 'bridge://debug/journal/latest' });
check('无快照时 debug/journal/latest 返回 -32002', missingJournal.error && missingJournal.error.code === -32002, JSON.stringify(missingJournal.error));
const unknownResource = await rpc('resources/read', { uri: 'bridge://nope' });
check('未知 resource 返回 -32002', unknownResource.error && unknownResource.error.code === -32002);

// 第十批-B：resources/list 行级分页 / 过滤 / 索引 / 新鲜度
const listPageOne = await rpc('resources/list', { limit: 2 });
const listPageOneMeta = listPageOne.result._meta['browser-bridge/resources'];
check('resources/list 支持 limit 行级分页并给出 nextCursor', listPageOne.result.resources.length === 2
  && typeof listPageOne.result.nextCursor === 'string'
  && listPageOneMeta.listPagination.hasMore === true, JSON.stringify(listPageOneMeta.listPagination));
const listPageTwo = await rpc('resources/list', { limit: 2, cursor: listPageOne.result.nextCursor });
check('resources/list 按游标续读得到不同行', listPageTwo.result.resources.length === 2
  && listPageTwo.result.resources[0].uri !== listPageOne.result.resources[0].uri);
const listKindFiltered = await rpc('resources/list', { kind: 'skill-main' });
check('resources/list 按 kind 过滤', listKindFiltered.result.resources.length === 1
  && listKindFiltered.result.resources[0].uri === 'bridge://skill/SKILL.md'
  && listKindFiltered.result._meta['browser-bridge/resources'].index.total === 1, JSON.stringify(listKindFiltered.result.resources.map((row) => row.uri)));
const listQueried = await rpc('resources/list', { query: 'protocol' });
check('resources/list 按 query 子串过滤', listQueried.result.resources.length === 1
  && listQueried.result.resources[0].uri === 'bridge://protocol/summary');
const listBadCursor = await rpc('resources/list', { cursor: 'garbage' });
check('resources/list 非法游标返回 -32602', listBadCursor.error && listBadCursor.error.code === -32602 && /cursor/.test(listBadCursor.error.message), JSON.stringify(listBadCursor.error));
const fullListMeta = (await rpc('resources/list', {})).result._meta['browser-bridge/resources'];
check('resources/list 报告索引分布（byKind/byMime/dynamic）', Boolean(fullListMeta.index)
  && fullListMeta.index.total >= 6
  && fullListMeta.index.byKind['skill-main'] === 1
  && fullListMeta.index.dynamic >= 3, JSON.stringify(fullListMeta.index && fullListMeta.index.byKind));
check('resources/list 报告新鲜度汇总与窗口', Boolean(fullListMeta.freshness)
  && typeof fullListMeta.freshness.byState === 'object'
  && fullListMeta.freshness.windows.freshMs > 0, JSON.stringify(fullListMeta.freshness && fullListMeta.freshness.windows));
const skillReadWithFreshness = await rpc('resources/read', { uri: 'bridge://skill/SKILL.md' });
check('resources/read 静态资源带 freshnessState=static', skillReadWithFreshness.result._meta['browser-bridge/resource'].freshnessState === 'static'
  && skillReadWithFreshness.result._meta['browser-bridge/resource'].freshnessAction === 'use');

const page1 = await rpc('resources/read', { uri: 'bridge://protocol/summary?limit=400' });
const page1Text = page1.result && page1.result.contents && page1.result.contents[0].text;
const page1Meta = page1.result && page1.result._meta && page1.result._meta['browser-bridge/resource'];
check('资源分页返回 nextCursor/nextUri', Boolean(page1Meta) && page1Meta.paged === true && page1Meta.nextCursor === '400' && String(page1Text).includes('…[paged]') && String(page1Meta.nextUri).includes('cursor=400'), JSON.stringify(page1Meta && { nextCursor: page1Meta.nextCursor, nextUri: page1Meta.nextUri, totalChars: page1Meta.totalChars }));
check('资源分页保留 totalChars/hasMore', page1Meta && page1Meta.totalChars > 400 && page1Meta.hasMore === true && page1Meta.returnedChars === 400);
const page2 = await rpc('resources/read', { uri: page1Meta.nextUri });
const page2Meta = page2.result && page2.result._meta && page2.result._meta['browser-bridge/resource'];
const page2Text = page2.result && page2.result.contents && page2.result.contents[0].text;
check('按 nextUri 续读得到不同分片', Boolean(page2Meta) && page2Meta.offset === 400 && page2Text !== page1Text && page2Text.length > 0);
const badLimit = await rpc('resources/read', { uri: 'bridge://protocol/summary?limit=0' });
check('资源分页 limit 越界返回 -32602', badLimit.error && badLimit.error.code === -32602 && String(badLimit.error.message).includes('limit'), JSON.stringify(badLimit.error));
const badQuery = await rpc('resources/read', { uri: 'bridge://protocol/summary?nope=1' });
check('未知资源查询参数返回 -32602', badQuery.error && badQuery.error.code === -32602 && String(badQuery.error.message).includes('nope'));
const badUri = await rpc('resources/read', { uri: 42 });
check('非字符串资源 URI 返回 -32602', badUri.error && badUri.error.code === -32602);

// ---------------------------------------------------------------------------
// W5-A：prompts 深化（HAR/网络诊断/长截图恢复/视频校验 + 枚举校验）
// ---------------------------------------------------------------------------
const prompts = await rpc('prompts/list', {});
const promptList = (prompts.result && prompts.result.prompts) || [];
check('prompts/list 至少 9 个 prompt', promptList.length >= 9, String(promptList.length));
check('prompt 声明都带 arguments', promptList.every((prompt) => Array.isArray(prompt.arguments) && prompt.arguments.length > 0 && prompt.description));
check('prompt 声明带 tags/resources _meta', promptList.every((prompt) => prompt._meta && prompt._meta['browser-bridge/prompt'] && Array.isArray(prompt._meta['browser-bridge/prompt'].tags) && Array.isArray(prompt._meta['browser-bridge/prompt'].resources)));
check('prompt 声明包含 HAR/网络/长截图/视频模板', ['har_analysis', 'network_diagnosis', 'longshot_recovery', 'video_verify'].every((name) => promptList.some((prompt) => prompt.name === name)));
const rendered = await rpc('prompts/get', { name: 'browser_task_brief', arguments: { task: '登录并查看订单', url: 'https://example.test/' } });
const renderedText = rendered.result && rendered.result.messages && rendered.result.messages[0] && rendered.result.messages[0].content.text;
check('prompts/get 渲染任务简报', typeof renderedText === 'string' && renderedText.includes('登录并查看订单') && renderedText.includes('https://example.test/'));
check('prompt 渲染包含分档/审批说明', typeof renderedText === 'string' && renderedText.includes('destructive'));
check('prompt 渲染包含 resources 提示', typeof renderedText === 'string' && renderedText.includes('bridge://skill/SKILL.md'));
const harPrompt = await rpc('prompts/get', { name: 'har_analysis', arguments: { source: 'latest', focus: 'errors' } });
const harText = harPrompt.result && harPrompt.result.messages[0].content.text;
check('prompts/get 渲染 HAR 分析模板', typeof harText === 'string' && harText.includes('latest') && harText.includes('browser_network_waterfall') && harText.includes('requestId'), String(harText).split('\n')[0]);
check('prompts/get 返回 prompt _meta', harPrompt.result && harPrompt.result._meta && harPrompt.result._meta['browser-bridge/prompt'].name === 'har_analysis');
const networkPrompt = await rpc('prompts/get', { name: 'network_diagnosis', arguments: { symptom: 'WebSocket 200ms 后断开', layer: 'websocket' } });
check('prompts/get 渲染网络诊断模板', networkPrompt.result && networkPrompt.result.messages[0].content.text.includes('browser_debug_start') && networkPrompt.result.messages[0].content.text.includes('websocket'));
const longshotPrompt = await rpc('prompts/get', { name: 'longshot_recovery', arguments: { failure: 'gap' } });
check('prompts/get 渲染长截图恢复模板', longshotPrompt.result && longshotPrompt.result.messages[0].content.text.includes('browser_longshot_recover') && longshotPrompt.result.messages[0].content.text.includes('缺片'));
const videoPrompt = await rpc('prompts/get', { name: 'video_verify', arguments: { recording: 'rec-1' } });
check('prompts/get 渲染视频校验模板', videoPrompt.result && videoPrompt.result.messages[0].content.text.includes('browser_video_recover') && videoPrompt.result.messages[0].content.text.includes('rec-1'));
const badEnum = await rpc('prompts/get', { name: 'longshot_recovery', arguments: { failure: 'not-a-real-failure' } });
check('prompts/get 枚举越界返回 -32602', badEnum.error && badEnum.error.code === -32602 && badEnum.error.message.includes('stale'), JSON.stringify(badEnum.error));
const badEnumOptional = await rpc('prompts/get', { name: 'har_analysis', arguments: { source: 'x.har', focus: 'nope' } });
check('prompts/get 可选枚举越界也返回 -32602', badEnumOptional.error && badEnumOptional.error.code === -32602 && badEnumOptional.error.message.includes('focus'));
const missingPromptArg = await rpc('prompts/get', { name: 'debug_investigation', arguments: {} });
check('prompts/get 缺必填参数返回 -32602', missingPromptArg.error && missingPromptArg.error.code === -32602 && missingPromptArg.error.message.includes('symptom'), JSON.stringify(missingPromptArg.error));
const unknownPrompt = await rpc('prompts/get', { name: 'nope_prompt', arguments: {} });
check('prompts/get 未知 prompt 返回 -32602', unknownPrompt.error && unknownPrompt.error.code === -32602);
const unknownPromptArg = await rpc('prompts/get', { name: 'browser_task_brief', arguments: { task: 'x', extra: 'y' } });
check('prompts/get 拒绝未声明参数', unknownPromptArg.error && unknownPromptArg.error.code === -32602 && unknownPromptArg.error.message.includes('extra'));

// 第十批-B：prompts/list 行级分页 + prompts 汇总 _meta
const promptsPageOne = await rpc('prompts/list', { limit: 3 });
check('prompts/list 支持 limit 分页', promptsPageOne.result.prompts.length === 3
  && typeof promptsPageOne.result.nextCursor === 'string'
  && promptsPageOne.result._meta['browser-bridge/prompts'].total >= 9, JSON.stringify(promptsPageOne.result._meta['browser-bridge/prompts']));
const promptsPageTwo = await rpc('prompts/list', { limit: 3, cursor: promptsPageOne.result.nextCursor });
const promptNames = [...promptsPageOne.result.prompts, ...promptsPageTwo.result.prompts].map((prompt) => prompt.name);
check('prompts/list 续读不重复', promptNames.length === new Set(promptNames).size && promptNames.length === 6);

// ---------------------------------------------------------------------------
// W6-C / W7-C：MCP 深度收口（进度通知 / 取消 / 资源快照持久化 / 订阅推送）
// ---------------------------------------------------------------------------
check('initialize 的 resources 能力升级为 subscribe=true', init.result.capabilities.resources.subscribe === true
  && init.result.capabilities.resources.listChanged === false);
check('initialize 声明进度扩展能力', Boolean(init.result.capabilities.experimental
  && init.result.capabilities.experimental['browser-bridge/progress']
  && init.result.capabilities.experimental['browser-bridge/progress'].supported === true
  && init.result.capabilities.experimental['browser-bridge/progress'].notification === 'notifications/progress'));
check('initialize 声明取消扩展能力', Boolean(init.result.capabilities.experimental
  && init.result.capabilities.experimental['browser-bridge/cancellation']
  && init.result.capabilities.experimental['browser-bridge/cancellation'].supported === true
  && init.result.capabilities.experimental['browser-bridge/cancellation'].response === 'suppressed'
  && init.result.capabilities.experimental['browser-bridge/cancellation'].remoteDaemonCancel === true));
check('initialize 声明快照持久化扩展能力', Boolean(init.result.capabilities.experimental
  && init.result.capabilities.experimental['browser-bridge/snapshots']
  && init.result.capabilities.experimental['browser-bridge/snapshots'].persisted === true
  && String(init.result.capabilities.experimental['browser-bridge/snapshots'].dir).includes('mcp-snapshots')));
const toolProgressMeta = tools.map((tool) => tool._meta && tool._meta['browser-bridge/progress']).filter(Boolean);
check('tools/list 每个工具都带进度档位', toolProgressMeta.length === tools.length, toolProgressMeta.length + '/' + tools.length);
check('tools/list 进度档位覆盖 stream/observe/fast', ['stream', 'observe', 'fast'].every((className) => toolProgressMeta.some((row) => row.class === className))
  && toolProgressMeta.findIndex((row) => row.class === 'stream') >= 0);
const screenshotIndex = tools.findIndex((tool) => tool.name === 'browser_screenshot');
const observeIndex = tools.findIndex((tool) => tool.name === 'browser_observe');
check('screenshot/observe 分别落在 stream/observe 档', toolProgressMeta[screenshotIndex].class === 'stream'
  && toolProgressMeta[observeIndex].class === 'observe', JSON.stringify({ screenshot: toolProgressMeta[screenshotIndex].class, observe: toolProgressMeta[observeIndex].class }));
check('tools/list 汇总进度分档统计', Boolean(list.result._meta['browser-bridge/progress'])
  && list.result._meta['browser-bridge/progress'].enabled === true
  && list.result._meta['browser-bridge/progress'].byClass.stream >= 1
  && list.result._meta['browser-bridge/progress'].maxNotifications >= 1);

// 接入 fake daemon：后续进度/取消/快照恢复都需要一个可延迟返回的 daemon。
const fakeDaemonPort = await startFakeDaemon();
fs.writeFileSync(path.join(home, 'daemon.json'), JSON.stringify({ port: fakeDaemonPort, token: 'selftest-token' }), 'utf8');
const statusWithDaemon = await rpc('tools/call', { name: 'browser_status', arguments: {} });
check('fake daemon 接入后 browser_status 成功', statusWithDaemon.result && statusWithDaemon.result.isError === false
  && JSON.parse(statusWithDaemon.result.content[0].text).daemon === 'fake');

// M6-P0②：新工具必须分发到既有 RPC 名称（不新增未实现 RPC），并把上游/协议风格入参换算正确。
const lastRequestOf = (method) => daemonState.requests.filter((request) => request.method === method).at(-1) || null;
const inspectHtmlCall = await rpc('tools/call', { name: 'browser_inspect_html', arguments: { ref: '@e1' } });
check('browser_inspect_html 分发到 get-html（ref + 会话注入）', Boolean(inspectHtmlCall.result && inspectHtmlCall.result.isError === false)
  && (() => { const request = lastRequestOf('get-html'); return Boolean(request) && request.params.ref === '@e1' && request.params.session === 's-fake'; })());
const emulateCall = await rpc('tools/call', { name: 'browser_assist_emulate', arguments: { device: 'iphone-14' } });
check('browser_assist_emulate 分发到 emulate 并换算 device 预设', Boolean(emulateCall.result && emulateCall.result.isError === false)
  && (() => {
    const request = lastRequestOf('emulate');
    return Boolean(request) && request.params.viewport && request.params.viewport.width === 390
      && request.params.viewport.height === 844 && request.params.viewport.deviceScaleFactor === 3
      && request.params.viewport.mobile === true && typeof request.params.userAgent === 'string'
      && request.params.userAgent.includes('iPhone') && request.params.session === 's-fake';
  })());
const requestHelpCall = await rpc('tools/call', { name: 'browser_assist_request_help', arguments: { reason: '完成登录', timeout_ms: 5000 } });
check('browser_assist_request_help 分发到 request-help（reason 必填）', Boolean(requestHelpCall.result && requestHelpCall.result.isError === false)
  && (() => { const request = lastRequestOf('request-help'); return Boolean(request) && request.params.reason === '完成登录' && request.params.timeoutMs === 5000; })());
const operationAwaitCall = await rpc('tools/call', { name: 'browser_assist_operation_await', arguments: { operation_id: 'op-42', timeout_ms: 5000 } });
check('browser_assist_operation_await 分发到 operation.await（operation_id→id）', Boolean(operationAwaitCall.result && operationAwaitCall.result.isError === false)
  && (() => { const request = lastRequestOf('operation.await'); return Boolean(request) && request.params.id === 'op-42' && request.params.timeoutMs === 5000; })());
const operationCancelCall = await rpc('tools/call', { name: 'browser_assist_operation_cancel', arguments: { operation_id: 'op-42' } });
check('browser_assist_operation_cancel 分发到 operation.cancel（operation_id→id）', Boolean(operationCancelCall.result && operationCancelCall.result.isError === false)
  && (() => { const request = lastRequestOf('operation.cancel'); return Boolean(request) && request.params.id === 'op-42'; })());
const browsersCall = await rpc('tools/call', { name: 'browser_session_browsers', arguments: {} });
check('browser_session_browsers 分发到 browsers（本地只读、不建会话）', Boolean(browsersCall.result && browsersCall.result.isError === false)
  && (() => { const request = lastRequestOf('browsers'); return Boolean(request) && Object.keys(request.params).length === 0; })());
const sessionListCall = await rpc('tools/call', { name: 'browser_session_list', arguments: {} });
check('browser_session_list 分发到 session.list（本地只读、不建会话）', Boolean(sessionListCall.result && sessionListCall.result.isError === false)
  && (() => { const request = lastRequestOf('session.list'); return Boolean(request) && Object.keys(request.params).length === 0; })());
const missingOperation = await rpc('tools/call', { name: 'browser_assist_operation_await', arguments: {} });
check('operation_await 缺 operation_id 返回 E_ARG_MISSING', Boolean(missingOperation.result && missingOperation.result.isError === true)
  && String(missingOperation.result.content[0].text).includes('E_ARG_MISSING'));
const badDevice = await rpc('tools/call', { name: 'browser_assist_emulate', arguments: { device: 'not-a-device' } });
check('emulate 未知 device 预设返回 E_ARG_ENUM（不静默忽略）', Boolean(badDevice.result && badDevice.result.isError === true)
  && String(badDevice.result.content[0].text).includes('E_ARG_ENUM'));

const progressToken = 'selftest-progress-token';
const progressCallId = 9001;
sendRaw({
  jsonrpc: '2.0',
  id: progressCallId,
  method: 'tools/call',
  params: { name: 'browser_observe', arguments: {}, _meta: { progressToken } },
});
const gotProgressResponse = await waitFor(() => rawMessages.some((message) => message.id === progressCallId), 8000);
const progressResponse = rawMessages.find((message) => message.id === progressCallId);
const progressResultMeta = progressResponse && progressResponse.result && progressResponse.result._meta && progressResponse.result._meta['browser-bridge/progress'];
check('tools/call 成功返回并带进度元数据', Boolean(gotProgressResponse && progressResponse.result && progressResponse.result.isError === false), JSON.stringify(progressResultMeta));
check('耗时工具发出多条 notifications/progress', Boolean(progressResultMeta && progressResultMeta.emitted >= 2)
  && progressResultMeta.class === 'observe' && progressResultMeta.finalPhase === 'done');
const progressNotifications = notifications.filter((message) => message.method === 'notifications/progress'
  && message.params && message.params.progressToken === progressToken);
check('通知带 tokens/progress/message 与工具元信息', progressNotifications.length >= 2
  && progressNotifications.every((message) => typeof message.params.progress === 'number' && typeof message.params.message === 'string'
    && message.params._meta['browser-bridge/progress'].tool === 'browser_observe')
  && progressNotifications[0].params.progress === 0, String(progressNotifications.length));
const progressValues = progressNotifications.map((message) => message.params.progress);
check('progress 单调递增且首条为 0', progressValues.every((value, index) => index === 0 || value >= progressValues[index - 1]), JSON.stringify(progressValues.slice(0, 6)));
check('完成通知带完成文案', progressNotifications.some((message) => /完成/.test(message.params.message)), progressNotifications.at(-1).params.message);
check('工具成功回填观察快照', Boolean(progressResponse.result._meta['browser-bridge/snapshot'])
  && progressResponse.result._meta['browser-bridge/snapshot'].kind === 'observation');
const snapshotDir = path.join(home, 'mcp-snapshots');
const snapshotFile = path.join(snapshotDir, 'observation.json');
check('观察快照落盘到 BB_HOME/mcp-snapshots', fs.existsSync(snapshotFile), snapshotDir);
const snapshotFiles = fs.existsSync(snapshotDir) ? fs.readdirSync(snapshotDir) : [];
check('快照目录无遗留 .tmp/.lock（原子写 + 写锁释放）', snapshotFiles.length > 0
  && snapshotFiles.every((name) => !name.endsWith('.tmp') && !name.endsWith('.lock')), JSON.stringify(snapshotFiles));
const savedSnapshot = fs.existsSync(snapshotFile) ? JSON.parse(fs.readFileSync(snapshotFile, 'utf8')) : null;
check('快照文件带 version/label/entries', Boolean(savedSnapshot && savedSnapshot.version === 1 && savedSnapshot.label === 'observation'
  && savedSnapshot.entries.some((entry) => entry.key === 's-fake')), savedSnapshot ? String(savedSnapshot.entries.length) : 'none');

// W7-C：快照更新推送 —— 订阅的会话级 URI 与 latest 别名都应收到 notifications/resources/updated。
const updatedNotifications = notifications.filter((message) => message.method === 'notifications/resources/updated');
const updatedUris = updatedNotifications.map((message) => message.params && message.params.uri);
check('快照更新推送 notifications/resources/updated', updatedUris.includes('bridge://observation/s-fake')
  && updatedUris.includes('bridge://observation/latest'), JSON.stringify(updatedUris));
check('更新通知带 uri 与来源元数据', updatedNotifications.length >= 2
  && updatedNotifications.every((message) => message.params && typeof message.params.uri === 'string'
    && message.params._meta['browser-bridge/resource-update'].action === 'record')
  && updatedNotifications.some((message) => message.params._meta['browser-bridge/resource-update'].tool === 'browser_observe'));
check('工具响应 _meta 记录已推送 URI', Boolean(progressResponse.result._meta['browser-bridge/resource-updates'])
  && progressResponse.result._meta['browser-bridge/resource-updates'].uris.includes('bridge://observation/s-fake'));

// 第十批-B：观察快照的新鲜度分级（read 与 list 两个面）
const observationRead = await rpc('resources/read', { uri: 'bridge://observation/latest' });
const observationMeta = observationRead.result && observationRead.result._meta && observationRead.result._meta['browser-bridge/resource'];
check('观察快照 read 带新鲜度状态与动作', Boolean(observationMeta)
  && ['fresh', 'recent'].includes(observationMeta.freshnessState)
  && observationMeta.freshnessAction !== 'recollect',
  JSON.stringify({ state: observationMeta && observationMeta.freshnessState, action: observationMeta && observationMeta.freshnessAction }));
check('观察快照 read 带 capturedAt/ageMs 且不 stale', Boolean(observationMeta)
  && typeof observationMeta.capturedAt === 'string'
  && typeof observationMeta.ageMs === 'number'
  && observationMeta.stale === false);
const freshnessAfterObserve = (await rpc('resources/list', {})).result._meta['browser-bridge/resources'].freshness;
check('resources/list 新鲜度统计反映刚写入的观察快照', Boolean(freshnessAfterObserve)
  && freshnessAfterObserve.total >= 1
  && freshnessAfterObserve.byState.fresh >= 1
  && freshnessAfterObserve.dynamicResources >= 1,
  JSON.stringify(freshnessAfterObserve && freshnessAfterObserve.byState));

// 取消订阅 latest 后：下一次快照更新只推会话级 URI（latest 不再收到通知）。
const latestUnsubscribe = await rpc('resources/unsubscribe', { uri: 'bridge://observation/latest' });
check('取消订阅返回 found=true', latestUnsubscribe.result._meta['browser-bridge/subscription'].found === true);
await delay(60);
const notifyCount = (uri) => notifications.filter((message) => message.method === 'notifications/resources/updated'
  && message.params && message.params.uri === uri).length;
const sessionNotifiedBefore = notifyCount('bridge://observation/s-fake');
const latestNotifiedBefore = notifyCount('bridge://observation/latest');
sendRaw({ jsonrpc: '2.0', id: 9003, method: 'tools/call', params: { name: 'browser_observe', arguments: {} } });
const gotSecondObserve = await waitFor(() => rawMessages.some((message) => message.id === 9003), 8000);
await delay(80);
const secondObserveMessage = rawMessages.find((message) => message.id === 9003);
check('第二次 observe 成功', Boolean(gotSecondObserve && secondObserveMessage.result && secondObserveMessage.result.isError === false));
check('仍订阅的会话 URI 继续收到更新通知', notifyCount('bridge://observation/s-fake') > sessionNotifiedBefore,
  String(notifyCount('bridge://observation/s-fake')) + ' > ' + sessionNotifiedBefore);
check('已取消订阅的 latest 不再收到更新通知', gotSecondObserve && notifyCount('bridge://observation/latest') === latestNotifiedBefore,
  String(notifyCount('bridge://observation/latest')) + ' == ' + latestNotifiedBefore);

// 取消：observe 在 daemon 侧拖延 1200ms，期间发 notifications/cancelled。
const cancelToken = 'selftest-cancel-token';
const cancelCallId = 9002;
const observeRequestsBefore = daemonState.requests.filter((request) => request.method === 'observe').length;
const observeResponsesBefore = daemonState.observeResponses;
sendRaw({
  jsonrpc: '2.0',
  id: cancelCallId,
  method: 'tools/call',
  params: { name: 'browser_observe', arguments: {}, _meta: { progressToken: cancelToken } },
});
const observeReachedDaemon = await waitFor(() => daemonState.requests.filter((request) => request.method === 'observe').length > observeRequestsBefore, 3000);
check('取消测试：observe 已到 daemon 且在途', observeReachedDaemon && daemonState.inflight.size >= 1, String(daemonState.inflight.size));
sendRaw({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: cancelCallId, reason: 'selftest-user-cancel' } });
const gotCancelProgress = await waitFor(() => notifications.some((message) => message.method === 'notifications/progress'
  && message.params && message.params.progressToken === cancelToken && /已取消/.test(String(message.params.message))), 4000);
check('取消后发出最终 cancelled 进度通知', gotCancelProgress);
check('取消转发到 daemon inflight.list/command.cancel', daemonState.requests.some((request) => request.method === 'inflight.list')
  && daemonState.requests.some((request) => request.method === 'command.cancel'));
// daemon 的 observe 响应可能已到达 server，但已取消请求必须不回响应（MCP 规范）。
await waitFor(() => daemonState.observeResponses > observeResponsesBefore, 4000);
await delay(300);
check('已取消的 tools/call 不回响应', !rawMessages.some((message) => message.id === cancelCallId));
const pingAfterCancel = await rpc('ping', {});
check('取消后 server 仍可服务', pingAfterCancel.result && Object.keys(pingAfterCancel.result).length === 0);
sendRaw({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 777777, reason: '不存在的请求' } });
await delay(120);
const pingAfterUnknownCancel = await rpc('ping', {});
check('取消未知请求不报错且不阻塞', pingAfterUnknownCancel.result && Object.keys(pingAfterUnknownCancel.result).length === 0);

// ---------------------------------------------------------------------------
// 第十一批-C：resource graph / 订阅差量 / prompt 版本 / 审批硬审计 / 恢复剧本
// ---------------------------------------------------------------------------
const experimental = init.result.capabilities.experimental;
const newCapabilityKeys = [
  'browser-bridge/resource-graph',
  'browser-bridge/subscription-diff',
  'browser-bridge/prompt-versions',
  'browser-bridge/prompt-completion',
  'browser-bridge/approval-audit',
  'browser-bridge/recovery-playbook',
];
check('initialize 声明第十一批-C 的六个扩展能力', newCapabilityKeys.every((key) => Boolean(experimental[key])),
  JSON.stringify(newCapabilityKeys.filter((key) => !experimental[key])));
check('resource-graph 声明节点/边/模板', experimental['browser-bridge/resource-graph'].edgeTypes.includes('session-sibling')
  && experimental['browser-bridge/resource-graph'].edgeTypes.includes('latest-shadow')
  && experimental['browser-bridge/resource-graph'].templates.includes('bridge://observation/{session}')
  && experimental['browser-bridge/resource-graph'].diff.fields.includes('graphDiff'));
check('recovery-playbook 声明动作与自检通过', experimental['browser-bridge/recovery-playbook'].audit.ok === true
  && experimental['browser-bridge/recovery-playbook'].actions.REOBSERVE === 'reobserve'
  && experimental['browser-bridge/recovery-playbook'].metaKey === 'browser-bridge/recovery');
check('prompt-versions 声明 9 个 prompt 的版本与指纹', experimental['browser-bridge/prompt-versions'].total === 9
  && experimental['browser-bridge/prompt-versions'].prompts.every((item) => item.version === '1.0.0' && item.fingerprint.length === 64)
  && experimental['browser-bridge/prompt-versions'].param === 'version');
check('approval-audit 声明回执/账本/风险分布', experimental['browser-bridge/approval-audit'].receipt.metaKey === 'browser-bridge/approval-receipt'
  && experimental['browser-bridge/approval-audit'].ledger.chainAlgorithm === 'sha256'
  && experimental['browser-bridge/approval-audit'].byEscalation.mandatory === 1
  && experimental['browser-bridge/approval-audit'].byBand.critical >= 1);
check('prompts 能力声明版本化参数', init.result.capabilities.prompts.versioned === true
  && init.result.capabilities.prompts.versionParam === 'version');

// resources/list：关系图 + 图差量 + 订阅覆盖/健康/流失。
const graphListOne = await rpc('resources/list', {});
const graphMetaOne = graphListOne.result._meta['browser-bridge/resources'];
check('resources/list 返回关系图摘要', Boolean(graphMetaOne.graph)
  && graphMetaOne.graph.nodes >= 6
  && graphMetaOne.graph.templates === 4
  && graphMetaOne.graph.sessions >= 1
  && typeof graphMetaOne.graph.fingerprint === 'string'
  && graphMetaOne.graph.fingerprint.length === 64,
  JSON.stringify(graphMetaOne.graph && { nodes: graphMetaOne.graph.nodes, edges: graphMetaOne.graph.edges, sessions: graphMetaOne.graph.sessions }));
check('resources/list 返回图差量字段', Boolean(graphMetaOne.graphDiff)
  && Array.isArray(graphMetaOne.graphDiff.nodesAdded)
  && Array.isArray(graphMetaOne.graphDiff.nodesRemoved)
  && typeof graphMetaOne.graphDiff.fingerprintChanged === 'boolean'
  && typeof graphMetaOne.graphDiff.before === 'string',
  JSON.stringify(graphMetaOne.graphDiff && graphMetaOne.graphDiff.nodesAdded));
check('资源关系图包含会话归属/模板/影子边', graphMetaOne.graph.byEdge['session-scope'] >= 1
  && graphMetaOne.graph.byEdge['template-instance'] >= 1
  && graphMetaOne.graph.byEdge['latest-shadow'] >= 1,
  JSON.stringify(graphMetaOne.graph.byEdge));
const graphListTwo = await rpc('resources/list', {});
check('连续两次 resources/list 的图指纹稳定且差量为空', graphListTwo.result._meta['browser-bridge/resources'].graph.fingerprint === graphMetaOne.graph.fingerprint
  && graphListTwo.result._meta['browser-bridge/resources'].graphDiff.unchanged === true,
  JSON.stringify(graphListTwo.result._meta['browser-bridge/resources'].graphDiff && graphListTwo.result._meta['browser-bridge/resources'].graphDiff.unchanged));
const coverageMeta = graphListTwo.result._meta['browser-bridge/resources'];
check('resources/list 返回订阅覆盖报告', Boolean(coverageMeta.subscriptionCoverage)
  && typeof coverageMeta.subscriptionCoverage.coverage === 'number'
  && Array.isArray(coverageMeta.subscriptionCoverage.suggestions)
  && Array.isArray(coverageMeta.subscriptionCoverage.orphanSubscriptions),
  JSON.stringify(coverageMeta.subscriptionCoverage && coverageMeta.subscriptionCoverage.coverage));
check('resources/list 返回订阅健康与流失指标', Boolean(coverageMeta.subscriptionHealth)
  && typeof coverageMeta.subscriptionHealth.healthy === 'boolean'
  && typeof coverageMeta.subscriptionChurn.churnRate === 'number');

// 订阅差量：subscribe → diff.added + 图谱邻居；unsubscribe → diff.removed。
const resubscribeLatest = await rpc('resources/subscribe', { uri: 'bridge://observation/latest' });
const resubscribeReport = resubscribeLatest.result._meta['browser-bridge/subscription'];
check('resources/subscribe 回执带订阅差量', Boolean(resubscribeReport.diff)
  && resubscribeReport.diff.added.includes('bridge://observation/latest')
  && resubscribeReport.diff.counts.added >= 1,
  JSON.stringify(resubscribeReport.diff && resubscribeReport.diff.added));
check('resources/subscribe 回执带图谱邻居（同会话/latest alias）', Array.isArray(resubscribeReport.related)
  && resubscribeReport.related.includes('bridge://observation/s-fake'),
  JSON.stringify(resubscribeReport.related));
check('resources/subscribe 回执带订阅健康', Boolean(resubscribeReport.health) && typeof resubscribeReport.health.total === 'number');
const resubscribeLatestOff = await rpc('resources/unsubscribe', { uri: 'bridge://observation/latest' });
const unsubscribeReport = resubscribeLatestOff.result._meta['browser-bridge/subscription'];
check('resources/unsubscribe 回执带 diff.removed', unsubscribeReport.found === true
  && unsubscribeReport.diff.removed.includes('bridge://observation/latest'),
  JSON.stringify(unsubscribeReport.diff && unsubscribeReport.diff.removed));

// prompts 版本化与参数补全。
const promptsList = await rpc('prompts/list', {});
const promptRows = promptsList.result.prompts || [];
const promptVersionMeta = promptRows[0] && promptRows[0]._meta['browser-bridge/prompt-version'];
check('prompts/list 每个声明带版本/指纹', promptRows.length === 9
  && promptRows.every((row) => row._meta['browser-bridge/prompt-version'].version === '1.0.0'
    && row._meta['browser-bridge/prompt-version'].fingerprint.length === 64),
  JSON.stringify(promptVersionMeta && { version: promptVersionMeta.version }));
check('prompts/list 返回版本与补全能力声明', promptsList.result._meta['browser-bridge/prompts'].versioning.total === 9
  && promptsList.result._meta['browser-bridge/prompts'].completion.supported === true
  && promptsList.result._meta['browser-bridge/prompts'].completion.sources.some((item) => item.argument === 'session'));
const promptExact = await rpc('prompts/get', {
  name: 'har_analysis',
  arguments: { source: 'latest' },
  version: '1.0.0',
});
const promptExactVersion = promptExact.result && promptExact.result._meta['browser-bridge/prompt-version'];
check('prompts/get 支持 version 精确协商', Boolean(promptExactVersion)
  && promptExactVersion.version === '1.0.0'
  && promptExactVersion.negotiation.exact === true
  && promptExactVersion.negotiation.fallback === false,
  JSON.stringify(promptExactVersion && promptExactVersion.negotiation));
const promptFallback = await rpc('prompts/get', {
  name: 'har_analysis',
  arguments: { source: 'latest' },
  version: '9.9.9',
});
const promptFallbackVersion = promptFallback.result && promptFallback.result._meta['browser-bridge/prompt-version'];
check('prompts/get 不支持的版本标记 fallback 且不伪造旧渲染', Boolean(promptFallbackVersion)
  && promptFallbackVersion.negotiation.fallback === true
  && promptFallbackVersion.negotiation.requested === '9.9.9'
  && promptFallbackVersion.version === '1.0.0'
  && promptFallback.result.messages[0].content.text.includes('HAR'),
  JSON.stringify(promptFallbackVersion && promptFallbackVersion.negotiation));
const promptNoVersion = await rpc('prompts/get', { name: 'browser_task_brief', arguments: { task: '检查页面' } });
check('prompts/get 不带 version 时按 latest 渲染', promptNoVersion.result._meta['browser-bridge/prompt-version'].negotiation.reason === 'latest');
const sessionCompletion = await rpc('completion/complete', {
  ref: { type: 'ref/prompt', name: 'cooperation_handoff' },
  argument: { name: 'session', value: '' },
});
check('completion/complete 能补全 prompt 的 session 参数（目录感知）', sessionCompletion.result.completion.values.includes('s-fake')
  && sessionCompletion.result._meta['browser-bridge/completion'].source === 'sessions',
  JSON.stringify(sessionCompletion.result.completion.values));

// tools/list：风险分级 + 审批硬审计摘要。
const riskList = await rpc('tools/list', {});
const riskTools = riskList.result.tools || [];
const riskMeta = riskList.result._meta['browser-bridge/approval-audit'];
check('tools/list 每个工具带风险等级/升级策略', riskTools.every((tool) => ['low', 'medium', 'high', 'critical'].includes(tool._meta['browser-bridge/policy'].approvalRiskBand)
  && typeof tool._meta['browser-bridge/policy'].approvalEscalation === 'string')
  && riskTools.find((tool) => tool.name === 'browser_evaluate')._meta['browser-bridge/policy'].approvalRiskBand === 'critical'
  && riskTools.find((tool) => tool.name === 'browser_update')._meta['browser-bridge/policy'].approvalEscalation === 'mandatory');
check('tools/list 带审批硬审计摘要与账本状态', Boolean(riskMeta)
  && riskMeta.ledger.chainAlgorithm === 'sha256'
  && riskMeta.byBand.critical >= 1
  && riskMeta.byEscalation.mandatory === 1
  && riskMeta.receipt.metaKey === 'browser-bridge/approval-receipt',
  JSON.stringify(riskMeta && { byBand: riskMeta.byBand, ledger: riskMeta.ledger && riskMeta.ledger.size }));
check('审批账本已记录本轮需要审批的调用', riskMeta.ledger.size >= 2
  && typeof riskMeta.ledger.headHash === 'string'
  && riskMeta.ledger.headHash.length === 64,
  String(riskMeta.ledger.size));

// tools/call：审批决策记录 + 回执 + 恢复剧本。
const auditDenied = await rpc('tools/call', { name: 'browser_evaluate', arguments: { expression: '1 + 1' } });
const deniedAudit = auditDenied.result && auditDenied.result._meta['browser-bridge/approval-audit'];
check('审批被拦截时记录 denied 决策与原因码', Boolean(deniedAudit)
  && deniedAudit.decision === 'denied'
  && deniedAudit.reasonCode === 'denied-enforced'
  && deniedAudit.enforced === true
  && typeof deniedAudit.ledgerSeq === 'number'
  && typeof deniedAudit.chainHead === 'string',
  JSON.stringify(deniedAudit && { decision: deniedAudit.decision, reasonCode: deniedAudit.reasonCode }));
const auditApproved = await rpc('tools/call', {
  name: 'browser_evaluate',
  arguments: { expression: '1 + 1' },
  _meta: { 'browser-bridge/approval': 'confirmed' },
});
const approvedReceipt = auditApproved.result && auditApproved.result._meta['browser-bridge/approval-receipt'];
const approvedAudit = auditApproved.result && auditApproved.result._meta['browser-bridge/approval-audit'];
check('审批确认放行时记录 approved 并签发哈希链回执', Boolean(approvedAudit)
  && approvedAudit.decision === 'approved'
  && approvedAudit.receiptId === (approvedReceipt && approvedReceipt.id)
  && Boolean(approvedReceipt)
  && approvedReceipt.id.startsWith('apr_')
  && approvedReceipt.chain === 'sha256'
  && typeof approvedReceipt.hash === 'string'
  && typeof approvedReceipt.prevHash === 'string'
  && approvedReceipt.paramsDigest.length <= 32,
  JSON.stringify(approvedReceipt && { id: approvedReceipt.id, seq: approvedReceipt.seq }));
check('回执不含参数明文（只记摘要）', Boolean(approvedReceipt)
  && !JSON.stringify(approvedReceipt).includes('1 + 1')
  && typeof approvedReceipt.paramsDigest === 'string');
// 恢复剧本：临时藏起 daemon.json 制造 E_DAEMON（fake daemon 还在跑，直接调 browser_status 不会失败）。
const daemonFile = path.join(home, 'daemon.json');
const daemonBackup = daemonFile + '.selftest-bak';
fs.renameSync(daemonFile, daemonBackup);
let statusError;
try {
  statusError = await rpc('tools/call', { name: 'browser_status', arguments: {} });
} finally {
  fs.renameSync(daemonBackup, daemonFile);
}
const statusRecovery = statusError.result && statusError.result._meta['browser-bridge/recovery'];
check('工具错误 _meta 带多步恢复剧本', Boolean(statusRecovery)
  && statusRecovery.code === 'E_DAEMON'
  && statusRecovery.terminal === true
  && Array.isArray(statusRecovery.steps)
  && statusRecovery.steps.length >= 2
  && statusRecovery.nextStep.action === 'check-status'
  && typeof statusRecovery.escalateToHuman === 'boolean'
  && typeof statusRecovery.summary === 'string',
  JSON.stringify(statusRecovery && { severity: statusRecovery.severity, next: statusRecovery.nextStep && statusRecovery.nextStep.action,
    steps: statusRecovery.steps && statusRecovery.steps.length, terminal: statusRecovery.terminal, code: statusRecovery.code }));
const badArgRecovery = (await rpc('tools/call', { name: 'browser_status', arguments: { bogus: 1 } })).result._meta['browser-bridge/recovery'];
check('校验错误恢复剧本先修参数再重试', Boolean(badArgRecovery)
  && badArgRecovery.category === 'validation'
  && badArgRecovery.nextStep.action === 'fix-arguments',
  JSON.stringify(badArgRecovery && badArgRecovery.nextStep));


// 进程重启恢复：同一个 BB_HOME 起第二个 server，resources/read 读到 latest。
const restart = await runOneShotMcpServer([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest-restart' } } },
  { jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'bridge://observation/latest' } },
  { jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} },
]);
const restartedRead = restart.messages.find((message) => message.id === 2);
const restartedList = restart.messages.find((message) => message.id === 3);
let restartedPayload = null;
try {
  restartedPayload = JSON.parse(restartedRead.result.contents[0].text);
} catch {
  restartedPayload = null;
}
const restartedMeta = restartedRead && restartedRead.result && restartedRead.result._meta['browser-bridge/resource'];
check('进程重启后 resources/read 恢复 latest 快照', Boolean(restartedPayload && restartedPayload.key === 's-fake'
  && restartedPayload.payload.observation === '@e1 fake button'));
check('恢复的快照带 persisted/capturedAt/etag', Boolean(restartedMeta && restartedMeta.persisted === true
  && typeof restartedMeta.capturedAt === 'string' && /^W\/"/.test(String(restartedMeta.etag))));
check('重启后 resources/list 报告 restored 与持久化状态', Boolean(restartedList && restartedList.result._meta['browser-bridge/resources'].restored.observation >= 1
  && restartedList.result._meta['browser-bridge/resources'].persistence.enabled === true
  && restartedList.result._meta['browser-bridge/resources'].persistence.files >= 1));
check('恢复的快照 meta 声明 subscribe=true 且持久化可用', Boolean(restartedMeta && restartedMeta.capabilities.subscribe === true
  && restartedMeta.capabilities.subscription.notification === 'notifications/resources/updated'
  && restartedMeta.capabilities.persistence === true));

const shutdown = await rpc('shutdown', {});
check('shutdown 有响应', Boolean(shutdown.result));

if (daemonState.server) {
  try { daemonState.server.unref(); daemonState.server.close(); } catch { /* 忽略 */ }
}

server.stdin.end();
server.kill();
const failed = results.filter((item) => !item.ok);
console.log('');
console.log('== MCP 结果 ==');
console.log('通过 ' + (results.length - failed.length) + ' 项，失败 ' + failed.length + ' 项');
process.exit(failed.length ? 1 : 0);
