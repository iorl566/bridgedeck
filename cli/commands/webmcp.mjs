// cli/commands/webmcp.mjs —— webmcp/exec（从 bridge 拆出）。
import fs from 'node:fs';
import path from 'node:path';

export function createWebmcpCommands(ctx) {
  const { callRpc, withControl, timeoutOf, outputFailure, outputJsonBody, print, isJson, ArgError, renderTable, truncateText, requirePos, BridgeError, parseDurationMs, emitJson } = ctx;

async function cmdWebmcp(flags, pos) {
    const sub = String(pos[1] || 'list');
    if (sub === 'list') {
      const body = await callRpc('webmcp.list', withControl(flags, {}), timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      if (!result.available) print('该页面没有 WebMCP（navigator.modelContext）');
      else print(renderTable(['tool', 'description'], (result.tools || []).map((tool) => [tool.name, truncateText(tool.description || '', 72)])));
      return 0;
    }
    if (sub === 'call') {
      const name = requirePos(pos, 2, '<tool>');
      let input = {};
      if (flags.input !== undefined) {
        try { input = JSON.parse(String(flags.input)); } catch (error) { throw new ArgError('--input 不是合法 JSON：' + error.message); }
      }
      const body = await callRpc('webmcp.call', withControl(flags, { name, input }), timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      print(JSON.stringify((body.result || {}).result, null, 2));
      return 0;
    }
    throw new ArgError('webmcp 用法：list | call <tool> --input <json>');
  }
  
  async function cmdExec(flags) {
    const source = flags.file !== undefined ? fs.readFileSync(path.resolve(process.cwd(), String(flags.file)), 'utf8') : flags.code;
    if (typeof source !== 'string' || !source.trim()) throw new ArgError('exec 需要 --file <script.js> 或 --code <code>');
    const call = async (method, params = {}) => {
      const body = await callRpc(method, withControl(flags, params), timeoutOf(flags));
      if (!body.ok) throw new BridgeError((body.error && body.error.code) || 'E_INTERNAL', (body.error && body.error.message) || ('exec page 调用失败：' + method), body.error && body.error.data);
      return body.result;
    };
    const { createExecPage } = await import('../../lib/exec-page.mjs');
    const page = createExecPage(call);
    const { runScript } = await import('../exec.mjs');
    const timeoutMs = flags.timeout !== undefined ? parseDurationMs(flags.timeout, 30000) : 30000;
    const sandbox = flags.sandbox !== undefined ? String(flags.sandbox) : 'vm';
    let out;
    try {
      if (sandbox === 'vm') {
        out = await runScript({ code: source, page, timeoutMs, filename: flags.file ? String(flags.file) : 'bridge-exec.js' });
      } else {
        const { runQuickJS } = await import('../exec-quickjs.mjs');
        out = await runQuickJS({ code: source, page, timeoutMs });
      }
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      // page/RPC 的失败码要原样带回（QuickJS 边界也保留 code/data），只把真正未知的错误归到 E_EXEC_FAILED。
      const code = error && typeof error.code === 'string' && error.code ? error.code : 'E_EXEC_FAILED';
      throw new BridgeError(code, String((error && error.message) || error), error && error.data);
    }
    for (const entry of out.logs) process.stderr.write('[' + entry.level + '] ' + entry.text + '\n');
    if (isJson()) {
      emitJson({ ok: true, result: { result: out.result, logs: out.logs } });
      if (sandbox !== 'vm') process.exit(0);
      return 0;
    }
    print(JSON.stringify(out.result, null, 2));
    if (sandbox !== 'vm') process.exit(0);
    return 0;
  }
  return { cmdWebmcp, cmdExec };
}
