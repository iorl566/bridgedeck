// cli/commands/schema-ledger.mjs —— schema/ledger/open 小命令。
import { RISK } from '../lib/arg-contract.mjs';
import { intFlag } from '../lib/args.mjs';
import { buildPlan, callStep, dryRunNotes, isDryRun, outputDryRun, rpcStep } from '../lib/action-plan.mjs';

const OPEN_WAIT_POLL_MS = 200;
const OPEN_WAIT_DEFAULT_TIMEOUT_MS = 5000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createSchemaLedgerCommands(ctx) {
  const { loadSchemaInfo, BridgeError, isJson, emitJson, print, callRpc, timeoutOf, outputFailure, outputJsonBody, ArgError, isControllerInfo, spec } = ctx;
  const io = {
    callRpc,
    timeoutOf,
    flags: null,
    isJson,
    emitJson,
    print,
  };

  async function cmdSchema(flags, pos) {
    const { describeMethod, listMethods, schemaFlags } = await loadSchemaInfo();
    const method = pos[1] ? String(pos[1]) : '';
    if (method) {
      const info = describeMethod(method);
      if (!info) throw new BridgeError('E_BAD_ARG', '未知方法：' + method + '（bridge schema 查看全部方法）');
      const result = { ...info, flags: schemaFlags(method) };
      if (isJson()) {
        emitJson({ ok: true, result });
        return 0;
      }
      print(JSON.stringify(result, null, 2));
      return 0;
    }
    const rows = listMethods();
    if (isJson()) {
      emitJson({ ok: true, result: { methods: rows } });
      return 0;
    }
    for (const row of rows) {
      print(row.method + '\t' + row.scope + '\t' + row.effect + '\t' + (row.mutating ? 'mutating' : 'read'));
    }
    return 0;
  }

  async function cmdLedger(flags, pos) {
    const sub = pos[1] || 'status';
    if (sub === 'status') {
      const limit = flags.limit !== undefined ? Number(flags.limit) : 20;
      // 走 兼容目标 对齐的通用入口 ledger.request { action:'status' }；载荷里保留既有字段
      // （pending/recent/wal/durability），所以人类输出与 0.3.0 逐字一致。
      const params = { action: 'status', limit: Number.isFinite(limit) ? limit : 20 };
      if (flags.session !== undefined) params.session_id = String(flags.session);
      if (flags['tab-id'] !== undefined) params.tab_id = Number(flags['tab-id']);
      const body = await callRpc('ledger.request', params, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      const pending = result.pending || [];
      if (!pending.length) print('账本：没有待确认的变异操作');
      else {
        print('待确认（同标签页的新变异操作会被拦截）：');
        for (const entry of pending) print(`  ${entry.id}  ${entry.method}  tab=${entry.tabId == null ? '-' : entry.tabId}  ${entry.state}  ${entry.at}`);
      }
      const recent = (result.recent || []).slice(0, 8);
      if (recent.length) {
        print('最近记录：');
        for (const entry of recent) print(`  ${entry.id}  ${entry.method}  ${entry.state}  ${entry.at}`);
      }
      return 0;
    }
    if (sub === 'resolve') {
      const id = pos[2] || flags.id;
      if (!id) throw new ArgError('用法：bridge ledger resolve <id> [--outcome abandoned|done]');
      const outcome = flags.outcome !== undefined ? String(flags.outcome) : 'abandoned';
      const params = { action: 'resolve', operation_id: String(id), outcome };
      if (flags.session !== undefined) params.session_id = String(flags.session);
      if (flags['tab-id'] !== undefined) params.tab_id = Number(flags['tab-id']);
      const body = await callRpc('ledger.request', params, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const entry = (body.result || {}).entry || {};
      print('账本记录 ' + id + ' 已确认（' + (entry.outcome || outcome) + '），同标签页已解锁');
      return 0;
    }
    throw new ArgError('用法：bridge ledger status | bridge ledger resolve <id> [--outcome abandoned|done]');
  }

  /** open 的 plan：session.start →（可选）navigate →（可选）observe。 */
  function buildOpenPlan(flags, pos) {
    const url = pos.slice(1).find((value) => /^https?:\/\//i.test(value)) || '';
    const startParams = { focus: flags.focus === true };
    if (flags.incognito === true) startParams.incognito = true;
    if (flags.browser !== undefined) startParams.browser = String(flags.browser);
    if (flags.scope !== undefined) startParams.scope = String(flags.scope);
    else if (process.env.BB_SESSION_SCOPE && process.env.BB_SESSION_SCOPE.trim()) startParams.scope = process.env.BB_SESSION_SCOPE.trim();
    if (flags['agent-name'] !== undefined) {
      const controller = { name: String(flags['agent-name']) };
      if (flags.project !== undefined) controller.project = String(flags.project);
      if (flags['controller-color'] !== undefined) controller.color = String(flags['controller-color']);
      if (!isControllerInfo(controller)) throw new ArgError('--agent-name/--project/--controller-color 不合法');
      startParams.controller = controller;
    }
    // dry-run 不知道新会话 id：用它作为占位符，并在 notes 里说明真实执行时自动填入。
    const sessionPlaceholder = '<sessionId>';
    const steps = [rpcStep('session.start', startParams, {
      description: '新建 Agent 会话',
      target: { kind: 'session-start', browser: startParams.browser || '(默认浏览器)' },
      risk: RISK.BROWSER_MUTATION,
    })];
    if (url) {
      steps.push(rpcStep('navigate', { session: sessionPlaceholder, url }, {
        description: '导航到 ' + url,
        target: { kind: 'tab', url },
        risk: RISK.BROWSER_MUTATION,
      }));
      if ((flags.observe === true || flags.snapshot === true)) {
        const observeParams = { session: sessionPlaceholder };
        const maxTokens = Number(flags['max-tokens']);
        if (Number.isInteger(maxTokens) && maxTokens > 0) observeParams.maxTokens = maxTokens;
        steps.push(rpcStep('observe', observeParams, {
          description: '返回一次观察（refs/token 预算）',
          target: { kind: 'observe', url },
          risk: RISK.READ_ONLY,
        }));
      }
    }
    const notes = dryRunNotes(flags);
    if (url) notes.push('后两步的 session 用 <sessionId> 占位：真实执行时用 session.start 返回的 id 自动填入。');
    // 兼容目标 open --wait-for / --wait-not：对渲染后的 VOM 文本做有界轮询（默认 5000ms）。
    if (flags['wait-for'] !== undefined || flags['wait-not'] !== undefined) {
      const timeoutMs = flags['timeout-ms'] !== undefined
        ? intFlag(flags, 'timeout-ms', { min: 1 })
        : OPEN_WAIT_DEFAULT_TIMEOUT_MS;
      notes.push('open 会在导航后轮询 observe 直到 VOM '
        + (flags['wait-for'] !== undefined ? '包含 "' + String(flags['wait-for']) + '"' : '')
        + (flags['wait-for'] !== undefined && flags['wait-not'] !== undefined ? ' 且 ' : '')
        + (flags['wait-not'] !== undefined ? '不再包含 "' + String(flags['wait-not']) + '"' : '')
        + '（上限 ' + timeoutMs + 'ms，每 ' + OPEN_WAIT_POLL_MS + 'ms 一次 observe）。');
    }
    return buildPlan({
      command: 'open',
      subcommand: null,
      risk: RISK.BROWSER_MUTATION,
      steps,
      notes,
    });
  }

  async function cmdOpenAlias(flags, pos, invocation) {
    io.flags = flags;
    const planned = buildOpenPlan(flags, pos);
    if (isDryRun(flags)) return outputDryRun(planned, io);
    const url = planned.steps.length > 1 ? planned.steps[1].params.url : '';
    if (url && flags['reuse-window'] === true && flags.incognito !== true) {
      // 复用已有 Agent Window：让 session.start 在同一窗口里新开标签页（默认也会复用窗口，这里显式保证不抢占已有 tab）。
      planned.steps[0].params.newTab = true;
    }
    const started = await callStep(planned.steps[0], io);
    if (!started.ok) return outputFailure(started);
    const sessionId = (started.result || {}).sessionId;
    let title = '';
    let observation = null;
    let wait = null;
    if (url) {
      const waitUntil = flags['wait-until'] === undefined ? 'domcontentloaded' : String(flags['wait-until']);
      const navParams = { session: sessionId, url };
      if (waitUntil === 'commit') navParams.timeoutMs = 800;
      else if (waitUntil === 'domcontentloaded') navParams.timeoutMs = 2000;
      const navStep = rpcStep('navigate', navParams, {
        description: '导航到 ' + url,
        target: { kind: 'tab', url },
        risk: RISK.BROWSER_MUTATION,
        minTimeoutMs: 60000,
      });
      const nav = await callStep(navStep, io);
      if (!nav.ok) return outputFailure(nav);
      const navReceipt = (nav.result && nav.result.receipt) || {};
      if (waitUntil === 'domcontentloaded' && navReceipt.effectState !== 'committed') {
        const waitStep = rpcStep('wait-for-navigation', { session: sessionId, waitUntil: 'domcontentloaded', timeoutMs: 5000 }, {
          description: '等待导航到 domcontentloaded',
          target: { kind: 'navigation', name: 'domcontentloaded' },
          risk: RISK.READ_ONLY,
          minTimeoutMs: 8000,
        });
        await callStep(waitStep, io).catch(() => null);
      }
      title = (nav.result || {}).title || '';
      const observeParams = { session: sessionId };
      const maxTokens = Number(flags['max-tokens']);
      if (Number.isInteger(maxTokens) && maxTokens > 0) observeParams.maxTokens = maxTokens;
      const wantsWait = flags['wait-for'] !== undefined || flags['wait-not'] !== undefined;
      if (wantsWait) {
        // 兼容目标 open --wait-for/--wait-not：对渲染后的 VOM 文本做有界轮询（真实 observe）。
        const waitFor = flags['wait-for'] !== undefined ? String(flags['wait-for']) : null;
        const waitNot = flags['wait-not'] !== undefined ? String(flags['wait-not']) : null;
        const timeoutMs = flags['timeout-ms'] !== undefined
          ? intFlag(flags, 'timeout-ms', { min: 1 })
          : OPEN_WAIT_DEFAULT_TIMEOUT_MS;
        const startedAt = Date.now();
        let attempts = 0;
        for (;;) {
          const obsStep = rpcStep('observe', observeParams, {
            description: '轮询观察（open --wait-for/--wait-not）',
            target: { kind: 'observe', url },
            risk: RISK.READ_ONLY,
            minTimeoutMs: 30000,
          });
          const obs = await callStep(obsStep, io);
          if (!obs.ok) return outputFailure(obs);
          attempts += 1;
          observation = obs.result || null;
          const text = String((observation && (observation.observation !== undefined ? observation.observation : observation.text)) || '');
          const forOk = waitFor === null || text.includes(waitFor);
          const notOk = waitNot === null || !text.includes(waitNot);
          if (forOk && notOk) {
            wait = { waitFor, waitNot, satisfied: true, attempts, waitedMs: Date.now() - startedAt, timeoutMs };
            break;
          }
          if (Date.now() - startedAt >= timeoutMs) {
            wait = { waitFor, waitNot, satisfied: false, attempts, waitedMs: Date.now() - startedAt, timeoutMs };
            return outputFailure({
              ok: false,
              error: {
                code: 'E_TIMEOUT',
                message: 'open 等待超时（' + timeoutMs + 'ms）'
                  + (waitFor !== null ? '：VOM 未包含 "' + waitFor + '"' : '')
                  + (waitNot !== null ? (waitFor !== null ? ' 或 ' : '：') + 'VOM 仍包含 "' + waitNot + '"' : ''),
                data: { wait, sessionId, url },
              },
            });
          }
          await sleep(OPEN_WAIT_POLL_MS);
        }
      } else if ((flags.observe === true || flags.snapshot === true)) {
        const obsStep = rpcStep('observe', observeParams, {
          description: '返回一次观察',
          target: { kind: 'observe', url },
          risk: RISK.READ_ONLY,
          minTimeoutMs: 30000,
        });
        const obs = await callStep(obsStep, io);
        if (!obs.ok) return outputFailure(obs);
        observation = obs.result || null;
      }
    }
    if (isJson()) {
      const result = { sessionId, url: url || null, title: title || null, observation };
      if (wait) result.wait = wait;
      emitJson({ ok: true, result });
      return 0;
    }
    print(`已打开会话 ${sessionId}` + (url ? `：${url}${title ? '（' + title + '）' : ''}` : ''));
    if (wait) {
      print('等待条件已满足（' + wait.attempts + ' 次 observe，' + wait.waitedMs + 'ms）：'
        + (wait.waitFor !== null ? 'VOM 包含 "' + wait.waitFor + '"' : '')
        + (wait.waitNot !== null ? (wait.waitFor !== null ? '，' : '') + 'VOM 不含 "' + wait.waitNot + '"' : ''));
    }
    if (observation) {
      print(observation.observation || '');
      print(`（refs=${observation.refs ?? 0}${observation.truncated ? '，已截断' : ''}）`);
    }
    return 0;
  }

  return { cmdSchema, cmdLedger, cmdOpenAlias };
}
