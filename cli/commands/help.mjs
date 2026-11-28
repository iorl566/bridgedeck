// cli/commands/help.mjs —— request-help（从 bridge 拆出）。

export async function requestHelpCommand(ctx, flags, pos) {
  const { parseDurationMs, withControl, callRpc, outputFailure, outputJsonBody, print, isJson, ArgError } = ctx;
  const prompt = flags.reason !== undefined ? flags.reason : flags.prompt;
  if (prompt === undefined) throw new ArgError('request-help 需要 --prompt 或 --reason <text>');
  const timeoutMs = Math.max(5000, parseDurationMs(flags.timeout, 180000));
  const params = withControl(flags, { reason: String(prompt), timeoutMs });
  if (flags.target !== undefined) {
    const targets = String(flags.target).split(',').map((item) => item.trim()).filter(Boolean).slice(0, 8);
    if (targets.length) {
      params.targets = targets; // 多目标高亮；第一个仍是主目标
      params.target = targets[0];
    }
  }
  if (flags.title !== undefined) params.title = String(flags.title);
  if (flags.until !== undefined) {
    let criteria;
    try {
      criteria = JSON.parse(String(flags.until));
    } catch {
      throw new ArgError('--until 需要 JSON 数组');
    }
    if (!Array.isArray(criteria) || criteria.length === 0 || criteria.length > 10) {
      throw new ArgError('--until 需要 1-10 条完成条件');
    }
    const normalized = criteria.map((item) => {
      if (!item || typeof item !== 'object') throw new ArgError('--until 每条条件需要对象');
      const kind = String(item.kind || item.type || '');
      if (kind === 'selector_exists' || kind === 'selector_visible') {
        const selector = String(item.selector || '');
        if (!selector) throw new ArgError('--until 的 ' + kind + ' 需要 selector');
        return { kind, selector };
      }
      if (kind === 'text_exists' || kind === 'url_contains') {
        const text = String(item.text || '');
        if (!text) throw new ArgError('--until 的 ' + kind + ' 需要 text');
        return { kind, text };
      }
      throw new ArgError('--until 支持 selector_exists/selector_visible/text_exists/url_contains');
    });
    params.criteria = normalized;
  }
  const body = await callRpc('request-help', params, timeoutMs + 5000);
  if (!body.ok) return outputFailure(body);
  if (isJson()) return outputJsonBody(body);
  const action = (body.result && body.result.action) || 'timeout';
  print(action === 'done' ? '用户已处理完成' : action === 'skip' ? '用户选择跳过' : '等待超时，用户未响应');
  return action === 'timeout' ? 1 : 0;
}
