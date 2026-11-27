// cli/commands/tab.mjs —— `bridge tab list|new|close|select|move|cleanup|alias|aliases|policy|borrow|return`。
//
// 与 session 一样：先构造 plan（RPC 方法 + 参数 + 目标 + 风险），--dry-run 只预检；
// 真实执行复用同一份 plan。tab cleanup 的 dry-run 是 daemon 侧计算（需要真实 tab 列表），
// 因此它的 --dry-run 走正常 RPC，只是把 dryRun=true 传给 daemon。
import { ArgError, parseDurationMs } from '../lib/args.mjs';
import { renderTable, truncateText } from '../lib/format.mjs';
import { ContractError, RISK } from '../lib/arg-contract.mjs';
import { buildPlan, callStep, dryRunNotes, isDryRun, outputDryRun, rpcStep } from '../lib/action-plan.mjs';

export function createTabCommand({
  withSession,
  callRpc,
  timeoutOf,
  outputFailure,
  outputJsonBody,
  isJson,
  print,
  renderTable: injectedRenderTable,
  truncateText: injectedTruncate,
  parseDurationMs: injectedParseDuration,
  requirePos,
  ArgError: InjectedArgError,
  spec,
}) {
  // 注入项优先（bridge 注入同一份实现），缺省用直连 import，便于单测独立调用。
  const table = injectedRenderTable || renderTable;
  const cut = injectedTruncate || truncateText;
  const duration = injectedParseDuration || parseDurationMs;
  const argError = InjectedArgError || ArgError;
  const io = {
    callRpc,
    timeoutOf,
    flags: null,
    isJson,
    emitJson: (body) => outputJsonBody(body),
    print,
  };

  async function runPlan(plan, flags) {
    io.flags = flags;
    if (isDryRun(flags)) return { dryRun: true, code: outputDryRun(plan, io) };
    const body = await callStep(plan.steps[0], io);
    return { body };
  }

  function buildListPlan(flags) {
    const params = withSession(flags, { scope: flags.scope !== undefined ? String(flags.scope) : 'agent' });
    if (flags.browser !== undefined) params.browser = String(flags.browser);
    return buildPlan({
      command: 'tab',
      subcommand: 'list',
      risk: RISK.READ_ONLY,
      steps: [rpcStep('tab.list', params, {
        description: '列出标签页（scope=' + params.scope + '）',
        target: { kind: 'tabs', scope: params.scope },
        risk: RISK.READ_ONLY,
      })],
    });
  }

  function buildNewPlan(flags, pos) {
    const params = withSession(flags, { focus: flags.focus === true });
    if (pos[2]) params.url = pos[2];
    if (flags.window === true) params.newWindow = true;
    if (flags['read-only'] === true) params.readOnly = true;
    if (flags['allow-origins'] !== undefined) params.allowedOrigins = String(flags['allow-origins']);
    if (flags['keep-open'] === true) params.keepOpen = true;
    if (flags.group !== undefined) params.group = String(flags.group);
    if (flags.alias !== undefined) params.alias = String(flags.alias);
    return buildPlan({
      command: 'tab',
      subcommand: 'new',
      risk: RISK.BROWSER_MUTATION,
      steps: [rpcStep('tab.new', params, {
        description: '新建标签页' + (params.url ? '：' + params.url : ''),
        target: { kind: 'tab', url: params.url || 'about:blank' },
        risk: RISK.BROWSER_MUTATION,
      })],
      notes: dryRunNotes(flags),
    });
  }

  function buildTabIdPlan(flags, pos, sub, options = {}) {
    const tabId = requirePos(pos, 2, '<tabId>');
    const params = withSession(flags, { tabId: Number(tabId) });
    if (sub === 'move') {
      if (flags['to-window'] === undefined) throw new argError('tab move 需要 --to-window <windowId>');
      const windowId = Number(flags['to-window']);
      if (!Number.isInteger(windowId)) throw new argError('--to-window 需要整数');
      params.windowId = windowId;
    }
    if (sub === 'borrow' && flags['confirmation-timeout'] !== undefined) {
      // 兼容目标 BorrowConfirmationTimeout 的触发参数（feature floor borrow_confirmation_timeout）。
      params.confirmationTimeoutMs = duration(flags['confirmation-timeout'], 60000);
    }
    const descriptions = {
      close: '关闭 tab ' + tabId,
      select: '激活 tab ' + tabId,
      move: '把 tab ' + tabId + ' 移动到 window ' + params.windowId,
      borrow: '借用 tab ' + tabId,
      return: '归还 tab ' + tabId,
    };
    const risk = sub === 'return' ? RISK.DAEMON_STATE : (options.risk || RISK.BROWSER_MUTATION);
    return buildPlan({
      command: 'tab',
      subcommand: sub,
      risk,
      steps: [rpcStep('tab.' + sub, params, {
        description: descriptions[sub] || ('tab.' + sub),
        target: { kind: 'tab', tabId: Number(tabId), windowId: params.windowId },
        risk,
        minTimeoutMs: sub === 'borrow' || sub === 'return' ? 75000 : 0,
      })],
      warnings: sub === 'close' ? ['关闭 tab ' + tabId + ' 之后无法从浏览器恢复（历史记录里也找不到已关闭的 Agent tab）。'] : [],
      confirmations: sub === 'borrow' ? ['借用用户标签页可能弹确认闸门（--borrow-confirm）'] : [],
      notes: dryRunNotes(flags),
    });
  }

  function buildAliasPlan(flags, pos) {
    const tabId = requirePos(pos, 2, '<tabId>');
    const alias = requirePos(pos, 3, '<alias>');
    const params = withSession(flags, {
      action: flags.clear === true ? 'clear' : 'set',
      alias: String(alias),
      ...(flags.clear === true ? {} : { tabId: Number(tabId) }),
    });
    return buildPlan({
      command: 'tab',
      subcommand: 'alias',
      risk: RISK.DAEMON_STATE,
      steps: [rpcStep('tab.alias', params, {
        description: (flags.clear === true ? '清除' : '设置') + ' tab ' + tabId + ' 的别名 ' + alias,
        target: { kind: 'tab', tabId: Number(tabId), alias: String(alias) },
        risk: RISK.DAEMON_STATE,
      })],
      notes: dryRunNotes(flags),
    });
  }

  function buildAliasesPlan(flags) {
    const params = withSession(flags, { action: 'list' });
    return buildPlan({
      command: 'tab',
      subcommand: 'aliases',
      risk: RISK.READ_ONLY,
      steps: [rpcStep('tab.alias', params, {
        description: '列出 tab 别名',
        target: { kind: 'aliases' },
        risk: RISK.READ_ONLY,
      })],
    });
  }

  function buildPolicyPlan(flags, pos) {
    const tabId = requirePos(pos, 2, '<tabId>');
    const params = withSession(flags, { tabId: Number(tabId) });
    if (flags['read-only'] === true) params.readOnly = true;
    if (flags['keep-open'] === true) params.keepOpen = true;
    if (flags['allow-origins'] !== undefined) params.allowedOrigins = String(flags['allow-origins']);
    if (flags.clear === true) params.clear = true;
    const effects = ['readOnly', 'keepOpen', 'allowedOrigins', 'clear'].filter((key) => params[key] !== undefined);
    return buildPlan({
      command: 'tab',
      subcommand: 'policy',
      risk: RISK.DAEMON_STATE,
      steps: [rpcStep('tab.policy', params, {
        description: '设置 tab ' + tabId + ' 策略（' + effects.join(', ') + '）',
        target: { kind: 'tab', tabId: Number(tabId) },
        risk: RISK.DAEMON_STATE,
        effects,
      })],
      notes: dryRunNotes(flags),
    });
  }

  function buildCleanupPlan(flags) {
    const idleMs = flags['idle-ms'] !== undefined ? duration(flags['idle-ms'], 600000) : 600000;
    const dryRunParam = flags['dry-run'] === true || flags.yes !== true;
    const params = withSession(flags, { idleMs, dryRun: dryRunParam });
    return buildPlan({
      command: 'tab',
      subcommand: 'cleanup',
      risk: RISK.BROWSER_MUTATION,
      steps: [rpcStep('tab.cleanup', params, {
        description: '清理空闲 Agent tab（阈值 ' + idleMs + 'ms' + (dryRunParam ? '，只预览' : '，会真正关闭') + '）',
        target: { kind: 'tabs', scope: 'agent' },
        risk: RISK.BROWSER_MUTATION,
      })],
      warnings: dryRunParam ? [] : ['--yes 会真正关闭空闲 tab，无法撤销。'],
      notes: dryRunNotes(flags),
    });
  }

  return async function cmdTab(flags, pos, invocation) {
    const sub = (invocation && invocation.sub) || pos[1];
    if (sub === 'list') {
      const planned = await runPlan(buildListPlan(flags), flags);
      if (planned.code !== undefined) return planned.code;
      const body = planned.body;
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const tabs = (body.result && body.result.tabs) || [];
      if (!tabs.length) {
        print('(没有 tab)');
        return 0;
      }
      print(table(
        ['tab', 'window', 'url', 'title', 'active'],
        tabs.map((item) => [item.tabId, item.windowId, cut(item.url, 56), cut(item.title, 28), item.active ? 'yes' : '']),
      ));
      return 0;
    }
    if (sub === 'cleanup') {
      // cleanup 的 --dry-run 由 daemon 计算（需要真实 tab 列表），因此这里不做 CLI 预检：
      // plan 里的 params.dryRun 已经带上 --dry-run/--yes 的语义，直接发同一个请求。
      io.flags = flags;
      const plan = buildCleanupPlan(flags);
      const body = await callStep(plan.steps[0], io);
      return renderCleanup(body);
    }
    if (sub === 'alias') {
      const planned = await runPlan(buildAliasPlan(flags, pos), flags);
      if (planned.code !== undefined) return planned.code;
      const body = planned.body;
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      if (flags.clear === true) print('已清除 alias ' + pos[3]);
      else print('tab ' + pos[2] + ' → ' + pos[3]);
      return 0;
    }
    if (sub === 'aliases') {
      const planned = await runPlan(buildAliasesPlan(flags), flags);
      if (planned.code !== undefined) return planned.code;
      const body = planned.body;
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const aliases = (body.result && body.result.aliases) || {};
      const names = Object.keys(aliases);
      if (!names.length) print('(没有 alias)');
      else print(table(['alias', 'tab'], names.map((name) => [name, aliases[name]])));
      return 0;
    }
    if (sub === 'policy') {
      const planned = await runPlan(buildPolicyPlan(flags, pos), flags);
      if (planned.code !== undefined) return planned.code;
      const body = planned.body;
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      print('tab ' + result.tabId + ' 策略：readOnly=' + Boolean(result.policy && result.policy.readOnly) + ' allowedOrigins=' + JSON.stringify((result.policy && result.policy.allowedOrigins) || []));
      return 0;
    }
    if (sub === 'new') {
      const planned = await runPlan(buildNewPlan(flags, pos), flags);
      if (planned.code !== undefined) return planned.code;
      const body = planned.body;
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      print(`tab ${result.tabId} 已创建（window ${result.windowId}）`);
      return 0;
    }
    if (['close', 'select', 'move', 'borrow', 'return'].includes(sub)) {
      const planned = await runPlan(buildTabIdPlan(flags, pos, sub), flags);
      if (planned.code !== undefined) return planned.code;
      const body = planned.body;
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      if (sub === 'borrow') {
        const result = body.result || {};
        print('已借用 tab ' + result.tabId + '（window ' + result.windowId + '）：' + cut(result.url || '', 60));
      } else if (sub === 'return') {
        print('已归还 tab ' + pos[2] + '（标签页保持打开）');
      } else if (sub === 'move') {
        print('tab ' + pos[2] + ' 已移动到 window ' + flags['to-window']);
      } else {
        print('ok');
      }
      return 0;
    }
    throw new ContractError('E_BAD_SUBCOMMAND', 'bridge tab 没有子命令 "' + sub + '"', {
      hint: '可用子命令：' + (spec ? spec.order.join('|') : 'list|new|close|select|move') + '。',
    });

    function renderCleanup(body) {
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      print((result.dryRun ? '将关闭 ' : '已关闭 ') + ((result.close || result.closed || []).length) + ' 个空闲 Agent tab');
      for (const tabId of result.close || result.closed || []) print('  tab ' + tabId);
      return 0;
    }
  };
}
