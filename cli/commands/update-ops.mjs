// cli/commands/update-ops.mjs —— update 子实现：install / fetch / apply / rollback。
//
// update 库、原子写、校验与路径由 bridge 注入；本模块只做参数整理与文件编排。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ArgError } from '../lib/args.mjs';

export function createUpdateOps({
  REPO_ROOT,
  HOME_DIR,
  UPDATE_STATE_PATH,
  emitJson,
  isJson,
  print,
  loadUpdate,
  releaseVerifyKey,
  writeFileAtomic,
  assertInside,
  sha256File,
  BridgeError,
}) {
function cmdUpdateInstall(flags) {
  const rollbackDir = flags.rollback !== undefined ? path.resolve(process.cwd(), String(flags.rollback)) : '';
  if (!rollbackDir && flags.from === undefined) throw new ArgError('update install 需要 --from <zip|tar.gz>（或 --rollback <备份目录>）');
  const archive = flags.from !== undefined ? path.resolve(process.cwd(), String(flags.from)) : '';
  if (archive && !fs.existsSync(archive)) throw new BridgeError('E_NOT_FOUND', '更新包不存在：' + archive);
  if (rollbackDir && !fs.existsSync(path.join(rollbackDir, 'install.json'))) {
    throw new BridgeError('E_NOT_FOUND', '回滚目录缺少 install.json：' + rollbackDir);
  }
  const dest = flags.dest !== undefined ? path.resolve(process.cwd(), String(flags.dest)) : REPO_ROOT;
  if (!rollbackDir && !fs.existsSync(path.join(dest, 'cli', 'bridge.mjs'))) {
    throw new BridgeError('E_NOT_FOUND', '目标目录不是 BridgeDeck 安装：' + dest);
  }
  const helper = path.join(REPO_ROOT, 'tools', 'install-update.mjs');
  if (!fs.existsSync(helper)) {
    throw new BridgeError('E_NOT_FOUND', '当前安装缺少 tools/install-update.mjs；请用新版完整包重装一次');
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-update-helper-'));
  const script = path.join(temp, 'install-update.mjs');
  fs.copyFileSync(helper, script);
  const args = [script];
  if (rollbackDir) {
    args.push('--rollback', rollbackDir);
  } else {
    args.push('--archive', archive, '--dest', dest);
    if (flags.manifest !== undefined) args.push('--manifest', path.resolve(process.cwd(), String(flags.manifest)));
  }
  if (flags.port !== undefined) args.push('--port', String(flags.port));
  if (flags['no-restart'] === true) args.push('--no-restart');
  if (isJson()) args.push('--json');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env: { ...process.env } });
    child.on('error', (error) => {
      fs.rmSync(temp, { recursive: true, force: true });
      if (isJson()) emitJson({ ok: false, error: { code: 'E_UPDATE', message: String(error && error.message ? error.message : error) } });
      else print('update install 失败：' + (error && error.message ? error.message : error));
      resolve(1);
    });
    child.on('close', (code) => {
      fs.rmSync(temp, { recursive: true, force: true });
      resolve(typeof code === 'number' ? code : 1);
    });
  });
}

async function cmdUpdateFetch(flags) {
  const { fetchManifest, fetchManifestWithFallback, DOMESTIC_MANIFEST_URL, GITHUB_MANIFEST_URL, verifyReleaseSignature, writeUpdateState } = await loadUpdate();
  let source;
  let manifest;
  if (flags.source !== undefined) {
    source = String(flags.source);
    manifest = await fetchManifest(source);
  } else {
    const picked = await fetchManifestWithFallback([
      { name: '官网国内源', url: DOMESTIC_MANIFEST_URL },
      { name: 'GitHub 回退', url: GITHUB_MANIFEST_URL },
    ]);
    source = picked.source;
    manifest = picked.manifest;
  }
  if (!manifest || typeof manifest !== 'object' || typeof manifest.version !== 'string' || !Array.isArray(manifest.artifacts)) {
    throw new BridgeError('E_RELEASE_INVALID', '发布清单缺少 version/artifacts');
  }
  let signature = { present: Boolean(manifest.signature), valid: null };
  const verifyKey = await releaseVerifyKey(manifest, flags);
  if (verifyKey) {
    signature.valid = verifyReleaseSignature(manifest, verifyKey);
    if (!signature.valid) throw new BridgeError('E_RELEASE_INVALID', '远程发布清单签名无效');
  }
  const out = path.resolve(process.cwd(), flags.out !== undefined ? String(flags.out) : path.join(HOME_DIR, 'update-cache', 'release.json'));
  writeFileAtomic(out, JSON.stringify(manifest, null, 2) + '\n');
  writeUpdateState(UPDATE_STATE_PATH, {
    lastFetch: { source, out, version: manifest.version, artifacts: manifest.artifacts.length, signature, at: new Date().toISOString() },
  });
  const result = { source, out, version: manifest.version, artifacts: manifest.artifacts.length, signature };
  if (isJson()) {
    emitJson({ ok: true, result });
    return 0;
  }
  print('已拉取发布清单：v' + manifest.version + '（' + manifest.artifacts.length + ' 个 artifact）→ ' + out);
  if (signature.present) print('签名：' + (signature.valid === true ? '有效' : signature.valid === false ? '无效' : '未提供 key，未校验'));
  return 0;
}

async function cmdUpdateApply(flags) {
  const { writeUpdateState } = await loadUpdate();
  if (flags.staging === undefined) throw new ArgError('update apply 需要 --staging <dir>');
  if (flags.target === undefined) throw new ArgError('update apply 需要 --target <dir>');
  const stagedDir = path.resolve(process.cwd(), String(flags.staging));
  const recordPath = path.join(stagedDir, 'staged.json');
  if (!fs.existsSync(recordPath)) throw new BridgeError('E_NOT_FOUND', 'staging 目录缺少 staged.json：' + recordPath);
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  const target = path.resolve(process.cwd(), String(flags.target));
  fs.mkdirSync(target, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-' + crypto.randomBytes(2).toString('hex');
  const backupDir = path.join(target, '.backup-' + stamp);
  fs.mkdirSync(backupDir, { recursive: true });
  const files = [];
  for (const item of Array.isArray(record.artifacts) ? record.artifacts : []) {
    if (!item || !item.name) throw new BridgeError('E_RELEASE_INVALID', 'staged.json artifact 缺少 name');
    if (path.basename(item.name) !== item.name) throw new BridgeError('E_RELEASE_INVALID', 'artifact name 含路径：' + item.name);
    const src = assertInside(stagedDir, path.join(stagedDir, item.name), 'artifact src');
    if (!fs.existsSync(src)) throw new BridgeError('E_NOT_FOUND', 'staging 缺少文件：' + src);
    const sha256 = sha256File(src);
    if (sha256 !== item.sha256) throw new BridgeError('E_RELEASE_INVALID', 'staging 文件哈希不匹配：' + item.name);
    const dest = assertInside(target, path.join(target, item.name), 'artifact dest');
    const existed = fs.existsSync(dest);
    let backup = null;
    let beforeSha256 = null;
    if (existed) {
      backup = path.relative(target, path.join(backupDir, item.name));
      fs.copyFileSync(dest, path.join(backupDir, item.name));
      beforeSha256 = sha256File(dest);
    }
    fs.copyFileSync(src, dest);
    if (sha256File(dest) !== sha256) throw new BridgeError('E_RELEASE_INVALID', '写入后校验失败：' + item.name);
    files.push({ name: item.name, existed, backup, beforeSha256, bytes: item.bytes, sha256 });
  }
  const backupRecord = { version: record.version, target, backupDir, files, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(backupDir, 'backup.json'), JSON.stringify(backupRecord, null, 2) + '\n', 'utf8');
  const result = { version: record.version, target, backupDir, files };
  writeUpdateState(UPDATE_STATE_PATH, {
    lastApply: { version: record.version, target, backupDir, files: files.length, at: new Date().toISOString() },
  });
  if (isJson()) {
    emitJson({ ok: true, result });
    return 0;
  }
  print('已应用 v' + record.version + ' → ' + target);
  for (const item of files) print('  ' + item.name + (item.existed ? '（已备份）' : '（新增）'));
  print('回滚目录：' + backupDir);
  return 0;
}

async function cmdUpdateRollback(flags) {
  const { writeUpdateState } = await loadUpdate();
  if (flags.backup === undefined) throw new ArgError('update rollback 需要 --backup <dir>');
  const backupDir = path.resolve(process.cwd(), String(flags.backup));
  const recordPath = path.join(backupDir, 'backup.json');
  if (!fs.existsSync(recordPath)) throw new BridgeError('E_NOT_FOUND', '备份目录缺少 backup.json：' + recordPath);
  const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
  const target = path.resolve(String(record.target || ''));
  const restored = [];
  for (const item of Array.isArray(record.files) ? record.files : []) {
    const dest = assertInside(target, path.join(target, item.name), 'artifact dest');
    if (item.existed) {
      const backupFile = item.backup
        ? assertInside(target, path.resolve(target, item.backup), 'rollback backup')
        : assertInside(backupDir, path.join(backupDir, item.name), 'rollback backup');
      if (!fs.existsSync(backupFile)) throw new BridgeError('E_NOT_FOUND', '备份文件缺失：' + backupFile);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(backupFile, dest);
      if (item.beforeSha256 && sha256File(dest) !== item.beforeSha256) {
        throw new BridgeError('E_RELEASE_INVALID', '回滚后哈希不符：' + item.name);
      }
    } else {
      fs.rmSync(dest, { force: true });
    }
    restored.push({ name: item.name, existed: item.existed });
  }
  const result = { version: record.version || null, target, restored };
  writeUpdateState(UPDATE_STATE_PATH, {
    lastRollback: { version: record.version || null, target, at: new Date().toISOString() },
  });
  if (isJson()) {
    emitJson({ ok: true, result });
    return 0;
  }
  print('已回滚 v' + (record.version || '?') + ' ← ' + target);
  for (const item of restored) print('  ' + item.name + (item.existed ? '（恢复旧文件）' : '（移除新增文件）'));
  return 0;
}

  return { cmdUpdateInstall, cmdUpdateFetch, cmdUpdateApply, cmdUpdateRollback };
}
