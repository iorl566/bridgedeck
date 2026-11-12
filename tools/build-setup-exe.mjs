#!/usr/bin/env node
// tools/build-setup-exe.mjs —— 用 Windows IExpress 生成单文件安装器 exe。
//
// 安装器内包含 portable zip + sfx-install.ps1；运行后解压到临时目录，
// 再调用 install.ps1 安装到 %LOCALAPPDATA%\BridgeDeck（可用 BB_SETUP_DEST 覆盖）。
// 不含 Node 运行时；目标机需已安装 Node.js 18+。
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = path.resolve(ROOT, outIndex >= 0 && args[outIndex + 1] ? args[outIndex + 1] : path.join('dist', `BridgeDeckSetup-${pkg.version}.exe`));
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-sfx-'));
const target = path.join(stage, 'BridgeDeckSetup.exe');

try {
  const payload = path.join(stage, 'payload.zip');
  const pack = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'package-portable.mjs'), '--out', payload], { encoding: 'utf8' });
  if (pack.status !== 0) throw new Error('package-portable failed: ' + (pack.stderr || pack.stdout));
  fs.copyFileSync(path.join(ROOT, 'tools', 'sfx-install.ps1'), path.join(stage, 'install-sfx.ps1'));

  const sed = `[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=1
UseLongFileName=1
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=
TargetName=${target}
FriendlyName=BridgeDeck
AppLaunched=powershell -NoProfile -ExecutionPolicy Bypass -File install-sfx.ps1
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
SourceFiles=SourceFiles
[Strings]
FILE0=payload.zip
FILE1=install-sfx.ps1
[SourceFiles]
SourceFiles0=${stage}
[SourceFiles0]
%FILE0%=
%FILE1%=
`;
  const sedPath = path.join(stage, 'bridge.sed');
  fs.writeFileSync(sedPath, sed, 'utf8');
  if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  const result = spawnSync('iexpress.exe', ['/N', '/Q', sedPath], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error('iexpress failed: ' + (result.stderr || result.stdout));
  if (!fs.existsSync(target)) throw new Error('iexpress did not produce ' + target);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(target, out);
  const bytes = fs.statSync(out).size;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
  console.log('setup exe: ' + out);
  console.log('  bytes  ' + bytes);
  console.log('  sha256 ' + sha256);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
