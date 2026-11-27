// cli/commands/status.mjs —— status/browsers/cancel（从 bridge 拆出）。
//
// 第十一批 G：`bridge status --views <a,b>` 显式请求 daemon 的增量视图
// （ledger/transfers/queues/doctor/leases/boundary/batch/arbitration）。
// 关键约束：**不带 --views 时请求参数与人类输出与 0.3.0 完全一致**（默认载荷不变）。
import { renderStatusViews } from '../lib/table-views.mjs';
import { ArgError } from '../lib/args.mjs';

export function createStatusCommands(ctx) {
  const { callRpc, timeoutOf, outputFailure, outputJsonBody, print, isJson, requirePos, formatTime, formatUptime, indent, renderTable, truncateText } = ctx;

function browserTable(browsers) {
    const showLabel = browsers.some((item) => item.label);
    const headers = showLabel
      ? ['instance', 'label', 'browser', 'version', 'ext', 'connected']
      : ['instance', 'browser', 'version', 'ext', 'connected'];
    const rows = browsers.map((item) => {
      const tail = [item.browser, item.browserVersion, item.extVersion, formatTime(item.connectedAt)];
      return showLabel ? [item.instanceId, item.label || '', ...tail] : [item.instanceId, ...tail];
    });
    return renderTable(headers, rows);
  }
  
  
  
  
  
  async function cmdStatus(flags) {
    // 默认请求 {}（与 0.3.0 一致）；只有显式 --views 才追加参数。
    const params = {};
    if (flags.views !== undefined && flags.views !== '') {
      params.views = String(flags.views).split(',').map((item) => item.trim()).filter(Boolean);
      if (!params.views.length) params.views = [];
      if (flags.limit !== undefined) {
        const limit = Number(flags.limit);
        if (!Number.isInteger(limit) || limit <= 0) {
          throw new ArgError('--limit 需要正整数');
        }
        params.limit = limit;
      }
      if (flags.strategy !== undefined) params.strategy = String(flags.strategy);
    }
    const body = await callRpc('status', params, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    const result = body.result || {};
    const browsers = result.browsers || [];
    const sessions = result.sessions || [];
    const lines = [];
    lines.push(`${result.service} v${result.version}  (protocol ${result.protocol ?? '?'}, pid ${result.pid}, port ${result.port}, uptime ${formatUptime(result.uptimeMs)})`);
    lines.push('');
    lines.push(`browsers (${browsers.length}):`);
    if (browsers.length) {
      lines.push(indent(browserTable(browsers)));
    } else {
      lines.push('  (无已连接浏览器)');
    }
    lines.push('');
    lines.push(`sessions (${sessions.length}):`);
    if (sessions.length) {
      lines.push(indent(renderTable(
        ['session', 'instance', 'tab', 'window', 'url', 'title', 'started'],
        sessions.map((item) => [
          item.sessionId,
          item.instanceId,
          item.tabId,
          item.windowId,
          truncateText(item.url, 48),
          truncateText(item.title, 32),
          formatTime(item.startedAt),
        ]),
      )));
    } else {
      lines.push('  (无活动 session)');
    }
    const inflight = result.inflight || [];
    lines.push('');
    lines.push(`inflight (${inflight.length}):`);
    if (inflight.length) {
      lines.push(indent(renderTable(
        ['method', 'instance', 'tab', 'elapsed'],
        inflight.map((item) => [
          item.method,
          item.instanceId,
          item.tabId == null ? '—' : String(item.tabId),
          item.elapsedMs + 'ms',
        ]),
      )));
    } else {
      lines.push('  (无进行中命令)');
    }
    // 显式视图：追加段落（默认路径不会走到这里，输出与基线一致）。
    if (params.views && params.views.length) {
      const viewsText = renderStatusViews(result);
      if (viewsText) lines.push(viewsText);
    }
    print(lines.join('\n'));
    return 0;
  }
  
  async function cmdCancel(flags, pos) {
    // 默认路径（bridge cancel <commandId>）保持 0.3.0 语义：command.cancel + 原输出。
    // 兼容目标 通用取消入口：--rpc-id / --request-id / --operation-id 走 daemon 的 `cancel` RPC
    //（cancel { rpc_id } → cancelled/forwarded；未知 id 回 cancelled:false 而不是报错）。
    const generic = {};
    if (flags['rpc-id'] !== undefined) generic.rpc_id = String(flags['rpc-id']);
    if (flags['request-id'] !== undefined) generic.request_id = String(flags['request-id']);
    if (flags['operation-id'] !== undefined) generic.operation_id = String(flags['operation-id']);
    if (Object.keys(generic).length) {
      const body = await callRpc('cancel', generic, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      const id = result.id || result.rpc_id || result.request_id || result.operation_id || '(unknown)';
      if (result.cancelled === true) print((result.forwarded === true ? '已转发取消' : '已取消') + '：' + id);
      else print('没有进行中的命令可取消：' + id + (result.reason ? '（' + result.reason + '）' : ''));
      return 0;
    }
    const id = requirePos(pos, 1, '<commandId>');
    const body = await callRpc('command.cancel', { id }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    const result = body.result || {};
    print((result.accepted ? '已取消' : '已转发但命令已结束') + '：' + result.id);
    return 0;
  }
  
  async function cmdBrowsers(flags) {
    const body = await callRpc('browsers', {}, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    const browsers = (body.result && body.result.browsers) || [];
    if (!browsers.length) {
      print('没有已连接的浏览器；请在 Edge/Chrome 里加载并启用 browser-bridge 扩展');
      return 0;
    }
    print(browserTable(browsers));
    return 0;
  }
  return { cmdStatus, cmdCancel, cmdBrowsers };
}
