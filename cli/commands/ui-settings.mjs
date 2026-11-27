// cli/commands/ui-settings.mjs —— ui/settings 命令（从 bridge 拆出）。

export async function uiCommand(ctx, flags, pos) {
  const { callRpc, timeoutOf, outputFailure, outputJsonBody, print, isJson } = ctx;
  const page = flags.page === undefined ? 'popup' : String(flags.page);
  if (flags.diagnostics === true) {
    const body = await callRpc('diagnostics.ui', {}, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    const result = body.result || {};
    print('extension v' + (result.packageVersion || '?') + (result.ok ? '（自检通过）' : '（自检有问题）'));
    for (const name of ['popup', 'options', 'preview', 'quick', 'record', 'debug', 'longshot', 'ops', 'audit']) {
      const item = result[name];
      if (!item) continue;
      const extra = Array.isArray(item.missing) && item.missing.length ? ' missing: ' + item.missing.join(',') : '';
      print(`  ${item.ok ? '[ok]' : '[!!]'} ${name} ${item.bytes || 0}B${extra}`);
    }
    const leases = Array.isArray(result.axLease) ? result.axLease : [];
    print('AX 租约：' + (leases.length ? leases.map((item) => `tab ${item.tabId} ${Math.round(item.remainingMs / 1000)}s`).join(', ') : '(无)'));
    return 0;
  }
  const params = { page };
  if (flags.query !== undefined) params.query = String(flags.query);
  const body = await callRpc('ui.open', params, timeoutOf(flags));
  if (!body.ok) return outputFailure(body);
  if (isJson()) return outputJsonBody(body);
  const result = body.result || {};
  print('已打开扩展' + (page === 'options' ? '设置页' : '弹窗') + '：tab ' + result.tabId + ' → ' + result.url);
  return 0;
}


export async function settingsCommand(ctx, flags, pos) {
  const { callRpc, timeoutOf, outputFailure, outputJsonBody, print, isJson, BridgeError, ArgError, parseOnOff } = ctx;
  const sub = pos[1];
  if (sub === 'set') {
    const patch = {};
    if (flags.label !== undefined) patch.instanceLabel = String(flags.label);
    if (flags['borrow-confirm'] !== undefined) {
      throw new BridgeError(
        'E_FORBIDDEN',
        '借用前确认只能在浏览器扩展的设置页修改，Agent/CLI 一侧不可改（安全策略要求）',
      );
    }
    if (flags['allow-help'] !== undefined) patch.allowHelp = parseOnOff(flags['allow-help'], 'allow-help');
    if (flags['page-guard'] !== undefined) patch.pageGuard = parseOnOff(flags['page-guard'], 'page-guard');
    if (flags['control-hint'] !== undefined) patch.controlHint = parseOnOff(flags['control-hint'], 'control-hint');
    if (flags['daemon-url'] !== undefined) patch.daemonUrl = String(flags['daemon-url']);
    if (flags['daemon-token'] !== undefined) patch.daemonToken = String(flags['daemon-token']);
    if (flags['long-shot'] !== undefined) {
      const mode = String(flags['long-shot']);
      if (mode !== 'auto' && mode !== 'manual') throw new ArgError('--long-shot 需要 auto|manual');
      patch.longShotMode = mode;
    }
    if (!Object.keys(patch).length) {
      throw new ArgError('settings set 至少给一个：--label/--allow-help/--control-hint/--page-guard/--long-shot');
    }
    const body = await callRpc('settings.set', { patch }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    const settings = (body.result && body.result.settings) || {};
    print('已保存：' + formatSettings(settings));
    return 0;
  }
  const body = await callRpc('settings.get', {}, timeoutOf(flags));
  if (!body.ok) return outputFailure(body);
  if (isJson()) return outputJsonBody(body);
  print(formatSettings((body.result && body.result.settings) || {}));
  return 0;
}

export function formatSettings(settings) {
  const onOff = (value) => (value !== false ? 'on' : 'off');
  return [
    '实例名      ' + (settings.instanceLabel || '（未命名）'),
    '借用前确认  ' + onOff(settings.borrowConfirm),
    '人工协助    ' + onOff(settings.allowHelp),
    '页面守卫    ' + onOff(settings.pageGuard),
    '长截图默认  ' + (settings.longShotMode || 'auto'),
  ].join('\n');
}

/** plan/step 的 --until-visible：步骤结束后等待目标可见（不改变步骤本身的退出码）。 */

