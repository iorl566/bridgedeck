// lib/skill-commands.mjs —— 为支持自定义斜杠命令的 harness 生成命令包装。
//
// Skill（SKILL.md + references）是自动发现/模型调用的；斜杠命令是另一层：
// Claude Code 用 ~/.claude/commands，Codex 用 ~/.codex/prompts，Cursor 用
// ~/.cursor/commands。这里只生成一个薄包装，正文仍指向已安装的 skill。
import os from 'node:os';
import path from 'node:path';

export const COMMAND_TARGETS = {
  'claude-code': { dir: (home) => path.join(home, '.claude', 'commands'), file: 'browser-bridge.md', style: 'claude' },
  claude: { dir: (home) => path.join(home, '.claude', 'commands'), file: 'browser-bridge.md', style: 'claude' },
  codex: { dir: (home) => path.join(home, '.codex', 'prompts'), file: 'browser-bridge.md', style: 'codex' },
  cursor: { dir: (home) => path.join(home, '.cursor', 'commands'), file: 'browser-bridge.md', style: 'cursor' },
};

/** 返回 { path, style }；该 harness 不支持命令层时返回 null。 */
export function commandTargetFor(harness, home = os.homedir()) {
  const spec = COMMAND_TARGETS[String(harness)];
  if (!spec) return null;
  return { path: path.join(spec.dir(home), spec.file), style: spec.style };
}

/** 生成命令文件内容；skillDir 是已安装技能的绝对目录。 */
export function renderSkillCommand({ harness, skillDir, home = os.homedir() }) {
  const target = commandTargetFor(harness, home);
  if (!target) return null;
  const entry = path.join(skillDir, 'SKILL.md');
  const body = [
    'Load and follow the `browser-bridge` skill before doing anything else.',
    '',
    `Skill entry point: ${entry}`,
    'If it is not loaded yet, read that file and the references it links.',
    '',
    'Then:',
    '1. Check `bridge doctor` if the CLI, daemon, or browser connection looks unhealthy.',
    '2. Follow the skill workflow for the requested task, using the user\'s real browser session.',
    '3. Never print cookies, tokens, credentials, or other secrets.',
    '',
    'Task: $ARGUMENTS',
    '',
    'If $ARGUMENTS is not substituted, use the text after /browser-bridge in the user message.',
  ].join('\n');
  if (target.style === 'claude') {
    return [
      '---',
      'description: Drive the user\'s Edge/Chrome through the BridgeDeck browser-bridge skill',
      'argument-hint: <task>',
      '---',
      '',
      body,
      '',
    ].join('\n');
  }
  return body + '\n';
}
