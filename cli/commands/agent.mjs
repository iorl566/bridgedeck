// cli/commands/agent.mjs —— agent brief / diagnose（从 bridge 拆出）。

export function createAgentCommands(ctx) {
  const { withControl, callRpc, timeoutOf, outputFailure, emitJson, print, isJson, ArgError, summarizePageDiagnostics } = ctx;

async function cmdAgent(flags, pos) {
    const sub = pos[1] || 'brief';
    if (sub !== 'brief') throw new ArgError('agent 只支持 brief');
    if (flags.session === undefined) throw new ArgError('agent brief 需要 --session <id>');
    const params = withControl(flags, { maxTokens: 1200, probeHover: false });
    const body = await callRpc('observe', params, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    const observation = body.result || {};
    let dialog = null;
    try {
      const dialogBody = await callRpc('dialog.status', withControl(flags, {}), Math.min(timeoutOf(flags), 5000));
      if (dialogBody.ok) dialog = dialogBody.result || null;
    } catch {
      dialog = null;
    }
    const pending = Boolean(dialog && (dialog.pending === true || dialog.armed === true));
    const next = [];
    if (pending) next.push('dialog accept', 'dialog dismiss');
    else next.push('click @eN', 'fill @eN --value <text>', 'observe');
    if (observation.truncated) next.push('observe --cursor <cursor>');
    const brief = {
      session: String(flags.session),
      page: {
        url: observation.url || '',
        title: observation.title || '',
      },
      observation: {
        text: String(observation.observation || ''),
        refs: Number(observation.refs) || 0,
        truncated: observation.truncated === true,
        cursor: observation.cursor || null,
        generation: observation.generation || null,
      },
      dialog: dialog ? { pending, armed: dialog.armed === true, type: dialog.type || null } : null,
      next,
      hint: pending ? '页面有待处理对话框，先 accept/dismiss 再继续。' : '使用 @eN ref 操作；导航后旧 ref 失效，重新 observe。',
    };
    if (isJson()) {
      emitJson({ ok: true, result: brief });
      return 0;
    }
    print('agent brief · ' + (brief.page.title || '(无标题)'));
    print('  url   ' + brief.page.url);
    print('  refs  ' + brief.observation.refs + (brief.observation.truncated ? '（观察已截断）' : ''));
    if (brief.dialog && brief.dialog.pending) print('  dialog 待处理');
    print('');
    print(brief.observation.text);
    print('');
    print('下一步：' + brief.next.join(' / '));
    return 0;
  }
  async function cmdDiagnose(flags) {
    const sessionId = flags.session || flags['session-id'] || process.env.BB_SESSION || '';
    if (!sessionId) throw new ArgError('diagnose 需要 --session <id>');
    const expression = "JSON.stringify({webdriver:navigator.webdriver,plugins:navigator.plugins.length,languages:String(navigator.languages||''),chrome:typeof window.chrome,mainWorldBB:typeof window.__BB_PAGE__==='object',overlay:!!(document.querySelector('[data-bb-ui=\\\"takeover\\\"]')||document.getElementById('__bb_takeover_host'))})";
    const body = await callRpc('evaluate', withControl(flags, { expression }), timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    let markers = {};
    try { markers = JSON.parse((body.result && body.result.value) || '{}'); } catch { markers = {}; }
    const report = summarizePageDiagnostics(markers);
    if (isJson()) {
      emitJson({ ok: true, result: report });
      return report.ok ? 0 : 1;
    }
    print('页面自动化痕迹（只报告，不修改指纹）：');
    for (const item of report.findings) print('  [' + item.level + '] ' + item.code + ': ' + item.message);
    return report.ok ? 0 : 1;
  }
  return { cmdAgent, cmdDiagnose };
}
