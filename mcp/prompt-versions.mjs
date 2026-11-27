// mcp/prompt-versions.mjs —— MCP prompts 的版本化（语义版本 / 结构指纹 / 协商 / 差量分类）。
//
// 目标（第十一批-C ②：prompts 版本化 / 参数补全）：
//   prompts 是客户端会缓存、会拼进系统提示的“协议面文本”。一旦模板内容或参数声明变了，
//   客户端缓存的旧 prompt 就会与实际渲染不一致。此前 prompts/list 只有 name/title/description，
//   客户端没有任何“这份 prompt 是不是我上次看到的版本”的依据。本模块补上：
//     1. 每个 prompt 一个 semver 版本 + 人类可读 changelog（单一登记表 PROMPT_VERSION_HISTORY）；
//     2. 结构指纹 fingerprint：由「声明（参数名/必填/枚举/资源/标签）+ 样例渲染文本」派生，
//        版本号相同但指纹变了 = 有人在未升版本的情况下改了 prompt（硬审计直接失败）；
//     3. 协商：prompts/get 可带 version（additive 扩展）；不支持的老版本不假装支持，
//        回退到当前版本并在 _meta 里显式标 fallback/reason；
//     4. 差量分类：diffPromptSignatures 把两个签名快照的差异分成 breaking / additive / patch，
//        并校验“版本号跳变与差量分类一致”（breaking 必须 major，additive 只能 minor/major）。
//
// 设计约束：
//   1. 纯函数、无 IO：签名由当前 PROMPT_DEFINITIONS 派生，不读盘、不访问 daemon；
//   2. 默认行为不变：不带 version 时按当前版本渲染，与历史 prompts/get 输出一致（只新增 _meta）；
//   3. 不伪造历史：只有登记在 PROMPT_VERSION_HISTORY 里的版本才算“存在”；服务端永远渲染当前
//      定义，因此请求老版本时如实标记 fallback（而不是返回一个假的旧渲染）；
//   4. 指纹稳定：样例参数取 sampleArguments()（枚举取首值），渲染结果参与哈希，避免“声明没变
//      但模板文本变了”被漏检。
//
// 调用点（真实消费）：
//   - mcp/server.mjs：prompts/list 每个声明的 _meta['browser-bridge/prompt'].version；
//     prompts/get 的版本协商 _meta['browser-bridge/prompt'].version；
//     initialize experimental['browser-bridge/prompt-versions']；启动期 assertPromptVersions()；
//   - 单测 tests/unit/mcp-prompt-versions.test.mjs。

import { createHash } from 'node:crypto';
import { PROMPT_DEFINITIONS, promptDefinition, sampleArguments } from './prompts.mjs';

/** 语义版本格式（MCP 扩展字段，非标准；只接受严格的 x.y.z）。 */
export const PROMPT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/** prompt 稳定性（客户端可据此决定是否缓存/是否在产品里暴露）。 */
export const PROMPT_STABILITY = Object.freeze({
  STABLE: 'stable',
  EXPERIMENTAL: 'experimental',
  DEPRECATED: 'deprecated',
});

/** 版本变更分级。 */
export const PROMPT_VERSION_BUMPS = Object.freeze({
  MAJOR: 'major',
  MINOR: 'minor',
  PATCH: 'patch',
  NONE: 'none',
});

/** 版本协商原因码（_meta 里给客户端看，便于诊断“为什么不是我要的版本”）。 */
export const PROMPT_VERSION_REASONS = Object.freeze({
  LATEST: 'latest',
  EXACT: 'exact',
  INVALID: 'invalid-version',
  NOT_SERVED: 'version-not-served',
  FUTURE: 'future-version',
  MAJOR: 'major-mismatch',
  UNKNOWN_PROMPT: 'unknown-prompt',
});

/** 携带 version 的 MCP 方法参数名（additive：老客户端不传即最新）。 */
export const PROMPT_VERSION_PARAM = 'version';

/**
 * prompt 版本登记表（单一来源）。
 *
 * 约定：
 *   - 每个 prompt 必须有一条历史记录，且最后一条的 version 就是当前服务端版本；
 *   - 修改 prompts.mjs 里的声明或渲染文本 → 必须新增一条历史（升版本）并更新指纹，
 *     否则 auditPromptVersions() 会以 prompt-version-fingerprint 失败（server 启动即挂）；
 *   - 指纹由 promptFingerprint() 计算（见文件头注释），不要手写。
 *
 * 说明：这些 prompt 在第十一批-C 之前没有版本号；本次为既有内容建立 1.0.0 基线，
 * 指纹取“登记当时”的实际声明 + 渲染文本，因此历史是真实的（不是编造的变更记录）。
 */
export const PROMPT_VERSION_HISTORY = Object.freeze({
  browser_task_brief: Object.freeze([
    Object.freeze({
      version: '1.0.0',
      date: '2026-11-26',
      stability: PROMPT_STABILITY.STABLE,
      changes: Object.freeze(['建立版本基线：任务简报模板（task/url/constraints）+ 显式 tier/审批/资源提示']),
      fingerprint: '9050402a4190691fd649a91f501d1423ef052dd879fe04184cd48ed7d88b4da7',
    }),
  ]),
  debug_investigation: Object.freeze([
    Object.freeze({
      version: '1.0.0',
      date: '2026-11-26',
      stability: PROMPT_STABILITY.STABLE,
      changes: Object.freeze(['建立版本基线：调试调查流程（debug_start → analyze → evidence → HAR/journal）']),
      fingerprint: '50fd37b16e9faab4daa04d42ee8ea6b19b45dde3832d278e3b9c4385234a9936',
    }),
  ]),
  cooperation_handoff: Object.freeze([
    Object.freeze({
      version: '1.0.0',
      date: '2026-11-26',
      stability: PROMPT_STABILITY.STABLE,
      changes: Object.freeze(['建立版本基线：人工接管/交还的交接流程（brief → cooperate_sync → 继续）']),
      fingerprint: 'ce8e70b932d7c5b5e43fbc2f840317f8c0fe28ac8c57c279e7fe10217d81073b',
    }),
  ]),
  recipe_from_session: Object.freeze([
    Object.freeze({
      version: '1.0.0',
      date: '2026-11-26',
      stability: PROMPT_STABILITY.STABLE,
      changes: Object.freeze(['建立版本基线：record → recipe draft/save → approve/run 的配方沉淀流程']),
      fingerprint: '0587d5e159365015fefa3e427b0960da23ba14bac34de6fe51d725fe83ef5618',
    }),
  ]),
  page_action_plan: Object.freeze([
    Object.freeze({
      version: '1.0.0',
      date: '2026-11-26',
      stability: PROMPT_STABILITY.STABLE,
      changes: Object.freeze(['建立版本基线：页面动作计划（步骤 → ref → 断言，destructive 单独确认）']),
      fingerprint: 'ea3bbeca6f8c48c2d462f7cf17c6f0a2b38fabb3f0405762c0cd6a57d24b8c66',
    }),
  ]),
  har_analysis: Object.freeze([
    Object.freeze({
      version: '1.0.0',
      date: '2026-11-26',
      stability: PROMPT_STABILITY.STABLE,
      changes: Object.freeze(['建立版本基线：HAR 1.2 分析（timings/errors/payloads/replay 枚举）']),
      fingerprint: '0c25a41174f97c4a4934c0e38afc45f063350aa3c3b52b01350936357493d06a',
    }),
  ]),
  network_diagnosis: Object.freeze([
    Object.freeze({
      version: '1.0.0',
      date: '2026-11-26',
      stability: PROMPT_STABILITY.STABLE,
      changes: Object.freeze(['建立版本基线：网络诊断分层（dns/tls/http/websocket/cache 枚举 + 证据闭环）']),
      fingerprint: 'abb47199659f3daafd75e48b0a14ab7d34b98e5efa8c9439ef73da6b7ec8c977',
    }),
  ]),
  longshot_recovery: Object.freeze([
    Object.freeze({
      version: '1.0.0',
      date: '2026-11-26',
      stability: PROMPT_STABILITY.STABLE,
      changes: Object.freeze(['建立版本基线：长截图四类失败形态恢复（stale/gap/crash/dpi-budget）']),
      fingerprint: 'aa4243500c8ab0544048eb999615defbc58428841194bbda451cc1abdc125108',
    }),
  ]),
  video_verify: Object.freeze([
    Object.freeze({
      version: '1.0.0',
      date: '2026-11-26',
      stability: PROMPT_STABILITY.STABLE,
      changes: Object.freeze(['建立版本基线：视频校验（duration/frames/sidx/all 枚举 + 修复路径）']),
      fingerprint: '72fdcad320d586920e3c20fd99f176c5d04e1dcf231477c9c9a79514fef0908f',
    }),
  ]),
});

/** 带 code 的 prompt 版本错误（server 一般不需要抛；保留给严格模式/测试）。 */
export class PromptVersionError extends Error {
  constructor(code, message) {
    super(String(message));
    this.name = 'PromptVersionError';
    this.code = code;
  }
}

function compareVersions(a, b) {
  const left = String(a).split('.').map((part) => Number(part) || 0);
  const right = String(b).split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function isHistoryEntry(entry) {
  return Boolean(entry) && typeof entry === 'object' && typeof entry.version === 'string' && PROMPT_VERSION_PATTERN.test(entry.version);
}

/**
 * prompt 的结构签名（可比较、可序列化；不含渲染函数本身）。
 * @param {object} prompt PROMPT_DEFINITIONS 的一项
 */
export function promptSignature(prompt) {
  if (!prompt || typeof prompt !== 'object') return null;
  return Object.freeze({
    name: String(prompt.name),
    arguments: Object.freeze((prompt.arguments || []).map((argument) => Object.freeze({
      name: String(argument.name),
      required: argument.required === true,
      enum: Array.isArray(argument.enum) ? Object.freeze([...argument.enum]) : null,
    }))),
    resources: Object.freeze([...(prompt.resources || [])]),
    tags: Object.freeze([...(prompt.tags || [])]),
  });
}

/**
 * prompt 指纹：sha256(声明规范化 JSON + 样例渲染文本)。
 * 声明变化或模板文本变化都会改变指纹；指纹与版本号登记表对不上时 auditPromptVersions 报错。
 * @param {object} prompt PROMPT_DEFINITIONS 的一项
 * @returns {string|null}
 */
export function promptFingerprint(prompt) {
  if (!prompt || typeof prompt !== 'object') return null;
  const canonical = {
    name: prompt.name,
    arguments: (prompt.arguments || []).map((argument) => ({
      name: argument.name,
      required: argument.required,
      enum: Array.isArray(argument.enum) ? [...argument.enum] : null,
    })),
    resources: [...(prompt.resources || [])],
    tags: [...(prompt.tags || [])],
    render: typeof prompt.render === 'function' ? prompt.render(sampleArguments(prompt)) : '',
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function latestHistory(history) {
  const list = Array.isArray(history) ? history.filter(isHistoryEntry) : [];
  if (!list.length) return null;
  return [...list].sort((a, b) => compareVersions(a.version, b.version))[list.length - 1];
}

/**
 * 单 prompt 的版本视图。
 * @returns null | { name:string, version:string, date:string, stability:string,
 *                   deprecated:boolean, changelog:ReadonlyArray<object>,
 *                   fingerprint:string, declaredFingerprint:(string|null), versionCount:number,
 *                   signature:object }
 */
export function promptVersionOf(name, prompts = PROMPT_DEFINITIONS) {
  const key = String(name || '');
  const prompt = (prompts || []).find((item) => item && item.name === key);
  if (!prompt) return null;
  const history = PROMPT_VERSION_HISTORY[key];
  const latest = latestHistory(history);
  if (!latest) return null;
  const fingerprint = promptFingerprint(prompt);
  const stability = latest.stability && Object.values(PROMPT_STABILITY).includes(latest.stability)
    ? latest.stability
    : PROMPT_STABILITY.STABLE;
  return Object.freeze({
    name: key,
    version: latest.version,
    date: latest.date,
    stability,
    deprecated: stability === PROMPT_STABILITY.DEPRECATED,
    changelog: Object.freeze((history || []).map((entry) => Object.freeze({
      version: entry.version,
      date: entry.date,
      changes: Object.freeze([...(entry.changes || [])]),
      stability: entry.stability || PROMPT_STABILITY.STABLE,
    })).sort((a, b) => compareVersions(b.version, a.version))),
    fingerprint,
    declaredFingerprint: typeof latest.fingerprint === 'string' ? latest.fingerprint : null,
    versionCount: Array.isArray(history) ? history.length : 0,
    signature: promptSignature(prompt),
  });
}

/** 全部 prompt 的版本表（顺序与 PROMPT_DEFINITIONS 一致）。 */
export function promptVersionTable(prompts = PROMPT_DEFINITIONS) {
  return (prompts || []).map((prompt) => promptVersionOf(prompt && prompt.name, prompts)).filter(Boolean);
}

/** 某个 prompt 是否存在指定版本（只有登记表里出现过才算）。 */
export function promptVersionExists(name, version) {
  const history = PROMPT_VERSION_HISTORY[String(name || '')];
  if (!Array.isArray(history)) return false;
  return history.some((entry) => isHistoryEntry(entry) && entry.version === String(version));
}

/**
 * 版本协商：prompts/get 的 version 参数（additive）→ 该prompt的版本决定。
 *
 * 规则（诚实优先，绝不假装支持未登记版本）：
 *   - 不传 / 空 / 'latest' → 当前版本，exact=true；
 *   - 严格等于当前版本 → exact=true；
 *   - 格式非法 → fallback=true，reason=invalid-version（不抛错，避免老客户端拼错就完全不可用）；
 *   - 登记过但不是当前（旧版本）→ 服务端只保留当前渲染函数，fallback=true，reason=version-not-served；
 *   - 未来版本 / major 不一致 → fallback=true（客户端应视为降级，决定是否接受）。
 *
 * @returns {{ name:string, requested:(string|null), current:string, version:string,
 *             exact:boolean, fallback:boolean, compatible:boolean, reason:string,
 *             availableVersions:ReadonlyArray<string>, deprecated:boolean }}
 */
export function resolvePromptVersion(name, requested, prompts = PROMPT_DEFINITIONS) {
  const entry = promptVersionOf(name, prompts);
  if (!entry) {
    throw new PromptVersionError('E_NOT_FOUND', '未知 prompt：' + name);
  }
  const current = entry.version;
  const raw = requested == null ? '' : String(requested).trim();
  const available = Object.freeze(entry.changelog.map((item) => item.version));
  const base = { name: entry.name, current, availableVersions: available, deprecated: entry.deprecated };
  if (!raw || raw.toLowerCase() === 'latest') {
    return Object.freeze({ ...base, requested: raw || null, version: current, exact: true, fallback: false, compatible: true, reason: PROMPT_VERSION_REASONS.LATEST });
  }
  if (!PROMPT_VERSION_PATTERN.test(raw)) {
    return Object.freeze({ ...base, requested: raw, version: current, exact: false, fallback: true, compatible: false, reason: PROMPT_VERSION_REASONS.INVALID });
  }
  if (raw === current) {
    return Object.freeze({ ...base, requested: raw, version: current, exact: true, fallback: false, compatible: true, reason: PROMPT_VERSION_REASONS.EXACT });
  }
  const sameMajor = raw.split('.')[0] === current.split('.')[0];
  if (promptVersionExists(entry.name, raw)) {
    return Object.freeze({ ...base, requested: raw, version: current, exact: false, fallback: true, compatible: sameMajor, reason: PROMPT_VERSION_REASONS.NOT_SERVED });
  }
  const greater = compareVersions(raw, current) > 0;
  // 语义优先看 major：跨 major 的请求一律标 major-mismatch（比“未来版本”更精确）；
  // 同 major 内：更新版本 → future-version，更旧版本 → version-not-served。
  return Object.freeze({
    ...base,
    requested: raw,
    version: current,
    exact: false,
    fallback: true,
    compatible: false,
    reason: !sameMajor ? PROMPT_VERSION_REASONS.MAJOR : (greater ? PROMPT_VERSION_REASONS.FUTURE : PROMPT_VERSION_REASONS.NOT_SERVED),
  });
}

/**
 * 两个签名快照的差量分类（breaking / additive / identical）。
 * 这是“版本号该跳哪一位”的判据，不依赖历史是否完整，因此可对任意快照做 CI 检查。
 *
 * breaking：删参数、新增必填参数、枚举收窄（旧值可能失效）、prompt 改名、删资源提示；
 * additive：新增可选参数、枚举放宽、新增资源/标签；
 * identical：上述都没有。
 *
 * @param {object} from promptSignature 快照
 * @param {object} to promptSignature 快照
 * @returns {{ classification:'identical'|'additive'|'breaking', breaking:boolean, additive:boolean,
 *             changes:object, summary:ReadonlyArray<string> }}
 */
export function diffPromptSignatures(from, to) {
  const before = from && typeof from === 'object' ? from : {};
  const after = to && typeof to === 'object' ? to : {};
  const beforeArgs = new Map((before.arguments || []).map((argument) => [argument.name, argument]));
  const afterArgs = new Map((after.arguments || []).map((argument) => [argument.name, argument]));
  const addedArguments = [];
  const removedArguments = [];
  const requiredAdded = [];
  const requiredChanged = [];
  const enumChanges = [];
  for (const [name, argument] of afterArgs) {
    if (!beforeArgs.has(name)) {
      addedArguments.push(name);
      if (argument.required) requiredAdded.push(name);
    }
  }
  for (const [name, argument] of beforeArgs) {
    if (!afterArgs.has(name)) {
      removedArguments.push(name);
      continue;
    }
    const next = afterArgs.get(name);
    if (argument.required !== next.required) requiredChanged.push(Object.freeze({ name, from: argument.required, to: next.required }));
    const oldEnum = Array.isArray(argument.enum) ? argument.enum : null;
    const newEnum = Array.isArray(next.enum) ? next.enum : null;
    if (JSON.stringify(oldEnum) !== JSON.stringify(newEnum)) {
      const oldSet = new Set(oldEnum || []);
      const newSet = new Set(newEnum || []);
      enumChanges.push(Object.freeze({
        name,
        added: [...newSet].filter((value) => !oldSet.has(value)),
        removed: [...oldSet].filter((value) => !newSet.has(value)),
        narrowed: Boolean(oldEnum) && Boolean(newEnum) && [...newSet].some((value) => !oldSet.has(value)) === false && newSet.size < oldSet.size,
        widened: Boolean(oldEnum) && Boolean(newEnum) && newSet.size > oldSet.size && [...oldSet].every((value) => newSet.has(value)),
      }));
    }
  }
  const beforeResources = new Set(before.resources || []);
  const afterResources = new Set(after.resources || []);
  const resourcesAdded = [...afterResources].filter((uri) => !beforeResources.has(uri));
  const resourcesRemoved = [...beforeResources].filter((uri) => !afterResources.has(uri));
  const beforeTags = new Set(before.tags || []);
  const afterTags = new Set(after.tags || []);
  const tagsAdded = [...afterTags].filter((tag) => !beforeTags.has(tag));
  const tagsRemoved = [...beforeTags].filter((tag) => !afterTags.has(tag));
  const nameChanged = Boolean(before.name) && Boolean(after.name) && before.name !== after.name;

  const breaking = removedArguments.length > 0 || requiredAdded.length > 0
    || nameChanged || resourcesRemoved.length > 0
    || enumChanges.some((change) => change.removed.length > 0)
    || requiredChanged.some((change) => change.from === false && change.to === true);
  const additive = !breaking && (
    addedArguments.length > 0 || resourcesAdded.length > 0 || tagsAdded.length > 0
    || enumChanges.some((change) => change.added.length > 0)
    || requiredChanged.some((change) => change.from === true && change.to === false)
  );
  const summary = [];
  if (nameChanged) summary.push('改名为 ' + after.name);
  if (addedArguments.length) summary.push('新增参数 ' + addedArguments.join(','));
  if (removedArguments.length) summary.push('删除参数 ' + removedArguments.join(','));
  if (requiredAdded.length) summary.push('新增必填参数 ' + requiredAdded.join(','));
  if (enumChanges.length) summary.push('枚举变化 ' + enumChanges.map((change) => change.name).join(','));
  if (resourcesAdded.length) summary.push('新增资源提示 ' + resourcesAdded.length + ' 条');
  if (resourcesRemoved.length) summary.push('删除资源提示 ' + resourcesRemoved.length + ' 条');
  if (tagsAdded.length || tagsRemoved.length) summary.push('标签变化 +' + tagsAdded.length + '/-' + tagsRemoved.length);
  return Object.freeze({
    classification: breaking ? 'breaking' : (additive ? 'additive' : 'identical'),
    breaking,
    additive,
    changes: Object.freeze({
      addedArguments: Object.freeze(addedArguments),
      removedArguments: Object.freeze(removedArguments),
      requiredAdded: Object.freeze(requiredAdded),
      requiredChanged: Object.freeze(requiredChanged),
      enumChanges: Object.freeze(enumChanges),
      resourcesAdded: Object.freeze(resourcesAdded),
      resourcesRemoved: Object.freeze(resourcesRemoved),
      tagsAdded: Object.freeze(tagsAdded),
      tagsRemoved: Object.freeze(tagsRemoved),
      nameChanged,
    }),
    summary: Object.freeze(summary),
  });
}

/** 差量 → 应该跳的版本位（breaking→major，additive→minor，identical→none/patch）。 */
export function classifyVersionBump(fromSignature, toSignature) {
  const diff = diffPromptSignatures(fromSignature, toSignature);
  if (diff.breaking) return PROMPT_VERSION_BUMPS.MAJOR;
  if (diff.additive) return PROMPT_VERSION_BUMPS.MINOR;
  if (diff.classification === 'identical') return PROMPT_VERSION_BUMPS.NONE;
  return PROMPT_VERSION_BUMPS.PATCH;
}

/** 版本号跳变是否与差量分类一致（审计用）。 */
export function versionBumpMatches(fromVersion, toVersion, bump) {
  const left = String(fromVersion).split('.').map(Number);
  const right = String(toVersion).split('.').map(Number);
  if (!left.length || !right.length) return false;
  const majorChanged = right[0] !== left[0];
  const minorChanged = right[1] !== left[1];
  if (bump === PROMPT_VERSION_BUMPS.MAJOR) return majorChanged && right[0] > left[0];
  if (bump === PROMPT_VERSION_BUMPS.MINOR) return !majorChanged && minorChanged && right[1] > left[1];
  if (bump === PROMPT_VERSION_BUMPS.PATCH) return !majorChanged && !minorChanged;
  return !majorChanged && !minorChanged;
}

/**
 * prompts/get / prompts/list 的版本元数据（server 组装 _meta 用）。
 * @param {string} name
 * @param {{requestedVersion?:string|null, prompts?:Array<object>}} [options]
 */
export function promptVersionMeta(name, { requestedVersion = null, prompts = PROMPT_DEFINITIONS } = {}) {
  const entry = promptVersionOf(name, prompts);
  if (!entry) return null;
  const negotiation = resolvePromptVersion(name, requestedVersion, prompts);
  return Object.freeze({
    version: entry.version,
    fingerprint: entry.fingerprint,
    stability: entry.stability,
    deprecated: entry.deprecated,
    requested: negotiation.requested,
    exact: negotiation.exact,
    fallback: negotiation.fallback,
    reason: negotiation.reason,
    availableVersions: negotiation.availableVersions,
    changelog: entry.changelog,
  });
}

/**
 * prompt 版本审计（server 启动期 assertPromptVersions 与单测共用）。
 * 硬规则：
 *   - 每个 prompt 都有登记且版本格式合法；
 *   - 同 prompt 内版本不重复且按语义降序登记（数组内不要求顺序，这里检查排序后的连续性）；
 *   - 最后（最高）版本必须等于服务端当前渲染的版本视图；
 *   - 最新登记指纹必须与当前声明+渲染文本一致（未升版本改 prompt 会被抓出来）；
 *   - changelog 每条至少一句说明；
 *   - 相邻版本若带 signature 快照，则版本跳变必须与差量分类一致；
 *   - 登记表里不能有已不存在 prompt 的“孤儿版本”。
 * @returns {{ ok:boolean, errors:Array<{code:string,prompt:string,message:string}>, stats:object }}
 */
export function auditPromptVersions({ prompts = PROMPT_DEFINITIONS, history = PROMPT_VERSION_HISTORY } = {}) {
  const errors = [];
  const push = (code, prompt, message) => errors.push(Object.freeze({ code, prompt: String(prompt || '<none>'), message }));
  const definitions = Array.isArray(prompts) ? prompts : [];
  if (!definitions.length) push('prompt-version-empty', '<none>', '没有可审计的 prompt');
  const known = new Set(definitions.map((prompt) => prompt && prompt.name));
  let versions = 0;
  let withEnums = 0;
  for (const prompt of definitions) {
    const name = prompt && prompt.name;
    const entries = Array.isArray(history && history[name]) ? history[name] : null;
    if (!entries || !entries.length) {
      push('prompt-version-missing', name, 'prompt 没有版本登记');
      continue;
    }
    const seen = new Set();
    let previousVersion = null;
    for (const entry of entries) {
      versions += 1;
      if (!isHistoryEntry(entry)) {
        push('prompt-version-format', name, '版本号格式必须是 x.y.z：' + JSON.stringify(entry && entry.version));
        continue;
      }
      if (seen.has(entry.version)) push('prompt-version-duplicate', name, '版本号重复：' + entry.version);
      seen.add(entry.version);
      if (!Array.isArray(entry.changes) || entry.changes.length === 0 || entry.changes.some((text) => typeof text !== 'string' || !text.trim())) {
        push('prompt-version-changelog', name, '版本 ' + entry.version + ' 缺可读 changelog');
      }
      if (typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
        push('prompt-version-date', name, '版本 ' + entry.version + ' 的 date 必须是 YYYY-MM-DD');
      }
      if (previousVersion && compareVersions(entry.version, previousVersion) <= 0) {
        push('prompt-version-order', name, '版本必须递增：' + previousVersion + ' → ' + entry.version);
      }
      previousVersion = entry.version;
      isHistoryEntry(entry) && (prompt.arguments || []).some((argument) => Array.isArray(argument.enum)) && (withEnums += 1);
    }
    const view = promptVersionOf(name, definitions);
    if (!view) {
      push('prompt-version-missing', name, '无法派生版本视图');
      continue;
    }
    if (!PROMPT_VERSION_PATTERN.test(view.version)) push('prompt-version-format', name, '当前版本格式非法：' + view.version);
    if (view.declaredFingerprint && view.declaredFingerprint !== view.fingerprint) {
      push('prompt-version-fingerprint', name,
        'prompt 声明/渲染文本已变化但版本仍为 ' + view.version + '（登记指纹 ' + view.declaredFingerprint.slice(0, 12) + '…，当前 ' + view.fingerprint.slice(0, 12) + '…）；请升版本并更新指纹');
    }
    if (view.stability === PROMPT_STABILITY.DEPRECATED && view.versionCount < 2) {
      push('prompt-version-deprecated', name, 'deprecated prompt 至少需要一个历史版本');
    }
    // 相邻版本带签名快照时，版本跳变必须与差量分类一致（breaking 必须 major）。
    for (let index = 1; index < (Array.isArray(entries) ? entries.length : 0); index += 1) {
      const previous = entries[index - 1];
      const next = entries[index];
      if (!previous || !next || !previous.signature || !next.signature) continue;
      const bump = classifyVersionBump(previous.signature, next.signature);
      if (!versionBumpMatches(previous.version, next.version, bump)) {
        push('prompt-version-bump', name, '版本 ' + previous.version + ' → ' + next.version + ' 与差量分类 ' + bump + ' 不一致');
      }
    }
  }
  for (const name of Object.keys(history || {})) {
    if (!known.has(name)) push('prompt-version-orphan', name, '登记表里有不存在的 prompt');
  }
  const table = promptVersionTable(definitions);
  const stats = Object.freeze({
    prompts: table.length,
    versions,
    withEnums,
    stable: table.filter((item) => item.stability === PROMPT_STABILITY.STABLE).length,
    experimental: table.filter((item) => item.stability === PROMPT_STABILITY.EXPERIMENTAL).length,
    deprecated: table.filter((item) => item.deprecated).length,
    fingerprints: Object.freeze(table.map((item) => Object.freeze({ name: item.name, version: item.version, fingerprint: item.fingerprint }))),
  });
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors), stats });
}

/** strict 包装：版本登记漂移（未升版本改 prompt / 格式错 / 缺 changelog）时启动即失败。 */
export function assertPromptVersions(input) {
  const report = auditPromptVersions(input);
  if (!report.ok) {
    throw new Error('MCP prompt 版本审计失败：\n' + report.errors.map((error) => error.code + ' ' + error.prompt + ' ' + error.message).join('\n'));
  }
  return report;
}

/** 版本能力快照（initialize experimental['browser-bridge/prompt-versions']）。 */
export function promptVersionsSnapshot({ prompts = PROMPT_DEFINITIONS } = {}) {
  const table = promptVersionTable(prompts);
  return Object.freeze({
    supported: true,
    format: 'semver (x.y.z)',
    param: PROMPT_VERSION_PARAM,
    reasons: PROMPT_VERSION_REASONS,
    stability: PROMPT_STABILITY,
    bumps: PROMPT_VERSION_BUMPS,
    total: table.length,
    prompts: Object.freeze(table.map((item) => Object.freeze({
      name: item.name,
      version: item.version,
      stability: item.stability,
      fingerprint: item.fingerprint,
    }))),
    fields: Object.freeze({
      list: 'prompts/list[]._meta["browser-bridge/prompt"].version',
      get: 'prompts/get._meta["browser-bridge/prompt"].version',
      fallback: 'prompts/get._meta["browser-bridge/prompt"].version.fallback',
    }),
    rendering: 'server 只渲染当前版本；请求老版本会如实标 fallback=true（不返回伪造的旧渲染）',
  });
}
