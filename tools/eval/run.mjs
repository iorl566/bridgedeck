#!/usr/bin/env node
/**
 * tools/eval/run.mjs -- deterministic invariant-gate runner.
 *
 * Usage:
 *   node tools/eval/run.mjs [--check] [--seed <n|0x..|text>] [--cases <n>]
 *                           [--property <id>] [--area <name>] [--tag <name>]
 *                           [--json] [--md] [--list] [--quiet] [--no-shrink]
 *                           [--out <file>] [--max-failures <n>] [--help]
 *
 * Gate semantics (`--check`):
 *   - loads tools/eval/corpus (strict: duplicate ids / unresolved file:line
 *     throw exit code 2);
 *   - requires the core areas (VOM geometry, observation diff, session queue,
 *     intent ledger, protocol state) and a minimum property count;
 *   - audits its own corpus/kernel sources for non-deterministic APIs
 *     (Math.random / Date.now / performance.now / timers / ambient crypto);
 *   - verifies every generator is a pure function of its case seed;
 *   - replays every retained counterexample from its recorded seed;
 *   - exits 0 only when the report digest, minimality and all invariants hold.
 *
 * There is no wall-clock or randomness in this process: output is a pure
 * function of (corpus, seed, cases).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CASES } from './lib/property.mjs';
import { replayCase, verifyDeterminism } from './lib/property.mjs';
import { DEFAULT_SEED, normalizeSeed } from './lib/prng.mjs';
import {
  assertCorpusCoverage,
  corpusSummary,
  loadCorpus,
  runCorpus,
  selectProperties,
} from './lib/corpus.mjs';
import {
  REQUIRED_AREAS,
  buildReport,
  renderMarkdown,
  renderSummary,
  verifyReport,
} from './lib/report.mjs';
import { ROOT, relativePosix } from './lib/source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE_CASES = 64;
const FORBIDDEN_PATTERNS = Object.freeze([
  { pattern: /\bMath\.random\s*\(/g, label: 'Math.random(' },
  { pattern: /\bDate\.now\s*\(/g, label: 'Date.now(' },
  { pattern: /\bnew Date\s*\(\s*\)/g, label: 'new Date()' },
  { pattern: /\bperformance\.now\s*\(/g, label: 'performance.now(' },
  { pattern: /\bprocess\.hrtime\b/g, label: 'process.hrtime' },
  { pattern: /\bcrypto\.(randomBytes|randomUUID|getRandomValues)\b/g, label: 'crypto.random*' },
  { pattern: /\bsetTimeout\s*\(/g, label: 'setTimeout(' },
  { pattern: /\bsetInterval\s*\(/g, label: 'setInterval(' },
]);

const USAGE = [
  '用法: node tools/eval/run.mjs [options]',
  '',
  '选项:',
  '  --check              门禁模式（确定性审计 + corpus 覆盖 + 反例复现），失败退出码 1',
  '  --seed <value>       固定种子：十进制 / 0x 十六进制 / 任意字符串（默认 0xb12d6e5）',
  '  --cases <n>          每个 property 的随机用例数（默认 ' + DEFAULT_CASES + '；--check 默认 ' + GATE_CASES + '）',
  '  --property <id>      只跑指定 property（可重复）',
  '  --area <name>        只跑指定 area（可重复）',
  '  --tag <name>         只跑带指定 tag 的 property',
  '  --max-failures <n>   每个 property 保留的反例条数（默认 3）',
  '  --no-shrink          关闭反例收缩（报告仍是确定性的，但反例不最小）',
  '  --json               输出 JSON 报告到 stdout',
  '  --md                 输出 Markdown 报告到 stdout',
  '  --list               列出 corpus 中的 property 与 runtime 消费点',
  '  --out <file>         把报告写入文件（.md 后缀写 Markdown，其它写 JSON）',
  '  --quiet              只输出一行结论',
  '  --help               显示本帮助',
].join('\n');

function parseArgs(argv) {
  const options = {
    check: false,
    seed: DEFAULT_SEED,
    cases: null,
    properties: [],
    areas: [],
    tag: null,
    json: false,
    md: false,
    list: false,
    quiet: false,
    shrink: true,
    out: null,
    maxFailures: 3,
    help: false,
  };
  const takeValue = (index, flag) => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) failUsage(flag + ' 需要一个值');
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--')) failUsage('未知参数：' + raw);
    const equals = raw.indexOf('=');
    const flag = equals >= 0 ? raw.slice(0, equals) : raw;
    const inline = equals >= 0 ? raw.slice(equals + 1) : null;
    const value = inline !== null ? inline : null;
    switch (flag) {
      case '--check': options.check = true; break;
      case '--seed': options.seed = normalizeSeed(value !== null ? value : takeValue(index++, flag)); break;
      case '--cases':
        options.cases = Number(value !== null ? value : takeValue(index++, flag));
        if (!Number.isFinite(options.cases) || options.cases < 1) failUsage('--cases 需要正整数');
        break;
      case '--property': options.properties.push(value !== null ? value : takeValue(index++, flag)); break;
      case '--area': options.areas.push(value !== null ? value : takeValue(index++, flag)); break;
      case '--tag': options.tag = value !== null ? value : takeValue(index++, flag); break;
      case '--max-failures':
        options.maxFailures = Number(value !== null ? value : takeValue(index++, flag));
        if (!Number.isFinite(options.maxFailures) || options.maxFailures < 1) failUsage('--max-failures 需要正整数');
        break;
      case '--no-shrink': options.shrink = false; break;
      case '--json': options.json = true; break;
      case '--md': options.md = true; break;
      case '--list': options.list = true; break;
      case '--quiet': options.quiet = true; break;
      case '--out': options.out = value !== null ? value : takeValue(index++, flag); break;
      case '--help': options.help = true; break;
      default: failUsage('未知参数：' + flag);
    }
  }
  if (options.json && options.md) failUsage('--json 与 --md 不能同时使用');
  return options;
}

function failUsage(message) {
  const error = new Error(message);
  error.usage = true;
  throw error;
}

/**
 * Scan the eval kernel + corpus sources for non-deterministic APIs.
 * This is the machine-checkable half of the determinism claim.
 */
export function auditDeterminism({ root = ROOT, directories = ['tools/eval/lib', 'tools/eval/corpus'] } = {}) {
  const files = [];
  for (const directory of directories) {
    const absolute = path.join(root, directory);
    let entries = [];
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
      files.push(relativePosix(root, path.join(absolute, entry.name)));
    }
  }
  files.sort();
  const forbiddenCalls = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const rule of FORBIDDEN_PATTERNS) {
        rule.pattern.lastIndex = 0;
        if (!rule.pattern.test(line)) continue;
        forbiddenCalls.push({ file, line: index + 1, pattern: rule.label, text: line.trim().slice(0, 120) });
      }
    }
  }
  return { ok: forbiddenCalls.length === 0, filesScanned: files.length, forbiddenCalls };
}

function selectCorpus(corpus, options) {
  return selectProperties(corpus, {
    properties: options.properties,
    areas: options.areas,
    tag: options.tag,
  });
}

function printFailureDetails(report) {
  const lines = [];
  for (const failure of report.failures) {
    lines.push('');
    lines.push('[eval] FAIL ' + failure.property + ' case=' + failure.caseIndex + ' seed=' + report.seed + ' caseSeed=' + failure.caseSeed);
    lines.push('[eval]   error: ' + (failure.error && failure.error.code ? failure.error.code + ': ' : '') + String(failure.error && failure.error.message));
    lines.push('[eval]   shrinks=' + failure.shrinks + ' candidates=' + failure.candidatesTested + ' minimalVerified=' + String(failure.minimalVerified));
    lines.push('[eval]   original=' + JSON.stringify(failure.original));
    if (failure.minimal !== null && failure.minimal !== undefined) lines.push('[eval]   minimal=' + JSON.stringify(failure.minimal));
  }
  return lines.join('\n');
}

function writeOut(file, text) {
  const absolute = path.resolve(file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, text, 'utf8');
  return absolute;
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error.usage) {
      console.error('[eval] ' + error.message);
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const cases = options.cases === null
    ? (options.check ? GATE_CASES : DEFAULT_CASES)
    : Math.trunc(options.cases);
  const seed = normalizeSeed(options.seed);

  let corpus;
  try {
    corpus = await loadCorpus();
  } catch (error) {
    console.error('[eval] corpus 加载失败（' + (error && error.code ? error.code : 'infra') + '）：' + String((error && error.message) || error));
    process.exitCode = 2;
    return;
  }

  if (options.list) {
    const lines = [];
    lines.push('[eval] corpus: ' + corpus.properties.length + ' properties / ' + corpus.areas.length + ' areas / ' + corpus.modules.length + ' modules');
    for (const property of corpus.properties) {
      lines.push('');
      lines.push('[' + property.area + '] ' + property.id);
      lines.push('  title: ' + property.title);
      lines.push('  source: ' + property.source);
      lines.push('  gen: ' + property.generator.name);
      for (const consume of property.consumes) lines.push('  runtime: ' + consume.location + '  ' + consume.symbol + (consume.note ? '  # ' + consume.note : ''));
    }
    console.log(lines.join('\n'));
    return;
  }

  const selected = selectCorpus(corpus, options);
  if (selected.length === 0) {
    console.error('[eval] 没有匹配的 property（--property/--area/--tag 过滤过严）');
    process.exitCode = 2;
    return;
  }

  const coverageIssues = options.check ? assertCorpusCoverage(corpus) : [];
  const determinismAudit = options.check ? auditDeterminism() : { ok: true, filesScanned: 0, forbiddenCalls: [] };
  const determinismChecks = [];
  for (const property of selected) {
    const result = verifyDeterminism(property, { seed, cases: Math.min(cases, 8) });
    if (!result.ok) determinismChecks.push({ property: property.id, mismatches: result.mismatches });
  }
  const determinism = {
    verified: determinismChecks.length === 0,
    mismatches: determinismChecks,
  };

  let run;
  try {
    run = await runCorpus(corpus, {
      seed,
      cases,
      shrink: options.shrink,
      maxFailures: options.maxFailures,
      properties: options.properties,
      areas: options.areas,
      tag: options.tag,
    });
  } catch (error) {
    console.error('[eval] 运行失败：' + String((error && error.message) || error));
    process.exitCode = 2;
    return;
  }

  // Replay every retained counterexample from its recorded seed: a failure row
  // that cannot be reproduced deterministically is an infrastructure error.
  const replayIssues = [];
  const byId = new Map(selected.map((property) => [property.id, property]));
  for (const result of run.results) {
    for (const failure of result.failures) {
      if (failure.kind === 'generator') continue;
      const property = byId.get(result.id);
      if (!property) continue;
      const replay = await replayCase(property, {
        seed,
        caseIndex: failure.caseIndex >= 0 ? failure.caseIndex : 0,
        example: failure.example || null,
      });
      failure.replayVerified = replay.ok === true && replay.failed === true;
      if (!failure.replayVerified) replayIssues.push({ property: result.id, caseIndex: failure.caseIndex, example: failure.example || null });
    }
    if (result.failures.some((failure) => failure.minimalVerified === false)) {
      replayIssues.push({ property: result.id, code: 'E_MINIMALITY', message: '收缩结果不是 1-minimal' });
    }
  }

  const areas = corpusSummary(corpus).areas;
  const gate = options.check
    ? {
      mode: 'check',
      ok: coverageIssues.length === 0
        && determinismAudit.ok
        && determinism.verified
        && run.errors.length === 0
        && replayIssues.length === 0
        && run.results.every((result) => result.status === 'passed'),
      coverageIssues,
      replayIssues,
      corpusErrors: run.errors,
      requiredAreas: REQUIRED_AREAS,
    }
    : null;

  const report = buildReport({
    seed,
    cases,
    results: run.results,
    areas,
    determinism: { ...determinism, audits: determinismAudit },
    audits: options.check ? determinismAudit : null,
    gate,
  });

  const structuralIssues = verifyReport(report);
  const gateOk = options.check
    ? gate.ok
      && structuralIssues.length === 0
      && report.summary.failed === 0
      && report.summary.minimalityViolations === 0
    : report.summary.failed === 0;

  const md = renderMarkdown(report);
  if (options.out) {
    const target = writeOut(options.out, path.extname(options.out).toLowerCase() === '.md' ? md : JSON.stringify(report, null, 2) + '\n');
    if (!options.quiet) console.log('[eval] report written: ' + target);
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (options.md) {
    console.log(md);
  } else if (options.quiet) {
    console.log('[eval] verdict=' + (gateOk ? 'PASS' : 'FAIL') + ' digest=' + report.digest
      + ' properties=' + report.summary.properties + ' checks=' + report.summary.checks
      + ' failures=' + report.summary.failures);
  } else {
    console.log(renderSummary(report));
    if (report.failures.length) console.log(printFailureDetails(report));
    if (coverageIssues.length) {
      console.log('');
      console.log('[eval] corpus coverage issues:');
      for (const issue of coverageIssues) console.log('[eval]   ' + issue.code + ' ' + issue.message);
    }
    if (determinismAudit.forbiddenCalls.length) {
      console.log('');
      console.log('[eval] non-deterministic API usage:');
      for (const item of determinismAudit.forbiddenCalls) console.log('[eval]   ' + item.file + ':' + item.line + ' ' + item.pattern);
    }
    if (determinism.mismatches.length) {
      console.log('');
      console.log('[eval] generator determinism mismatches:');
      for (const item of determinism.mismatches) console.log('[eval]   ' + item.property);
    }
    if (replayIssues.length) {
      console.log('');
      console.log('[eval] replay issues:');
      for (const issue of replayIssues) console.log('[eval]   ' + JSON.stringify(issue));
    }
    if (run.errors.length) {
      console.log('');
      console.log('[eval] runner errors:');
      for (const issue of run.errors) console.log('[eval]   ' + issue.property + ' ' + issue.code + ' ' + issue.message);
    }
    for (const issue of structuralIssues) console.log('[eval] report issue: ' + issue.code + ' ' + issue.message);
  }

  if (options.check) {
    if (!gateOk) process.exitCode = 1;
  } else if (report.summary.failed > 0 || run.errors.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('[eval] 未处理错误：' + String((error && error.message) || error));
  process.exitCode = 2;
});
