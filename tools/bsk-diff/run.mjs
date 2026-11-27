#!/usr/bin/env node
// tools/bsk-diff/run.mjs —— 上游 0.5.0 差分矩阵生成器 CLI。
//
// 用法：
//   node tools/bsk-diff/run.mjs                   生成 matrix.json + docs/上游-DIFF-MATRIX.md
//   node tools/bsk-diff/run.mjs --check           只校验仓库内产物是否与生成结果一致（CI）
//   node tools/bsk-diff/run.mjs --json            把 matrix.json 打到 stdout（不写文件）
//   node tools/bsk-diff/run.mjs --out <dir>       把 matrix.json + 上游-DIFF-MATRIX.md 写到指定目录
//   node tools/bsk-diff/run.mjs --quiet           抑制人读输出
//   node tools/bsk-diff/run.mjs --probe-exe       执行参照二进制，校验 help 快照未过期
//   node tools/bsk-diff/run.mjs --snapshot-help   用参照二进制重新采集 help 快照
//
// 退出码：0 一致/成功；1 不一致或校验失败；2 参数错误。

import fs from 'node:fs';
import path from 'node:path';
import { build, PATHS } from './build.mjs';
import { renderMarkdown, serializeMatrix, MATRIX_JSON_REL, MATRIX_MD_REL } from './lib/report.mjs';
import { captureHelpSnapshots, probeHelpSnapshots, exeAvailability } from './lib/exe.mjs';
import { loadCliCommands } from './lib/extract-bsk.mjs';
import { REPO_ROOT } from './lib/extract-ours.mjs';

function parseArgv(argv) {
  const options = {
    check: false,
    json: false,
    quiet: false,
    out: null,
    probeExe: false,
    snapshotHelp: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') options.check = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--quiet') options.quiet = true;
    else if (arg === '--probe-exe') options.probeExe = true;
    else if (arg === '--snapshot-help') options.snapshotHelp = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--out') {
      options.out = argv[i + 1];
      i += 1;
      if (!options.out) throw new Error('--out 需要一个目录参数');
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

const HELP = `BSK 0.5.0 差分矩阵生成器

用法：node tools/bsk-diff/run.mjs [选项]

  --check          校验 ${MATRIX_JSON_REL} 与 ${MATRIX_MD_REL} 是否与生成结果一致
  --json           把 matrix.json 打到 stdout（不写文件）
  --out <dir>      写到指定目录（默认写仓库内固定路径）
  --quiet          抑制人读输出
  --probe-exe      执行 ref/bsk-0.5.0-bin/bsk.exe，逐命令校验 help 快照是否过期
  --snapshot-help  用参照二进制重新采集 56 个命令 + 根帮助快照
  -h, --help       显示本帮助
`;

function writeArtifacts(matrix, outDir) {
  const jsonText = serializeMatrix(matrix);
  const mdText = renderMarkdown(matrix);
  const jsonPath = outDir ? path.join(outDir, 'matrix.json') : PATHS.matrixJson;
  const mdPath = outDir ? path.join(outDir, 'BSK-DIFF-MATRIX.md') : PATHS.matrixMarkdown;
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(mdPath), { recursive: true });
  fs.writeFileSync(jsonPath, jsonText, 'utf8');
  fs.writeFileSync(mdPath, mdText, 'utf8');
  return { jsonPath, mdPath, jsonText, mdText };
}

function readIfExists(absPath) {
  return fs.existsSync(absPath) ? fs.readFileSync(absPath, 'utf8') : null;
}

async function main(argv) {
  const options = parseArgv(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (options.snapshotHelp) {
    const result = captureHelpSnapshots(REPO_ROOT);
    if (!result.ok) {
      process.stderr.write(`采集失败：${result.reason}\n`);
      return 1;
    }
    if (!options.quiet) {
      process.stdout.write(`已采集 ${result.captured.length} 个帮助快照（含根帮助）→ tools/bsk-diff/data/bsk-exe-help/\n`);
    }
    return 0;
  }

  if (options.probeExe) {
    const availability = exeAvailability(REPO_ROOT);
    if (!availability.ok) {
      process.stderr.write(`无法执行参照二进制：${availability.reason}\n`);
      return 1;
    }
    const commands = loadCliCommands(REPO_ROOT).map((command) => command.name);
    const probe = probeHelpSnapshots(REPO_ROOT, [...commands, '_root']);
    const mismatched = probe.rows.filter((row) => !row.snapshotMatch);
    if (!options.quiet) {
      process.stdout.write(`参照二进制：${availability.abs}\n`);
      process.stdout.write(`快照校验：${probe.rows.length - mismatched.length}/${probe.rows.length} 一致\n`);
      const refDiff = probe.rows.filter((row) => row.hasRef && !row.refSurface);
      process.stdout.write(`.ref/bsk-help 旁证：${probe.rows.filter((row) => row.hasRef && row.refSurface).length}/${probe.rows.filter((row) => row.hasRef).length} 参数面一致（${refDiff.length} 个已过期）\n`);
      if (mismatched.length) {
        process.stdout.write(`过期快照：${mismatched.map((row) => row.command).join(', ')}\n`);
      }
    }
    return mismatched.length === 0 ? 0 : 1;
  }

  const matrix = await build(REPO_ROOT, { runProbe: false });

  if (options.json) {
    process.stdout.write(serializeMatrix(matrix));
    return 0;
  }

  const jsonText = serializeMatrix(matrix);
  const mdText = renderMarkdown(matrix);

  if (options.check) {
    const currentJson = readIfExists(PATHS.matrixJson);
    const currentMd = readIfExists(PATHS.matrixMarkdown);
    const problems = [];
    if (currentJson === null) problems.push(`${MATRIX_JSON_REL} 不存在`);
    else if (currentJson !== jsonText) problems.push(`${MATRIX_JSON_REL} 与生成结果不一致`);
    if (currentMd === null) problems.push(`${MATRIX_MD_REL} 不存在`);
    else if (currentMd !== mdText) problems.push(`${MATRIX_MD_REL} 与生成结果不一致`);
    if (problems.length) {
      process.stderr.write(`--check 失败：\n${problems.map((item) => `  - ${item}`).join('\n')}\n提示：运行 node tools/bsk-diff/run.mjs 重新生成。\n`);
      return 1;
    }
    if (!options.quiet) {
      process.stdout.write(`一致性校验通过：${MATRIX_JSON_REL}（${jsonText.length} 字节）+ ${MATRIX_MD_REL}（${mdText.length} 字节）\n`);
      const { totals } = matrix;
      process.stdout.write(`矩阵规模：${totals.rows} 格（equal ${totals.equal} / partial ${totals.partial} / missing ${totals.missing} / extra ${totals.extra} / unknown ${totals.unknown}）\n`);
    }
    return 0;
  }

  const outDir = options.out ? path.resolve(options.out) : null;
  const written = writeArtifacts(matrix, outDir);
  if (!options.quiet) {
    process.stdout.write(`已生成 ${written.jsonPath}（${written.jsonText.length} 字节）\n`);
    process.stdout.write(`已生成 ${written.mdPath}（${written.mdText.length} 字节）\n`);
    const { totals } = matrix;
    process.stdout.write(`矩阵规模：${totals.rows} 格（equal ${totals.equal} / partial ${totals.partial} / missing ${totals.missing} / extra ${totals.extra} / unknown ${totals.unknown}）\n`);
    process.stdout.write(`P0 差距：${matrix.p0.length} 条\n`);
  }
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`生成失败：${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  });
