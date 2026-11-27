// lib/skill-register.mjs —— 把内嵌技能注册进 DSH 的 skills 服务。
// 独立模块，便于单测时不引入 schemastery/tools 依赖。
import { fileURLToPath } from 'node:url';
import {
  SKILL_DESCRIPTION,
  SKILL_EXTRA_REFERENCES,
  SKILL_MARKDOWN,
  SKILL_NAME,
} from './skill-content.generated.mjs';

/** 补充参考在技能正文里的索引标题（生成器输出 SKILL_EXTRA_REFERENCES）。 */
export const EXTRA_REFERENCES_HEADER = '## 插件专属参考（DSH 插件补充）';

/**
 * 组合最终技能正文：仓库主技能正文 + DSH 插件补充参考索引。
 * 索引里的路径相对 resourceBase（dsh-plugin/skill/），DSH 按需读取时直接可用。
 */
export function composeSkillContent() {
  const body = String(SKILL_MARKDOWN || '').trimEnd();
  if (!Array.isArray(SKILL_EXTRA_REFERENCES) || !SKILL_EXTRA_REFERENCES.length) return body + '\n';
  const lines = [
    body,
    '',
    EXTRA_REFERENCES_HEADER,
    '',
    '除上面的通用技能外，DSH 插件还附带以下补充参考（按需读取）：',
    '',
  ];
  for (const reference of SKILL_EXTRA_REFERENCES) {
    lines.push('- [' + reference.title + '](' + reference.path + ') — ' + reference.summary);
  }
  lines.push('');
  return lines.join('\n');
}

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
    content: composeSkillContent(),
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
