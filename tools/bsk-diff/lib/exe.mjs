// tools/bsk-diff/lib/exe.mjs —— 可选地执行 上游 参照二进制（仅 Windows x64 可用）。
//
// 生成器默认**不执行** exe：产物只依赖仓库内提交的快照文件，保证在任何平台、
// 任何时间二次运行逐字节一致。执行 exe 只用于两个显式动作：
//   `run.mjs --snapshot-help` 重新采集 56 个命令 + 根帮助（写入 data/bsk-exe-help/）
//   `run.mjs --probe-exe`     逐命令执行并与快照/旁证比对（发现快照过期就非 0 退出）
// 运行环境不可用（非 Windows / 无该二进制 / 执行失败）时，两者都如实报告而不是猜测。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BSK_PATHS, parseHelpText, parseRootCommands } from './extract-bsk.mjs';
import { normalizeText } from './text.mjs';

/** exe 是否可执行：文件存在 + 平台匹配（该参照物是 windows-x64 构建）。 */
export function exeAvailability(root) {
  const abs = path.join(root, BSK_PATHS.bin);
  if (!fs.existsSync(abs)) return { ok: false, reason: `参照二进制不存在：${BSK_PATHS.bin}` };
  if (process.platform !== 'win32') {
    return {
      ok: false,
      reason: `参照二进制是 windows-x64 构建（当前平台 ${process.platform} 无法执行），改用仓库内帮助快照 + Rust 源码作为证据`,
    };
  }
  return { ok: true, abs };
}

/**
 * 采集/探测用的 argv。`help` 是 clap 内置子命令：`参考实现 CLI help --help` 会以
 * `error: unrecognized subcommand '--help'` 退出 1，`参考实现 CLI help` 则打印根帮助；
 * 因此对 `help` 采集 `参考实现 CLI help`，其余命令采集 `参考实现 CLI <cmd> --help`。
 */
export function helpArgv(command) {
  const name = command === null ? '_root' : command;
  return name === 'help' ? ['help'] : name === '_root' ? ['--help'] : [name, '--help'];
}

/** 执行 `参考实现 CLI <argv>`，返回 { ok, status, stdout, stderr, reason }。 */
export function runBsk(root, argv) {
  const availability = exeAvailability(root);
  if (!availability.ok) return { ok: false, status: null, stdout: '', stderr: '', reason: availability.reason };
  const result = spawnSync(availability.abs, argv, {
    cwd: root,
    encoding: 'buffer',
    timeout: 20000,
    windowsHide: true,
  });
  if (result.error) {
    return { ok: false, status: null, stdout: '', stderr: '', reason: `执行失败：${result.error.message}` };
  }
  const decode = (buffer) => normalizeText((buffer || Buffer.alloc(0)).toString('utf8')).replace(/^\uFEFF/, '');
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
    reason: result.status === 0 ? '' : `退出码 ${result.status}`,
  };
}

/** 帮助快照文件名：根帮助为 `_root.txt`，命令为 `<name>.txt`。 */
export function snapshotFile(root, command) {
  const name = command === null ? '_root' : command;
  return path.join(root, BSK_PATHS.snapshot, `${name}.txt`);
}

function canonical(text) {
  return normalizeText(text).replace(/^\uFEFF/, '').replace(/[ \t]+$/gm, '').replace(/\n+$/, '') + '\n';
}

function writeNormalized(absPath, content) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const body = canonical(content);
  fs.writeFileSync(absPath, body, 'utf8');
  return body;
}

/**
 * 采集根帮助 + 全部 56 个命令帮助，写入 data/bsk-exe-help/。
 * 命令表从**本次采集到的根帮助**解析（而不是仓库里的旧快照），避免自洽性陷阱。
 * 返回 { ok, captured, failed, reason }。
 */
export function captureHelpSnapshots(root) {
  const availability = exeAvailability(root);
  if (!availability.ok) return { ok: false, captured: [], failed: [], reason: availability.reason };

  const rootHelp = runBsk(root, helpArgv(null));
  if (!rootHelp.ok) return { ok: false, captured: [], failed: ['_root'], reason: rootHelp.reason };
  const rootBody = writeNormalized(snapshotFile(root, null), rootHelp.stdout);
  const commands = parseRootCommands(rootBody, `${BSK_PATHS.snapshot}/_root.txt`);
  const captured = ['_root'];
  const failed = [];
  for (const command of commands) {
    const help = runBsk(root, helpArgv(command.name));
    if (!help.ok || !help.stdout.trim()) {
      failed.push(command.name);
      continue;
    }
    writeNormalized(snapshotFile(root, command.name), help.stdout);
    captured.push(command.name);
  }
  return { ok: failed.length === 0, captured, failed, reason: failed.length ? `采集失败：${failed.join(',')}` : '' };
}

/** 结构化摘要：命令帮助的「可核对面」（usage + 位置参数名 + 长选项名集合）。 */
export function surfaceDigest(text) {
  const parsed = parseHelpText(text);
  return {
    usage: parsed.usage,
    positionals: parsed.positionals.map((item) => `${item.required ? 'required' : 'optional'}:${item.name}`).sort(),
    options: parsed.options.map((item) => item.name).sort(),
    summary: parsed.summary,
  };
}

function sameDigest(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 逐命令执行 exe，与已提交快照、以及 `.ref/bsk-help` 旁证比对。
 * 返回 { ok, reason, rows }
 *   rows[i].snapshotMatch   exe 与提交快照字节一致
 *   rows[i].snapshotSurface exe 与提交快照「可核对面」一致
 *   rows[i].refMatch / refSurface   `.ref/bsk-help/<cmd>.txt` 是否与实机一致
 */
export function probeHelpSnapshots(root, commandNames) {
  const availability = exeAvailability(root);
  if (!availability.ok) return { ok: false, reason: availability.reason, rows: [] };
  const rows = [];
  for (const command of commandNames) {
    const exe = runBsk(root, helpArgv(command));
    const exeText = canonical(exe.stdout);
    const exeDigest = surfaceDigest(exeText);
    const snapAbs = snapshotFile(root, command);
    const snapshot = fs.existsSync(snapAbs) ? canonical(fs.readFileSync(snapAbs, 'utf8')) : null;
    const refAbs = path.join(root, BSK_PATHS.help, `${command}.txt`);
    const ref = fs.existsSync(refAbs) ? canonical(fs.readFileSync(refAbs, 'utf8')) : null;
    rows.push({
      command,
      exeStatus: exe.status,
      hasSnapshot: snapshot !== null,
      snapshotMatch: snapshot !== null && snapshot === exeText,
      snapshotSurface: snapshot !== null && sameDigest(surfaceDigest(snapshot), exeDigest),
      hasRef: ref !== null,
      refMatch: ref !== null && ref === exeText,
      refSurface: ref !== null && sameDigest(surfaceDigest(ref), exeDigest),
    });
  }
  return { ok: rows.every((row) => row.snapshotMatch), reason: '', rows };
}
