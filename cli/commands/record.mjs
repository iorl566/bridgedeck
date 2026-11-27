// cli/commands/record.mjs —— `bridge record start|stop|status|list|export`。
//
// Trace v3 构建器按需动态 import；文件写入/表格/JSON 输出由 bridge 注入。
import fs from 'node:fs';
import path from 'node:path';
import { isDryRun } from '../lib/action-plan.mjs';
import { dryRunIo, preflight } from '../lib/command-plans.mjs';

export function createRecordCommand({
  withControl,
  callRpc,
  timeoutOf,
  outputFailure,
  outputJsonBody,
  emitJson,
  isJson,
  print,
  BridgeError,
  ArgError,
  writeFileAtomic,
  renderTable,
  formatTime,
  truncateText,
}) {
  return async function cmdRecord(flags, pos) {
    const sub = pos[1];
    const session = withControl(flags, {});
    // --dry-run：export 只打印“读录制 + 写 trace.json/states”的路径，不落盘。
    if (isDryRun(flags)) {
      return preflight('record', sub, { flags, pos, session }, dryRunIo({ isJson, emitJson, print }));
    }
    const { buildTraceV3 } = await import('../../lib/trace-v3.mjs');

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /** 把一条录制写成 Trace v3 目录（trace.json + states/*.txt）；export 与 --blocking 共用。 */
    async function writeTraceExport(recording, outDir, flags, session) {
      fs.mkdirSync(path.join(outDir, 'states'), { recursive: true });
      const trace = buildTraceV3(recording);
      let screenshots = 0;
      if (flags.screenshot === true) {
        try {
          const shot = await callRpc('screenshot', { ...session, fullPage: false }, Math.max(timeoutOf(flags), 30000));
          if (shot.ok && shot.result && typeof shot.result.dataUrl === 'string') {
            trace.screenshots = [{
              id: 'shot-1',
              at: new Date().toISOString(),
              label: '导出时页面',
              width: Number(shot.result.width) || null,
              height: Number(shot.result.height) || null,
              dataUrl: shot.result.dataUrl,
            }];
            screenshots = 1;
          }
        } catch {
          // 截图是可选增强，失败不阻断 trace 导出
        }
      }
      if (recording.redactValues === true) {
        for (const step of trace.steps) {
          if (Object.prototype.hasOwnProperty.call(step, 'value')) step.value = '[filled]';
          if (Object.prototype.hasOwnProperty.call(step, 'input')) step.input = '[filled]';
        }
      }
      for (const state of trace.states) {
        writeFileAtomic(path.join(outDir, 'states', state.id + '.txt'), String(state.body || ''), 0o600);
      }
      const tracePath = path.join(outDir, 'trace.json');
      writeFileAtomic(tracePath, JSON.stringify(trace, null, 2) + '\n', 0o600);
      return {
        tracePath,
        outDir,
        traceVersion: trace.version,
        events: trace.steps.length,
        states: trace.states.length,
        steps: trace.steps.length,
        screenshots,
        stepScreenshots: trace.steps.filter((step) => typeof step.screenshot === 'string' && step.screenshot.startsWith('data:image/')).length,
        id: recording.id,
      };
    }
    if (sub === 'start') {
      if (flags.url !== undefined) {
        const nav = await callRpc('navigate', { ...session, url: String(flags.url) }, timeoutOf(flags));
        if (!nav.ok) return outputFailure(nav);
      }
      const params = { ...session };
      if (flags.screenshots === true) params.screenshots = true;
      if (flags['include-agent'] === true) params.includeAgent = true;
      if (flags.purpose !== undefined) params.purpose = String(flags.purpose);
      if (flags['redact-values'] === true) params.redactValues = true;
      if (flags['max-page-tokens'] !== undefined) params.maxPageTokens = Number(flags['max-page-tokens']);
      if (flags['trace-version'] !== undefined) params.traceVersion = Number(flags['trace-version']);
      let beforeIds = null;
      if (flags.blocking === true) {
        const listed = await callRpc('record.list', session, timeoutOf(flags));
        if (listed.ok) beforeIds = (listed.result && listed.result.recordings ? listed.result.recordings : []).map((item) => item.id);
      }
      const body = await callRpc('record.start', params, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (flags.blocking !== true) {
        if (isJson()) return outputJsonBody(body);
        print('已开始记录用户操作（tab ' + (body.result && body.result.tabId) + '）；结束用 bridge record stop');
        return 0;
      }
      const tabId = body.result && body.result.tabId;
      if (!isJson()) print('录制中：在浏览器里完成操作，点浮层停止后会自动导出 trace…');
      for (;;) {
        const status = await callRpc('record.status', session, timeoutOf(flags));
        if (!status.ok) return outputFailure(status);
        const active = (status.result && status.result.active) || [];
        if (!active.some((item) => Number(item.tabId) === Number(tabId))) break;
        await sleep(500);
      }
      await sleep(200);
      const listed = await callRpc('record.list', session, timeoutOf(flags));
      if (!listed.ok) return outputFailure(listed);
      const all = (listed.result && listed.result.recordings) || [];
      const previous = new Set(beforeIds || []);
      const candidate = all.find((item) => !previous.has(item.id) && Number(item.tabId) === Number(tabId)) || all.find((item) => !previous.has(item.id));
      if (!candidate) throw new BridgeError('E_NOT_FOUND', '阻塞式录制结束但没有可导出记录');
      const outDir = path.resolve(process.cwd(), flags.out !== undefined ? String(flags.out) : 'trace');
      const result = await writeTraceExport(candidate, outDir, flags, session);
      result.recordingId = candidate.id;
      if (isJson()) { emitJson({ ok: true, result }); return 0; }
      print('已结束录制并导出：' + result.tracePath + '（Trace v' + result.traceVersion + '：' + result.steps + ' 步，' + result.states + ' 个状态）');
      return 0;
    }

    if (sub === 'stop') {
      const body = await callRpc('record.stop', session, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      print('已保存操作记录：' + ((result.recording && result.recording.events) || 0) + ' 条事件');
      return 0;
    }
    if (sub === 'status') {
      const body = await callRpc('record.status', session, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const active = (body.result && body.result.active) || [];
      if (!active.length) {
        print('(没有进行中的记录)');
        return 0;
      }
      for (const item of active) print('记录中：tab ' + item.tabId + '，' + item.events + ' 条事件');
      return 0;
    }
    if (sub === 'list') {
      const body = await callRpc('record.list', session, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const recordings = (body.result && body.result.recordings) || [];
      if (!recordings.length) {
        print('(没有历史记录)');
        return 0;
      }
      print(renderTable(['id', 'events', 'started', 'title'], recordings.map((item) => [
        item.id.slice(0, 8),
        String(item.events.length),
        formatTime(item.startedAt),
        truncateText(item.title || item.url || '', 40),
      ])));
      return 0;
    }
    if (sub === 'export') {
      const body = await callRpc('record.list', session, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      const recordings = (body.result && body.result.recordings) || [];
      const wanted = pos[2] ? String(pos[2]) : '';
      const recording = wanted
        ? recordings.find((item) => item.id === wanted || item.id.startsWith(wanted))
        : recordings[0];
      if (!recording) throw new BridgeError('E_NOT_FOUND', wanted ? '找不到录制 ' + wanted : '没有历史录制');
      const outDir = path.resolve(process.cwd(), flags.out !== undefined ? String(flags.out) : 'trace');
      const result = await writeTraceExport(recording, outDir, flags, session);
      if (isJson()) { emitJson({ ok: true, result }); return 0; }
      print('已导出录制：' + result.tracePath + '（Trace v' + result.traceVersion + '：' + result.steps + ' 步，' + result.states + ' 个状态）');
      return 0;
    }

    throw new ArgError('用法：bridge record start|stop|status|list|export [id] [--out <dir>]');
  };
}
