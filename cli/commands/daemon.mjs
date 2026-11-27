// cli/commands/daemon.mjs —— `bridge daemon start|stop|restart|status|log|pair|devices|revoke|rotate|trust-local`
// 以及第九批 B 新增的只读/自检面：`ledger|transfer|queue|doctor`。
//
// daemon 生命周期（ensure/stop/locate）与路径由 bridge 注入；foreground 模式 spawn 子进程。
// 新子命令全部真实调用 daemon：ledger.* 走 ledger.status / ledger.resolve，
// transfer/queue/doctor 走 status 的增量视图（views/doctor），既有 daemon status 输出不变。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { formatUptime } from '../lib/format.mjs';
import { intFlag, ArgError } from '../lib/args.mjs';
import {
  doctorExitCode,
  renderDoctorReport,
  renderLedgerReconcile,
  renderLedgerSnapshot,
  renderLedgerStatus,
  renderQueueStatus,
  renderTransferStatus,
} from '../lib/daemon-views.mjs';

const LEDGER_OUTCOMES = ['confirmed', 'not-applied', 'reconciled', 'abandoned', 'applied', 'none'];
const LEDGER_USAGE = '用法：bridge daemon ledger [status] | snapshot [--out <file>] | restore | reconcile <tabId>|--all [--outcome confirmed|not-applied|reconciled] [--dry-run]';

function ledgerLimit(flags) {
  return flags.limit !== undefined ? intFlag(flags, 'limit', { min: 1 }) : 20;
}

function ledgerOutcome(flags) {
  if (flags.outcome === undefined) return 'reconciled';
  const value = String(flags.outcome).trim().toLowerCase();
  if (!LEDGER_OUTCOMES.includes(value)) {
    throw new ArgError(LEDGER_USAGE + '（--outcome 需要 ' + LEDGER_OUTCOMES.join('|') + '）');
  }
  return value;
}

function writeSnapshotFile(file, result) {
  const target = path.resolve(process.cwd(), file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const payload = result && result.snapshot ? result.snapshot : result;
  const text = JSON.stringify(payload, null, 2);
  fs.writeFileSync(target, text, 'utf8');
  return { path: target, bytes: Buffer.byteLength(text) };
}

export function createDaemonCommand({
  SERVER_PATH,
  REPO_ROOT,
  HOME_DIR,
  ensureDaemon,
  stopDaemon,
  locateDaemon,
  setDaemonInfo,
  callRpc,
  timeoutOf,
  outputFailure,
  outputJsonBody,
  emitJson,
  isJson,
  print,
  daemonLog,
  cmdBatch = null,
  cmdLease = null,
}) {
  /** `bridge daemon ledger [status|snapshot|restore|reconcile]` —— 真实调用 ledger.* RPC。 */
  async function cmdDaemonLedger(flags, pos) {
    const action = pos[2] || 'status';
    const limit = ledgerLimit(flags);
    if (action === 'status') {
      const body = await callRpc('ledger.status', { limit }, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      print(renderLedgerStatus(body.result || {}));
      return 0;
    }
    if (action === 'snapshot') {
      // snapshot=true 让 daemon 返回结构化快照；persist=true 让 daemon 把对账快照写进 BB_HOME。
      const body = await callRpc('ledger.status', { limit, snapshot: true, persist: true, compare: flags.compare === true }, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      let local = null;
      if (flags.out !== undefined && flags.out !== '') {
        try {
          local = writeSnapshotFile(String(flags.out), body.result || {});
        } catch (error) {
          throw new ArgError('写入快照文件失败：' + ((error && error.message) || error));
        }
      }
      if (isJson()) {
        if (local) body.result = { ...(body.result || {}), localFile: local };
        return outputJsonBody(body);
      }
      print(renderLedgerSnapshot(body.result || {}));
      if (local) print('本地副本：' + local.path + '（' + local.bytes + ' 字节）');
      return 0;
    }
    if (action === 'restore' || action === 'compare') {
      const body = await callRpc('ledger.status', { limit, snapshot: true, compare: true }, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      // renderLedgerSnapshot 末尾已包含 restore 段落，避免重复打印。
      print(renderLedgerSnapshot(body.result || {}));
      return 0;
    }
    if (action === 'reconcile') {
      const all = flags.all === true;
      const tabRaw = pos[3] !== undefined ? pos[3] : flags.tab;
      if (!all && (tabRaw === undefined || tabRaw === '')) throw new ArgError(LEDGER_USAGE);
      let tabId = null;
      if (!all) {
        const text = String(tabRaw).trim();
        if (!/^\d+$/.test(text)) throw new ArgError('tabId 必须是 >= 0 的整数，收到 "' + text + '"');
        tabId = Number(text);
      }
      const outcome = ledgerOutcome(flags);
      const params = { outcome, dryRun: flags['dry-run'] === true, by: 'cli' };
      if (all) params.all = true;
      else params.tabId = tabId;
      const body = await callRpc('ledger.resolve', params, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      print(renderLedgerReconcile(body.result || {}));
      const report = body.result || {};
      return report.ok === false ? 1 : 0;
    }
    throw new ArgError(LEDGER_USAGE);
  }

  /** `bridge daemon transfer [--limit N]` —— status views=transfers（配额/续传/校验/清理诊断）。 */
  async function cmdDaemonTransfer(flags) {
    const limit = flags.limit !== undefined ? intFlag(flags, 'limit', { min: 1 }) : 20;
    const body = await callRpc('status', { views: ['transfers'], limit }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    print(renderTransferStatus((body.result && body.result.transfers) || {}));
    return 0;
  }

  /** `bridge daemon queue` —— status views=queues（排队/等待/拒绝/公平性诊断）。 */
  async function cmdDaemonQueue(flags) {
    const body = await callRpc('status', { views: ['queues'], limitSessions: 50, limit: 20 }, timeoutOf(flags));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    print(renderQueueStatus((body.result && body.result.queue) || {}));
    return 0;
  }

  /** `bridge daemon doctor` —— daemon 侧结构化自检（ledger/transfer/queue/recovery/storage/runtime）。 */
  async function cmdDaemonDoctor(flags) {
    const body = await callRpc('status', { doctor: true, views: ['ledger', 'transfers', 'queues'] }, Math.max(timeoutOf(flags), 15000));
    if (!body.ok) return outputFailure(body);
    if (isJson()) return outputJsonBody(body);
    const report = (body.result && body.result.doctor) || {};
    print(renderDoctorReport(report));
    return doctorExitCode(report);
  }

  return async function cmdDaemon(flags, pos) {
    const sub = pos[1];
    // 第九批 B 新子命令：全部真实调用 daemon（ledger.* / status 增量视图）。
    if (sub === 'ledger') return cmdDaemonLedger(flags, pos);
    if (sub === 'transfer') return cmdDaemonTransfer(flags);
    if (sub === 'queue') return cmdDaemonQueue(flags);
    if (sub === 'doctor') return cmdDaemonDoctor(flags);
    // 第十一批 G：批处理会话/配额 与 跨会话租约裁决（真实 RPC；batch/lease 内部有独立用法）。
    if (sub === 'batch') {
      if (typeof cmdBatch !== 'function') throw new ArgError('当前构建未装配 batch 子命令（cli/commands/batch.mjs）');
      return cmdBatch(flags, pos);
    }
    if (sub === 'lease') {
      if (typeof cmdLease !== 'function') throw new ArgError('当前构建未装配 lease 子命令（cli/commands/lease.mjs）');
      return cmdLease(flags, pos);
    }
    if (sub === 'start') {
      if (flags.foreground === true) {
        // 沙箱宿主：由宿主保持前台进程，CLI 不 detach、不 unref。
        const args = [SERVER_PATH, '--foreground'];
        if (flags.port !== undefined) args.push('--port', String(flags.port));
        const child = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: 'inherit', env: { ...process.env, BB_HOME: HOME_DIR } });
        return await new Promise((resolve) => {
          child.on('close', (code) => resolve(code || 0));
          child.on('error', (error) => {
            process.stderr.write('daemon --foreground 启动失败：' + ((error && error.message) || error) + '\n');
            resolve(1);
          });
        });
      }
      const mode = String(flags.mode || 'local').toLowerCase();
      if (mode !== 'local' && mode !== 'server') throw new ArgError('--mode 需要 local|server');
      if (mode === 'server') {
        const listen = String(flags.listen || '0.0.0.0');
        const publicUrl = String(flags['public-url'] || '').trim().replace(/\/+$/, '');
        if (!/^wss:\/\/[^/]+/i.test(publicUrl)) {
          throw new ArgError('server 模式需要 --public-url wss://host[:port]/ws；远程必须 TLS');
        }
        const pfx = flags['tls-pfx'] ? path.resolve(process.cwd(), String(flags['tls-pfx'])) : '';
        if (!pfx || !fs.existsSync(pfx)) throw new ArgError('server 模式需要存在的 --tls-pfx <cert.pfx>');
        process.env.BB_BIND = listen;
        process.env.BB_TLS = '1';
        process.env.BB_TLS_PFX = pfx;
        if (flags['tls-passphrase'] !== undefined) process.env.BB_TLS_PASSPHRASE = String(flags['tls-passphrase']);
        process.env.BB_PUBLIC_URL = publicUrl;
        if (flags.port !== undefined) {
          const port = intFlag(flags, 'port', { min: 1, max: 65535 });
          process.env.BB_PORT = String(port);
        }
        const stopped = await stopDaemon();
        setDaemonInfo(null);
        const info = await ensureDaemon();
        if (isJson()) {
          emitJson({ ok: true, result: { running: true, pid: info.pid, port: info.port, mode, listen, publicUrl, tls: true, stopped: stopped.stopped === true } });
          return 0;
        }
        print(`daemon 已以 server 模式启动 (pid ${info.pid}, bind ${listen}, ${publicUrl})`);
        print('警告：这会监听非本机地址；只暴露在可信网络/反代后，并配置防火墙。');
        print('下一步：bridge pair create --label <device>，把链接/配对码发给另一台浏览器。');
        print('远程浏览器必须信任 --tls-pfx 对应的证书；自签证书需先导入信任库。');
        return 0;
      }
      const info = await ensureDaemon();
      if (isJson()) {
        emitJson({ ok: true, result: { running: true, pid: info.pid, port: info.port } });
        return 0;
      }
      print(`daemon 运行中 (pid ${info.pid}, port ${info.port})`);
      return 0;
    }
    if (sub === 'stop') {
      const result = await stopDaemon();
      if (isJson()) {
        emitJson({ ok: true, result });
        return 0;
      }
      print(result.message);
      return 0;
    }
    if (sub === 'restart') {
      // 重启保留 BB_HOME 下的 sessions.json 与凭据；已连接的浏览器会重新握手。
      const stopped = await stopDaemon();
      const started = await ensureDaemon();
      if (isJson()) {
        emitJson({ ok: true, result: { restarted: true, stopped: stopped.stopped === true, pid: started.pid, port: started.port } });
        return 0;
      }
      print(`daemon 已重启 (pid ${started.pid}, port ${started.port})`);
      return 0;
    }
    if (sub === 'status') {
      const found = await locateDaemon();
      if (found.info) {
        const health = found.health;
        if (isJson()) {
          emitJson({
            ok: true,
            result: {
              running: true,
              pid: health.pid,
              port: health.port,
              version: health.version,
              uptimeMs: health.uptimeMs,
              browsers: health.browsers,
              sessions: health.sessions,
            },
          });
          return 0;
        }
        print(`daemon 运行中 (pid ${health.pid}, port ${health.port}, v${health.version}, uptime ${formatUptime(health.uptimeMs)}, browsers ${health.browsers}, sessions ${health.sessions})`);
        return 0;
      }
      if (isJson()) {
        emitJson({ ok: true, result: { running: false } });
        return 0;
      }
      print('daemon 未运行');
      if (found.health) print(`（检测到 pid ${found.health.pid} 在 port ${found.health.port} 监听，但 daemon.json 缺失）`);
      return 0;
    }
    if (sub === 'devices') {
      const body = await callRpc('pair.list', {}, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      print('已连接远程浏览器：' + (result.devices || []).length);
      for (const device of result.devices || []) print('  ' + device.instanceId + '  ' + device.browser + ' v' + (device.browserVersion || '?'));
      print('已记住远程设备：' + (result.knownDevices || []).length);
      for (const device of result.knownDevices || []) print('  ' + device.deviceId + '  ' + (device.label || '-') + '  [' + (device.scope || 'control') + ']  ' + device.browser);
      print('未使用配对码：' + (result.pairings || []).length);
      return 0;
    }
    if (sub === 'revoke') {
      const code = flags.all === true ? '' : String(pos[2] || '');
      if (!code && flags.all !== true) throw new ArgError('用法：bridge daemon revoke <code> | --all');
      const body = flags.all === true
        ? await (async () => {
          const list = await callRpc('pair.list', {}, timeoutOf(flags));
          let revoked = 0;
          for (const item of (list.result && list.result.pairings) || []) {
            const one = await callRpc('pair.revoke', { code: item.code }, timeoutOf(flags));
            if (one.ok && one.result && one.result.revoked) revoked += 1;
          }
          return { ok: true, result: { revoked, all: true } };
        })()
        : await callRpc('pair.revoke', { code }, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      print('已撤销：' + JSON.stringify(body.result));
      return 0;
    }
    if (sub === 'pair') {
      const params = { replace: flags.replace !== undefined ? String(flags.replace) : '' };
      const body = await callRpc('local.pair', params, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      print('本机配对链接：' + result.link);
      if (result.code) print('6 位配对码：' + result.code + '（扩展“连接设置”里填写）');
      print('（5 分钟内有效，粘贴到扩展“连接设置 → 配对链接”）');
      return 0;
    }
    if (sub === 'trust-local') {
      const value = (pos[2] || '').toLowerCase();
      if (value !== 'on' && value !== 'off') throw new ArgError('用法：bridge daemon trust-local on|off');
      const body = await callRpc('local.trust', { strict: value === 'off' }, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      print(value === 'off' ? '本机严格模式已开启：未配对连接会被拒绝' : '本机未配对连接已允许');
      return 0;
    }
    if (sub === 'rotate') {
      const body = await callRpc('pair.rotate', {}, timeoutOf(flags));
      if (!body.ok) return outputFailure(body);
      if (isJson()) return outputJsonBody(body);
      const result = body.result || {};
      print('本机 rotation 已开始（pending，10 分钟内 commit）：');
      print('新配对链接：' + result.link);
      print('（commit 前旧 token 仍有效；在扩展“连接设置 → 配对链接”粘贴，扩展会自动 auth-commit）');
      return 0;
    }
    if (sub === 'log') {
      return daemonLog(flags);
    }
    throw new ArgError('用法：bridge daemon start|stop|restart|status|log|pair|devices|revoke|rotate|trust-local on|off|ledger|transfer|queue|doctor|batch|lease [--tail]');
  };
}
