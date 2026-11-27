// cli/commands/doctor.mjs —— `bridge doctor` 环境自检（daemon/token/浏览器/扩展/配对/安装/TLS/日志）。
import fs from 'node:fs';
import path from 'node:path';
import { formatUptime, formatBytes, padEndWidth } from '../lib/format.mjs';

export function createDoctorCommand({
  HOME_DIR,
  DAEMON_JSON_PATH,
  LOG_PATH,
  REPO_ROOT,
  locateDaemon,
  postRpc,
  readDaemonInfo,
  readTailLines,
  emitJson,
  isJson,
  print,
}) {
  return async function cmdDoctor(flags) {
  const checks = [];
  const add = (status, name, detail) => checks.push({ status, name, detail });
  let hardOk = true;

  add('ok', 'node', process.version);

  try {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.accessSync(HOME_DIR, fs.constants.W_OK);
    add('ok', 'BB_HOME', HOME_DIR);
  } catch (err) {
    hardOk = false;
    add('fail', 'BB_HOME', `${HOME_DIR} 不可写：${err.message}`);
  }

  const info = readDaemonInfo();
  if (info) add('ok', 'daemon.json', `pid ${info.pid}, port ${info.port}`);
  else add('fail', 'daemon.json', `${DAEMON_JSON_PATH} 不存在`);

  // 日志与磁盘：排障时最常看的两个落点。
  try {
    const logStat = fs.statSync(LOG_PATH);
    add('ok', 'log', `${LOG_PATH}（${formatBytes(logStat.size)}）`);
  } catch {
    add('warn', 'log', `${LOG_PATH} 尚不存在（首次写入日志后出现）`);
  }
  try {
    const fsStat = fs.statfsSync(HOME_DIR);
    const freeBytes = Number(fsStat.bavail) * Number(fsStat.bsize);
    add(freeBytes > 50 * 1024 * 1024 ? 'ok' : 'warn', 'disk', `BB_HOME 可用 ${formatBytes(freeBytes)}`);
  } catch {
    // statfs 在部分平台/旧 Node 不可用：跳过，不影响主流程
  }

  // 安装/版本一致性：CLI（package.json）与扩展 manifest 必须同版本，否则会出现协议/行为错配。
  try {
    const pkgVersion = String(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version || '');
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'extension', 'manifest.json'), 'utf8'));
    const same = pkgVersion === String(manifest.version || '');
    add(same ? 'ok' : 'warn', 'install', `repo v${pkgVersion}，extension v${manifest.version}${same ? '' : '（版本不一致：重新加载/构建扩展）'}`);
  } catch (err) {
    add('warn', 'install', '读取 package/manifest 失败：' + err.message);
  }

  // TLS 证书状态（只提示，不改变运行配置）。
  if (fs.existsSync(path.join(HOME_DIR, 'tls', 'cert.pfx'))) {
    add('ok', 'tls', 'cert.pfx 存在（BB_TLS=1 可用 WSS）');
  } else {
    add('ok', 'tls', '未启用（无 cert.pfx；需要加密时用 BB_TLS=1 启动）');
  }

  // 日志尾部错误摘要：只读最后 64KB，避免 doctor 读大日志。
  try {
    const tail = readTailLines(LOG_PATH, 64 * 1024).slice(-200);
    const bad = tail.filter((line) => /\b(error|failed|exception)\b/i.test(line) || /失败|异常/.test(line));
    add(bad.length ? 'warn' : 'ok', 'log-errors', bad.length
      ? `${bad.length} 条可疑错误（最近 200 行），最后：${bad[bad.length - 1].slice(0, 120)}`
      : '最近 200 行无错误');
  } catch {
    add('ok', 'log-errors', '无日志（尚未写入）');
  }

  const found = await locateDaemon();
  let daemonStatusBody = null;
  if (found.info) {
    const health = found.health;
    add('ok', 'daemon', `运行中 pid ${health.pid}, port ${health.port}, uptime ${formatUptime(health.uptimeMs)}`);
    try {
      // 一次 status 同时验 token 并取回 daemon 侧结构化自检（ledger/transfer/queue/recovery/storage）。
      // 旧 daemon 会忽略 doctor 参数：此时只跳过新增自检项，不影响既有检查与退出码。
      const body = await postRpc(found.info, 'status', { doctor: true }, 5000);
      if (body.ok) {
        daemonStatusBody = body;
        add('ok', 'token', '有效（/rpc status 通）');
      } else {
        hardOk = false;
        add('fail', 'token', `/rpc 返回 ${body.error ? body.error.code : 'unknown'}`);
      }
    } catch (err) {
      hardOk = false;
      add('fail', 'token', err.message);
    }
    if (health.browsers > 0) add('ok', 'browsers', `${health.browsers} 个已连接`);
    else add('warn', 'browsers', '0 个已连接（在浏览器里启用扩展）');
    add('ok', 'sessions', `${health.sessions} 个活动`);
    // 端口一致性：daemon.json 与 /health 不一致通常意味着旧进程/端口被占用。
    const wantedPort = Number(found.info.port);
    const actualPort = Number(health.port);
    if (Number.isInteger(wantedPort) && Number.isInteger(actualPort) && wantedPort !== actualPort) {
      add('warn', 'port', `daemon.json 记录 ${wantedPort}，实际监听 ${actualPort}（可能有旧 daemon 残留）`);
    } else {
      add('ok', 'port', String(actualPort || wantedPort || '?'));
    }
  } else {
    hardOk = false;
    add('fail', 'daemon', '未运行（运行 bridge daemon start）');
    if (found.health) {
      add('warn', 'daemon', `pid ${found.health.pid} 在 port ${found.health.port} 监听，但 daemon.json 缺失，无法鉴权`);
    }
  }

  const manifestPath = path.join(REPO_ROOT, 'extension', 'manifest.json');
  if (fs.existsSync(manifestPath)) add('ok', 'extension', manifestPath);
  else add('warn', 'extension', `${manifestPath} 不存在（扩展未加载/未构建）`);

  if (found.info && found.health && found.health.browsers > 0) {
    try {
      const body = await postRpc(found.info, 'diagnostics.ui', {}, 5000);
      if (body.ok && body.result && body.result.ok) {
        const result = body.result;
        add('ok', 'extension-ui', 'popup/options/图标可加载（ext v' + (result.packageVersion || '?') + '）');
      } else {
        hardOk = false;
        add('fail', 'extension-ui', JSON.stringify(body.result || body.error).slice(0, 240));
      }
    } catch (err) {
      hardOk = false;
      add('fail', 'extension-ui', err.message);
    }
  } else {
    add('warn', 'extension-ui', '浏览器未连接，跳过');
  }

  // 配对状态：可选/必需模式、已知设备、未配对连接。
  if (found.info) {
    try {
      const [pairBody, browsersBody] = await Promise.all([
        postRpc(found.info, 'pair.list', {}, 3000),
        postRpc(found.info, 'browsers', {}, 3000),
      ]);
      if (pairBody.ok && pairBody.result) {
        const pairing = pairBody.result;
        const devices = (pairing.knownDevices || []).length;
        const pending = (pairing.pairings || []).length;
        const unpaired = ((browsersBody.ok && browsersBody.result && browsersBody.result.browsers) || [])
          .filter((item) => item.localAuth === 'unpaired').length;
        const mode = pairing.strict === true ? '必需模式（未配对连接被拒绝）' : '可选模式（未配对连接可用，但会显示身份警告）';
        const warn = pairing.strict !== true && unpaired > 0;
        add(warn ? 'warn' : 'ok', 'pairing', mode + '；已知设备 ' + devices + '，待配对码 ' + pending + (unpaired ? '，未配对连接 ' + unpaired : ''));
        if (warn) add('warn', 'pairing-hint', '未配对连接无法证明身份：运行 bridge daemon pair（或 bridge pair create 生成远程码）');
      }
    } catch {
      // 配对状态是增强信息，失败不影响 doctor 主流程
    }
  }

  // daemon 侧自检（第九批 B）：ledger/transfer/queue 状态直接来自 daemon 的 status doctor 视图。
  if (daemonStatusBody && daemonStatusBody.result && daemonStatusBody.result.doctor) {
    const report = daemonStatusBody.result.doctor;
    const rows = Array.isArray(report.checks) ? report.checks : [];
    const areas = [['ledger', 'daemon-ledger'], ['transfer', 'daemon-transfer'], ['queue', 'daemon-queue']];
    for (const [area, name] of areas) {
      const areaRows = rows.filter((item) => item && item.area === area);
      if (!areaRows.length) continue;
      const status = areaRows.some((item) => item.status === 'fail') ? 'fail' : areaRows.some((item) => item.status === 'warn') ? 'warn' : 'ok';
      // daemon 内部 fail 也只记 warn：doctor 的“硬失败”仍由本地环境项决定（既有退出码语义不变）。
      add(status === 'fail' ? 'warn' : status, name, areaRows.map((item) => item.detail).join('；'));
    }
    const summary = report.summary || {};
    add(report.status === 'fail' ? 'warn' : 'ok', 'daemon-doctor',
      `daemon 自检 ${summary.total || rows.length} 项：ok ${summary.ok || 0}，warn ${summary.warn || 0}，fail ${summary.fail || 0}`);
  } else if (found.info) {
    add('ok', 'daemon-doctor', '旧 daemon 未提供自检数据（升级后可见 ledger/transfer/queue 状态）');
  }

  if (!isJson()) {
    const label = { ok: '[ok]  ', warn: '[warn]', fail: '[fail]' };
    print(checks.map((item) => `${label[item.status] || '[?]   '} ${padEndWidth(item.name, 14)} ${item.detail}`).join('\n'));
  }
  if (isJson()) {
    const payload = { ok: hardOk, result: { checks, home: HOME_DIR, daemonJson: DAEMON_JSON_PATH, log: LOG_PATH } };
    // 只增字段：daemon 侧自检原始报告（旧 daemon 时缺省）。
    if (daemonStatusBody && daemonStatusBody.result && daemonStatusBody.result.doctor) {
      payload.result.daemon = daemonStatusBody.result.doctor;
    }
    if (!hardOk) payload.error = { code: 'E_ENV', message: '环境自检未通过' };
    emitJson(payload);
  }
  return hardOk ? 0 : 1;
  };
}
