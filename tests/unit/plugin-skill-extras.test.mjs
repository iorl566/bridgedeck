// 插件补充技能参考：真实内容、生成物同步、resourceBase 可读、组合后的技能正文。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_EXTRA_REFERENCES, SKILL_MARKDOWN, SKILL_NAME } from '../../dsh-plugin/lib/skill-content.generated.mjs';
import { buildSkillContent, checkSkillContent, readSkillExtras } from '../../dsh-plugin/scripts/build-skill-content.mjs';
import { composeSkillContent, EXTRA_REFERENCES_HEADER, registerBundledSkill } from '../../dsh-plugin/lib/skill-register.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PLUGIN = path.join(ROOT, 'dsh-plugin');
const EXTRAS = path.join(PLUGIN, 'skill-extras', 'references');
const EXPECTED = ['actions-guide.md', 'evaluation.md', 'offline-testing.md', 'transactions.md'];

test('补充参考共 4 篇，均有标题与摘要，且内容充实', () => {
  assert.deepEqual(fs.readdirSync(EXTRAS).filter((name) => name.endsWith('.md')).sort(), EXPECTED);
  const extras = readSkillExtras();
  assert.equal(extras.length, 4);
  for (const extra of extras) {
    assert.ok(extra.path.startsWith('references/'));
    assert.ok(extra.title.length >= 4, extra.path + ' 标题过短');
    assert.ok(extra.summary.length >= 15, extra.path + ' 摘要过短');
    const text = fs.readFileSync(path.join(EXTRAS, path.basename(extra.path)), 'utf8');
    assert.ok(text.length > 2000, extra.path + ' 内容过短（疑似占位）');
    assert.ok((text.match(/^## /gm) || []).length >= 3, extra.path + ' 至少需要 3 个小节');
    assert.ok(text.includes('browser_'), extra.path + ' 应引用真实工具名');
    assert.ok(!/\bTODO\b|\bTBD\b/.test(text), extra.path + ' 不应留 TODO');
  }
  const titles = extras.map((extra) => extra.title);
  assert.equal(new Set(titles).size, titles.length, '补充参考标题重复');
});

test('生成物 SKILL_EXTRA_REFERENCES 与 skill-extras 源一致', () => {
  assert.deepEqual(SKILL_EXTRA_REFERENCES, readSkillExtras());
  for (const reference of SKILL_EXTRA_REFERENCES) {
    const generated = path.join(PLUGIN, 'skill', reference.path);
    const source = path.join(EXTRAS, path.basename(reference.path));
    assert.ok(fs.existsSync(generated), '生成目录缺少补充参考：' + reference.path);
    assert.ok(fs.readFileSync(generated).equals(fs.readFileSync(source)), '补充参考未同步：' + reference.path);
  }
});

test('生成器 --check 通过且可重跑（写出后再次校验仍 clean）', () => {
  const check = checkSkillContent();
  assert.deepEqual(check.problems, []);
  assert.equal(check.stats.name, SKILL_NAME);
  assert.equal(check.stats.extras, 4);
  assert.equal(check.stats.references, 18, '仓库 references（14）+ 插件补充（4）');
  const before = fs.readFileSync(path.join(PLUGIN, 'lib', 'skill-content.generated.mjs'), 'utf8');
  const rebuilt = buildSkillContent({ check: false });
  assert.deepEqual(rebuilt.problems, []);
  const after = fs.readFileSync(path.join(PLUGIN, 'lib', 'skill-content.generated.mjs'), 'utf8');
  assert.equal(after, before, '生成器重跑应幂等');
  assert.deepEqual(checkSkillContent().problems, []);
});

test('组合技能正文：主正文 + 补充参考索引（路径相对 resourceBase）', () => {
  const content = composeSkillContent();
  assert.ok(content.startsWith(SKILL_MARKDOWN.trimEnd()), '主技能正文应在前');
  assert.ok(content.includes(EXTRA_REFERENCES_HEADER));
  for (const reference of SKILL_EXTRA_REFERENCES) {
    assert.ok(content.includes('(' + reference.path + ')'), '索引缺少路径：' + reference.path);
    assert.ok(content.includes(reference.title), '索引缺少标题：' + reference.title);
    assert.ok(content.includes(reference.summary), '索引缺少摘要：' + reference.title);
  }
  // 索引路径必须能在 resourceBase 下解析（DSH 按需读取）。
  const base = path.join(PLUGIN, 'skill');
  for (const reference of SKILL_EXTRA_REFERENCES) assert.ok(fs.existsSync(path.join(base, reference.path)));
});

test('技能注册使用组合正文，resourceBase 指向生成后的 skill 目录', () => {
  const registered = [];
  const ctx = {
    get(name) {
      if (name !== 'skills') return null;
      return { register(skill) { registered.push(skill); return () => {}; } };
    },
  };
  registerBundledSkill(ctx);
  assert.equal(registered.length, 1);
  const skill = registered[0];
  assert.equal(skill.content, composeSkillContent());
  assert.ok(skill.content.includes(EXTRA_REFERENCES_HEADER));
  assert.equal(skill.resourceBase.kind, 'directory');
  for (const reference of SKILL_EXTRA_REFERENCES) {
    assert.ok(fs.existsSync(path.join(skill.resourceBase.path, reference.path)));
  }
});

test('生成器拒绝缺少摘要的补充参考（防止空资源混入）', () => {
  const tempDir = fs.mkdtempSync(path.join(PLUGIN, '.tmp-extras-'));
  try {
    fs.mkdirSync(path.join(tempDir, 'references'));
    fs.writeFileSync(path.join(tempDir, 'references', 'bad.md'), '# 标题\n\n没有摘要行。\n', 'utf8');
    assert.throws(() => readSkillExtras(tempDir), /缺少“> 摘要：”行/);
    fs.writeFileSync(path.join(tempDir, 'references', 'bad.md'), '# 标题\n\n> 摘要：有摘要且足够长的说明文字。\n', 'utf8');
    const parsed = readSkillExtras(tempDir);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].title, '标题');
    assert.match(parsed[0].summary, /有摘要/);
    assert.throws(() => readSkillExtras(path.join(tempDir, 'missing')), /缺少补充参考目录/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
