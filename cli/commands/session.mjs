// cli/commands/session.mjs —— `bridge session start|stop|list|run-log|pause|resume|rebind|control*|handoff`。
//
// 每个子命令先用 buildPlan 构造“将要发生的动作”（RPC 方法 + 参数 + 目标 + 风险），
// 再二选一：--dry-run 只输出预检；否则用同一份 plan 里的方法/参数调用 daemon。
// 参数合法性与“缺什么/为什么互斥”由 cli/lib/command-specs.mjs 统一判定（在 bridge 入口执行）。
import { ArgError, intFlag, parseDurationMs } from '../lib/args.mjs';
import { renderTable, formatTime, formatLease, truncateText } from '../lib/format.mjs';
import { ContractError, RISK } from '../lib/arg-contract.mjs';
import { buildPlan, callStep, dryRunNotes, isDryRun, outputDryRun, rpcStep } from '../lib/action-plan.mjs';
import { isControllerInfo } from '../../extension/src/lib/controller-info.js';

export function createSessionCommand({
  callRpc,
  timeoutOf,
  outputFailure,
  outputJsonBody,
  isJson,
  print,
  spec,
}) {
  const io = {
    callRpc,
    timeoutOf,
    flags: null,
    isJson,
    // dry-run 的 JSON 走与普通成功回包同一个出口（统一 --json 契约）。
    emitJson: (body) => outputJsonBody(body),
    print,
  };

  /** 统一出口：dry-run 或执行第一步 RPC。 */
  async function runPlan(plan, flags) {
    io.flags = flags;
    if (isDryRun(flags)) return outputDryRun(plan, io);
    const body = await callStep(plan.steps[0], io);
    return { plan, body };
  }

  function buildStartPlan(flags) {
    const params = { focus: flags.focus === true };
    if (flags.incognito === true) params.incognito = true;
    if (flags['allow-domains'] !== undefined) params.allowDomains = String(flags['allow-domains']);
    if (flags['deny-domains'] !== undefined) params.denyDomains = String(flags['deny-domains']);
    if (flags['min-interval'] !== undefined) params.minIntervalMs = Math.min(parseDurationMs(flags['min-interval'], 0), 5000);
    if (flags.browser !== undefined) params.browser = String(flags.browser);
    if (flags.scope !== undefined) params.scope = String(flags.scope);
    else if (process.env.BB_SESSION_SCOPE && process.env.BB_SESSION_SCOPE.trim()) params.scope = process.env.BB_SESSION_SCOPE.trim();
    const controller = controllerFromFlags(flags);
    if (controller) params.controller = controller;
    if (flags.tab !== undefined) params.tab = intFlag(flags, 'tab', { min: 1 });
    if (flags.share === true) {
      if (params.tab === undefined) {
        throw new ContractError('E_ARG_REQUIRES', '--share 需要 --tab <tabId>（共享已有标签页）', {
          hint: '共享已有标签页需要 --tab <tabId>。',
          usage: 'bridge session start --tab <tabId> --share',
        });
      }
      params.share = true;
    }
    if (flags.control !== undefined) params.controlMode = String(flags.control);
    // 可恢复启动：调用方生成 <expiry>:<id> 作为 requestId；同 token 重试返回既有会话。
    const requestId = flags['request-id'] !== undefined ? String(flags['request-id']) : null;
    if (requestId) params.requestId = requestId;
    const method = requestId ? 'session.start_tracked' : 'session.start';
    const target = { kind: 'session-start', browser: params.browser || '(默认浏览器)' };
    if (flags.share === true) target.tabId = params.tab;
    const warnings = [];
    if (flags.share === true) warnings.push('将共享 tab ' + params.tab + '，其他会话也会看到该标签页。');
    if (flags.incognito === true) warnings.push('无痕窗口不会被现有登录态复用。');
    return buildPlan({
      command: 'session',
      subcommand: 'start',
      risk: RISK.BROWSER_MUTATION,
      steps: [rpcStep(method, params, {
        description: '新建 Agent 会话' + (flags.share === true ? '（共享 tab ' + params.tab + '）' : ''),
        target,
        risk: RISK.BROWSER_MUTATION,
      })],
      warnings,
      notes: dryRunNotes(flags),
    });
  }

  function buildRequestPlan(flags, sub) {
    const requestId = flags['request-id'] !== undefined ? String(flags['request-id']) : '';
    if (!requestId) throw new ArgError('用法：bridge session ' + sub + ' --request-id <token>');
    const methods = {
      prepare: 'session.request_prepare',
      claim: 'session.request_claim',
      cancel: 'session.request_cancel',
      request: 'session.request_status',
    };
    const params = { requestId };
    if (sub === 'prepare') {
      if (flags.browser !== undefined) params.browser = String(flags.browser);
      if (flags['no-focus'] === true) params.noFocus = true;
      if (flags.incognito === true) params.incognito = true;
    }
    const risk = sub === 'request' ? RISK.READ_ONLY : RISK.DAEMON_STATE;
    return buildPlan({
      command: 'session',
      subcommand: sub,
      risk,
      steps: [rpcStep(methods[sub], params, {
        description: ({ prepare: '预登记启动请求', claim: '认领已就绪的启动请求', cancel: '取消启动请求', request: '查询启动请求状态' })[sub],
        target: { kind: 'start-request', name: requestId },
        risk,
      })],
      notes: dryRunNotes(flags),
    });
  }

  function buildStopPlan(flags, pos) {
    if (flags.all === true) {
      const params = { keep: flags.keep === true };
      return buildPlan({
        command: 'session',
        subcommand: 'stop',
        risk: RISK.BROWSER_MUTATION,
        steps: [rpcStep('session.stop_all', params, {
          description: '停止所有会话' + (params.keep ? '（保留窗口）' : ''),
          target: { kind: 'all-sessions' },
          risk: RISK.BROWSER_MUTATION,
          minTimeoutMs: 60000,
        })],
        warnings: ['将停止当前浏览器实例上的所有会话' + (params.keep ? '（窗口保留）' : '（默认关闭会话窗口）') + '。'],
        confirmations: ['--all 是不可撤销的批量操作'],
        notes: dryRunNotes(flags),
      });
    }
    const sessionId = pos[2] || flags.session;
    if (!sessionId) throw new ArgError('用法：bridge session stop <sessionId> [--keep] | bridge session stop --all');
    const params = { session: String(sessionId), keep: flags.keep === true };
    return buildPlan({
      command: 'session',
      subcommand: 'stop',
      risk: RISK.BROWSER_MUTATION,
      steps: [rpcStep('session.stop', params, {
        description: '停止会话 ' + params.session + (params.keep ? '（保留窗口）' : ''),
        target: { kind: 'session', sessionId: params.session },
        risk: RISK.BROWSER_MUTATION,
      })],
      notes: dryRunNotes(flags),
    });
  }

  function buildRunLogPlan(flags, pos) {
    const sessionId = pos[2] || flags.session;
    if (!sessionId) throw new ArgError('用法：bridge session run-log <sessionId> [--limit N]');
    const params = { session: String(sessionId) };
    const limit = intFlag(flags, 'limit', { min: 1 });
    if (limit !== undefined) params.limit = limit;
    return buildPlan({
      command: 'session',
      subcommand: 'run-log',
      risk: RISK.READ_ONLY,
      steps: [rpcStep('session.run_log', params, {
        description: '读取会话步骤日志',
        target: { kind: 'session', sessionId: params.session },
        risk: RISK.READ_ONLY,
      })],
    });
  }

  function buildPausePlan(flags, pos, sub) {
    const sessionId = pos[2] || flags.session;
    if (!sessionId) throw new ArgError('用法：bridge session pause|resume <sessionId>');
    const params = { session: String(sessionId), paused: sub === 'pause' };
    if (flags.reason !== undefined) params.reason = String(flags.reason);
    if (flags.auto === true) params.auto = true;
    return buildPlan({
      command: 'session',
      subcommand: sub,
      risk: RISK.DAEMON_STATE,
      steps: [rpcStep('session.pause', params, {
        description: (sub === 'pause' ? '暂停会话 ' : '恢复会话 ') + params.session,
        target: { kind: 'session', sessionId: params.session },
        risk: RISK.DAEMON_STATE,
      })],
    });
  }

  function buildRebindPlan(flags, pos) {
    const sessionId = pos[2] || flags.session;
    if (!sessionId) throw new ArgError('用法：bridge session rebind <sessionId> --tab <tabId> [--release-old]');
    const tabId = intFlag(flags, 'tab', { min: 1 });
    if (!tabId) throw new ArgError('session rebind 需要 --tab <tabId>');
    const params = { session: String(sessionId), tab: tabId, releaseOld: flags['release-old'] === true };
    return buildPlan({
      command: 'session',
      subcommand: 'rebind',
      risk: RISK.DAEMON_STATE,
      steps: [rpcStep('session.rebind', params, {
        description: '把会话重绑到 tab ' + tabId,
        target: { kind: 'session', sessionId: params.session, tabId },
        risk: RISK.DAEMON_STATE,
      })],
    });
  }

  function buildListPlan(flags) {
    return buildPlan({
      command: 'session',
      subcommand: 'list',
      risk: RISK.READ_ONLY,
      steps: [rpcStep('session.list', {}, { description: '列出活动会话', target: { kind: 'sessions' }, risk: RISK.READ_ONLY })],
    });
  }

  function buildControlPlan(flags, pos) {
    const sessionId = pos[2] || flags.session;
    if (!sessionId) throw new ArgError('用法：bridge session control <sessionId> [--mode open|exclusive]');
    if (flags.mode !== undefined) {
      const mode = String(flags.mode);
      // 防御性校验：bridge 入口已校验，但命令模块也可能被单测/其它调用方直接使用。
      if (!['open', 'exclusive'].includes(mode)) {
        throw new ContractError('E_ARG_ENUM', '--mode 只支持 open|exclusive，收到 "' + mode + '"', {
          hint: '改成 open 或 exclusive。',
          usage: 'bridge session control <sessionId> [--mode open|exclusive]',
        });
      }
      return buildPlan({
        command: 'session',
        subcommand: 'control',
        risk: RISK.DAEMON_STATE,
        steps: [rpcStep('session.control_mode', { session: String(sessionId), mode }, {
          description: '切换 tab 共享控制模式为 ' + mode,
          target: { kind: 'session', sessionId: String(sessionId) },
          risk: RISK.DAEMON_STATE,
        })],
      });
    }
    return buildPlan({
      command: 'session',
      subcommand: 'control',
      risk: RISK.READ_ONLY,
      steps: [rpcStep('session.control_status', { session: String(sessionId) }, {
        description: '读取控制权/租约状态',
        target: { kind: 'session', sessionId: String(sessionId) },
        risk: RISK.READ_ONLY,
      })],
    });
  }

  function buildClaimControlPlan(flags, pos) {
    const sessionId = pos[2] || flags.session;
    if (!sessionId) throw new ArgError('用法：bridge session claim-control <sessionId> [--lease 60s] [--expect-epoch N]');
    const params = { session: String(sessionId) };
    if (flags.lease !== undefined) params.leaseMs = parseDurationMs(flags.lease, 60000);
    const epoch = intFlag(flags, 'expect-epoch', { min: 0 });
    if (epoch !== undefined) params.expectEpoch = epoch;
    return buildPlan({
      command: 'session',
      subcommand: 'claim-control',
      risk: RISK.DAEMON_STATE,
      steps: [rpcStep('session.claim_control', params, {
        description: '认领/续租控制权',
        target: { kind: 'session', sessionId: params.session },
        risk: RISK.DAEMON_STATE,
      })],
    });
  }

  function buildReleaseControlPlan(flags, pos) {
    const sessionId = pos[2] || flags.session;
    if (!sessionId) throw new ArgError('用法：bridge session release-control <sessionId> [--expect-epoch N]');
    const params = { session: String(sessionId) };
    const epoch = intFlag(flags, 'expect-epoch', { min: 0 });
    if (epoch !== undefined) params.expectEpoch = epoch;
    return buildPlan({
      command: 'session',
      subcommand: 'release-control',
      risk: RISK.DAEMON_STATE,
      steps: [rpcStep('session.release_control', params, {
        description: '释放控制权',
        target: { kind: 'session', sessionId: params.session },
        risk: RISK.DAEMON_STATE,
      })],
    });
  }

  function buildHandoffPlan(flags, pos) {
    const sessionId = pos[2] || flags.session;
    const to = pos[3] || flags.to;
    if (!sessionId || !to) throw new ArgError('用法：bridge session handoff <sessionId> --to <targetSessionId> [--lease 60s] [--expect-epoch N]');
    const params = { session: String(sessionId), to: String(to) };
    if (flags.lease !== undefined) params.leaseMs = parseDurationMs(flags.lease, 60000);
    const epoch = intFlag(flags, 'expect-epoch', { min: 0 });
    if (epoch !== undefined) params.expectEpoch = epoch;
    return buildPlan({
      command: 'session',
      subcommand: 'handoff',
      risk: RISK.DAEMON_STATE,
      steps: [rpcStep('session.handoff', params, {
        description: '把控制权转交给 ' + params.to,
        target: { kind: 'session', sessionId: params.session, name: params.to },
        risk: RISK.DAEMON_STATE,
      })],
    });
  }

  return async function cmdSession(flags, pos, invocation) {
    const sub = (invocation && invocation.sub) || pos[1];
    if (sub === 'start') {
      const planned = await runPlan(buildStartPlan(flags), flags);
      if (typeof planned === 'number') return planned;
      const { body } = planned;
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      print(`session ${result.sessionId} 已创建（instance ${result.instanceId}, tab ${result.tabId}, window ${result.windowId}）${result.shared ? ' [shared]' : ''}`);
      return 0;
    }
    if (sub === 'prepare' || sub === 'claim' || sub === 'cancel' || sub === 'request') {
      const planned = await runPlan(buildRequestPlan(flags, sub), flags);
      if (typeof planned === 'number') return planned;
      const { body } = planned;
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const requestId = flags['request-id'] !== undefined ? String(flags['request-id']) : '';
      const entry = (body.result && body.result.entry) || {};
      print(`request ${requestId} state=${entry.state || 'unknown'}` +
        (entry.result && entry.result.sessionId ? ` session=${entry.result.sessionId}` : ''));
      return 0;
    }
    if (sub === 'stop') {
      const planned = await runPlan(buildStopPlan(flags, pos), flags);
      if (typeof planned === 'number') return planned;
      const { body } = planned;
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      if (flags.all === true) {
        const result = body.result || {};
        print('已停止 ' + (result.count || 0) + ' 个会话' + (result.failed && result.failed.length ? '，失败 ' + result.failed.length + ' 个' : ''));
        return 0;
      }
      const sessionId = pos[2] || flags.session;
      const handedOff = body.result && body.result.handedOff;
      print(`session ${sessionId} 已停止${flags.keep === true ? '（保留窗口）' : ''}`
        + (handedOff ? `（共享 tab ${handedOff.tabId} 的控制权/主会话转交 ${handedOff.sessionId}）` : ''));
      return 0;
    }
    if (sub === 'run-log') {
      const planned = await runPlan(buildRunLogPlan(flags, pos), flags);
      if (typeof planned === 'number') return planned;
      const { body } = planned;
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      const steps = Array.isArray(result.steps) ? result.steps : [];
      if (!steps.length) {
        print('（该会话没有可记录的步骤）');
        return 0;
      }
      print(renderTable(
        ['#', 'kind', 'method', 'target', 'ok'],
        steps.map((step, index) => [
          String(index + 1),
          step.kind || '',
          step.method || '',
          step.kind === 'navigate' ? ((step.origin || '') + (step.path || '') + (step.dropped_query ? '?…' : '')) : JSON.stringify(step.target || {}),
          step.ok === false ? 'no' : 'yes',
        ]),
      ));
      if (result.truncated === true) print('（已达到步数上限，较早的步骤被丢弃）');
      return 0;
    }
    if (sub === 'pause' || sub === 'resume') {
      const planned = await runPlan(buildPausePlan(flags, pos, sub), flags);
      if (typeof planned === 'number') return planned;
      const { body } = planned;
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const sessionId = pos[2] || flags.session;
      print('session ' + sessionId + (sub === 'pause' ? ' 已暂停' : ' 已恢复'));
      return 0;
    }
    if (sub === 'rebind') {
      const planned = await runPlan(buildRebindPlan(flags, pos), flags);
      if (typeof planned === 'number') return planned;
      const { body } = planned;
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const sessionId = pos[2] || flags.session;
      const result = body.result || {};
      print('session ' + sessionId + ' 已重绑到 tab ' + result.tabId + '（' + (result.url || '') + '）');
      return 0;
    }
    if (sub === 'list') {
      const planned = await runPlan(buildListPlan(flags), flags);
      if (typeof planned === 'number') return planned;
      const { body } = planned;
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const sessions = (body.result && body.result.sessions) || [];
      if (!sessions.length) {
        print('没有活动 session');
        return 0;
      }
      print(renderTable(
        ['session', 'instance', 'tab', 'window', 'agent / project', 'url', 'title', 'started'],
        sessions.map((item) => [
          item.sessionId,
          item.instanceId,
          item.tabId,
          item.windowId,
          item.controller ? (item.controller.project ? `${item.controller.name} / ${item.controller.project}` : item.controller.name) : '-',
          truncateText(item.url, 48),
          truncateText(item.title, 32),
          formatTime(item.startedAt),
        ]),
      ));
      const sharedTabs = new Map();
      for (const item of sessions) {
        if (item.control && item.control.shared) sharedTabs.set(item.tabId, item.control);
      }
      for (const [tabId, control] of sharedTabs) {
        print('tab ' + tabId + ' 共享：mode=' + control.mode + ' holder=' + (control.holder || '(空闲)')
          + ' epoch=' + control.epoch + ' 租约=' + formatLease(control.leaseRemainingMs)
          + ' 会话=' + (control.sessionCount || 0));
      }
      return 0;
    }
    if (sub === 'control') {
      const planned = await runPlan(buildControlPlan(flags, pos), flags);
      if (typeof planned === 'number') return planned;
      const { body } = planned;
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const sessionId = pos[2] || flags.session;
      if (flags.mode !== undefined) {
        print('session ' + sessionId + ' 所在 tab 的共享控制模式：' + String(flags.mode));
        return 0;
      }
      const control = body.result || {};
      print('tab ' + control.tabId + ' 控制权：holder=' + (control.holder || '(空闲)')
        + ' mode=' + control.mode + ' epoch=' + control.epoch
        + ' 租约=' + formatLease(control.leaseRemainingMs)
        + (control.holdsControl ? '（本会话持有）' : '（本会话不持有）'));
      if (control.shared) {
        print('共享会话：' + (control.sessions || []).join(', ') + '（primary=' + (control.primary || '-') + '）');
        if (Array.isArray(control.control && control.control.history) && control.control.history.length) {
          const last = control.control.history[control.control.history.length - 1];
          print('最近转移：' + last.reason + ' ' + (last.from || '-') + ' → ' + (last.to || '-') + '（epoch ' + last.epoch + '）');
        }
      }
      return 0;
    }
    if (sub === 'claim-control') {
      const planned = await runPlan(buildClaimControlPlan(flags, pos), flags);
      if (typeof planned === 'number') return planned;
      const { body } = planned;
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const sessionId = pos[2] || flags.session;
      const result = body.result || {};
      print('session ' + sessionId + (result.renewed ? ' 续租控制权' : ' 已获得控制权')
        + '（epoch ' + result.epoch + '，租约 ' + formatLease(result.leaseRemainingMs) + '）'
        + (result.preempted ? '，从 ' + result.preempted + ' 收回' : ''));
      return 0;
    }
    if (sub === 'release-control') {
      const planned = await runPlan(buildReleaseControlPlan(flags, pos), flags);
      if (typeof planned === 'number') return planned;
      const { body } = planned;
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const sessionId = pos[2] || flags.session;
      print('session ' + sessionId + ' 已释放控制权（epoch ' + (body.result || {}).epoch + '）');
      return 0;
    }
    if (sub === 'handoff') {
      const planned = await runPlan(buildHandoffPlan(flags, pos), flags);
      if (typeof planned === 'number') return planned;
      const { body } = planned;
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const sessionId = pos[2] || flags.session;
      const result = body.result || {};
      print('控制权已从 ' + sessionId + ' 转交 ' + result.to + '（tab ' + result.tabId + ', epoch ' + result.epoch + '，租约 ' + formatLease(result.leaseRemainingMs) + '）');
      return 0;
    }
    throw new ContractError('E_BAD_SUBCOMMAND', 'bridge session 没有子命令 "' + sub + '"', {
      hint: '可用子命令：' + (spec ? spec.order.join('|') : 'start|stop|list') + '。',
    });
  };
}

/** 由 --agent-name/--project/--controller-color 组装 controller（已由 spec 校验）。 */
function controllerFromFlags(flags) {
  if (flags['agent-name'] === undefined) return null;
  const controller = { name: String(flags['agent-name']) };
  if (flags.project !== undefined) controller.project = String(flags.project);
  if (flags['controller-color'] !== undefined) controller.color = String(flags['controller-color']);
  if (!isControllerInfo(controller)) throw new ArgError('--agent-name/--project/--controller-color 不合法（名称 1-80 字符，项目 1-120 字符，颜色 #rrggbb）');
  return controller;
}
