// cli/commands/cooperate.mjs —— cooperate/operation（从 bridge 拆出）。
import fs from 'node:fs';
import path from 'node:path';

export function createCooperateCommands(ctx) {
  const { callRpc, withControl, timeoutOf, outputFailure, outputJsonBody, print, isJson, intFlag, parseDurationMs, ArgError, BridgeError, requirePos } = ctx;

async function cmdCooperate(flags, pos) {
    const sub = pos[1];
    if (sub === 'sync') {
      const params = withControl(flags, {});
      if (flags.policy !== undefined) params.policy = String(flags.policy);
      if (flags['probe-hover'] === true) params.probeHover = true;
      if (flags['match-text'] !== undefined) params.matchText = String(flags['match-text']);
      if (flags['context-lines'] !== undefined) params.contextLines = intFlag(flags, 'context-lines', { min: 0 });
      const body = await callRpc('cooperate.sync', params, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      print('control_policy: ' + result.control_policy);
      print('context_id: ' + result.context_id);
      print('observation_id: ' + result.observation_id);
      print('');
      print('url: ' + (result.url || ''));
      print('title: ' + (result.title || ''));
      if (result.cooperation) {
        const coop = result.cooperation;
        const fields = Array.isArray(coop.fields) ? coop.fields : [];
        const media = Array.isArray(coop.media) ? coop.media : [];
        print('cooperation: fields=' + fields.length + ' media=' + media.length +
          ' editing=' + (coop.editing === true) + ' focus=' + (coop.focus || '-') +
          ' human=' + ((coop.activity && coop.activity.lastKind) || '-') +
          ' mode=' + (coop.mode || '-') + ' rev=' + (coop.revision ?? '-'));
      }
      print('');
      print(result.observation && result.observation.text ? result.observation.text : '');
      return 0;
    }
    if (sub === 'hold') {
      const held = flags.release !== true;
      const body = await callRpc('cooperate.hold', withControl(flags, { held }), timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      print(held ? '已人工接管（held）：Agent 动作会被 E_SESSION_PAUSED 拒绝' : '已交回 Agent（held=false）');
      return 0;
    }
    if (sub === 'handback') {
      const body = await callRpc('cooperate.handback', withControl(flags, {}), timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      print('已交回控制权（agent 可继续操作）');
      return 0;
    }
    if (sub === 'wait') {
      const params = withControl(flags, {});
      if (flags.timeout !== undefined) params.timeoutMs = parseDurationMs(flags.timeout, 0);
      const body = await callRpc('cooperate.wait', params, Math.max(timeoutOf(flags), (params.timeoutMs || 0) + 5000));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      print('state: ' + ((result.state && result.state.mode) || 'unknown') + '（ready=' + Boolean(result.ready) + '，waited=' + (result.waitedMs || 0) + 'ms）');
      if (result.context_id) print('context_id: ' + result.context_id);
      return 0;
    }
    throw new ArgError('用法：bridge cooperate sync [--policy auto|strict] [--probe-hover] | cooperate wait');
  }
async function cmdOperation(flags, pos) {
    const sub = pos[1];
    if (sub === 'await') {
      const id = requirePos(pos, 2, '<operationId>');
      const timeoutMs = Math.max(1000, parseDurationMs(flags.timeout, 60000));
      const body = await callRpc('operation.await', withControl(flags, { id, timeoutMs }), timeoutMs + 5000);
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      print('operation ' + id + '：' + (result.state || 'unknown'));
      if (result.state === 'completed') {
        print(JSON.stringify(result.result === undefined ? {} : result.result).slice(0, 2000));
        return 0;
      }
      if (result.state === 'failed') {
        process.stderr.write(JSON.stringify(result.error || {}).slice(0, 1000) + '\n');
        return 1;
      }
      return 0;
    }
    if (sub === 'cancel') {
      const id = requirePos(pos, 2, '<operationId>');
      const body = await callRpc('operation.cancel', withControl(flags, { id }), timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      print('已取消 operation ' + id);
      return 0;
    }
    throw new ArgError('用法：bridge operation await <id> [--timeout 60s] | operation cancel <id>');
  }
  return { cmdCooperate, cmdOperation };
}
