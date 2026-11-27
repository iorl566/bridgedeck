// cli/commands/window.mjs —— `bridge window list|focus|ensure|resize`。
export function createWindowCommand({
  callRpc,
  timeoutOf,
  outputFailure,
  outputJsonBody,
  isJson,
  print,
  renderTable,
  requirePos,
  intFlag,
  ArgError,
}) {
  return async function cmdWindow(flags, pos) {
    const sub = pos[1];
    if (sub === 'list') {
      const body = await callRpc('window.list', {}, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const windows = (body.result && body.result.windows) || [];
      if (!windows.length) {
        print('(没有窗口)');
        return 0;
      }
      print(renderTable(['window', 'focused', 'type', 'tabs'], windows.map((win) => [
        String(win.windowId), win.focused ? 'yes' : 'no', win.type, String((win.tabs || []).length),
      ])));
      return 0;
    }
    if (sub === 'focus') {
      const windowId = Number(requirePos(pos, 2, '<windowId>'));
      if (!Number.isInteger(windowId)) throw new ArgError('<windowId> 需要整数');
      const body = await callRpc('window.focus', { windowId }, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      print('已聚焦 window ' + windowId);
      return 0;
    }
    if (sub === 'ensure') {
      const params = {};
      if (flags.session !== undefined) params.session = String(flags.session);
      const body = await callRpc('window.ensureAgent', params, Math.max(timeoutOf(flags), 30000));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      print('Agent 窗口：window ' + result.windowId + '，tab ' + result.tabId + '（' + (result.created ? '新建' : '复用') + '）');
      return 0;
    }
    if (sub !== 'resize') throw new ArgError('用法：bridge window list|focus <windowId>|ensure|resize --width <n> --height <n>');
    const width = intFlag(flags, 'width', { min: 1 });
    const height = intFlag(flags, 'height', { min: 1 });
    if (width === undefined || height === undefined) throw new ArgError('window resize 需要 --width 与 --height');
    const params = { width, height };
    if (flags.session !== undefined) params.session = String(flags.session);
    const body = await callRpc('window.resize', params, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    print('ok');
    return 0;
  };
}
