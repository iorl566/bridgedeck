// cli/commands/network.mjs —— `bridge network start|stop|list|detail|replay`。
import path from 'node:path';
import fs from 'node:fs';
import { parseHarReplayEntries, findHarReplayEntry } from '../../lib/har-replay.mjs';

export function createNetworkCommand({
  withControl,
  callRpc,
  timeoutOf,
  outputFailure,
  outputJsonBody,
  renderPageBody,
  isJson,
  print,
  renderTable,
  truncateText,
  requirePos,
  intFlag,
  ArgError,
}) {
  return async function cmdNetwork(flags, pos) {
    // 与 BSK 的 `bsk network` 对齐：不带子命令时默认读取当前缓冲。
    const sub = pos[1] || 'list';
    if (sub === 'start') {
      const body = await callRpc('network.start', withControl(flags, { bodies: flags.bodies === true }), timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      print('已开始采集（正文：' + ((body.result && body.result.bodies) ? '开' : '关') + '）');
      return 0;
    }
    if (sub === 'stop') {
      const body = await callRpc('network.stop', withControl(flags, {}), timeoutOf(flags));
      return renderPageBody(body, () => print('已停止采集'));
    }
    if (sub === 'list') {
      const params = withControl(flags, {});
      const filter = {};
      if (flags.filter !== undefined) filter.urlContains = String(flags.filter);
      if (flags.method !== undefined) filter.method = String(flags.method).toUpperCase();
      if (flags.status !== undefined) filter.status = Number(flags.status);
      if (Object.keys(filter).length) params.filter = filter;
      const limit = intFlag(flags, 'limit', { min: 1 });
      if (limit !== undefined) params.limit = limit;
      const since = intFlag(flags, 'since', { min: 0 });
      if (since !== undefined) params.since = since;
      const body = await callRpc('network.list', params, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const entries = (body.result && body.result.entries) || [];
      if (!entries.length) {
        print('(没有抓到请求；先 network start 再操作页面)');
        return 0;
      }
      print(renderTable(['id', 'method', 'status', 'ms', 'type', 'url'], entries.map((entry) => [
        String(entry.id), entry.method || '', entry.status || '', entry.durationMs != null ? String(entry.durationMs) : '', entry.type || '', truncateText(entry.url || '', 64),
      ])));
      return 0;
    }
    if (sub === 'waterfall') {
      const params = withControl(flags, { limit: intFlag(flags, 'limit', { min: 1 }) ?? 500 });
      const body = await callRpc('network.waterfall', params, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      const waterfall = body.result || { rows: [], summary: { count: 0, wallMs: 0, errors: 0 } };
      if (isJson()) {
        return outputJsonBody({ ok: true, result: waterfall });
      }
      if (!waterfall.rows.length) {
        print('(没有可用的网络请求；先 network start 并操作页面)');
        return 0;
      }
      print(renderTable(['start', 'ms', 'status', 'type', 'url'], waterfall.rows.map((row) => [
        '+' + row.startOffsetMs + 'ms',
        String(row.durationMs),
        row.status == null ? '' : String(row.status),
        row.type,
        truncateText(row.url, 64),
      ])));
      print('总数 ' + waterfall.summary.count + '，跨度 ' + waterfall.summary.wallMs + 'ms，错误 ' + waterfall.summary.errors);
      return 0;
    }
    if (sub === 'detail') {
      const id = requirePos(pos, 2, '<id>');
      const body = await callRpc('network.detail', withControl(flags, { id: Number(id) }), timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      print(JSON.stringify(body.result || {}, null, 2));
      return 0;
    }
    if (sub === 'replay-har') {
      const file = requirePos(pos, 2, '<har.json>');
      let har;
      try {
        har = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'));
      } catch (error) {
        throw new ArgError('HAR 不是合法 JSON：' + error.message);
      }
      const entries = parseHarReplayEntries(har);
      if (!entries.length) throw new ArgError('HAR 没有可重放请求');
      const entry = findHarReplayEntry(entries, {
        index: flags.entry !== undefined ? Number(flags.entry) : null,
        urlContains: flags.filter !== undefined ? String(flags.filter) : '',
      });
      if (!entry) throw new ArgError('没有匹配的 HAR 请求');
      if (flags.all === true) {
        const limit = Math.max(1, Math.min(Number(flags.limit) || 10, 50));
        const results = [];
        for (const item of entries.slice(0, limit)) {
          const response = await callRpc('network.replay', withControl(flags, { request: { url: item.url, method: item.method, headers: item.headers, ...(item.body != null ? { body: item.body } : {}) }, id: item.index }), Math.max(timeoutOf(flags), 120000));
          results.push({ index: item.index, ok: response.ok === true, status: response.ok ? response.result.status : null, error: response.ok ? null : response.error && response.error.code });
        }
        if (isJson()) {
          return outputJsonBody({ ok: true, result: { results } });
        }
        for (const item of results) print('#' + item.index + ' ' + (item.ok ? 'HTTP ' + item.status : 'FAIL ' + item.error));
        return 0;
      }
      const body = await callRpc('network.replay', withControl(flags, { request: { url: entry.url, method: entry.method, headers: entry.headers, ...(entry.body != null ? { body: entry.body } : {}) }, id: entry.index }), Math.max(timeoutOf(flags), 120000));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      print('HTTP ' + result.status + '（' + (result.durationMs || 0) + 'ms）');
      print(truncateText(String(result.body || ''), 4000));
      return 0;
    }

    if (sub === 'replay') {
      const id = requirePos(pos, 2, '<id>');
      const body = await callRpc('network.replay', withControl(flags, { id: Number(id) }), Math.max(timeoutOf(flags), 120000));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      print('HTTP ' + result.status + '（' + (result.durationMs || 0) + 'ms）');
      print(truncateText(String(result.body || ''), 4000));
      return 0;
    }
    throw new ArgError('用法：bridge network start|stop|list|detail|replay|replay-har');
  };
}
