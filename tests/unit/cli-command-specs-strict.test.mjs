// tests/unit/cli-command-specs-strict.test.mjs —— 高频命令（video/longshot/record/debug/trace）
// 纳入严格参数契约的回归门禁。
//
// 关键约束：这些 spec 是从 `tools/e2e.mjs` 的真实调用形状反推出来的，**不能**为了
// 让校验通过而放宽白名单。所以这里把 E2E 里出现过的每一种调用形状逐条列出来当“必须接受”的
// 基线，再用非法形状证明校验真的在拦。任何一条 E2E 形状被拒，212 条 E2E 就会开始挂。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  COMMAND_SPECS,
  COMMAND_TOPICS,
  COMMON_EXAMPLES,
  renderCommandHelp,
  validateInvocation,
} from '../../cli/lib/command-specs.mjs';
import { ContractError } from '../../cli/lib/arg-contract.mjs';
import {
  auditCommandSpecs,
  countSubcommands,
  dryRunTopics,
  renderCommandIndexBody,
} from '../../tools/readme-commands.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CLI = path.join(REPO, 'cli', 'bridge.mjs');
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-specs-strict-'));

/** 布尔型参数（本测试用到的子集）；其余 `--name` 一律吃下一个 token。 */
const BOOL_FLAGS = new Set([
  'json', 'dry-run', 'quiet', 'verbose', 'help', 'bodies', 'merged', 'with-requests', 'insight',
  'overwrite', 'force-frames', 'include-agent', 'screenshots', 'screenshot', 'prune',
]);

/** 与 cli/bridge.mjs 的 parseArgs 同语义的最小解析器（只为构造 validateInvocation 的入参）。 */
function parseArgv(argv) {
  const flags = Object.create(null);
  const pos = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') { flags.help = true; continue; }
    if (!arg.startsWith('-')) { pos.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    if (BOOL_FLAGS.has(name)) {
      flags[name] = inline === undefined ? true : inline !== 'false';
      continue;
    }
    if (inline !== undefined) {
      flags[name] = inline;
      continue;
    }
    flags[name] = argv[index + 1];
    index += 1;
  }
  return { flags, pos };
}

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, BB_HOME: tempHome, BB_NO_PROBE: '1', BB_AUTO_START: '0', ...env },
  });
}

function singleJson(result) {
  const lines = String(result.stdout || '').trim().split('\n').filter(Boolean);
  if (lines.length !== 1) return null;
  try { return JSON.parse(lines[0]); } catch { return null; }
}

// ---------------------------------------------------------------------------
// 必须接受：tools/e2e.mjs 里出现过的真实调用形状
// ---------------------------------------------------------------------------

const E2E_SHAPES = [
  // video
  ['video', 'start', '--duration', '3s', '--session', 'a1b2'],
  ['video', 'start', '--duration', '3s', '--force-frames', '--session', 'a1b2'],
  ['video', 'status', '--session', 'a1b2'],
  ['video', 'status', 'rec-1', '--session', 'a1b2'],
  ['video', 'list', '--session', 'a1b2'],
  ['video', 'save', 'rec-1', '--out', 'f.webm', '--overwrite', '--session', 'a1b2'],
  ['video', 'verify', 'rec-1', '--session', 'a1b2'],
  ['video', 'prune', '--ttl', '1ms', '--session', 'a1b2'],
  ['video', 'discard', 'rec-1', '--session', 'a1b2'],
  ['video', 'recover', '--session', 'a1b2'],
  ['video', 'recover', '--json'],
  ['video', 'info', 'f.webm', '--session', 'a1b2'],
  ['video', 'trim', 'f.webm', '--out', 't.webm', '--start', '0s', '--end', '5s', '--session', 'a1b2'],
  ['video', 'split', 'f.webm', '--out-dir', 'd', '--parts', '2', '--session', 'a1b2'],
  ['video', 'merge', 'a.webm', 'b.webm', '--out', 'm.webm', '--session', 'a1b2'],
  ['video', 'durability', '--session', 'a1b2'],
  // longshot
  ['longshot', 'recover', 'ls-a1b2', '--out', 'shot.png', '--session', 'a1b2'],
  ['longshot', 'recover', 'ls-a1b2', '--out', 'shot.png', '--json'],
  // record
  ['record', 'start', '--include-agent', '--session', 'a1b2'],
  ['record', 'start', '--screenshots', '--include-agent', '--session', 'a1b2'],
  ['record', 'stop', '--session', 'a1b2'],
  ['record', 'status', '--session', 'a1b2'],
  ['record', 'list', '--session', 'a1b2'],
  ['record', 'list'],
  ['record', 'export', '--out', 'trace-dir', '--screenshot', '--session', 'a1b2'],
  ['record', 'export', 'rec-1', '--out', 'trace-dir', '--session', 'a1b2'],
  // trace
  ['trace', 'start', '--session', 'a1b2'],
  ['trace', 'status', '--session', 'a1b2'],
  ['trace', 'stop', '--out', 'trace.json', '--session', 'a1b2'],
  ['trace', 'stop', '--session', 'a1b2'],
  ['trace', 'summary', 'trace.json', '--session', 'a1b2'],
  ['trace', 'diff', 'a.json', 'b.json', '--session', 'a1b2'],
  ['trace', 'view', 'trace.json', '--debug', 'archive.json', '--out', 'viewer.html', '--limit', '10', '--max-bytes', '4096', '--max-chars', '64'],
  ['trace', 'summary', '--file', 'trace.json'],
  // debug
  ['debug', 'start', '--name', 'e2e-debug', '--bodies', '--session', 'a1b2'],
  ['debug', 'start', '--session', 'a1b2'],
  ['debug', 'stop', '--session', 'a1b2'],
  ['debug', 'status', '--session', 'a1b2'],
  ['debug', 'requests', '--filter', '/api/ping', '--session', 'a1b2'],
  ['debug', 'requests', '--method', 'GET', '--limit', '1', '--session', 'a1b2'],
  ['debug', 'requests', '--session', 'a1b2'],
  ['debug', 'request', '5', '--session', 'a1b2'],
  ['debug', 'request', '5', '--part', 'metadata', '--session', 'a1b2'],
  ['debug', 'console', '--session', 'a1b2'],
  ['debug', 'pages', '--session', 'a1b2'],
  ['debug', 'performance', '--session', 'a1b2'],
  ['debug', 'performance', '--insight', '--session', 'a1b2'],
  ['debug', 'aggregate', '--filter', '/api/ping', '--session', 'a1b2'],
  ['debug', 'aggregate', '--filter', '/api/', '--slow-ms', '500', '--session', 'a1b2'],
  ['debug', 'duplicates', '--window-ms', '10000', '--filter', '/api/ping', '--session', 'a1b2'],
  ['debug', 'coverage', '--session', 'a1b2'],
  ['debug', 'capabilities', '--session', 'a1b2'],
  ['debug', 'ws', '--output', 'ws.json', '--session', 'a1b2'],
  ['debug', 'har', '--output', 'net.har', '--session', 'a1b2'],
  ['debug', 'har-import', 'net.har', '--output', 'archive.json', '--session', 'a1b2'],
  ['debug', 'export', '--output', 'debug.json', '--session', 'a1b2'],
  ['debug', 'query', '--file', 'debug.json', '--filter', '/api/ping', '--session', 'a1b2'],
  ['debug', 'query', '--dir', 'out', '--filter', '/api/ping', '--session', 'a1b2'],
  ['debug', 'analyze', '--file', 'debug.json', '--session', 'a1b2'],
  ['debug', 'archive', '--output', 'archive.json', '--session', 'a1b2'],
  ['debug', 'archives', '--dir', 'out', '--session', 'a1b2'],
  ['debug', 'evidence', '--output', 'evidence.json', '--session', 'a1b2'],
  ['debug', 'evidence', '--file', 'debug.json', '--output', 'evidence.json', '--session', 'a1b2'],
  ['debug', 'journal', '--session', 'a1b2'],
  ['debug', 'journal', '--merged', '--session', 'a1b2'],
  ['debug', 'history', '--session', 'a1b2'],
  ['debug', 'pin', 'req-test', '--session', 'a1b2'],
  ['debug', 'pinned', '--session', 'a1b2'],
  ['debug', 'unpin', 'req-test', '--session', 'a1b2'],
  ['debug', 'operations', '--limit', '10', '--session', 'a1b2'],
  ['debug', 'operation', 'op-1', '--with-requests', '--session', 'a1b2'],
  ['debug', 'fetch_probe', '--ms', '3000', '--session', 'a1b2'],
  ['debug', 'rule_add', '--rule', '{"urlPattern":"*/api/ping*","action":"block"}', '--session', 'a1b2'],
  ['debug', 'rule_add', '--rule-file', 'rule.json', '--session', 'a1b2'],
  ['debug', 'rule_list', '--session', 'a1b2'],
  ['debug', 'rule_disable', '3', '--session', 'a1b2'],
  ['debug', 'rule_remove', '3', '--session', 'a1b2'],
  ['debug', 'rule_enable', '3', '--session', 'a1b2'],
  ['debug', 'rule_clear', '--session', 'a1b2'],
  ['debug', 'rule_export', '--output', 'rules.json', '--session', 'a1b2'],
  ['debug', 'rule_import', '--file', 'rules.json', '--session', 'a1b2'],
  ['debug', 'replay', '5', '--session', 'a1b2'],
  ['debug', 'activity', '--limit', '5', '--session', 'a1b2'],
];

test('E2E 里出现过的调用形状全部通过严格校验（这就是 212 条的参数基线）', () => {
  assert.ok(E2E_SHAPES.length >= 70, 'E2E 形状样本太少：' + E2E_SHAPES.length);
  const failures = [];
  for (const argv of E2E_SHAPES) {
    const { flags, pos } = parseArgv([...argv, '--json']);
    try {
      const invocation = validateInvocation(pos[0], flags, pos);
      if (!invocation) failures.push(argv.join(' ') + ' → 未命中任何 spec');
      else if (invocation.sub !== pos[1] && invocation.sub !== 'default') {
        failures.push(argv.join(' ') + ' → 解析出子命令 ' + invocation.sub);
      }
    } catch (error) {
      failures.push(argv.join(' ') + ' → ' + (error.code || error.name) + '：' + error.message);
    }
  }
  assert.deepEqual(failures, []);
});

// ---------------------------------------------------------------------------
// 必须拒绝：非法 flag / 子命令 / 枚举 / 缺参 / 互斥
// ---------------------------------------------------------------------------

const REJECTED = [
  ['video start 不接受 --ref', ['video', 'start', '--ref', '@e1'], 'E_UNKNOWN_FLAG'],
  ['video start 不接受多余位置参数', ['video', 'start', 'x'], 'E_ARG_UNEXPECTED'],
  ['video start 时长非法', ['video', 'start', '--duration', '5x'], 'E_ARG_TYPE'],
  ['video save 缺 --out', ['video', 'save', 'rec-1'], 'E_ARG_MISSING'],
  ['video split --parts 越界', ['video', 'split', 'f.webm', '--out-dir', 'd', '--parts', '0'], 'E_ARG_RANGE'],
  ['video merge 只有一个输入', ['video', 'merge', 'a.webm', '--out', 'm.webm'], 'E_ARG_MISSING'],
  ['video 未知子命令', ['video', 'frobnicate'], 'E_BAD_SUBCOMMAND'],
  ['longshot recover 缺 --out', ['longshot', 'recover', 'ls-1'], 'E_ARG_MISSING'],
  ['longshot recover 多余参数', ['longshot', 'recover', 'ls-1', '--out', 's.png', 'extra'], 'E_ARG_UNEXPECTED'],
  ['record start 不接受 --limit', ['record', 'start', '--limit', '3'], 'E_UNKNOWN_FLAG'],
  ['record export 不接受 --overwrite', ['record', 'export', '--overwrite'], 'E_UNKNOWN_FLAG'],
  ['trace view 缺文件', ['trace', 'view'], 'E_ARG_MISSING'],
  ['trace summary 缺文件', ['trace', 'summary'], 'E_ARG_MISSING'],
  ['trace diff 只有一个文件', ['trace', 'diff', 'a.json'], 'E_ARG_MISSING'],
  ['trace stop 不接受位置参数', ['trace', 'stop', 'trace.json'], 'E_ARG_UNEXPECTED'],
  ['debug requests --kind 非法', ['debug', 'requests', '--kind', 'nope'], 'E_ARG_ENUM'],
  ['debug requests --state 非法', ['debug', 'requests', '--state', 'solid'], 'E_ARG_ENUM'],
  ['debug requests --status 越界', ['debug', 'requests', '--status', '999'], 'E_ARG_RANGE'],
  ['debug start 不接受 --limit', ['debug', 'start', '--limit', '3'], 'E_UNKNOWN_FLAG'],
  ['debug request 非整数 id', ['debug', 'request', 'abc'], 'E_ARG_TYPE'],
  ['debug rule_add 缺 --rule', ['debug', 'rule_add'], 'E_ARG_MISSING'],
  ['debug rule_add --rule 与 --rule-file 互斥', ['debug', 'rule_add', '--rule', '{"a":1}', '--rule-file', 'r.json'], 'E_ARG_CONFLICT'],
  ['debug query 缺 --file/--dir', ['debug', 'query'], 'E_ARG_MISSING'],
  ['debug query --file 与 --dir 互斥', ['debug', 'query', '--file', 'a.json', '--dir', 'out'], 'E_ARG_CONFLICT'],
  ['debug query 不接受位置参数', ['debug', 'query', 'a.json', '--file', 'a.json'], 'E_ARG_UNEXPECTED'],
  ['debug archive 缺 --output', ['debug', 'archive'], 'E_ARG_MISSING'],
  ['debug archives 缺 --dir', ['debug', 'archives'], 'E_ARG_MISSING'],
  ['debug har-import 缺 --output', ['debug', 'har-import', 'net.har'], 'E_ARG_MISSING'],
  ['debug rule_export 缺 --output', ['debug', 'rule_export'], 'E_ARG_MISSING'],
  ['debug rule_export 不接受 --limit', ['debug', 'rule_export', '--output', 'r.json', '--limit', '3'], 'E_UNKNOWN_FLAG'],
  ['debug rule_remove 非整数 id', ['debug', 'rule_remove', 'x'], 'E_ARG_TYPE'],
  ['debug operation 缺 id', ['debug', 'operation'], 'E_ARG_MISSING'],
  ['debug 缺子命令', ['debug'], 'E_BAD_SUBCOMMAND'],
];

test('非法形状在参数层被拒绝：code + hint + usage 齐全（不发 RPC）', () => {
  const failures = [];
  for (const [label, argv, expected] of REJECTED) {
    const { flags, pos } = parseArgv(argv);
    try {
      validateInvocation(pos[0], flags, pos);
      failures.push(label + ' → 未抛错');
    } catch (error) {
      if (!(error instanceof ContractError)) failures.push(label + ' → 抛的不是 ContractError：' + error.name);
      else {
        if (error.code !== expected) failures.push(label + ' → code=' + error.code + ' 期望 ' + expected);
        if (!error.hint) failures.push(label + ' → 缺 hint');
        if (!error.usage) failures.push(label + ' → 缺 usage');
      }
    }
  }
  assert.deepEqual(failures, []);
});

// ---------------------------------------------------------------------------
// CLI 黑盒：错误信封 + dry-run 不触达 daemon
// ---------------------------------------------------------------------------

test('CLI 黑盒：参数错误退出 2 且 stdout 是单行 bb.cli/1 错误信封', () => {
  const cases = [
    ['debug', 'requests', '--since', '1h'], // 该子命令不支持 --since
    ['video', 'start', '--duration', '5x'],
    ['video', 'save', 'rec-1'],
    ['debug', 'requests', '--kind', 'nope'],
  ];
  for (const argv of cases) {
    const result = runCli([...argv, '--json']);
    assert.equal(result.status, 2, argv.join(' ') + '：' + result.stderr);
    const parsed = singleJson(result);
    assert.ok(parsed, argv.join(' ') + ' stdout 不是单行 JSON：' + result.stdout);
    assert.equal(parsed.schema, 'bb.cli/1', argv.join(' '));
    assert.equal(parsed.ok, false, argv.join(' '));
    assert.ok(parsed.error && parsed.error.code, argv.join(' ') + ' 缺 error.code');
    assert.ok(parsed.error.hint && parsed.error.usage, argv.join(' ') + ' 缺 hint/usage');
  }
});

test('CLI 黑盒：五个命令的 --dry-run 在无 daemon 时也退出 0（证明没有 RPC）', () => {
  const cases = [
    ['video', 'save', 'rec-1', '--out', 'demo.webm'],
    ['longshot', 'recover', 'ls-1', '--out', 'shot.png'],
    ['record', 'export', '--out', 'trace-dir'],
    ['debug', 'requests', '--filter', '/api/'],
    ['trace', 'view', 'trace.json', '--out', 'viewer.html'],
  ];
  for (const argv of cases) {
    const result = runCli([...argv, '--dry-run', '--json']);
    assert.equal(result.status, 0, argv.join(' ') + '：' + result.stderr);
    const parsed = singleJson(result);
    assert.ok(parsed && parsed.dryRun === true, argv.join(' ') + ' 未返回 dryRun：' + result.stdout.slice(0, 200));
    assert.equal(parsed.result.executed, false, argv.join(' '));
    assert.ok(parsed.result.steps.length >= 1, argv.join(' ') + ' 没有步骤');
  }
});

test('CLI 黑盒：debug 的 --slow-ms / --min-duration 已能被解析（历史漏注册回归）', () => {
  const aggregate = runCli(['debug', 'aggregate', '--slow-ms', '500', '--dry-run', '--json']);
  assert.equal(aggregate.status, 0, aggregate.stderr);
  const analyze = runCli(['debug', 'analyze', '--file', 'a.json', '--min-duration', '100', '--dry-run', '--json']);
  assert.equal(analyze.status, 0, analyze.stderr);
  const query = runCli(['debug', 'query', '--file', 'a.json', '--min-duration', '100', '--dry-run', '--json']);
  assert.equal(query.status, 0, query.stderr);
});

// ---------------------------------------------------------------------------
// 帮助 / README 索引自动覆盖新命令
// ---------------------------------------------------------------------------

test('bridge help <命令> 由 spec 渲染，且 --help 等价', () => {
  for (const topic of ['video', 'longshot', 'record', 'debug', 'trace']) {
    const spec = COMMAND_SPECS[topic];
    const viaTopic = runCli(['help', topic]);
    assert.equal(viaTopic.status, 0, topic + '：' + viaTopic.stderr);
    assert.equal(viaTopic.stdout.trimEnd(), renderCommandHelp(topic), topic + ' 帮助与渲染器不一致');
    for (const name of spec.order) {
      assert.ok(viaTopic.stdout.includes(spec.subs[name].usage), topic + ' 帮助缺少用法：' + spec.subs[name].usage);
      assert.ok(viaTopic.stdout.includes('--dry-run'), topic + ' 帮助缺少 --dry-run');
    }
    const viaFlag = runCli([topic, '--help']);
    assert.equal(viaFlag.status, 0, topic + ' --help：' + viaFlag.stderr);
    assert.equal(viaFlag.stdout, viaTopic.stdout, topic + ' 两种帮助写法不一致');
  }
});

test('全局帮助的命令主题与示例包含新命令', () => {
  const help = runCli(['help']);
  assert.equal(help.status, 0, help.stderr);
  assert.ok(help.stdout.includes(COMMAND_TOPICS.join(' | ')), '全局帮助缺少命令主题清单');
  for (const topic of ['video', 'longshot', 'record', 'debug', 'trace']) {
    assert.ok(COMMAND_TOPICS.includes(topic), 'COMMAND_TOPICS 缺少 ' + topic);
  }
  for (const example of COMMON_EXAMPLES) {
    assert.ok(help.stdout.includes(example), '全局帮助缺少示例：' + example);
  }
});

test('README 命令索引生成器自动覆盖新命令（覆盖数字 + dry-run 列表）', () => {
  assert.deepEqual(dryRunTopics(), ['video', 'longshot', 'record', 'debug', 'trace']);
  assert.ok(countSubcommands() >= 100, '子命令总数异常：' + countSubcommands());
  const body = renderCommandIndexBody();
  assert.ok(body.includes('覆盖面：' + COMMAND_TOPICS.length + ' 个命令 / ' + countSubcommands() + ' 个子命令'));
  for (const topic of ['video', 'longshot', 'record', 'debug', 'trace']) {
    assert.ok(body.includes('`bridge ' + topic + '`'), 'README 索引缺少 ' + topic);
  }
  assert.ok(body.includes('`video`、`longshot`、`record`、`debug`、`trace`'), 'README 未列出 dry-run 覆盖的命令');
  assert.deepEqual(auditCommandSpecs(COMMAND_SPECS), []);
});

test('README --check 与 specs 一致（新命令已生成，无漂移）', () => {
  const result = spawnSync(process.execPath, [path.join(REPO, 'tools', 'readme-commands.mjs'), '--check'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(result.status, 0, String(result.stderr || result.stdout).slice(0, 400));
  assert.ok(String(result.stdout).includes('clean'), String(result.stdout));
});
