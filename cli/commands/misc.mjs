// cli/commands/misc.mjs —— longshot/refs 小命令。
import { formatLongshotRecoveryLines, summarizeLongshotRecovery } from '../lib/recovery-summary.mjs';
import { isDryRun } from '../lib/action-plan.mjs';
import { dryRunIo, preflight } from '../lib/command-plans.mjs';

export async function longshotCommand(ctx, flags, pos) {
  const { callRpc, withControl, timeoutOf, outputFailure, print, emitJson, isJson, writeDataUrl, ArgError, requirePos } = ctx;
  const sub = pos[1] || 'recover';
  const session = withControl(flags, {});
  // --dry-run：longshot recover 会先发 RPC 再写 PNG，预检只打印这两步。
  if (isDryRun(flags)) {
    return preflight('longshot', sub, { flags, pos, session }, dryRunIo({ isJson, emitJson, print }));
  }
  if (sub !== 'recover') throw new ArgError('用法：bridge longshot recover <longshotId> --out <file>');
  const id = requirePos(pos, 2, '<longshotId>');
  if (!flags.out) throw new ArgError('longshot recover 需要 --out <file>');
  const body = await callRpc('longshot.recover', withControl(flags, { longshotId: id }), timeoutOf(flags));
  if (!body.ok) return outputFailure(body);
  const result = body.result || {};
  const summary = summarizeLongshotRecovery(result);
  const written = writeDataUrl(flags.out, result.dataUrl);
  if (isJson()) {
    // 只做加法：0.3.0 的字段保持不变，新增 summary（分片校验/结论/下一步）。
    emitJson({
      ok: true,
      result: {
        path: written.target,
        width: result.width,
        height: result.height,
        tiles: result.tiles,
        complete: result.complete,
        bytes: written.buffer.length,
        ...(result.recovered !== undefined ? { recovered: result.recovered } : {}),
        ...(result.sealed !== undefined ? { sealed: result.sealed } : {}),
        ...(Array.isArray(result.gaps) && result.gaps.length ? { gaps: result.gaps } : {}),
        ...(result.manifest ? { manifest: result.manifest } : {}),
        summary,
      },
    });
    return 0;
  }
  print('已恢复长截图：' + written.target + '（' + result.width + 'x' + result.height + '，' + result.tiles + ' tiles）');
  for (const line of formatLongshotRecoveryLines(result)) print(line);
  return 0;
}

/** refs negotiate：重新确认 stableRef 是否仍指向当前文档里的节点。 */
export async function refsCommand(ctx, flags, pos) {
  const { callRpc, withControl, timeoutOf, outputFailure, outputJsonBody, print, isJson, ArgError } = ctx;
  const sub = pos[1] || 'negotiate';
  if (sub !== 'negotiate') throw new ArgError('用法：bridge refs negotiate <stableRef...> [--session <id>]');
  const refs = pos.slice(2).filter(Boolean);
  if (flags['stable-ref'] !== undefined) refs.push(String(flags['stable-ref']));
  if (!refs.length) throw new ArgError('refs negotiate 需要至少一个 stableRef');
  const body = await callRpc('refs.negotiate', withControl(flags, { stableRefs: refs }), timeoutOf(flags));
  if (!body.ok) return outputFailure(body);
  if (isJson()) return outputJsonBody(body);
  const result = body.result || {};
  for (const item of result.refs || []) {
    print((item.ok ? 'ok' : 'stale') + ' ' + item.stableRef + (item.ref ? ' → ' + item.ref : '') + (item.reason ? ' (' + item.reason + ')' : ''));
  }
  return 0;
}


