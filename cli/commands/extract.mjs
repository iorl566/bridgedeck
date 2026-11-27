// cli/commands/extract.mjs —— `bridge extract [list|table|discover]`（JSON/CSV 导出、覆盖度、游标）。
import fs from 'node:fs';
import path from 'node:path';
import { ContractError, RISK } from '../lib/arg-contract.mjs';
import { buildPlan, callStep, dryRunNotes, isDryRun, outputDryRun, rpcStep } from '../lib/action-plan.mjs';

function toCsv(result, csvSafe) {
  const columns = Array.isArray(result.columns) ? result.columns : [];
  const rows = Array.isArray(result.rows) ? result.rows : [];
  const escape = (raw) => {
    let text = raw == null ? '' : String(raw);
    if (csvSafe && /^[=+\-@]/.test(text)) text = "'" + text;
    return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  };
  const lines = [];
  lines.push(columns.map((column) => escape(column.label || column.key)).join(','));
  for (const row of rows) {
    lines.push(columns.map((column) => escape(row[column.key])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/** 覆盖度一句话：读了多少、页面声明多少、为什么停。 */
function formatCoverage(coverage) {
  if (!coverage || typeof coverage !== 'object') return '';
  const parts = ['返回 ' + (coverage.returned != null ? coverage.returned : '?') + ' 行'];
  if (coverage.declared != null) parts.push('页面声明 ' + coverage.declared + ' 行');
  else parts.push('页面未声明总数');
  if (coverage.stopReason) parts.push('停止原因 ' + coverage.stopReason);
  if (coverage.datasetComplete) parts.push('完整性 ' + coverage.datasetComplete);
  return parts.join('，');
}

export function createExtractCommand({
  withControl,
  resolveTarget,
  callRpc,
  timeoutOf,
  outputFailure,
  outputJsonBody,
  emitJson,
  isJson,
  print,
  renderTable,
  truncateText,
  intFlag,
  ArgError,
  spec,
}) {
  const io = {
    callRpc,
    timeoutOf,
    flags: null,
    isJson,
    emitJson,
    print,
  };

  function buildBase(flags) {
    const base = withControl(flags, {});
    if (flags.frame !== undefined) {
      const frameId = intFlag(flags, 'frame', { min: 0 });
      if (frameId !== undefined) base.frameId = frameId;
    }
    const maxRows = intFlag(flags, 'max-rows', { min: 1 });
    if (maxRows !== undefined) base.maxRows = maxRows;
    const maxBytes = intFlag(flags, 'max-bytes', { min: 1 });
    if (maxBytes !== undefined) base.maxBytes = maxBytes;
    if (flags['expect-revision'] !== undefined) {
      const revision = Number(flags['expect-revision']);
      if (!Number.isInteger(revision) || revision < 0) throw new ArgError('--expect-revision 需要 ≥0 的整数（取自 observe 的 revision）');
      base.expectRevision = revision;
    }
    const maxCells = intFlag(flags, 'max-cells', { min: 1 });
    if (maxCells !== undefined) base.maxCells = maxCells;
    // 兼容目标 extract --max-columns：真实进入 extract 协议参数；daemon 在返回前按列截断
    // （table 结果 columns/rows 同步裁剪并带 truncated/limits 证据）。
    const maxColumns = intFlag(flags, 'max-columns', { min: 1 });
    if (maxColumns !== undefined) base.maxColumns = maxColumns;
    const maxTargets = intFlag(flags, 'max-targets', { min: 1 });
    if (maxTargets !== undefined) base.maxTargets = maxTargets;
    const previewColumns = intFlag(flags, 'preview-columns', { min: 1 });
    if (previewColumns !== undefined) base.previewColumns = previewColumns;
    if (flags.cursor !== undefined) base.cursor = String(flags.cursor);
    return base;
  }

  function buildPlanFor(flags, pos, sub) {
    const format = flags.format === 'csv' ? 'csv' : 'json';
    const base = buildBase(flags);
    // 可选目标：没有 ref/selector 时不算错误（list/default 可读整页），
    // table 的 --target 路径也不要求再给 ref/selector。
    const tryResolveTarget = (index) => {
      try {
        return resolveTarget(flags, pos, index, { required: false });
      } catch {
        return null;
      }
    };
    if (sub === 'discover') {
      const params = { ...base };
      return {
        format,
        plan: buildPlan({
          command: 'extract',
          subcommand: 'discover',
          risk: RISK.READ_ONLY,
          steps: [rpcStep('extract.discover', params, {
            description: '发现可导出的表格/列表',
            target: { kind: 'extract-targets' },
            risk: RISK.READ_ONLY,
          })],
          notes: dryRunNotes(flags),
        }),
      };
    }
    const params = { ...base };
    let method = 'extract';
    let target = { kind: 'extract', name: '当前页面表格/列表' };
    if (sub === 'list') {
      method = 'extract.list';
      if (flags['item-selector'] !== undefined) params.itemSelector = String(flags['item-selector']);
      if (flags['fields-json'] !== undefined) {
        let fields;
        try {
          fields = JSON.parse(String(flags['fields-json']));
        } catch (error) {
          throw new ContractError('E_ARG_TYPE', '--fields-json 不是合法 JSON：' + error.message, {
            hint: '例如 --fields-json \'[{"name":"text"}]\'.', usage: 'bridge extract list --selector <css>',
          });
        }
        params.fields = Array.isArray(fields) ? fields : (fields && Array.isArray(fields.fields) ? fields.fields : null);
        if (!params.fields) throw new ContractError('E_ARG_TYPE', '--fields-json 需要数组或 {fields:[...]}', { usage: 'bridge extract list' });
      }
      if (flags.fields !== undefined) {
        try {
          const raw = JSON.parse(fs.readFileSync(String(flags.fields), 'utf8'));
          params.fields = Array.isArray(raw) ? raw : raw.fields;
        } catch (error) {
          throw new ContractError('E_ARG_TYPE', '--fields 读取失败：' + error.message, {
            hint: '检查 --fields 指向的 JSON 文件。', usage: 'bridge extract list --selector <css>',
          });
        }
      }
      const resolvedTarget = tryResolveTarget(2);
      if (resolvedTarget) Object.assign(params, resolvedTarget);
      target = { kind: 'extract-list', name: params.selector || params.ref || '当前页面列表' };
    } else if (sub === 'table') {
      method = 'extract.table';
      if (flags.target !== undefined) {
        const value = String(flags.target);
        if (!/^\d+$/.test(value)) throw new ContractError('E_ARG_TYPE', '--target 需要整数 id', { usage: 'bridge extract table --target <id>' });
        params.target = Number(value);
      }
      const resolvedTarget = params.target === undefined ? tryResolveTarget(2) : null;
      if (resolvedTarget) Object.assign(params, resolvedTarget);
      if (params.target === undefined && !resolvedTarget) {
        throw new ContractError('E_ARG_MISSING', 'extract table 需要 --target <id>（先 extract discover）或 --selector/--ref', {
          hint: '先 bridge extract discover 拿 target id，或直接 --selector "#people"。',
          usage: 'bridge extract table --target <id> | --selector <css>',
        });
      }
      target = { kind: 'extract-table', name: params.target !== undefined ? 'target=' + params.target : (params.selector || params.ref) };
    } else {
      const resolvedTarget = tryResolveTarget(1);
      if (resolvedTarget) Object.assign(params, resolvedTarget);
      if (params.selector || params.ref) target = { kind: 'extract', name: params.selector || params.ref };
    }
    return {
      format,
      plan: buildPlan({
        command: 'extract',
        subcommand: sub,
        risk: RISK.READ_ONLY,
        steps: [rpcStep(method, params, {
          description: '导出表格/列表（' + method + '）',
          target,
          risk: RISK.READ_ONLY,
        })],
        notes: dryRunNotes(flags),
      }),
    };
  }

  return async function cmdExtract(flags, pos, invocation) {
    io.flags = flags;
    const sub = (invocation && invocation.sub) || (pos[1] && ['list', 'table', 'discover'].includes(String(pos[1])) ? String(pos[1]) : 'default');
    const built = buildPlanFor(flags, pos, sub);
    if (isDryRun(flags)) return outputDryRun(built.plan, io);
    const body = await callStep(built.plan.steps[0], io);
    if (!body.ok) return outputFailure(body);
    const result = body.result || {};

    if (sub === 'discover') {
      if (isJson()) return outputJsonBody(body);
      const targets = result.targets || [];
      if (!targets.length) {
        print('(没有可导出的表格/列表)');
        return 0;
      }
      print(renderTable(
        ['id', 'kind', 'label', 'rows', 'columns'],
        targets.map((target) => [String(target.id), target.kind, truncateText(target.label, 40), String(target.rows), String(target.columns)]),
      ));
      return 0;
    }

    if (built.format === 'csv') {
      if (!flags.out) throw new ArgError('extract --format csv 需要 --out <path>');
      const file = path.resolve(process.cwd(), String(flags.out));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '\ufeff' + toCsv(result, flags['csv-safe'] === true), 'utf8');
      if (isJson()) {
        emitJson({ ok: true, result: { path: file, rowCount: result.rowCount || 0, truncated: result.truncated === true, coverage: result.coverage } });
        return 0;
      }
      print('已导出 ' + (result.rowCount || 0) + ' 行 → ' + file + (result.truncated ? '（已截断）' : ''));
      if (result.coverage) print('覆盖度：' + formatCoverage(result.coverage));
      return 0;
    }
    if (isJson()) {
      emitJson(body);
      return 0;
    }
    print(JSON.stringify({
      kind: result.kind,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rowCount,
      truncated: result.truncated,
      coverage: result.coverage,
      warnings: result.warnings,
    }, null, 2));
    return 0;
  };
}
