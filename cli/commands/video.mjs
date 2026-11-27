// cli/commands/video.mjs —— `bridge video *` 子命令（录制/恢复/查询/保存/校验/裁剪/清理）。
//
// 依赖由 cli/bridge.mjs 注入（RPC/输出/表格/文件写入），本模块不持有 CLI 全局状态。
import path from 'node:path';
import { mergeVideoFiles, probeVideoFile, splitVideoFile, trimVideoFile } from '../lib/video-edit.mjs';
import { isDryRun } from '../lib/action-plan.mjs';
import { dryRunIo, preflight } from '../lib/command-plans.mjs';
import {
  formatVideoRecoveryLines,
  recoveryFailureHint,
  summarizeVideoRecovery,
} from '../lib/recovery-summary.mjs';
export function createVideoCommand({
  withControl,
  callRpc,
  timeoutOf,
  outputFailure,
  outputJsonBody,
  emitJson,
  expectOkBody,
  isJson,
  print,
  BridgeError,
  ArgError,
  requirePos,
  parseDurationMs,
  writeVideoFile,
  remuxFaststartBase64,
  formatBytes,
  formatTime,
  renderTable,
  truncateText,
}) {
  return async function cmdVideo(flags, pos) {
    const sub = pos[1];
    const session = withControl(flags, {});
    // --dry-run：只构造并打印“将要发出的 RPC / 本机文件操作”，不发任何请求。
    if (isDryRun(flags)) {
      return preflight('video', sub, { flags, pos, session }, dryRunIo({ isJson, emitJson, print }));
    }

    if (sub === 'start') {
      const params = { ...session };
      const durationMs = parseDurationMs(flags.duration, 0);
      if (durationMs > 0) params.durationMs = durationMs;
      if (flags.quality !== undefined) params.quality = String(flags.quality);
      if (flags.encoder !== undefined) params.encoder = String(flags.encoder);
      if (flags['force-frames'] === true) params.forceFrames = true;
      const body = await callRpc('video.start', params, Math.max(timeoutOf(flags), 30000));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      print('开始录制：' + result.recordingId + '（' + (String(result.mime).includes('mp4') ? 'MP4' : 'WebM') + '，' + (result.mode || '') + '）');
      return 0;
    }

    if (sub === 'recover') {
      const body = await callRpc('video.recover', session, Math.max(timeoutOf(flags), 30000));
      if (!body.ok) {
        // 失败时扩展会在错误对象上挂一次扫描证据，但 daemon 的错误链只保留 code/message；
        // CLI 只按错误码/文本给“下一步”，不假装拿到了缺失的扫描明细。
        if (!isJson()) {
          const hint = recoveryFailureHint(body.error || {});
          print('恢复摘要：' + hint.classification.code + '（' + hint.classification.label + '）');
          print('  下一步：');
          for (const step of hint.nextSteps) print('    - ' + step);
        }
        return outputFailure(body);
      }
      const result = body.result || {};
      const summary = summarizeVideoRecovery(result);
      if (isJson()) {
        // 只做加法：既有 result 字段一个不动，新增 result.summary（稳定词表 + 下一步）。
        emitJson({ ...body, result: { ...result, summary } });
        return 0;
      }
      print('已恢复录制：' + (summary.recordingId || '') + '（' + formatBytes(summary.bytes || 0) + '）');
      for (const line of formatVideoRecoveryLines(result)) print(line);
      return 0;
    }

    if (sub === 'status') {
      const id = pos[2] ? String(pos[2]) : null;
      const state = expectOkBody(await callRpc('video.status', session, timeoutOf(flags)), 'video status');
      if (state.active) {
        if (!id || state.recordingId === id) {
          if (isJson()) return outputJsonBody({ ok: true, result: { state: 'recording', ...state } });
          print('录制中：' + state.recordingId + '（' + Math.round((Date.now() - state.startedAt) / 1000) + 's）');
          return 0;
        }
      }
      const listed = expectOkBody(await callRpc('video.list', session, timeoutOf(flags)), 'video list');
      const record = (listed.recordings || []).find((item) => !id || item.id === id);
      if (!record) {
        const detail = state && state.trace ? ' trace=' + JSON.stringify(state.trace) : '';
        if (isJson()) return emitJson({ ok: false, error: { code: 'E_NOT_FOUND', message: '找不到录制 ' + (id || '') + detail } }), 1;
        throw new BridgeError('E_NOT_FOUND', '找不到录制 ' + (id || '') + detail);
      }
      if (isJson()) return outputJsonBody({ ok: true, result: { state: 'ready', ...record } });
      print('已就绪：' + record.id + '（' + (String(record.mime).includes('mp4') ? 'MP4' : 'WebM') + '，' + formatBytes(record.bytes) + '）');
      return 0;
    }

    if (sub === 'stop') {
      const id = pos[2] ? String(pos[2]) : undefined;
      const body = await callRpc('video.stop', { ...session, recording: id }, Math.max(timeoutOf(flags), 30000));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      print('已停止：' + result.recordingId + '（' + formatBytes(result.bytes) + '）');
      return 0;
    }

    if (sub === 'info') {
      const input = requirePos(pos, 2, 'video info 需要输入文件');
      const info = await probeVideoFile(input);
      if (isJson()) emitJson({ ok: true, result: { path: input, ...info } });
      else print(input + '：' + info.codec + ' ' + (info.width || '?') + 'x' + (info.height || '?') + '，' + info.duration + 's，' + info.packets + ' 帧（key ' + info.keyframes + '），' + formatBytes(info.bytes));
      return 0;
    }

    if (sub === 'merge') {
      if (!flags.out) throw new ArgError('video merge 需要 --out <file>');
      const inputs = pos.slice(2).filter(Boolean);
      if (inputs.length < 2) throw new ArgError('video merge 需要至少两个输入文件');
      const result = await mergeVideoFiles(inputs, path.resolve(process.cwd(), String(flags.out)));
      if (isJson()) emitJson({ ok: true, result });
      else print('已合并 ' + result.inputs + ' 个文件 → ' + flags.out + '（' + result.packets + ' 帧，' + formatBytes(result.bytes) + '）');
      return 0;
    }

    if (sub === 'split') {
      const input = requirePos(pos, 2, 'video split 需要输入文件');
      if (!flags['out-dir']) throw new ArgError('video split 需要 --out-dir <dir>');
      const outDir = path.resolve(process.cwd(), String(flags['out-dir']));
      const result = await splitVideoFile(input, outDir, flags.parts !== undefined ? Number(flags.parts) : 2);
      if (isJson()) emitJson({ ok: true, result: { count: result.count, outputs: result.outputs } });
      else {
        print('已分段 ' + result.count + ' 个：' + outDir);
        for (const item of result.outputs) print('  ' + item.path + '（' + item.packets + ' 帧，' + formatBytes(item.bytes) + '）');
      }
      return 0;
    }

    if (sub === 'trim') {
      const input = requirePos(pos, 2, 'video trim 需要输入文件');
      const out = flags.out ? path.resolve(process.cwd(), String(flags.out)) : '';
      if (!out) throw new ArgError('video trim 需要 --out <file>');
      const start = flags.start !== undefined ? parseDurationMs(flags.start, 0) : 0;
      const end = flags.end !== undefined ? parseDurationMs(flags.end, 0) : null;
      const result = await trimVideoFile(input, out, { startSec: start / 1000, endSec: end ? end / 1000 : null });
      if (isJson()) emitJson({ ok: true, result: { path: out, ...result } });
      else print('已裁剪：' + out + '（' + formatBytes(result.bytes) + '，' + result.packets + ' 帧，' + result.codec + '）');
      return 0;
    }

    if (sub === 'save') {
      const id = requirePos(pos, 2, '<recordingId>');
      if (!flags.out) throw new ArgError('video save 需要 --out <path>');
      const body = await callRpc('video.fetch', { ...session, recording: String(id) }, Math.max(timeoutOf(flags), 120000));
      if (!body.ok) return outputFailure(body);
      const result = body.result || {};
      const journal = result.journal || null;
      // 已带 sidx 的可 seek 文件由 worker 截好，CLI 不再按 raw complete_bytes 裁剪（偏移已变）。
      const completeBytes = !result.indexed && journal && Number(journal.trailing_bytes) > 0 ? Number(journal.complete_bytes) : undefined;
      // fMP4 → faststart（moov 前置）：packet 级 remux，不解码；失败回退原始字节。
      let remux = null;
      let remuxError = null;
      const alreadyFaststart = result.faststart === true;
      if (!alreadyFaststart && journal && journal.fragmented && result.base64) {
        try { remux = await remuxFaststartBase64(result.base64); } catch (error) { remuxError = String((error && error.message) || error); }
      }
      const written = writeVideoFile(remux ? remux.base64 : result.base64, flags.out, flags.overwrite === true, { completeBytes: remux ? undefined : completeBytes });
      if (isJson()) {
        emitJson({
          ok: true,
          result: {
            path: written.target,
            bytes: written.buffer.length,
            mime: result.mime,
            ...(written.trimmedBytes > 0 ? { trimmedBytes: written.trimmedBytes, completeBytes: written.buffer.length, journal } : {}),
            ...(result.indexed ? { indexed: true, sidx_bytes: result.sidx_bytes } : {}),
            ...(remux ? { faststart: true, remuxBytes: remux.bytes, remuxPackets: remux.packets, codec: remux.codec } : (alreadyFaststart ? { faststart: true, remuxed: true } : {})),
            ...(remuxError ? { remuxError } : {}),
          },
        });
        return 0;
      }
      print('已保存：' + written.target + '（' + formatBytes(written.buffer.length) + '）'
        + (written.trimmedBytes > 0 ? '，已截到完整分片（丢弃 ' + formatBytes(written.trimmedBytes) + '）' : '')
        + (remux ? '，已重封装 faststart' : ''));
      return 0;
    }

    if (sub === 'verify') {
      const id = requirePos(pos, 2, '<recordingId>');
      const body = await callRpc('video.verify', { ...session, recording: String(id) }, Math.max(timeoutOf(flags), 30000));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      if (result.verified) print('分片校验通过：' + result.chunks + ' 片，' + formatBytes(result.bytes || 0));
      else print('分片校验失败：' + JSON.stringify(result.mismatches || []));
      return 0;
    }

    if (sub === 'durability') {
      const body = await callRpc('video.list', session, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      const recordings = (body.result && body.result.recordings) || [];
      const id = pos[2] || '';
      const record = id ? recordings.find((item) => item.id === id) : recordings[0];
      if (!record) throw new ArgError(id ? '没有该录制：' + id : '没有录制');
      const result = {
        id: record.id,
        durability: record.durability || 'unknown',
        durability_parts: record.durability_parts ?? null,
        durability_policy: record.durability_policy || 'browser-readback',
        fsync_supported: record.fsync_supported === true,
        storage_persisted: record.storage_persisted === true,
        storage_quota: record.storage_quota ?? null,
        completeness: record.completeness || null,
      };
      if (isJson()) {
        emitJson({ ok: true, result });
        return 0;
      }
      print('durability=' + result.durability + ' policy=' + result.durability_policy + ' fsync=' + result.fsync_supported);
      print('parts=' + (result.durability_parts ?? '-') + ' storage.persisted=' + result.storage_persisted + ' quota=' + (result.storage_quota ?? '-'));
      return 0;
    }

    if (sub === 'list') {
      const body = await callRpc('video.list', session, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const recordings = (body.result && body.result.recordings) || [];
      if (!recordings.length) {
        print('(没有录制)');
        return 0;
      }
      print(renderTable(['id', 'kind', 'bytes', 'started', 'title'], recordings.map((item) => [
        item.id.slice(0, 8),
        String(item.mime).includes('mp4') ? 'MP4' : 'WebM',
        formatBytes(item.bytes),
        formatTime(item.startedAt),
        truncateText(item.title || item.url || '', 40),
      ])));
      return 0;
    }

    if (sub === 'prune') {
      const params = { ...session };
      if (flags.ttl !== undefined) params.ttlMs = parseDurationMs(flags.ttl, 0);
      const body = await callRpc('video.prune', params, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      print('已清理 ' + (result.removed || 0) + ' 条过期录制，剩余 ' + (result.remaining || 0) + ' 条');
      return 0;
    }

    if (sub === 'discard') {
      const id = requirePos(pos, 2, '<recordingId>');
      const body = await callRpc('video.discard', { ...session, recording: String(id) }, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      print('已删除录制 ' + id);
      return 0;
    }

    throw new ArgError('用法：bridge video start|status|stop|save|list|discard|recover');
  };
}
