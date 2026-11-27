// daemon/auto-update.js —— 自动检查/下载/应用更新。

export function createAutoUpdate({ HOME_DIR, VERSION, fs, path, crypto, spawnSync, fetchManifest, fetchArtifact, verifyReleaseSignature, RELEASE_PUBLIC_KEY, readUpdateState, writeUpdateState, log }) {
let autoUpdateTimer = null;
  let autoUpdateRunning = false;
  
  function extractReleaseArchive(archive, target) {
    let result = spawnSync('tar', ['-xf', archive, '-C', target], { encoding: 'utf8' });
    if (result.status === 0) return;
    if (process.platform !== 'win32') {
      result = spawnSync('unzip', ['-q', '-o', archive, '-d', target], { encoding: 'utf8' });
      if (result.status === 0) return;
    }
    throw new Error('自动应用失败：' + String(result.error?.message || result.stderr || result.stdout || archive));
  }
  
  async function checkAutoUpdate() {
    if (autoUpdateRunning) return;
    const statePath = path.join(HOME_DIR, 'update-state.json');
    const state = readUpdateState(statePath);
    const auto = state.auto;
    if (!auto || auto.enabled !== true || !auto.source) return;
    const now = Date.now();
    const last = auto.lastCheckAt ? Date.parse(auto.lastCheckAt) : 0;
    if (auto.intervalMs && now - last < Number(auto.intervalMs)) return;
    autoUpdateRunning = true;
    try {
      const manifest = await fetchManifest(auto.source);
      let signature = null;
      let verifyKey = '';
      if (auto.key) {
        try { verifyKey = fs.readFileSync(auto.key, 'utf8').trim(); } catch { verifyKey = ''; }
      } else if (manifest && manifest.signature && manifest.signature.alg === 'ed25519') {
        verifyKey = RELEASE_PUBLIC_KEY;
      }
      if (verifyKey) {
        try { signature = verifyReleaseSignature(manifest, verifyKey); } catch { signature = false; }
        if (signature === false) throw new Error('发布清单签名无效');
      }
      const latest = typeof manifest.version === 'string' ? manifest.version : null;
      if (latest && !/^[0-9A-Za-z._-]{1,32}$/.test(latest)) throw new Error('清单 version 非法：' + latest);
      const available = Boolean(latest && latest !== VERSION);
      if (available && auto.apply === true && signature !== true) throw new Error('自动应用要求有效的发布签名');
      let downloadedDir = null;
      if (available && auto.download === true && Array.isArray(manifest.artifacts)) {
        downloadedDir = path.join(HOME_DIR, 'update-cache', 'v' + latest);
        fs.mkdirSync(downloadedDir, { recursive: true });
        for (const artifact of manifest.artifacts) {
          if (!artifact || typeof artifact.file !== 'string' || !artifact.sha256) continue;
          const artifactUrl = new URL(artifact.file, auto.source).toString();
          const buffer = await fetchArtifact(artifactUrl);
          const hash = crypto.createHash('sha256').update(buffer).digest('hex');
          if (hash !== String(artifact.sha256).toLowerCase()) throw new Error('artifact sha256 不匹配：' + artifact.name);
          fs.writeFileSync(path.join(downloadedDir, path.basename(artifact.file)), buffer, { mode: 0o600 });
        }
      }
      let appliedAt = null;
      if (available && auto.apply === true && auto.applyTarget && downloadedDir) {
        fs.mkdirSync(auto.applyTarget, { recursive: true });
        for (const file of fs.readdirSync(downloadedDir).filter((name) => /\.(zip|tar\.gz)$/i.test(name))) {
          extractReleaseArchive(path.join(downloadedDir, file), auto.applyTarget);
        }
        appliedAt = new Date().toISOString();
      }
      writeUpdateState(statePath, {
        auto: {
          ...auto,
          lastCheckAt: new Date().toISOString(),
          latest,
          available,
          signature,
          downloadedDir,
          appliedAt,
          error: null,
        },
      });
      if (available) log('自动更新：发现新版本 ' + latest + '（当前 ' + VERSION + '）');
    } catch (error) {
      writeUpdateState(statePath, {
        auto: { ...auto, lastCheckAt: new Date().toISOString(), error: String((error && error.message) || error) },
      });
    } finally {
      autoUpdateRunning = false;
    }
  }
  
  function startAutoUpdateCheck() {
    if (autoUpdateTimer) return;
    setTimeout(() => { checkAutoUpdate().catch(() => {}); }, 5000).unref?.();
    autoUpdateTimer = setInterval(() => { checkAutoUpdate().catch(() => {}); }, 10 * 60 * 1000);
    autoUpdateTimer.unref?.();
  }
  
  
  return { startAutoUpdateCheck, checkAutoUpdate };
}
