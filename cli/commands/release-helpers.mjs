// cli/commands/release-helpers.mjs —— update/verify 辅助（从 bridge 拆出）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function createReleaseHelpers(ctx) {
  const { REPO_ROOT, VERSION, loadUpdate, BridgeError } = ctx;

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  
  function verifyRelease(manifest, manifestPath) {
    const artifacts = (Array.isArray(manifest.artifacts) ? manifest.artifacts : []).map((item) => {
      const file = path.resolve(REPO_ROOT, String(item.file || path.join('dist', item.name || '')));
      let bytes = null;
      let sha256 = null;
      try {
        const buffer = fs.readFileSync(file);
        bytes = buffer.length;
        sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      } catch {
        // 缺失文件保持 null
      }
      return {
        name: item.name || path.basename(file),
        source: file,
        ok: bytes === item.bytes && sha256 === item.sha256,
        bytes,
        expectedBytes: item.bytes,
        sha256,
        expectedSha256: item.sha256,
      };
    });
    const verified = artifacts.length > 0 && artifacts.every((item) => item.ok);
    return {
      artifacts,
      verified,
      result: {
        version: VERSION,
        latest: typeof manifest.version === 'string' ? manifest.version : null,
        updateAvailable: manifest.version !== VERSION,
        verified,
        manifest: manifestPath,
        artifacts: artifacts.map(({ source, ...rest }) => rest),
      },
    };
  }
  async function releaseVerifyKey(manifest, flags) {
    if (flags.key !== undefined) {
      return fs.readFileSync(path.resolve(process.cwd(), String(flags.key)), 'utf8').trim();
    }
    if (manifest && manifest.signature && manifest.signature.alg === 'ed25519') {
      const { RELEASE_PUBLIC_KEY } = await loadUpdate();
      return RELEASE_PUBLIC_KEY;
    }
    return '';
  }
  function assertInside(base, candidate, label) {
    const root = path.resolve(base);
    const value = path.resolve(candidate);
    if (value !== root && !value.startsWith(root + path.sep)) {
      throw new BridgeError('E_RELEASE_INVALID', label + ' 越界：' + candidate);
    }
    return value;
  }
  return { sha256File, verifyRelease, releaseVerifyKey, assertInside };
}
