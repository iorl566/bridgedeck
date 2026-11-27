// 发布目录只读保护：已签名的 dist 不允许被普通构建覆盖，防止误打包清掉签名。
import fs from 'node:fs';
import path from 'node:path';

export function readReleaseManifest(dir) {
  const file = path.join(dir, 'release.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function isSignedRelease(dir) {
  const release = readReleaseManifest(dir);
  return Boolean(release && typeof release.signature === 'string' && release.signature);
}

export function assertReleaseWritable(dir, { force = false } = {}) {
  if (force || !isSignedRelease(dir)) return;
  throw new Error(
    'dist 是已签名发布目录，拒绝覆盖。正式发布请用 tools/release.mjs 重新签名；'
    + '仅调试打包请加 --force，或用 --out <临时目录> 输出到别处。',
  );
}

export function parseBuildArgs(argv = []) {
  const args = { out: '', force: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--force') args.force = true;
    else if (value === '--dry-run') args.dryRun = true;
    else if (value === '--out') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) throw new Error('--out 需要目录');
      args.out = next;
      i += 1;
    } else if (value.startsWith('--out=')) args.out = value.slice(6);
    else throw new Error('未知参数：' + value);
  }
  return args;
}
