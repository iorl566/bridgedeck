import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerBundledSkill, safeRegisterBundledSkill } from '../../dsh-plugin/lib/skill-register.mjs';

function fakeContext() {
  const skills = [];
  const effects = [];
  const ctx = {
    get(name) {
      if (name === 'skills') return { register(skill) { skills.push(skill); return () => {}; } };
      return null;
    },
    effect(fn, label) {
      const dispose = fn();
      effects.push({ label, dispose });
      return dispose;
    },
    on() { return () => {}; },
    tools: { register() { return () => {}; } },
    logger: { warn() {}, info() {} },
  };
  return { ctx, skills, effects };
}

test('DSH 插件注册内嵌 browser-bridge 技能（不依赖 CLI）', () => {
  const { ctx, skills } = fakeContext();
  registerBundledSkill(ctx);
  assert.equal(skills.length, 1);
  const skill = skills[0];
  assert.equal(skill.name, 'browser-bridge');
  assert.ok(skill.description.length > 0);
  assert.ok(skill.content.includes('# browser-bridge'));
  assert.equal(skill.source, 'bundled');
  assert.equal(skill.resourceBase.kind, 'directory');
  assert.ok(fs.existsSync(skill.resourceBase.path));
  assert.ok(fs.existsSync(`${skill.resourceBase.path}/SKILL.md`));
});

test('技能注册失败不会抛出，只记录警告', () => {
  const warnings = [];
  const ctx = {
    get(name) {
      if (name === 'skills') return { register() { throw new Error('duplicate skill'); } };
      return null;
    },
    logger: { warn(message, value) { warnings.push(String(message) + ' ' + String(value)); } },
  };
  const dispose = safeRegisterBundledSkill(ctx);
  assert.equal(typeof dispose, 'function');
  dispose();
  assert.equal(warnings.length, 1);
});
