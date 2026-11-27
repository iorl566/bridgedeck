// tools/quality/lib/consumers.mjs —— 运行时消费点登记与真实性核验。
//
// 门禁最容易退化成"只测自己"：声明了一堆检查，却没有真实调用产品模块。
// 这里把"哪个 gate 用了哪个模块的哪个符号"写成静态表，并在每次 --check 时：
//   1) 在模块源码里找到符号定义的真实行号（export function/const/class）；
//   2) 在 gate 源码里找到引用该符号的真实行号（import 或调用）；
//   3) 任何一侧找不到 = 消费点漂移（blocking finding，带 file:line 证据）。
// 报告里的 runtime 表就是这些 file:line，可直接被审计复核。

import fs from 'node:fs';
import path from 'node:path';

/**
 * 消费点声明：gate 用到的真实模块符号。
 * gate: 'run' 表示门禁入口 run.mjs 自身对 lib 的消费。
 */
export const CONSUMPTION_POINTS = Object.freeze([
  // —— 确定性 gate ——
  {
    gate: 'determinism',
    module: 'lib/har-plan.mjs',
    symbols: ['buildHarReplayPlan', 'replayIdOf', 'normalizeReplayEntry', 'summarizeHarReplayPlan'],
  },
  {
    gate: 'determinism',
    module: 'lib/har-replay.mjs',
    symbols: ['parseHarReplayEntries', 'planHarReplay'],
  },
  {
    gate: 'determinism',
    module: 'lib/trace-budget.mjs',
    symbols: ['planTraceExport', 'sampleTraceEvents', 'summarizeTraceSampling', 'compactTrace'],
  },
  {
    gate: 'determinism',
    module: 'lib/plan-steps.mjs',
    symbols: ['normalizePlanStep', 'normalizePlanSteps'],
  },
  {
    gate: 'determinism',
    module: 'lib/run-log.mjs',
    symbols: ['SessionRunLog'],
  },
  {
    gate: 'determinism',
    module: 'lib/error-codes.mjs',
    symbols: ['recoveryHint', 'normalizeErrorCode'],
  },
  {
    gate: 'determinism',
    module: 'tools/quality/lib/child.mjs',
    symbols: ['runFingerprintSuite'],
  },
  // —— 幂等 gate ——
  {
    gate: 'idempotency',
    module: 'lib/intent-ledger.mjs',
    symbols: ['IntentLedger', 'createMemoryLedgerStorage', 'isNonIdempotentAction', 'normalizeResolveOutcome', 'hasNoEffect'],
  },
  {
    gate: 'idempotency',
    module: 'lib/har-plan.mjs',
    symbols: ['buildHarReplayPlan', 'executeHarReplayPlan', 'compareReplayRuns', 'isIdempotentRequest'],
  },
  {
    gate: 'idempotency',
    module: 'lib/recipe-store.mjs',
    symbols: ['saveRecipe', 'readRecipe', 'approveRecipe', 'acquireRecipeLock', 'releaseRecipeLock', 'writeRunReport', 'readRunReport'],
  },
  {
    gate: 'idempotency',
    module: 'lib/methods.mjs',
    symbols: ['isMutating'],
  },
  {
    gate: 'idempotency',
    module: 'tools/quality/lib/child.mjs',
    symbols: ['runTokenFixture'],
  },
  // —— 可解释性 gate ——
  {
    gate: 'explainability',
    module: 'lib/error-codes.mjs',
    symbols: ['ERROR_CODES', 'ERROR_RECOVERY', 'recoveryHint'],
  },
  {
    gate: 'explainability',
    module: 'cli/lib/json-contract.mjs',
    symbols: ['decorateFailure', 'errorEnvelope', 'validateEnvelope'],
  },
  {
    gate: 'explainability',
    module: 'tools/quality/lib/child.mjs',
    symbols: ['runChildRaw'],
  },
  // —— 反脆弱 gate ——
  {
    gate: 'antifragility',
    module: 'lib/har-plan.mjs',
    symbols: ['buildHarReplayPlan', 'executeHarReplayPlan'],
  },
  {
    gate: 'antifragility',
    module: 'lib/trace-budget.mjs',
    symbols: ['planTraceExport', 'compactTrace', 'buildTraceEventUnits'],
  },
  {
    gate: 'antifragility',
    module: 'lib/intent-ledger.mjs',
    symbols: ['IntentLedger', 'createMemoryLedgerStorage', 'createFileLedgerStorage'],
  },
  {
    gate: 'antifragility',
    module: 'lib/limits.mjs',
    symbols: ['enforceOperationLimit', 'jsonByteLength'],
  },
  {
    gate: 'antifragility',
    module: 'tools/quality/lib/registry.mjs',
    symbols: ['createRegistry', 'runSuite'],
  },
  // —— run.mjs 自身对门禁框架的消费 ——
  { gate: 'run', module: 'tools/quality/lib/registry.mjs', symbols: ['runSuite', 'createRegistry', 'listGates'] },
  { gate: 'run', module: 'tools/quality/lib/render.mjs', symbols: ['renderReport', 'renderQuiet'] },
  { gate: 'run', module: 'tools/quality/lib/consumers.mjs', symbols: ['collectConsumption'] },
  { gate: 'run', module: 'tools/quality/lib/taxonomy.mjs', symbols: ['validateTaxonomy', 'validateQualityCodes'] },
  { gate: 'run', module: 'tools/quality/lib/result.mjs', symbols: ['attachDigest', 'summarizeFindings', 'makeFinding', 'configureSanitize'] },
  { gate: 'run', module: 'tools/quality/gates/determinism.mjs', symbols: ['GATE', 'buildFingerprintSuite'] },
  { gate: 'run', module: 'tools/quality/gates/idempotency.mjs', symbols: ['GATE'] },
  { gate: 'run', module: 'tools/quality/gates/explainability.mjs', symbols: ['GATE', 'auditFindings'] },
  { gate: 'run', module: 'tools/quality/gates/antifragility.mjs', symbols: ['GATE'] },
]);

/** gate 的源码文件映射（消费点核验的一侧）。 */
export const GATE_FILES = Object.freeze({
  determinism: 'tools/quality/gates/determinism.mjs',
  idempotency: 'tools/quality/gates/idempotency.mjs',
  explainability: 'tools/quality/gates/explainability.mjs',
  antifragility: 'tools/quality/gates/antifragility.mjs',
  run: 'tools/quality/run.mjs',
});

function readText(root, relPath) {
  try {
    return fs.readFileSync(path.join(root, relPath), 'utf8');
  } catch {
    return null;
  }
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 在模块源码里找导出定义的行号（1-based），找不到返回 null。 */
export function findDefinitionLine(text, symbol) {
  if (typeof text !== 'string' || !symbol) return null;
  const escaped = escapeRegExp(symbol);
  const patterns = [
    new RegExp('export\\s+(async\\s+)?function\\s+' + escaped + '\\b'),
    new RegExp('export\\s+const\\s+' + escaped + '\\b'),
    new RegExp('export\\s+class\\s+' + escaped + '\\b'),
    new RegExp('export\\s*\\{[^}]*\\b' + escaped + '\\b[^}]*\\}'),
  ];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (patterns.some((pattern) => pattern.test(lines[index]))) return index + 1;
  }
  return null;
}

/** 在 gate 源码里找引用该符号的行号（1-based），找不到返回 null。 */
export function findReferenceLine(text, symbol) {
  if (typeof text !== 'string' || !symbol) return null;
  const regex = new RegExp('\\b' + escapeRegExp(symbol) + '\\b');
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (regex.test(lines[index])) return index + 1;
  }
  return null;
}

/**
 * 收集并核验消费点。
 * @returns {{entries: Array<{gate:string,module:string,symbol:string,location:string,consumedAt:string}>,
 *   problems: Array<{kind:string,gate:string,module:string,symbol:string,detail:string}>}}
 */
export function collectConsumption(root, options = {}) {
  const gates = Array.isArray(options.gates) && options.gates.length
    ? options.gates
    : Object.keys(GATE_FILES);
  const selected = new Set(gates);
  const moduleCache = new Map();
  const gateCache = new Map();
  const entries = [];
  const problems = [];
  const readModule = (relPath) => {
    if (!moduleCache.has(relPath)) moduleCache.set(relPath, readText(root, relPath));
    return moduleCache.get(relPath);
  };
  const readGate = (relPath) => {
    if (!gateCache.has(relPath)) gateCache.set(relPath, readText(root, relPath));
    return gateCache.get(relPath);
  };
  for (const point of CONSUMPTION_POINTS) {
    if (!selected.has(point.gate)) continue;
    const gateFile = GATE_FILES[point.gate];
    if (!gateFile) {
      problems.push({ kind: 'unknown-gate', gate: point.gate, module: point.module, symbol: '*', detail: '消费点声明了未知 gate' });
      continue;
    }
    const moduleText = readModule(point.module);
    if (moduleText == null) {
      problems.push({ kind: 'missing-module', gate: point.gate, module: point.module, symbol: '*', detail: '被消费模块不存在：' + point.module });
      continue;
    }
    const gateText = readGate(gateFile);
    if (gateText == null) {
      problems.push({ kind: 'missing-gate-file', gate: point.gate, module: point.module, symbol: '*', detail: 'gate 源码不存在：' + gateFile });
      continue;
    }
    for (const symbol of point.symbols) {
      const defLine = findDefinitionLine(moduleText, symbol);
      if (defLine == null) {
        problems.push({
          kind: 'missing-symbol',
          gate: point.gate,
          module: point.module,
          symbol,
          detail: point.module + ' 没有导出符号 ' + symbol,
        });
        continue;
      }
      const refLine = findReferenceLine(gateText, symbol);
      if (refLine == null) {
        problems.push({
          kind: 'unreferenced-symbol',
          gate: point.gate,
          module: point.module,
          symbol,
          detail: gateFile + ' 没有引用 ' + symbol + '（消费点声明与实际代码不一致）',
        });
        continue;
      }
      entries.push({
        gate: point.gate,
        module: point.module,
        symbol,
        location: point.module + ':' + defLine,
        consumedAt: gateFile + ':' + refLine,
      });
    }
  }
  entries.sort((left, right) => {
    if (left.gate !== right.gate) return left.gate < right.gate ? -1 : 1;
    if (left.module !== right.module) return left.module < right.module ? -1 : 1;
    if (left.symbol !== right.symbol) return left.symbol < right.symbol ? -1 : 1;
    return 0;
  });
  problems.sort((left, right) => String(left.gate + left.module + left.symbol).localeCompare(String(right.gate + right.module + right.symbol)));
  return { entries, problems };
}

/** 解析 "file:line" 字符串。 */
export function parseLocation(location) {
  const match = /^(.+):(\d+)$/.exec(String(location || ''));
  if (!match) return null;
  return { file: match[1], line: Number(match[2]) };
}

/** 断言某个 location 的行文本包含符号（测试用；也供审计工具复用）。 */
export function assertLocationContains(root, location, symbol) {
  const parsed = parseLocation(location);
  if (!parsed) return { ok: false, detail: '不是 file:line：' + location };
  const text = readText(root, parsed.file);
  if (text == null) return { ok: false, detail: '文件不存在：' + parsed.file };
  const lines = text.split(/\r?\n/);
  if (parsed.line < 1 || parsed.line > lines.length) return { ok: false, detail: '行号越界：' + location };
  const lineText = lines[parsed.line - 1];
  return { ok: lineText.includes(symbol), detail: lineText.trim().slice(0, 200), lineText };
}

/** 门禁列表（供 --list 与文档）。 */
export function gateFiles() {
  return Object.entries(GATE_FILES).map(([gate, file]) => ({ gate, file }));
}

/** 未在消费点里出现的 gate（防止"空 gate"混入）。 */
export function gatesWithoutConsumption(gateIds = []) {
  const declared = new Set(CONSUMPTION_POINTS.map((point) => point.gate));
  return gateIds.filter((gate) => !declared.has(gate));
}
