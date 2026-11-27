// cli/commands/update.mjs —— `bridge update` 发布清单校验/暂存/应用/回滚/自动检查。
//
// update 库与低层 helper（verifyRelease/sha256File/releaseVerifyKey/子命令实现）由 bridge 注入。
import fs from 'node:fs';
import path from 'node:path';
import { ArgError, intFlag, parseDurationMs } from '../lib/args.mjs';

export function createUpdateCommand({
  REPO_ROOT,
  UPDATE_STATE_PATH,
  VERSION,
  emitJson,
  isJson,
  print,
  loadUpdate,
  verifyRelease,
  releaseVerifyKey,
  sha256File,
  cmdUpdateInstall,
  cmdUpdateFetch,
  cmdUpdateApply,
  cmdUpdateRollback,
  BridgeError,
}) {
  return async function cmdUpdate(flags, pos) {
  const { readUpdateState, writeUpdateState, verifyReleaseSignature } = await loadUpdate();
  const sub = pos && pos[1] ? String(pos[1]) : (flags.check === true ? 'check' : '');
  if (sub && !['check', 'verify', 'stage', 'apply', 'rollback', 'fetch', 'state', 'auto', 'install'].includes(sub)) {
    throw new ArgError('update 只支持 check|verify|stage|apply|rollback|fetch|state|auto|install');
  }
  if (sub === 'install') return cmdUpdateInstall(flags);
  if (sub === 'apply') return cmdUpdateApply(flags);
  if (sub === 'rollback') return cmdUpdateRollback(flags);
  if (sub === 'auto') {
    const state = readUpdateState(UPDATE_STATE_PATH);
    if (flags.disable === true) {
      state.auto = { ...(state.auto || {}), enabled: false, updatedAt: new Date().toISOString() };
      writeUpdateState(UPDATE_STATE_PATH, { auto: state.auto });
      if (isJson()) { emitJson({ ok: true, result: { auto: state.auto } }); return 0; }
      print('自动更新检查已关闭');
      return 0;
    }
    if (flags.enable === true) {
      if (!flags.source) throw new ArgError('update auto --enable 需要 --source <https URL>');
      const intervalMs = flags.interval !== undefined ? Math.max(60000, parseDurationMs(flags.interval, 6 * 60 * 60 * 1000)) : 6 * 60 * 60 * 1000;
      state.auto = {
        enabled: true,
        source: String(flags.source),
        key: flags.key !== undefined ? path.resolve(process.cwd(), String(flags.key)) : null,
        intervalMs,
        download: flags.download === true,
        apply: flags.apply === true,
        applyTarget: flags.target !== undefined ? path.resolve(process.cwd(), String(flags.target)) : null,
        updatedAt: new Date().toISOString(),
      };
      writeUpdateState(UPDATE_STATE_PATH, { auto: state.auto });
      if (isJson()) { emitJson({ ok: true, result: { auto: state.auto } }); return 0; }
      print('自动更新检查已开启：' + state.auto.source + '（每 ' + Math.round(intervalMs / 60000) + ' 分钟）');
      return 0;
    }
    if (isJson()) { emitJson({ ok: true, result: { auto: state.auto || { enabled: false } } }); return 0; }
    print(JSON.stringify(state.auto || { enabled: false }, null, 2));
    return 0;
  }
  if (sub === 'fetch') return cmdUpdateFetch(flags);
  if (sub === 'state') {
    const state = readUpdateState(UPDATE_STATE_PATH);
    if (isJson()) {
      emitJson({ ok: true, result: { state } });
      return 0;
    }
    print(JSON.stringify(state, null, 2));
    return 0;
  }
  const manifestPath = flags.manifest !== undefined
    ? path.resolve(process.cwd(), String(flags.manifest))
    : path.join(REPO_ROOT, 'dist', 'release.json');
  let manifest = null;
  let parseError = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      parseError = error.message;
    }
  }
  if (!manifest) {
    const result = {
      version: VERSION,
      latest: null,
      updateAvailable: false,
      verified: false,
      manifest: manifestPath,
      note: parseError ? '发布清单解析失败：' + parseError : '未找到发布清单（先运行 node tools/release.mjs）',
    };
    if (isJson()) {
      emitJson({ ok: true, result });
      return 0;
    }
    print(result.note);
    return 0;
  }
  const { artifacts, verified, result } = verifyRelease(manifest, manifestPath);
  const signKey = await releaseVerifyKey(manifest, flags);
  const signature = { present: Boolean(manifest.signature), valid: null };
  if (manifest.signature && signKey) signature.valid = verifyReleaseSignature(manifest, signKey);
  else if (!manifest.signature && signKey) signature.valid = false;
  result.signature = signature;
  writeUpdateState(UPDATE_STATE_PATH, {
    lastCheck: { manifest: manifestPath, latest: result.latest, verified, signature, at: new Date().toISOString() },
  });

  if (sub === 'stage') {
    if (!verified) throw new BridgeError('E_RELEASE_INVALID', '发布清单校验失败，拒绝 staging');
    if (signature.valid === false) throw new BridgeError('E_RELEASE_INVALID', '发布清单签名无效，拒绝 staging');
    if (flags.dir === undefined) throw new ArgError('update stage 需要 --dir <path>');
    const version = typeof manifest.version === 'string' ? manifest.version : VERSION;
    const target = path.resolve(process.cwd(), String(flags.dir), 'v' + version);
    if (fs.existsSync(target) && fs.readdirSync(target).length && flags.force !== true) {
      throw new BridgeError('E_EXISTS', 'staging 目录已存在非空内容：' + target + '（加 --force 覆盖）');
    }
    fs.mkdirSync(target, { recursive: true });
    const staged = [];
    for (const item of artifacts) {
      const name = path.basename(item.name || item.source);
      const dest = path.join(target, name);
      fs.copyFileSync(item.source, dest);
      const sha256 = sha256File(dest);
      if (sha256 !== item.sha256) throw new BridgeError('E_RELEASE_INVALID', 'staging 后校验失败：' + name);
      staged.push({ name, bytes: item.bytes, sha256 });
    }
    const record = { version, stagedAt: new Date().toISOString(), manifest: manifestPath, artifacts: staged };
    fs.writeFileSync(path.join(target, 'staged.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');
    const stagedResult = { version, dir: target, verified: true, artifacts: staged };
    writeUpdateState(UPDATE_STATE_PATH, {
      lastStage: { version, dir: target, artifacts: staged.length, at: new Date().toISOString() },
    });
    if (isJson()) {
      emitJson({ ok: true, result: stagedResult });
      return 0;
    }
    print('已 staging v' + version + ' → ' + target);
    for (const item of staged) print('  ' + item.name + '  ' + item.bytes + 'B  ' + item.sha256.slice(0, 16) + '…');
    print('注意：仅落盘 staging，不替换当前安装。');
    return 0;
  }

  if (isJson()) {
    emitJson({ ok: true, result });
    return verified ? 0 : 1;
  }
  print('当前版本：' + VERSION + '，清单版本：' + (result.latest || '?') + (result.updateAvailable ? '（有差异）' : '（一致）'));
  for (const item of artifacts) print((item.ok ? 'OK   ' : 'FAIL ') + item.name + '  ' + (item.bytes == null ? '缺文件' : item.bytes + 'B'));
  print(verified ? '发布清单校验通过。' : '发布清单校验失败。');
  return verified ? 0 : 1;
  };
}
