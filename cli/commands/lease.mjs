// cli/commands/lease.mjs —— `bridge daemon lease report|conflicts|arbitrate|schema`
// 真实调用 daemon 的跨会话租约裁决 RPC（lease.report / lease.arbitrate），并负责：
//   - 默认只读：`report` / `conflicts` 永远 dry-run，不会改任何租约；
//   - `arbitrate` 默认也 dry-run；只有显式 `--apply` 才让 daemon 执行 transfer/join/release 等步骤；
//   - 人类输出（verdict/step 表格）与 --json 单行信封；
//   - 退出码：dry-run 计划 0；apply 有步骤失败 1；参数错误 2；
//   - --strict：按 cli/lib/json-schema.mjs 的 bb.lease-arbitration/1 自检。
//
// 用法示例：
//   bridge daemon lease report
//   bridge daemon lease conflicts --strategy fifo --json
//   bridge daemon lease arbitrate --strategy lru --limit 10        # dry-run（默认）
//   bridge daemon lease arbitrate --apply --yes                   # 真的执行裁决步骤
//   bridge daemon lease schema
//
// 安全约定：
// - 本命令不带 --apply 时不产生任何写操作；
// - --apply 需要与 --yes 同时出现（防止误触）；否则本地以参数错误拒绝（退出码 2）；
// - 结构不一致类冲突（repair）只报告，daemon 侧不会执行任何步骤。

import { exitCodeForArbitration, EXIT_OK } from '../lib/exit-codes.mjs';
import { assertSchema, describeSchema, listSchemas, schemaTable } from '../lib/json-schema.mjs';
import { renderArbitrationPlan } from '../lib/table-views.mjs';

const USAGE = '用法：bridge daemon lease report|conflicts|arbitrate '
  + '[--strategy fifo|lru|priority|holder] [--limit N] [--tab <tabId>] [--apply --yes] '
  + '[--policy <strategy>] [--include-clean] [--json] [--strict] | schema [<schemaId>]';

const STRATEGIES = ['fifo', 'lru', 'priority', 'holder'];

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function positiveInt(flags, name, ArgError, { min = 1, max = 200 } = {}) {
  if (flags[name] === undefined) return undefined;
  const text = String(flags[name]).trim();
  if (!/^\d+$/.test(text)) throw new ArgError('--' + name + ' 需要整数，收到 "' + text + '"');
  const value = Number(text);
  if (value < min || value > max) throw new ArgError('--' + name + ' 需要在 ' + min + '..' + max + ' 之间');
  return value;
}

/** 从 flags 构造裁决参数（report/conflicts/arbitrate 共用）。 */
export function leaseParamsFromFlags(flags = {}, { ArgError } = {}) {
  const error = ArgError || Error;
  const params = {};
  const strategyRaw = flags.strategy !== undefined ? flags.strategy : flags.policy;
  if (strategyRaw !== undefined) {
    const value = String(strategyRaw).trim().toLowerCase();
    if (!STRATEGIES.includes(value)) throw new error('--strategy 需要 ' + STRATEGIES.join('|'));
    params.strategy = value;
  }
  const limit = positiveInt(flags, 'limit', error, { min: 1, max: 200 });
  if (limit !== undefined) params.limit = limit;
  if (flags.tab !== undefined) {
    const text = String(flags.tab).trim();
    if (!/^\d+$/.test(text)) throw new error('--tab 需要 >= 0 的整数');
    params.tabId = Number(text);
  }
  if (flags['include-clean'] === true) params.includeClean = true;
  return params;
}

/**
 * 构造 `bridge daemon lease` 命令。
 * @param {{callRpc: Function, timeoutOf: Function, outputFailure: Function, outputJsonBody: Function,
 *          emitJson: Function, isJson: () => boolean, print: Function, ArgError: Function}} ctx
 */
export function createLeaseCommand(ctx) {
  const { callRpc, timeoutOf, outputFailure, outputJsonBody, emitJson, isJson, print, ArgError } = ctx;
  const errorType = ArgError || Error;

  function strictCheck(value) {
    try {
      assertSchema('bb.lease-arbitration/1', value, { ErrorType: errorType });
      return null;
    } catch (error) {
      const problems = error.problems || [error.message];
      if (isJson()) {
        emitJson({ ok: false, error: { code: error.code || 'E_INTERNAL', message: 'daemon 返回的裁决结果不符合 bb.lease-arbitration/1', problems } });
      } else {
        process.stderr.write('schema 校验失败（bb.lease-arbitration/1）：\n');
        for (const problem of problems) process.stderr.write('  - ' + problem + '\n');
      }
      return 1;
    }
  }

  async function cmdReport(flags, { filterConflicts = false } = {}) {
    const params = leaseParamsFromFlags(flags, { ArgError: errorType });
    const body = await callRpc('lease.report', params, Math.max(timeoutOf(flags), 10_000));
    if (!body.ok) return outputFailure(body);
    const result = body.result || {};
    if (flags.strict === true) {
      const failed = strictCheck(result);
      if (failed !== null) return failed;
    }
    if (filterConflicts) {
      // conflicts 视图：只保留确实冲突的 verdict（去掉了 includeClean 的干净 tab）。
      const verdicts = Array.isArray(result.verdicts) ? result.verdicts : [];
      result.verdicts = verdicts.filter((verdict) => Array.isArray(verdict.conflictCodes) && verdict.conflictCodes.length > 0);
      result.summary = { ...(result.summary || {}), verdicts: result.verdicts.length, filtered: true };
    }
    if (isJson()) return outputJsonBody(body);
    print(renderArbitrationPlan(result, { verdictLimit: params.limit || 20 }));
    if (result.summary && result.summary.reportOnly > 0) {
      print('\n提示：report-only 冲突不会被自动修复；核对后可用 bridge daemon lease arbitrate --apply --yes 执行安全步骤。');
    }
    return EXIT_OK;
  }

  async function cmdArbitrate(flags) {
    const params = leaseParamsFromFlags(flags, { ArgError: errorType });
    const apply = flags.apply === true;
    if (apply && flags.yes !== true) {
      throw new errorType(USAGE + '（--apply 需要同时给 --yes 确认）');
    }
    params.apply = apply;
    if (!apply) params.dryRun = true;
    const body = await callRpc('lease.arbitrate', params, Math.max(timeoutOf(flags), 15_000));
    if (!body.ok) return outputFailure(body);
    const result = body.result || {};
    if (flags.strict === true) {
      const failed = strictCheck(result);
      if (failed !== null) return failed;
    }
    if (isJson()) {
      outputJsonBody(body);
    } else {
      print(renderArbitrationPlan(result, {
        verdictLimit: params.limit || 20,
        applied: isObject(result.applied) ? result.applied : null,
        residual: isObject(result.residual) ? result.residual : null,
      }));
      if (!apply) print('\n（dry-run：没有执行任何步骤；确认后加 --apply --yes）');
    }
    return exitCodeForArbitration(result, { apply });
  }

  async function cmdSchema(flags, pos) {
    const schemaId = pos[3];
    if (schemaId) {
      const described = describeSchema(String(schemaId));
      if (!described) throw new errorType('未知 schema id：' + schemaId + '（可用：' + listSchemas().map((item) => item.id).join(', ') + '）');
      if (isJson()) return outputJsonBody({ ok: true, result: described });
      print(JSON.stringify(described, null, 2));
      return EXIT_OK;
    }
    const result = { schemas: listSchemas(), table: schemaTable() };
    if (isJson()) return outputJsonBody({ ok: true, result });
    print('登记的 JSON schema（cli/lib/json-schema.mjs）：');
    for (const row of result.table) {
      print('  ' + row.id.padEnd(26) + '  ' + row.title);
      if (row.required) print('    required: ' + row.required);
    }
    return EXIT_OK;
  }

  return async function cmdLease(flags, pos) {
    const action = pos[2] || 'report';
    switch (action) {
    case 'report': return cmdReport(flags);
    case 'conflicts': return cmdReport(flags, { filterConflicts: true });
    case 'arbitrate': return cmdArbitrate(flags);
    case 'schema': return cmdSchema(flags, pos);
    default: throw new errorType('未知 lease 子命令：' + action + '\n' + USAGE);
    }
  };
}

export const LEASE_USAGE = USAGE;
export const LEASE_ACTIONS = Object.freeze(['report', 'conflicts', 'arbitrate', 'schema']);
