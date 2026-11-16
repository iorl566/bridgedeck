import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { commandTargetFor, renderSkillCommand } from '../../lib/skill-commands.mjs';

const home = path.join(os.tmpdir(), 'bb-home');
const skillDir = path.join(home, '.claude', 'skills', 'browser-bridge');

test('Claude/Codex/Cursor 的命令路径', () => {
  assert.equal(commandTargetFor('claude-code', home).path, path.join(home, '.claude', 'commands', 'browser-bridge.md'));
  assert.equal(commandTargetFor('codex', home).path, path.join(home, '.codex', 'prompts', 'browser-bridge.md'));
  assert.equal(commandTargetFor('cursor', home).path, path.join(home, '.cursor', 'commands', 'browser-bridge.md'));
  assert.equal(commandTargetFor('qoder', home), null);
  assert.equal(commandTargetFor('dir', home), null);
});

test('命令正文指向技能入口并保留 $ARGUMENTS', () => {
  for (const harness of ['claude-code', 'codex', 'cursor']) {
    const text = renderSkillCommand({ harness, skillDir, home });
    assert.ok(text.includes(path.join(skillDir, 'SKILL.md')));
    assert.ok(text.includes('$ARGUMENTS'));
    assert.ok(text.includes('bridge doctor'));
  }
});

test('Claude 命令带 frontmatter，Codex/Cursor 保持纯正文', () => {
  const claude = renderSkillCommand({ harness: 'claude-code', skillDir, home });
  assert.ok(claude.startsWith('---\n'));
  assert.ok(claude.includes('argument-hint'));
  const codex = renderSkillCommand({ harness: 'codex', skillDir, home });
  assert.equal(codex.startsWith('---'), false);
});
