// cli/commands/pair.mjs —— `bridge pair *` 子命令（create/devices/list/redeem/renew/revoke）。
//
// 依赖由 cli/bridge.mjs 注入（RPC/输出/表格/JSON），本模块不持有 CLI 全局状态。
import crypto from 'node:crypto';
import { verifyPairProof } from '../../lib/pair-proof.mjs';
import { ArgError, requirePos, parseDurationMs } from '../lib/args.mjs';

export function createPairCommand({
  callRpc,
  timeoutOf,
  outputFailure,
  outputJsonBody,
  isJson,
  print,
  renderTable,
  formatTime,
  truncateText,
  BridgeError,
}) {
  return async function cmdPair(flags, pos) {
    const sub = pos[1] || 'list';
    if (sub === 'create') {
      const params = {};
      if (flags.ttl !== undefined) params.ttlMs = parseDurationMs(flags.ttl, 10 * 60 * 1000);
      if (flags.label !== undefined) params.label = String(flags.label);
      if (flags.host !== undefined) params.host = String(flags.host);
      if (flags.replace === true) params.replace = true;
      if (flags.scope !== undefined) {
        const scope = String(flags.scope).toLowerCase();
        if (scope !== 'read' && scope !== 'control') throw new ArgError('--scope 需要 read|control');
        params.scope = scope;
      }
      const body = await callRpc('pair.create', params, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      print('配对码：' + result.code + '（' + Math.round((result.expiresAt - Date.now()) / 60000) + ' 分钟内有效）');
      print('远程地址：' + result.url);
      print('配对 token：' + result.token);
      if (result.link) print('配对链接：' + result.link);
      print('');
      print('在另一台浏览器上粘贴配对链接（或运行 bridge pair redeem ' + result.code + ' 获取）。');
      return 0;
    }
    if (sub === 'devices') {
      const body = await callRpc('pair.list', {}, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const devices = (body.result && body.result.devices) || [];
      const known = (body.result && body.result.knownDevices) || [];
      if (known.length) {
        print(renderTable(['device', 'label', 'scope', 'browser', 'instance', 'lastSeen'], known.map((item) => [
          item.deviceId,
          item.label || '',
          item.scope || 'control',
          item.browser || '',
          item.instanceId || '',
          formatTime(item.lastSeenAt),
        ])));
      } else if (!devices.length) {
        print('(没有已连接的远程设备)');
        return 0;
      }
      if (devices.length) {
        print('');
        print(renderTable(['instance', 'browser', 'version', 'connected'], devices.map((item) => [
          item.instanceId,
          item.browser || '',
          item.browserVersion || '',
          formatTime(item.connectedAt),
        ])));
      }
      return 0;
    }
    if (sub === 'list') {
      const body = await callRpc('pair.list', {}, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const list = (body.result && body.result.pairings) || [];
      if (!list.length) {
        print('(没有有效配对码；daemon 绑定 ' + ((body.result && body.result.bind) || '?') + ')');
        return 0;
      }
      print(renderTable(['code', 'label', 'url', 'expires'], list.map((item) => [
        item.code,
        item.label || '',
        truncateText(item.url, 48),
        formatTime(item.expiresAt),
      ])));
      return 0;
    }
    if (sub === 'redeem') {
      const code = requirePos(pos, 2, '<code>');
      const clientNonce = crypto.randomBytes(16).toString('hex');
      const body = await callRpc('pair.redeem', { code: String(code), clientNonce }, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      const result = body.result || {};
      if (result.proof && !verifyPairProof(result.token, result.proof, {
        endpoint: result.endpoint,
        role: result.scope,
        clientNonce: result.clientNonce,
        serverNonce: result.serverNonce,
      })) {
        throw new BridgeError('E_PAIR_INVALID', '配对证明校验失败：endpoint/nonce/token 不一致');
      }
      if (isJson()) return outputJsonBody(body);
      print('远程地址：' + result.url);
      print('配对 token：' + result.token);
      if (result.proof) print('配对证明：已验证（endpoint + nonce 绑定）');
      return 0;
    }
    if (sub === 'renew') {
      const deviceId = requirePos(pos, 2, '<deviceId>');
      const params = { deviceId };
      if (flags.scope !== undefined) {
        const scope = String(flags.scope).toLowerCase();
        if (scope !== 'read' && scope !== 'control') throw new ArgError('--scope 需要 read|control');
        params.scope = scope;
      }
      const body = await callRpc('pair.renew', params, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      print('设备 rotation 已开始（pending）：' + result.deviceId + '（scope=' + result.scope + '，10 分钟内 commit）');
      print('新配对链接：' + result.link);
      print('（commit 前旧 token 仍有效；把新链接粘贴到远端扩展，扩展会自动 auth-commit）');
      return 0;
    }
    if (sub === 'revoke') {
      const code = requirePos(pos, 2, '<code>');
      const body = await callRpc('pair.revoke', { code: String(code) }, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      print((body.result && body.result.revoked ? '已撤销 ' : '没有找到 ') + String(code));
      if (body.result && body.result.deviceId) print('设备：' + body.result.deviceId);
      return 0;
    }
    throw new ArgError('用法：bridge pair create [--ttl 10m] [--label x] [--replace] | devices | list | redeem <code> | revoke <code>');
  };
}
