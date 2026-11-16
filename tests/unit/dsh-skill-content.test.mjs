import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_DESCRIPTION, SKILL_MARKDOWN, SKILL_NAME } from '../../dsh-plugin/lib/skill-content.generated.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');
const source = fs.readFileSync(path.join(root, 'skill', 'SKILL.md'), 'utf8');
const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
const front = match[1];
const body = source.slice(match[0].length);
const name = (front.match(/^name:\s*(.+)$/m) || [])[1].trim();

test('DSH 插件内嵌技能与仓库 skill/SKILL.md 同步', () => {
  assert.equal(SKILL_NAME, name);
  assert.equal(SKILL_MARKDOWN, body);
  assert.ok(SKILL_DESCRIPTION.length > 0);
  assert.ok(fs.existsSync(path.join(root, 'dsh-plugin', 'skill', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(root, 'dsh-plugin', 'skill', 'references', 'environment.md')));
});

test('插件包包含 skill 目录（resourceBase 可解析）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'dsh-plugin', 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('skill'));
});
