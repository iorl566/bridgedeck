// cli/commands/install-skill.mjs —— install-skill（从 bridge 拆出）。
import fs from 'node:fs';
import path from 'node:path';

export async function installSkillCommand(ctx, flags, pos) {
  const { loadSkillBundle, SKILL_SOURCE, SKILL_TARGETS, commandTargetFor, installSkillAtomic, writeSkillFiles, copySkillDir, renderSkillCommand, configureMcp, emitJson, isJson, print, BridgeError, ArgError } = ctx;
  const { SKILL_VERSION } = await loadSkillBundle();
  const source = flags.source !== undefined ? path.resolve(process.cwd(), String(flags.source)) : SKILL_SOURCE;
  const useEmbedded = flags.embedded === true || !fs.existsSync(source);
  if (!useEmbedded && !fs.existsSync(source)) throw new BridgeError('E_INTERNAL', '找不到 skill 源：' + source);
  const names = Object.keys(SKILL_TARGETS);
  const isDetected = (name) => {
    const target = SKILL_TARGETS[name]();
    const root = path.dirname(path.dirname(target));
    return fs.existsSync(root);
  };
  const isInstalled = (name) => fs.existsSync(path.join(SKILL_TARGETS[name](), 'SKILL.md'));

  if (flags.list === true) {
    const rows = names.map((name) => ({ harness: name, path: SKILL_TARGETS[name](), detected: isDetected(name), installed: isInstalled(name), command: commandTargetFor(name)?.path || null }));
    if (isJson()) { emitJson({ ok: true, result: { harnesses: rows, skillVersion: SKILL_VERSION, embedded: true } }); return 0; }
    for (const row of rows) print(row.harness + '  ' + (row.detected ? '已检测' : '未检测') + (row.installed ? ' · 已安装' : '') + '  →  ' + row.path + (row.command ? '（命令：' + row.command + '）' : ''));
    return 0;
  }

  let selected;
  if (flags.all === true) selected = names.filter((name) => isDetected(name));
  else if (flags.harness !== undefined) {
    const raw = String(flags.harness);
    selected = raw.split(',').map((item) => item.trim()).filter(Boolean);
    for (const name of selected) if (!SKILL_TARGETS[name]) throw new ArgError('--harness 只能取 ' + names.join('|'));
  } else if (flags.dir !== undefined) selected = ['dir'];
  else selected = ['dsh'];

  const results = [];
  for (const name of selected) {
    const targetDir = name === 'dir' ? path.resolve(process.cwd(), String(flags.dir)) : SKILL_TARGETS[name]();
    const targetFile = path.join(targetDir, 'SKILL.md');
    let skipped = fs.existsSync(targetFile) && flags.force !== true;
    if (skipped) {
      results.push({ kind: 'skill', harness: name, path: targetFile, status: 'skipped' });
    } else {
      const installed = await installSkillAtomic(
        targetDir,
        (tempDir) => (useEmbedded ? writeSkillFiles(tempDir) : copySkillDir(source, tempDir)),
        useEmbedded ? 'embedded' : 'filesystem',
        flags.force === true,
      );
      if (installed.skipped) {
        results.push({ kind: 'skill', harness: name, path: targetFile, status: 'skipped' });
      } else {
        results.push({ kind: 'skill', harness: name, path: targetFile, status: 'installed', files: Object.keys(installed.manifest.files).length, manifest: installed.manifest.version });
      }
    }
    if (flags.commands === true) {
      const commandTarget = commandTargetFor(name);
      if (!commandTarget) {
        results.push({ kind: 'command', harness: name, commandStatus: 'unsupported' });
      } else if (fs.existsSync(commandTarget.path) && flags.force !== true) {
        results.push({ kind: 'command', harness: name, commandPath: commandTarget.path, commandStatus: 'skipped' });
      } else {
        fs.mkdirSync(path.dirname(commandTarget.path), { recursive: true });
        fs.writeFileSync(commandTarget.path, renderSkillCommand({ harness: name, skillDir: targetDir }), { mode: 0o644 });
        results.push({ kind: 'command', harness: name, commandPath: commandTarget.path, commandStatus: 'installed' });
      }
    }
    if (flags.mcp === true) results.push({ kind: 'mcp', ...configureMcp(name) });
  }
  if (isJson()) { emitJson({ ok: true, result: { results, skillVersion: SKILL_VERSION, embedded: useEmbedded } }); return 0; }
  for (const row of results) {
    if (row.kind === 'command') {
      if (row.commandPath) print(row.commandStatus === 'skipped' ? '命令已存在，跳过（--force 覆盖）：' + row.commandPath : '已安装命令 → ' + row.commandPath);
    } else if (row.kind === 'mcp') {
      print('MCP ' + row.harness + ' → ' + row.path + '（' + row.status + '）');
    } else if (row.kind === 'skill') {
      print(row.status === 'skipped' ? '已存在，跳过（--force 覆盖）：' + row.path : '已安装 skill → ' + row.path + '（' + row.files + ' 个文件）');
    }
  }
  return 0;
}
