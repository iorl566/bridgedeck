// tools/bsk-diff/lib/join.mjs —— joiner：把两侧事实 + 判定映射合成 6 张差分表的行。
//
// 状态判定是**机械可见**的：每行都带 detail（覆盖/缺字段/缺子命令计数），
// 文档「差距」列由 detail 渲染，读数可复核。判定不到位的（例如我方方法没单列
// schema）一律 unknown，绝不写成 equal。

import fs from 'node:fs';
import path from 'node:path';
import { readLines, lineOf, percent, stableSortBy, toSnake } from './text.mjs';
import { COMPAT_RPC_METHODS } from '../../../lib/compat-rpc.mjs';
import { schemaFieldNames, REPO_ROOT } from './extract-ours.mjs';
import {
  CLI_OVERRIDES, CLI_EXTRA, CLI_CORE, CLI_SPEC_TOPIC, CLI_NOTES, FLAG_ALIASES, CLI_SKIP_SUBCOMMANDS,
  CLI_SUBCOMMAND_TOP_LEVEL,
  RPC_OVERRIDES, PARAM_ENVELOPE, RPC_CRITICAL_FIELDS,
  MCP_MAP, BSK_MCP_ACTION_COVERAGE,
  EXT_ROWS, FEATURE_MAP, FEATURE_BSK_ONLY,
  ERROR_CODE_MAP, ERROR_REASON_MAP, ERROR_MAPPING_NOTES,
  STATUS, STATUS_VALUES, BSK_DAEMON_PARAM_EVIDENCE, BSK_VIDEO_VARIANTS , FIELD_SEMANTIC_EQUIVALENTS } from './mapping.mjs';

const anchorFileCache = new Map();
function fileLines(file) {
  if (!anchorFileCache.has(file)) anchorFileCache.set(file, readLines(path.join(REPO_ROOT, file)));
  return anchorFileCache.get(file);
}

/** `{file, needle}` → `file:line`；找不到直接抛错（不允许过期证据）。 */
export function resolveAnchor(anchor) {
  if (typeof anchor === 'string') return anchor;
  const entry = fileLines(anchor.file);
  const line = lineOf(entry.lines, anchor.needle);
  if (!line) throw new Error(`证据锚点未命中：${anchor.file} 中找不到 ${String(anchor.needle)}`);
  return `${anchor.file}:${line}`;
}

function uniq(list) {
  return [...new Set(list.filter(Boolean))];
}

function normalizeFlag(name) {
  const bare = String(name).replace(/^--/, '');
  if (FLAG_ALIASES[bare]) return FLAG_ALIASES[bare];
  return bare.replace(/_/g, '-').replace(/-ms$/, '').replace(/^timeout$/, 'timeout');
}

// ---------------------------------------------------------------------------
// ① CLI 命令轴
// ---------------------------------------------------------------------------

const CLI_SUB_ALIASES = Object.freeze({ create: 'new' });

function buildCliRows(bsk, ours) {
  const rows = [];
  const ourVerbs = new Map(ours.cli.verbs.map((item) => [item.verb, item]));
  const globalFlagSet = new Set(ours.cli.globalFlagUniverse.map(normalizeFlag));
  const mappedOurs = new Set();

  for (const surface of bsk.cliSurfaces) {
    const override = CLI_OVERRIDES[surface.name] || null;
    const ourName = override ? override.ours : surface.name;
    const ourVerb = ourVerbs.get(ourName) || null;
    if (ourVerb) mappedOurs.add(ourName);

    const note = CLI_NOTES[surface.name] || (override ? override.note : '');
    const bskEvidence = [];
    if (surface.helpFile) {
      bskEvidence.push(`${surface.helpFile}:${surface.usageLine || 1}`);
      const firstOption = surface.options[0];
      if (firstOption) bskEvidence.push(`${surface.helpFile}:${firstOption.line}`);
      const firstSub = surface.subcommands.find((item) => item.name !== 'help');
      if (firstSub) bskEvidence.push(`${surface.helpFile}:${firstSub.line}`);
    } else {
      bskEvidence.push(`${surface.rootFile}:${surface.rootLine}`);
    }

    if (!ourVerb) {
      rows.push({
        id: `cli:${surface.name}`,
        axis: 'cli',
        name: surface.name,
        bskName: surface.name,
        oursName: null,
        status: STATUS.MISSING,
        evidence: { ours: [], bsk: bskEvidence },
        gap: `我方 CLI 没有 \`${ourName}\` 动词。${note}`.trim(),
        priority: 'P0',
        detail: { missingCommand: true },
      });
      continue;
    }

    // 命令级契约（COMMAND_SPECS）：优先按声明比对；否则只能按 CLI 全局 flag 全集比对。
    const specTopic = Object.prototype.hasOwnProperty.call(CLI_SPEC_TOPIC, ourName)
      ? CLI_SPEC_TOPIC[ourName]
      : (ours.cli.specs[ourName] ? ourName : null);
    const spec = specTopic ? ours.cli.specs[specTopic] : null;
    const specSubs = spec ? spec.subs : {};
    const specFlags = new Set();
    for (const sub of Object.values(specSubs)) for (const flag of sub.flags) specFlags.add(normalizeFlag(flag));
    if (spec) for (const flag of spec.globals) specFlags.add(normalizeFlag(flag));
    const commandLevelContract = Boolean(spec && Object.keys(specSubs).length > 0);

    const bskOptions = surface.options
      .filter((option) => !surface.globalOptions.includes(option.name))
      .map((option) => option.name);
    const coveredBySpec = bskOptions.filter((option) => specFlags.has(normalizeFlag(option)));
    const coveredByGlobal = bskOptions.filter((option) => globalFlagSet.has(normalizeFlag(option)));
    const covered = bskOptions.filter((option) => specFlags.has(normalizeFlag(option)) || globalFlagSet.has(normalizeFlag(option)));
    const uncovered = bskOptions.filter((option) => !covered.includes(option));

    // 位置参数契约：上游 的必选/可选个数 vs 我方 spec 的 min/max（有声明且语义可比才比）。
    // 跳过两类：① 上游 该命令本身是子命令容器（`<COMMAND>`）；② 上游 用位置参数表达动作
    // （`<ACTION>`/`<METHOD>`），此时位置参数不是"目标参数"，不可与目标位置参数直接比。
    const POSITIONAL_SKIP_NAMES = new Set(['ACTION', 'COMMAND', 'METHOD']);
    const bskIsContainer = !CLI_SKIP_SUBCOMMANDS.includes(surface.name)
      && surface.subcommands.some((item) => item.name !== 'help');
    const bskActionPositional = surface.positionals.some((item) => POSITIONAL_SKIP_NAMES.has(item.name));
    const bskRequired = surface.positionals.filter((item) => item.required).length;
    const bskOptional = surface.positionals.length - bskRequired;
    let positional = null;
    if (commandLevelContract && !bskIsContainer && !bskActionPositional) {
      const candidates = Object.values(specSubs).filter((sub) => sub.positionals);
      // 命令本体（default 子命令）优先；没有 default 时取位置参数最宽的子命令。
      const best = candidates.find((sub) => sub.name === 'default')
        || candidates.sort((a, b) => (b.positionals.max || 0) - (a.positionals.max || 0))[0];
      if (best) {
        positional = {
          bsk: `${bskRequired} 必选 / ${bskOptional} 可选`,
          ours: `${best.positionals.min} 必选 / ${(best.positionals.max || 0) - (best.positionals.min || 0)} 可选`,
          match: bskRequired === best.positionals.min && bskOptional === (best.positionals.max || 0) - (best.positionals.min || 0),
        };
      }
    } else if (bskIsContainer || bskActionPositional) {
      positional = {
        bsk: `${bskRequired} 必选 / ${bskOptional} 可选`,
        ours: 'n/a（BSK 位置参数是子命令/动作占位，不作目标参数比对）',
        match: true,
        skipped: true,
      };
    }

    // 子命令面：两侧都有 Commands 段才算数；我方没有声明时，用顶层独立命令证据兜底。
    const bskSubsRaw = surface.subcommands.filter((item) => item.name !== 'help').map((item) => item.name);
    const bskSubs = CLI_SKIP_SUBCOMMANDS.includes(surface.name) ? [] : bskSubsRaw;
    let subcommands = null;
    if (bskSubs.length) {
      const ourSubs = Object.keys(specSubs).filter((name) => name !== 'default');
      const oursNormalized = new Set(ourSubs.map((name) => CLI_SUB_ALIASES[name] || name));
      const verbNames = new Set(ours.cli.verbs.map((verb) => verb.verb));
      const topLevel = CLI_SUBCOMMAND_TOP_LEVEL[surface.name] || null;
      const coveredSubs = ourSubs.length
        ? bskSubs.filter((name) => oursNormalized.has(CLI_SUB_ALIASES[name] || name))
        : (topLevel ? bskSubs.filter((name) => Object.prototype.hasOwnProperty.call(topLevel, name) && verbNames.has(topLevel[name])) : []);
      const uncoveredSubs = ourSubs.length ? bskSubs.filter((name) => !coveredSubs.includes(name)) : [];
      subcommands = {
        bsk: bskSubs,
        ours: ourSubs,
        covered: coveredSubs,
        uncovered: uncoveredSubs,
        // 我方没有声明子命令面时，上游 子命令是否齐备「无法核对」——不能写成"未覆盖"。
        unverifiable: ourSubs.length === 0 && coveredSubs.length === 0,
        parity: uncoveredSubs.length === 0 && (ourSubs.length > 0 || coveredSubs.length > 0),
        commandLevel: ourSubs.length > 0,
        providedAsTopLevel: ourSubs.length === 0 && Boolean(topLevel),
      };
    }

    let status = STATUS.PARTIAL;
    const reasons = [];
    if (uncovered.length) reasons.push(`BSK 参数未覆盖：${uncovered.join(' ')}`);
    if (subcommands && subcommands.uncovered.length) {
      reasons.push(`BSK 子命令未覆盖：${subcommands.uncovered.join(' ')}`);
    }
    if (subcommands && subcommands.unverifiable) {
      reasons.push(`BSK 子命令（${subcommands.bsk.join(' ')}）在我方是否齐备无法机械核对：cli/lib/command-specs.mjs 未声明该命令的子命令面（分发写在具体命令模块里）`);
    }
    if (subcommands && subcommands.providedAsTopLevel && subcommands.covered.length) {
      reasons.push(`我方把 BSK 的子命令实现为顶层命令（${subcommands.covered.join(' ')}），命令级子命令契约缺失`);
    }
    if (!commandLevelContract) {
      reasons.push(`命令级参数契约缺失：仅能按 CLI 全局 flag 全集比对（${covered.length}/${bskOptions.length} 命中）`);
    }
    if (positional && !positional.match) reasons.push(`位置参数不一致：BSK ${positional.bsk}，我方 ${positional.ours}`);
    if (!positional && commandLevelContract) reasons.push('位置参数契约缺声明，无法比对');

    const allOptionsCovered = uncovered.length === 0;
    const subsOk = !subcommands || (subcommands.parity && !subcommands.unverifiable);
    const positionalOk = positional ? positional.match : (surface.positionals.length === 0);
    if (allOptionsCovered && subsOk && positionalOk && commandLevelContract && !(subcommands && subcommands.providedAsTopLevel)) {
      status = STATUS.EQUAL;
      reasons.length = 0;
    }

    const priority = status === STATUS.EQUAL
      ? 'P2'
      : (CLI_CORE.includes(surface.name) && (uncovered.length > 0 || (subcommands && subcommands.uncovered.length > 0))) ? 'P0'
        : 'P1';

    const ourEvidence = [`${ourVerb.file}:${ourVerb.line}`];
    if (spec && spec.line) ourEvidence.push(`${spec.file}:${spec.line}`);

    let gapText;
    if (status === STATUS.EQUAL) {
      const subSummary = subcommands ? `子命令 ${subcommands.covered.length}/${subcommands.bsk.length} 覆盖` : '无子命令面';
      const posSummary = positional && !positional.skipped ? '位置参数一致' : (positional && positional.skipped ? '位置参数不适用' : '无位置参数');
      gapText = `可核对面一致（参数 ${covered.length}/${bskOptions.length} 覆盖、${subSummary}、${posSummary}）；行为等价未做 E2E 验证。${note ? `补充：${note}` : ''}`;
    } else {
      gapText = reasons.length ? reasons.join('；') : (note || '可核对面未完全覆盖。');
    }

    rows.push({
      id: `cli:${surface.name}`,
      axis: 'cli',
      name: surface.name,
      bskName: surface.name,
      oursName: ourName,
      status,
      evidence: { ours: uniq(ourEvidence), bsk: bskEvidence },
      gap: gapText,
      note,
      priority,
      detail: {
        optionCount: bskOptions.length,
        optionCoveredBySpec: coveredBySpec.length,
        optionCoveredByGlobal: coveredByGlobal.length,
        uncoveredOptions: uncovered,
        commandLevelContract,
        positional,
        subcommands,
        bskUsage: surface.usage,
        bskSource: surface.helpSource,
      },
    });
  }

  for (const verb of ours.cli.verbs) {
    if (mappedOurs.has(verb.verb)) continue;
    const extra = CLI_EXTRA[verb.verb];
    rows.push({
      id: `cli:extra:${verb.verb}`,
      axis: 'cli',
      name: verb.verb,
      bskName: null,
      oursName: verb.verb,
      status: STATUS.EXTRA,
      evidence: { ours: [`${verb.file}:${verb.line}`], bsk: [] },
      gap: `${extra ? extra.note : '我方 CLI 独有动词。'}（本轴 extra：BSK 0.5.0 没有同名命令）`,
      priority: 'P2',
      detail: { oursKind: verb.kind },
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// ② RPC 方法轴
// ---------------------------------------------------------------------------

function bskParamFields(bsk, method, ourMethod = null) {
  if (!method) return null;
  // serde_json::Value：若 daemon 侧有 typed 证据表，则用它做字段级比对（证据写进 row）。
  if (/serde_json::Value/.test(method.paramsType)) {
    const evidence = BSK_DAEMON_PARAM_EVIDENCE[method.wire];
    if (evidence) return { opaque: false, fields: evidence.fields, daemonEvidence: evidence.source };
    return { opaque: true, fields: [] };
  }
  // serde 枚举（#[serde(tag="action")]）：按我方方法名后缀选变体。
  if (method.paramsType === 'VideoParams' || method.paramsType === 'VideoAction') {
    const action = ourMethod ? ourMethod.name.split('.').pop() : null;
    const variant = action ? BSK_VIDEO_VARIANTS[action] : null;
    if (variant) return { opaque: false, fields: variant.fields, daemonEvidence: variant.source };
    return { opaque: false, fields: [], daemonEvidence: 'crates/bsk-protocol/src/tools/video.rs:13-60（枚举变体未解析）' };
  }
  const struct = bsk.paramStructs[method.paramsType];
  if (!struct) return null;
  const fields = struct.fields.map((field) => field.wire).filter((field) => !PARAM_ENVELOPE.includes(field));
  return { opaque: false, fields, struct };
}

function ourParamFields(method) {
  if (!method || !method.schemaDefined) return { defined: false, fields: [] };
  const fields = schemaFieldNames(method.schema).filter((field) => !PARAM_ENVELOPE.includes(field));
  return { defined: fields.length > 0, fields };
}

function methodCandidates(name) {
  const stripped = name.replace(/^tool\./, '');
  const forms = new Set();
  for (const base of [name, stripped]) {
    forms.add(base);
    forms.add(base.replace(/_/g, '-'));
    forms.add(base.replace(/\./g, '-'));
    forms.add(base.replace(/\./g, '_'));
  }
  return [...forms];
}

function buildRpcMatch(bsk, ours) {
  const ourByName = new Map(ours.methods.methods.map((method) => [method.name, method]));
  const ourIndex = new Map();
  for (const method of ours.methods.methods) {
    for (const candidate of methodCandidates(method.name)) ourIndex.set(candidate, method);
  }
  const matches = new Map(); // bskWire -> ourMethod
  for (const method of bsk.methods) {
    const override = RPC_OVERRIDES[method.wire];
    if (override) {
      const targets = override.ours.map((name) => ourByName.get(name)).filter(Boolean);
      if (targets.length) matches.set(method.wire, targets);
      continue;
    }
    const candidateKeys = methodCandidates(method.wire);
    for (const key of candidateKeys) {
      const hit = ourIndex.get(key);
      if (hit) {
        matches.set(method.wire, [hit]);
        break;
      }
    }
  }
  return { matches, ourByName };
}

function buildRpcRows(bsk, ours) {
  const { matches, ourByName } = buildRpcMatch(bsk, ours);
  const matchedOurs = new Set();
  for (const list of matches.values()) for (const method of list) matchedOurs.add(method.name);

  const rows = [];
  for (const bskMethod of bsk.methods) {
    const override = RPC_OVERRIDES[bskMethod.wire] || null;
    const targets = matches.get(bskMethod.wire) || [];
    const bskEvidence = [`${bskMethod.file}:${bskMethod.line}`];

    if (!targets.length) {
      const compat = COMPAT_RPC_METHODS[bskMethod.wire];
      if (compat) {
        const compatFile = path.join(REPO_ROOT, 'lib', 'compat-rpc.mjs');
        const compatLines = fs.readFileSync(compatFile, 'utf8').split('\n');
        const idx = compatLines.findIndex((line) => line.includes("'" + bskMethod.wire + "'") || line.includes('"' + bskMethod.wire + '"'));
        rows.push({
          id: 'rpc:bsk:' + bskMethod.wire,
          axis: 'rpc',
          name: bskMethod.wire,
          bskName: bskMethod.wire,
          oursName: compat.canonical || 'daemon-local',
          status: STATUS.PARTIAL,
          evidence: { ours: ['lib/compat-rpc.mjs:' + (idx + 1)], bsk: bskEvidence },
          gap: compat.note,
          priority: 'P1',
          detail: { bskOwner: bskMethod.owner, bskEffect: bskMethod.effect, bskParamsType: bskMethod.paramsType, compat: true, route: compat.route },
        });
        continue;
      }
      rows.push({
        id: 'rpc:bsk:' + bskMethod.wire,
        axis: 'rpc',
        name: bskMethod.wire,
        bskName: bskMethod.wire,
        oursName: null,
        status: STATUS.MISSING,
        evidence: { ours: [], bsk: bskEvidence },
        gap: `我方没有对应协议方法。${override ? override.note : ''}`.trim(),
        priority: (override && override.priority) || 'P0',
        detail: { bskOwner: bskMethod.owner, bskEffect: bskMethod.effect, bskParamsType: bskMethod.paramsType },
      });
      continue;
    }

    for (const ourMethod of targets) {
      const ourParam = ourParamFields(ourMethod);
      // 上游 参数证据按目标方法计算（serde 枚举变体 / daemon typed 证据与配对方法相关）。
      const bskParam = bskParamFields(bsk, bskMethod, ourMethod);
      const rowBskEvidence = bskParam && bskParam.struct
        ? [...bskEvidence, `${bskParam.struct.file}:${bskParam.struct.line}`]
        : (bskParam && bskParam.daemonEvidence ? [...bskEvidence, bskParam.daemonEvidence] : [...bskEvidence]);
      const ourEvidence = [`${ourMethod.catalogFile}:${ourMethod.catalogLine}`];
      if (ourMethod.schemaLine) ourEvidence.push(`${ourMethod.schemaFile}:${ourMethod.schemaLine}`);
      let status;
      let gap;
      let priority;
      let detail = {
        bskParamsType: bskMethod.paramsType,
        ourSchemaDefined: ourMethod.schemaDefined,
        bskOwner: bskMethod.owner,
        bskEffect: bskMethod.effect,
        ourOwner: ourMethod.owner,
        ourEffect: ourMethod.effect,
        override: Boolean(override),
        bskDaemonEvidence: (bskParam && bskParam.daemonEvidence) || null,
      };
      if (!ourParam.defined) {
        status = STATUS.UNKNOWN;
        gap = ourMethod.schemaDefined
          ? '我方 lib/schemas.mjs 只给该方法声明了通用信封字段（没有业务参数），参数面无法机械比对；需要人工补 schema 后才能判等价。'
          : '我方 lib/schemas.mjs 未单列该方法的参数（回落到通用信封 schema），参数面无法机械比对；需要人工补 schema 后才能判等价。';
        priority = 'P1';
        detail = { ...detail, ourFieldCount: 0 };
      } else if (!bskParam || bskParam.opaque) {
        status = STATUS.UNKNOWN;
        gap = bskParam && bskParam.opaque
          ? 'BSK 侧参数类型是 serde_json::Value（不透明 JSON），无法做字段级比对。'
          : `BSK 侧参数结构体 ${bskMethod.paramsType} 未被解析到，无法做字段级比对。`;
        priority = 'P1';
      } else {
        const bskFields = bskParam.fields;
        const ourFields = ourParam.fields;
        const shared = bskFields.filter((field) => ourFields.includes(field));
        const bskOnly = bskFields.filter((field) => !ourFields.includes(field));
        const ourOnly = ourFields.filter((field) => !bskFields.includes(field));
        const semantic = FIELD_SEMANTIC_EQUIVALENTS[`${bskMethod.wire}->${ourMethod.name}`] || null;
        detail = {
          ...detail,
          bskFieldCount: bskFields.length,
          ourFieldCount: ourFields.length,
          sharedFields: shared,
          bskOnlyFields: bskOnly,
          ourOnlyFields: ourOnly,
          bskFields,
          ourFields,
          semanticPairs: semantic ? semantic.pairs : null,
        };
        if (shared.length === 0 && bskFields.length > 0 && ourFields.length > 0) {
          if (semantic) {
            // 字段名不同但语义相同：判 partial（线格式已确认不同，行为级仍需真实对端验证）。
            status = STATUS.PARTIAL;
            const pairs = semantic.pairs.map(([bskField, ourField]) => bskField + '↔' + ourField).join('、');
            gap = `字段命名不同但语义等价（${pairs}）：${semantic.note}`;
            priority = 'P1';
          } else {
            status = STATUS.UNKNOWN;
            gap = `两侧参数字段零交集（BSK: ${bskFields.join('/')}；我方: ${ourFields.join('/')}），无法确认是同一能力，映射本身需要人工复核。`;
            priority = 'P1';
          }
        } else if (bskOnly.length === 0 && ourOnly.length === 0) {
          status = STATUS.EQUAL;
          gap = `参数集合完全一致（${bskFields.length} 个字段）。语义等价未做行为级验证。`;
          priority = 'P2';
        } else {
          status = STATUS.PARTIAL;
          const parts = [];
          if (bskOnly.length) parts.push(`我方缺 ${bskOnly.length} 个 BSK 字段：${bskOnly.join(' ')}`);
          if (ourOnly.length) parts.push(`我方多 ${ourOnly.length} 个字段：${ourOnly.join(' ')}`);
          gap = parts.join('；');
          priority = bskOnly.some((field) => RPC_CRITICAL_FIELDS.includes(field)) ? 'P0' : 'P1';
        }
      }
      if (override && override.note) gap = `${gap}${gap ? '；' : ''}${override.note}`;
      rows.push({
        id: `rpc:${bskMethod.wire}->${ourMethod.name}`,
        axis: 'rpc',
        name: bskMethod.wire,
        bskName: bskMethod.wire,
        oursName: ourMethod.name,
        status,
        evidence: { ours: uniq(ourEvidence), bsk: uniq(rowBskEvidence) },
        gap,
        priority,
        detail,
      });
    }
  }

  for (const ourMethod of ours.methods.methods) {
    if (matchedOurs.has(ourMethod.name)) continue;
    rows.push({
      id: `rpc:extra:${ourMethod.name}`,
      axis: 'rpc',
      name: ourMethod.name,
      bskName: null,
      oursName: ourMethod.name,
      status: STATUS.EXTRA,
      evidence: {
        ours: uniq([`${ourMethod.catalogFile}:${ourMethod.catalogLine}`, ourMethod.schemaLine ? `${ourMethod.schemaFile}:${ourMethod.schemaLine}` : '']),
        bsk: [],
      },
      gap: `我方协议方法，BSK 0.5.0 的方法表里没有对应项（${ourMethod.owner}/${ourMethod.effect}）。`,
      priority: 'P2',
      detail: { ourOwner: ourMethod.owner, ourEffect: ourMethod.effect, ourSchemaDefined: ourMethod.schemaDefined },
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// ③ MCP 工具轴
// ---------------------------------------------------------------------------

/** 上游 MCP 动作里的"核心输入/观测链路"：排序与优先级判定都优先看这些动作。 */
const BSK_MCP_CORE_ORDER = [
  'click', 'press', 'fill', 'hover', 'select', 'drag', 'scroll_to', 'wheel', 'focus', 'blur',
  'evaluate', 'navigate', 'back', 'forward', 'reload', 'read', 'observe', 'snapshot', 'screenshot', 'console',
];
const BSK_MCP_CORE_ACTIONS = new Set(BSK_MCP_CORE_ORDER);

function buildMcpRows(bsk, ours) {
  const rows = [];
  const actionIndex = new Map();
  for (const [enumName, block] of Object.entries(bsk.mcp.actionEnums)) {
    for (const action of block.actions) {
      actionIndex.set(`${enumName}:${action.wire}`, { enumName, action, block });
    }
  }
  const bskToolLine = (name) => {
    const tool = bsk.mcp.tools.find((item) => item.name === name);
    if (tool) return { file: bsk.mcp.file, line: tool.line };
    if (bsk.mcp.recipeTool && bsk.mcp.recipeTool.name === name) {
      return { file: bsk.mcp.file, line: bsk.mcp.recipeTool.line };
    }
    if (name === 'bsk_plan' && bsk.mcp.planArgs) return { file: bsk.mcp.planArgs.file, line: bsk.mcp.planArgs.line };
    return null;
  };

  for (const tool of ours.mcp.tools) {
    const declared = MCP_MAP[tool.name];
    if (!declared) throw new Error(`MCP_MAP 缺少工具映射：${tool.name}`);
    const ourEvidence = [`${tool.file}:${tool.line}`];
    if (!declared.bsk) {
      rows.push({
        id: `mcp:${tool.name}`,
        axis: 'mcp',
        name: tool.name,
        bskName: null,
        oursName: tool.name,
        status: STATUS.EXTRA,
        evidence: { ours: ourEvidence, bsk: [] },
        gap: declared.note,
        priority: 'P2',
        detail: { ourMethods: tool.methods },
      });
      continue;
    }
    const [toolName, actionWire] = declared.bsk.split(':');
    const located = bskToolLine(toolName);
    const action = actionWire ? actionIndex.get(`${toolName === 'bsk_session' ? 'Session' : toolName === 'bsk_page' ? 'Page' : toolName === 'bsk_inspect' ? 'Inspect' : toolName === 'bsk_interact' ? 'Interact' : toolName === 'bsk_tabs' ? 'Tabs' : toolName === 'bsk_assist' ? 'Assist' : 'Recipe'}:${actionWire}`) : null;
    const bskEvidence = [];
    if (located) bskEvidence.push(`${located.file}:${located.line}`);
    if (action) bskEvidence.push(`${action.block.file}:${action.action.line}`);
    if (!bskEvidence.length) throw new Error(`MCP BSK 证据缺失：${declared.bsk}`);
    rows.push({
      id: `mcp:${tool.name}`,
      axis: 'mcp',
      name: tool.name,
      bskName: declared.bsk,
      oursName: tool.name,
      status: STATUS.PARTIAL,
      evidence: { ours: ourEvidence, bsk: bskEvidence },
      gap: declared.note,
      priority: 'P1',
      detail: { ourMethods: tool.methods, bskTool: toolName, bskAction: actionWire || null },
    });
  }

  // ③b：上游 MCP 动作在我方工具面上的覆盖（missing / partial / covered）。
  const coveredActions = new Set();
  for (const tool of ours.mcp.tools) {
    const declared = MCP_MAP[tool.name];
    if (declared && declared.bsk) coveredActions.add(declared.bsk);
  }
  for (const coverage of BSK_MCP_ACTION_COVERAGE) {
    const key = `${coverage.tool}:${coverage.action}`;
    const action = actionIndex.get(`${coverage.enumName}:${coverage.action}`);
    if (!action) throw new Error(`BSK_MCP_ACTION_COVERAGE 引用了不存在的动作：${key}`);
    const bskEvidence = [`${action.block.file}:${action.action.line}`];
    const located = bskToolLine(coverage.tool);
    if (located) bskEvidence.unshift(`${located.file}:${located.line}`);
    const ourTools = coverage.ours || [];
    const ourEvidence = ourTools.map((name) => {
      const tool = ours.mcp.tools.find((item) => item.name === name);
      if (!tool) throw new Error(`BSK_MCP_ACTION_COVERAGE 引用了不存在的工具：${name}`);
      return `${tool.file}:${tool.line}`;
    });
    const status = ourTools.length ? STATUS.PARTIAL : STATUS.MISSING;
    rows.push({
      id: `mcp:bsk:${key}`,
      axis: 'mcp',
      name: key,
      bskName: key,
      oursName: ourTools.length ? ourTools.join(',') : null,
      status,
      evidence: { ours: ourEvidence, bsk: bskEvidence },
      gap: coverage.note,
      priority: coverage.priority || (status === STATUS.MISSING ? 'P0' : 'P1'),
      detail: {
        bskTool: coverage.tool,
        bskAction: coverage.action,
        ourTools,
        coreAction: BSK_MCP_CORE_ACTIONS.has(coverage.action),
        coreOrder: BSK_MCP_CORE_ORDER.indexOf(coverage.action) === -1 ? 99 : BSK_MCP_CORE_ORDER.indexOf(coverage.action),
      },
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// ④ 扩展能力轴
// ---------------------------------------------------------------------------

function buildExtensionRows(ours) {
  const rows = EXT_ROWS.map((row) => {
    const ourEvidence = row.ours.map(resolveAnchor);
    const bskEvidence = row.bsk.map((entry) => entry);
    const status = row.status;
    if (!STATUS_VALUES.includes(status)) throw new Error(`扩展能力行状态非法：${row.capability}=${status}`);
    if (row.priority !== 'P0' && row.priority !== 'P1' && row.priority !== 'P2') {
      throw new Error(`扩展能力行优先级非法：${row.capability}=${row.priority}`);
    }
    return {
      id: `extension:${row.capability}`,
      axis: 'extension',
      name: row.capability,
      bskName: row.bsk.join(', '),
      oursName: row.ours.map((anchor) => anchor.file).join(', '),
      status,
      evidence: { ours: ourEvidence, bsk: bskEvidence },
      gap: row.note,
      priority: row.priority,
      detail: { ourArtifacts: row.ours.length, bskArtifacts: row.bsk.length },
    };
  });

  // manifest 权限面：把两侧权限集合差异算成可核对数字。
  const bskManifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'ref/bsk-0.5.0-ext/manifest.json'), 'utf8'),
  );
  const bskPerms = new Set(bskManifest.permissions || []);
  const ourPerms = new Set(ours.extension.permissions);
  const both = [...bskPerms].filter((perm) => ourPerms.has(perm)).sort();
  const bskOnly = [...bskPerms].filter((perm) => !ourPerms.has(perm)).sort();
  const ourOnly = [...ourPerms].filter((perm) => !bskPerms.has(perm)).sort();
  const current = rows.find((row) => row.name === 'manifest-permissions');
  if (current) {
    current.detail = { both, bskOnly, ourOnly, bskCount: bskPerms.size, ourCount: ourPerms.size };
    current.gap = `${current.gap}（权限交集 ${both.length}、BSK 独有 ${bskOnly.join(',') || '无'}、我方独有 ${ourOnly.join(',') || '无'}）`;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// ⑤ 协议 / feature floor 轴
// ---------------------------------------------------------------------------

function buildFeatureRows(bsk, ours) {
  const rows = [];
  const catalogText = fileLines(ours.methods.catalogFile);
  const bskFeatureBySnake = new Map(bsk.features.map((feature) => [feature.feature, feature]));

  for (const [name, floor] of Object.entries(ours.methods.featureFloors)) {
    const declared = FEATURE_MAP[name];
    if (!declared) throw new Error(`FEATURE_MAP 缺少特性映射：${name}`);
    const meta = ours.methods.featureMeta[name] || {};
    const quoted = `'${name}': '`;
    const plain = `${name}: '`;
    const ourLine = lineOf(catalogText.lines, plain) || lineOf(catalogText.lines, quoted);
    const ourEvidence = [ourLine ? `${ours.methods.catalogFile}:${ourLine}` : ''].filter(Boolean);
    const bskFeature = declared.bsk ? bskFeatureBySnake.get(declared.bsk) : null;

    if (!declared.bsk) {
      rows.push({
        id: `feature:${name}`,
        axis: 'feature',
        name,
        bskName: null,
        oursName: name,
        status: STATUS.EXTRA,
        evidence: { ours: ourEvidence, bsk: [] },
        gap: declared.note,
        priority: 'P2',
        detail: { ourFloor: floor, kind: meta.kind || '', params: meta.params || [], methods: meta.methods || [] },
      });
      continue;
    }
    if (!bskFeature) throw new Error(`BSK feature 证据缺失：${declared.bsk}`);
    const bskEvidence = [`${bskFeature.file}:${bskFeature.line}`];
    const floorMatch = bskFeature.extensionFloor === floor;
    const triggerMatch = (meta.kind === 'param' && bskFeature.whenKind === 'true' && (meta.params || []).includes(bskFeature.whenField))
      || (meta.kind === 'param' && bskFeature.whenKind === 'present' && (meta.params || []).includes(bskFeature.whenField));
    const status = floorMatch && triggerMatch ? STATUS.EQUAL : STATUS.PARTIAL;
    const parts = [];
    if (!floorMatch) parts.push(`floor 不同：BSK ${bskFeature.extensionFloor} / 我方 ${floor}`);
    if (!triggerMatch) parts.push(`触发面不同：BSK ${bskFeature.whenKind}${bskFeature.whenField ? `(${bskFeature.whenField})` : ''} / 我方 ${meta.kind || '未知'}(${(meta.params || []).join(',') || '方法级'})`);
    rows.push({
      id: `feature:${name}`,
      axis: 'feature',
      name,
      bskName: bskFeature.feature,
      oursName: name,
      status,
      evidence: { ours: ourEvidence, bsk: bskEvidence },
      gap: `${parts.length ? parts.join('；') : ''}${parts.length ? '；' : ''}${declared.note}`,
      priority: status === STATUS.EQUAL ? 'P2' : 'P1',
      detail: { ourFloor: floor, compatFloor: bskFeature.extensionFloor, bskDaemonFloor: bskFeature.daemonFloor, triggerMatch, floorMatch },
    });
  }

  for (const [name, declared] of Object.entries(FEATURE_BSK_ONLY)) {
    const bskFeature = bskFeatureBySnake.get(name);
    if (!bskFeature) throw new Error(`BSK feature 证据缺失：${name}`);
    rows.push({
      id: `feature:bsk:${name}`,
      axis: 'feature',
      name,
      bskName: name,
      oursName: null,
      status: STATUS.MISSING,
      evidence: { ours: [], bsk: [`${bskFeature.file}:${bskFeature.line}`] },
      gap: declared.note,
      priority: declared.priority,
      detail: { compatFloor: bskFeature.extensionFloor, bskDaemonFloor: bskFeature.daemonFloor, operation: bskFeature.operation },
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// ⑥ 错误码轴
// ---------------------------------------------------------------------------

function normalizedCodeName(bskWire) {
  return toSnake(bskWire).replace(/_/g, '_');
}
function ourCodeSnake(code) {
  return code.replace(/^E_/, '').toLowerCase();
}

function buildErrorRows(bsk, ours) {
  const ourByCode = new Map(ours.errors.codes.map((code) => [code.code, code]));
  const usedOur = new Set();
  const rows = [];

  const addRow = (bskEntry, ourCode, kind, declaredNote = '') => {
    const ourEntry = ourCode ? ourByCode.get(ourCode) : null;
    if (ourCode && !ourEntry) throw new Error(`ERROR map 引用了不存在的我方错误码：${ourCode}`);
    if (ourEntry) usedOur.add(ourCode);
    let status;
    if (!ourCode) status = STATUS.MISSING;
    else if (kind === 'code' || kind === 'reason') {
      const exact = normalizedCodeName(bskEntry.wire) === ourCodeSnake(ourCode);
      status = exact ? STATUS.EQUAL : STATUS.PARTIAL;
    } else status = STATUS.PARTIAL;
    const gapParts = [];
    if (status === STATUS.MISSING) gapParts.push('我方错误码表里没有对应码；调用方无法稳定区分该失败原因。');
    if (status === STATUS.PARTIAL) gapParts.push(`名称不同（BSK \`${bskEntry.wire}\` → 我方 \`${ourCode}\`），属于语义近似映射。`);
    if (status === STATUS.EQUAL) gapParts.push('归一化名称一致。');
    const mapNote = ourCode && ERROR_MAPPING_NOTES[ourCode];
    if (mapNote) gapParts.push(mapNote);
    if (declaredNote) gapParts.push(declaredNote);
    rows.push({
      id: `error:bsk:${kind}:${bskEntry.wire}`,
      axis: 'error',
      name: bskEntry.wire,
      bskName: `${kind}:${bskEntry.wire}`,
      oursName: ourCode || null,
      status,
      evidence: {
        ours: ourEntry ? [`${ourEntry.file}:${ourEntry.line}`] : [],
        bsk: [`${bskEntry.file}:${bskEntry.line}`],
      },
      gap: gapParts.join('；'),
      priority: status === STATUS.MISSING ? 'P1' : (status === STATUS.PARTIAL ? 'P2' : 'P2'),
      detail: { kind, bskVariant: bskEntry.variant },
    });
  };

  for (const entry of bsk.vocabulary.errorCodes) {
    const mapped = ERROR_CODE_MAP[entry.wire];
    if (mapped === undefined) throw new Error(`ERROR_CODE_MAP 缺少条目：${entry.wire}`);
    addRow(entry, mapped, 'code');
  }
  for (const entry of bsk.vocabulary.reasons) {
    if (!Object.prototype.hasOwnProperty.call(ERROR_REASON_MAP, entry.wire)) {
      throw new Error(`ERROR_REASON_MAP 缺少条目：${entry.wire}`);
    }
    const mapped = ERROR_REASON_MAP[entry.wire];
    addRow(entry, mapped, 'reason');
  }

  for (const entry of ours.errors.codes) {
    if (usedOur.has(entry.code)) continue;
    rows.push({
      id: `error:extra:${entry.code}`,
      axis: 'error',
      name: entry.code,
      bskName: null,
      oursName: entry.code,
      status: STATUS.EXTRA,
      evidence: { ours: [`${entry.file}:${entry.line}`], bsk: [] },
      gap: `我方错误码，BSK 0.5.0 词表里没有对应 wire 值（含义：${entry.meaning || '未登记说明'}）。`,
      priority: 'P2',
      detail: { meaning: entry.meaning },
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

export function buildMatrix(bsk, ours) {
  const axes = {
    cli: buildCliRows(bsk, ours),
    rpc: buildRpcRows(bsk, ours),
    mcp: buildMcpRows(bsk, ours),
    extension: buildExtensionRows(ours),
    feature: buildFeatureRows(bsk, ours),
    error: buildErrorRows(bsk, ours),
  };

  const summary = {};
  const allRows = [];
  for (const [axis, rows] of Object.entries(axes)) {
    const counts = { total: rows.length, equal: 0, partial: 0, missing: 0, extra: 0, unknown: 0 };
    for (const row of rows) {
      if (!STATUS_VALUES.includes(row.status)) throw new Error(`状态非法：${row.id}=${row.status}`);
      if (!['P0', 'P1', 'P2'].includes(row.priority)) throw new Error(`优先级非法：${row.id}=${row.priority}`);
      counts[row.status] += 1;
    }
    const comparable = counts.equal + counts.partial + counts.missing + counts.extra;
    summary[axis] = {
      ...counts,
      percentages: {
        equal: percent(counts.equal, counts.total),
        partial: percent(counts.partial, counts.total),
        missing: percent(counts.missing, counts.total),
        extra: percent(counts.extra, counts.total),
        unknown: percent(counts.unknown, counts.total),
      },
      evidenceCoverage: percent(comparable, counts.total),
    };
    allRows.push(...rows);
  }

  const p0 = allRows.filter((row) => row.priority === 'P0');
  const ranked = stableSortBy(p0, ['axis', 'id']);
  return {
    axes,
    summary,
    rows: stableSortBy(allRows, ['axis', 'id']),
    p0: ranked,
    totals: {
      rows: allRows.length,
      equal: Object.values(summary).reduce((sum, item) => sum + item.equal, 0),
      partial: Object.values(summary).reduce((sum, item) => sum + item.partial, 0),
      missing: Object.values(summary).reduce((sum, item) => sum + item.missing, 0),
      extra: Object.values(summary).reduce((sum, item) => sum + item.extra, 0),
      unknown: Object.values(summary).reduce((sum, item) => sum + item.unknown, 0),
    },
  };
}
