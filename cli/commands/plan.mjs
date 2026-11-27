// cli/commands/plan.mjs —— plan/step/view（多步动作、单步动作、观察缓存查看）。
import fs from 'node:fs';
import path from 'node:path';
import { ArgError } from '../lib/args.mjs';
import { ContractError, RISK } from '../lib/arg-contract.mjs';
import {
  annotateStepMethods, buildPlan, callStep, dryRunNotes, isDryRun, localStep, outputDryRun,
  planRiskFromSteps, rpcStep,
} from '../lib/action-plan.mjs';
import { normalizeTraceSteps, summarizeReplayPlan } from '../lib/trace-replay.mjs';

export function createPlanCommands(ctx) {
  const {
    callRpc, withSession, timeoutOf, withControl, outputFailure, outputJsonBody, print, emitJson,
    isJson, renderTable, writeFileAtomic, resolveTarget, BridgeError, ArgError: InjectedArgError,
    intFlag, formatTime, spec,
  } = ctx;
  const argError = InjectedArgError || ArgError;
  const io = {
    callRpc,
    timeoutOf,
    flags: null,
    isJson,
    emitJson,
    print,
  };

  function waitVisibleMs(flags) {
    const rawWait = Number(flags['wait-timeout-ms']);
    return Number.isFinite(rawWait) && rawWait > 0 ? Math.min(Math.max(Math.round(rawWait), 1), 25000) : 5000;
  }

  function untilVisibleStep(flags, selector) {
    const waitMs = waitVisibleMs(flags);
    const params = withSession(flags, { selector, state: 'visible', timeoutMs: waitMs });
    return rpcStep('wait-for-element', params, {
      description: '等待目标出现：' + selector,
      target: { kind: 'selector', name: selector },
      risk: RISK.READ_ONLY,
      minTimeoutMs: waitMs + 5000,
    });
  }

  async function waitUntilVisible(flags, selector) {
    const body = await callStep(untilVisibleStep(flags, selector), { ...io, flags });
    if (body.ok) return { selector, ...body.result };
    return { selector, satisfied: false, error: body.error || null };
  }

  /** 解析并校验 --steps/--steps-file；返回 { steps, raw }。 */
  function readSteps(flags) {
    const raw = flags['steps-file'] !== undefined
      ? (() => {
        const file = path.resolve(process.cwd(), String(flags['steps-file']));
        try {
          return fs.readFileSync(file, 'utf8');
        } catch (error) {
          throw new ContractError('E_ARG_TYPE', '读取 --steps-file 失败：' + error.message, {
            hint: '检查路径：' + file,
            usage: 'bridge plan --steps-file <json>',
          });
        }
      })()
      : (flags.steps !== undefined ? String(flags.steps) : null);
    if (!raw) {
      throw new ContractError('E_ARG_MISSING', 'plan 需要 --steps \'[{"method":"click","params":{"selector":"#a"}}]\' 或 --steps-file <json>', {
        hint: '内联 JSON 用单引号包住；也可以把数组写进 plan.json 用 --steps-file plan.json。',
        usage: 'bridge plan --steps <json> | --steps-file <json>',
      });
    }
    let steps;
    try {
      steps = JSON.parse(raw);
    } catch (error) {
      throw new ContractError('E_ARG_TYPE', '--steps 不是合法 JSON：' + error.message, {
        hint: '示例：--steps \'[{"method":"click","params":{"selector":"#a"}}]\'。',
        usage: 'bridge plan --steps <json>',
      });
    }
    if (!Array.isArray(steps) || !steps.length) {
      throw new ContractError('E_ARG_TYPE', '--steps 需要非空数组', {
        hint: '示例：--steps \'[{"method":"click","params":{"selector":"#a"}}]\'。',
        usage: 'bridge plan --steps <json>',
      });
    }
    steps.forEach((step, index) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        throw new ContractError('E_ARG_TYPE', '第 ' + (index + 1) + ' 步不是对象', {
          hint: '每一步形如 {"method":"click","params":{...}}。', usage: 'bridge plan --steps <json>',
        });
      }
      const method = step.method !== undefined ? step.method : step.action;
      if (typeof method !== 'string' || !method.trim()) {
        throw new ContractError('E_ARG_TYPE', '第 ' + (index + 1) + ' 步缺少 method', {
          hint: '每一步形如 {"method":"click","params":{...}}。', usage: 'bridge plan --steps <json>',
        });
      }
    });
    return { steps, raw };
  }

  function buildPlanCommand(flags, pos) {
    const { steps } = readSteps(flags);
    const params = withControl(flags, { steps });
    const riskInfo = planRiskFromSteps(steps);
    const annotated = annotateStepMethods(steps);
    const planSteps = [rpcStep('plan', params, {
      description: '执行 ' + steps.length + ' 步动作',
      target: { kind: 'plan', name: String(steps.length) },
      risk: riskInfo.risk,
      minTimeoutMs: 120000,
      effects: annotated.mutating.slice(0, 8),
    })];
    const untilVisible = flags['until-visible'] !== undefined ? String(flags['until-visible']).trim() : '';
    if (untilVisible) planSteps.push(untilVisibleStep(flags, untilVisible));
    if (flags['save-full'] !== undefined) {
      planSteps.push(localStep({
        action: 'write',
        description: '把执行后的完整观察写入文件',
        paths: [path.resolve(process.cwd(), String(flags['save-full']))],
        risk: RISK.LOCAL_WRITE,
      }));
    }
    return buildPlan({
      command: 'plan',
      subcommand: null,
      risk: riskInfo.risk,
      steps: planSteps,
      warnings: riskInfo.warnings,
      notes: dryRunNotes(flags),
    });
  }

  async function cmdPlan(flags, pos, invocation) {
    io.flags = flags;
    const planned = buildPlanCommand(flags, pos);
    if (isDryRun(flags)) return outputDryRun(planned, io);
    const steps = planned.steps[0].params.steps;
    const body = await callStep(planned.steps[0], io);
    if (!body.ok) return outputFailure(body);
    const untilVisible = flags['until-visible'] !== undefined ? String(flags['until-visible']).trim() : '';
    if (untilVisible && body.result && body.result.failedAt == null) {
      body.result.untilVisible = await waitUntilVisible(flags, untilVisible);
    }
    if (flags['save-full'] !== undefined && body.result) {
      const file = path.resolve(process.cwd(), String(flags['save-full']));
      const observation = body.result.observation;
      if (observation && typeof observation.text === 'string') {
        writeFileAtomic(file, String(observation.text), 0o600);
        body.result.savedTo = file;
      } else {
        body.result.saveError = { code: 'E_OBSERVE_FAILED', message: 'plan 后的同步观察不可用' };
      }
    }
    if (isJson()) return outputJsonBody(body);
    const result = body.result || {};
    const rows = (result.steps || []).map((step) => [
      String(step.index),
      step.method || '',
      step.ok ? 'ok' : 'fail',
      step.ok ? '' : (step.error && step.error.code ? step.error.code : ''),
    ]);
    print(renderTable(['#', 'method', 'result', 'error'], rows));
    print('完成 ' + (result.completed || 0) + '/' + steps.length + (result.failedAt != null ? '，第 ' + result.failedAt + ' 步失败' : ''));
    if (result.observation) {
      print('观察：变化 ' + result.observation.changed + ' 行，refs ' + result.observation.refs);
    }
    if (result.untilVisible) {
      print('until-visible ' + result.untilVisible.selector + '：' + (result.untilVisible.satisfied ? '已可见' : '等待超时'));
    }
    return result.failedAt != null ? 1 : 0;
  }

  function buildAction(flags, pos) {
    // 兼容 --action/--method：方法名可来自 flag，位置参数作为 ref/selector（0 必选位置参数）。
    const flagMethod = flags.action !== undefined ? flags.action : flags.method;
    const method = flagMethod !== undefined ? String(flagMethod) : pos[1];
    if (!method) throw new ContractError('E_ARG_MISSING', 'step 需要 <method> 或 --action', { hint: '用法：bridge step <method> [参数] | bridge step --action <method> --params <json>', usage: 'bridge step <method> [参数]' });
    const params = {};
    if (flags.params !== undefined) {
      let parsed;
      try {
        parsed = JSON.parse(String(flags.params));
      } catch {
        throw new ContractError('E_ARG_TYPE', '--params 不是合法 JSON', { hint: '示例：--params "{\"ref\":\"@e1\"}"' });
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ContractError('E_ARG_TYPE', '--params 必须是 JSON 对象', { hint: '示例：--params "{\"ref\":\"@e1\"}"' });
      }
      Object.assign(params, parsed);
    }
    const targetIndex = flagMethod !== undefined ? 1 : 2;
    const target = resolveTarget(flags, pos, targetIndex, { required: false });
    if (target) Object.assign(params, target);
    if (flags.value !== undefined) params.value = String(flags.value);
    if (flags.key !== undefined) params.key = String(flags.key);
    if (flags.url !== undefined) params.url = String(flags.url);
    if (pos[2] && !target && method === 'navigate') params.url = pos[2];
    return { method: String(method), params };
  }

  function buildStepPlan(flags, pos) {
    const action = buildAction(flags, pos);
    const riskInfo = planRiskFromSteps([{ method: action.method }]);
    const planSteps = [rpcStep('step', withControl(flags, { action }), {
      description: '执行 ' + action.method,
      target: { kind: 'step', name: action.method },
      risk: riskInfo.risk,
      minTimeoutMs: 120000,
    })];
    const untilVisible = flags['until-visible'] !== undefined ? String(flags['until-visible']).trim() : '';
    if (untilVisible) planSteps.push(untilVisibleStep(flags, untilVisible));
    if (flags['save-full'] !== undefined) {
      planSteps.push(localStep({
        action: 'write',
        description: '把执行后的完整观察写入文件',
        paths: [path.resolve(process.cwd(), String(flags['save-full']))],
        risk: RISK.LOCAL_WRITE,
      }));
    }
    return buildPlan({
      command: 'step',
      subcommand: null,
      risk: riskInfo.risk,
      steps: planSteps,
      warnings: riskInfo.warnings,
      notes: dryRunNotes(flags),
    });
  }

  async function cmdStep(flags, pos, invocation) {
    io.flags = flags;
    const planned = buildStepPlan(flags, pos);
    if (isDryRun(flags)) return outputDryRun(planned, io);
    const body = await callStep(planned.steps[0], io);
    if (!body.ok) return outputFailure(body);
    const untilVisible = flags['until-visible'] !== undefined ? String(flags['until-visible']).trim() : '';
    if (untilVisible && body.result) {
      body.result.untilVisible = await waitUntilVisible(flags, untilVisible);
    }
    if (flags['save-full'] !== undefined && body.result && body.result.observation) {
      const file = path.resolve(process.cwd(), String(flags['save-full']));
      writeFileAtomic(file, String(body.result.observation.text || ''), 0o600);
      body.result.savedTo = file;
    }
    if (isJson()) return outputJsonBody(body);
    const result = body.result || {};
    print('动作：ok');
    const observation = result.observation;
    if (observation) {
      print('观察：变化 ' + observation.changed + ' 行，refs ' + observation.refs);
      print(observation.text || '');
    }
    if (result.untilVisible) {
      print('until-visible ' + result.untilVisible.selector + '：' + (result.untilVisible.satisfied ? '已可见' : '等待超时'));
    }
    return 0;
  }

  function buildViewPlan(flags, pos) {
    if (pos[1]) {
      return buildPlan({
        command: 'view',
        subcommand: null,
        risk: RISK.READ_ONLY,
        steps: [localStep({
          action: 'read',
          description: '读取本地观察文件',
          paths: [path.resolve(process.cwd(), String(pos[1]))],
          risk: RISK.READ_ONLY,
        })],
      });
    }
    const params = withControl(flags, {});
    if (flags.grep !== undefined) params.grep = String(flags.grep);
    const offset = intFlag(flags, 'offset', { min: 0 });
    if (offset !== undefined) params.offset = offset;
    const limit = intFlag(flags, 'limit', { min: 1 });
    if (limit !== undefined) params.limit = limit;
    return buildPlan({
      command: 'view',
      subcommand: null,
      risk: RISK.READ_ONLY,
      steps: [rpcStep('view', params, {
        description: '读取观察缓存',
        target: { kind: 'observation-cache' },
        risk: RISK.READ_ONLY,
      })],
      notes: dryRunNotes(flags),
    });
  }

  function viewFile(file, flags) {
    const target = path.resolve(process.cwd(), String(file));
    let text = '';
    try {
      text = fs.readFileSync(target, 'utf8');
    } catch (error) {
      throw new BridgeError('E_NOT_FOUND', '读不到文件：' + target);
    }
    const lines = text.split('\n');
    const find = flags.find !== undefined ? String(flags.find) : '';
    const start = intFlag(flags, 'start-line', { min: 1 }) ?? 1;
    const count = intFlag(flags, 'line-count', { min: 1 }) ?? 200;
    let rows = [];
    let matched = 0;
    if (find) {
      const needle = find.toLowerCase();
      const keep = new Set();
      lines.forEach((line, index) => {
        if (!line.toLowerCase().includes(needle)) return;
        matched += 1;
        for (let offset = -2; offset <= 2; offset += 1) {
          const target2 = index + offset;
          if (target2 >= 0 && target2 < lines.length) keep.add(target2);
        }
      });
      rows = [...keep].sort((a, b) => a - b);
    } else {
      rows = [];
      for (let index = start - 1; index < Math.min(lines.length, start - 1 + count); index += 1) rows.push(index);
    }
    if (isJson()) {
      emitJson({
        ok: true,
        result: {
          file: target,
          total: lines.length,
          matched: matched,
          lines: rows.map((index) => ({ number: index + 1, text: lines[index] })),
        },
      });
      return 0;
    }
    if (!rows.length) {
      print('(没有内容)');
      return 0;
    }
    print(rows.map((index) => String(index + 1).padStart(5) + ' | ' + lines[index]).join('\n'));
    return 0;
  }

  async function cmdView(flags, pos, invocation) {
    io.flags = flags;
    const planned = buildViewPlan(flags, pos);
    if (isDryRun(flags)) return outputDryRun(planned, io);
    if (pos[1]) return viewFile(pos[1], flags);
    const body = await callStep(planned.steps[0], io);
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    const result = body.result || {};
    print('url: ' + result.url + '\n缓存时间: ' + formatTime(result.at) + '，共 ' + result.total + ' 行，命中 ' + result.matched + ' 行');
    print('');
    print((result.lines || []).join('\n'));
    return 0;
  }


  /** replay <trace.json>：把 record export 的 Trace v3 映射为 plan 步骤并执行（dry-run 只摘要）。 */
  async function cmdReplay(flags, pos, invocation) {
    const file = pos[1] !== undefined ? pos[1] : pos[0];
    if (!file) throw new argError('E_BAD_ARG', 'replay 需要 trace.json 路径（record export 产物）', {
      usage: 'bridge replay <trace.json> [--dry-run]',
    });
    const target = path.resolve(process.cwd(), String(file));
    let trace;
    try {
      trace = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch (error) {
      throw new argError('E_BAD_ARG', '读取 trace 失败：' + ((error && error.message) || error), { path: target });
    }
    const normalized = normalizeTraceSteps(trace);
    const summary = summarizeReplayPlan(normalized, { source: target });
    if (isDryRun(flags)) {
      if (isJson()) emitJson({ ok: true, result: summary, schema: 'bb.cli/1', command: 'replay', dryRun: true });
      else print(JSON.stringify(summary, null, 2));
      return 0;
    }
    const planFlags = { ...flags, steps: JSON.stringify(normalized.steps) };
    return cmdPlan(planFlags, [], invocation);
  }
  return { cmdPlan, cmdStep, cmdView, cmdReplay };
}
