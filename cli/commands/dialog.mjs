// cli/commands/dialog.mjs —— `bridge dialog status|accept|dismiss|arm|disarm|list|handle`。
export function createDialogCommand({
  withControl,
  dialogPolicy,
  callRpc,
  timeoutOf,
  outputFailure,
  outputJsonBody,
  renderPageBody,
  isJson,
  print,
  renderTable,
  truncateText,
  requirePos,
  ArgError,
}) {
  return async function cmdDialog(flags, pos) {
    const sub = pos[1];
    if (sub === 'status') {
      const body = await callRpc('dialog.status', withControl(flags, {}), timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const dialogs = (body.result && body.result.dialogs) || [];
      if (!dialogs.length) {
        print('(没有对话框记录)');
        return 0;
      }
      print(renderTable(['id', 'type', 'action', 'message'], dialogs.map((item) => [
        item.id, item.type, item.action || '', truncateText(item.message || '', 60),
      ])));
      return 0;
    }
    if (sub === 'accept' || sub === 'dismiss') {
      const id = requirePos(pos, 2, '<id>');
      const params = withControl(flags, { id: Number(id) });
      if (sub === 'accept' && flags.text !== undefined) params.text = String(flags.text);
      const body = await callRpc('dialog.' + sub, params, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      print((sub === 'accept' ? '已接受' : '已拒绝') + '对话框 ' + id);
      return 0;
    }
    if (sub === 'arm') {
      const body = await callRpc('dialog.arm', withControl(flags, { policy: dialogPolicy(flags) }), timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      print('已挂载对话框拦截：' + JSON.stringify(body.result && body.result.policy));
      return 0;
    }
    if (sub === 'disarm') {
      const body = await callRpc('dialog.disarm', withControl(flags, {}), timeoutOf(flags));
      return renderPageBody(body, () => print('已卸载'));
    }
    if (sub === 'list') {
      const body = await callRpc('dialog.list', withControl(flags, {}), timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const dialogs = (body.result && body.result.dialogs) || [];
      if (!dialogs.length) {
        print('(没有记录到对话框)');
        return 0;
      }
      print(renderTable(['id', 'type', 'action', 'message'], dialogs.map((item) => [
        item.id, item.type, item.action || '', truncateText(item.message || '', 60),
      ])));
      return 0;
    }
    if (sub === 'handle') {
      const id = requirePos(pos, 2, '<id>');
      if (flags.accept !== true && flags.dismiss !== true) throw new ArgError('dialog handle 需要 --accept 或 --dismiss');
      const params = withControl(flags, { id, accept: flags.accept === true });
      if (flags['prompt-text'] !== undefined) params.promptText = String(flags['prompt-text']);
      const body = await callRpc('dialog.handle', params, timeoutOf(flags));
      return renderPageBody(body, () => print('ok'));
    }
    throw new ArgError('用法：bridge dialog arm|disarm|list|handle');
  };
}
