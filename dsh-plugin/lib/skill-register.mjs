// lib/skill-register.mjs —— 把内嵌技能注册进 DSH 的 skills 服务。
// 独立模块，便于单测时不引入 schemastery/tools 依赖。
import { fileURLToPath } from 'node:url';
import { SKILL_DESCRIPTION, SKILL_MARKDOWN, SKILL_NAME } from './skill-content.generated.mjs';

export function registerBundledSkill(targetCtx) {
  if (!targetCtx || typeof targetCtx.get !== 'function') return () => {};
  let skills = null;
  try {
    skills = targetCtx.get('skills');
  } catch {
    skills = null;
  }
  if (!skills || typeof skills.register !== 'function') return () => {};
  return skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    content: SKILL_MARKDOWN,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: fileURLToPath(new URL('../skill/', import.meta.url)) },
  });
}

/** 技能注册失败不能阻断 browser_* 工具注册。 */
export function safeRegisterBundledSkill(targetCtx) {
  try {
    return registerBundledSkill(targetCtx);
  } catch (error) {
    try {
      if (targetCtx && targetCtx.logger && typeof targetCtx.logger.warn === 'function') {
        targetCtx.logger.warn('BridgeDeck 技能注册失败（工具仍可用）：%s', (error && error.message) || error);
      }
    } catch {
      // 日志失败也忽略
    }
    return () => {};
  }
}
