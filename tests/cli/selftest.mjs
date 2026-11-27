// tests/cli/selftest.mjs — daemon + CLI 全链路自测（不依赖真实浏览器）。
//
// 流程：临时 BB_HOME/BB_PORT 起 daemon → mock-extension 连 /ws →
// 用 CLI 跑 status/session/browsers/navigate/observe/screenshot/evaluate/... →
// 断言退出码与输出 → 停 daemon、删临时目录。全部通过时退出码 0。
//
// 运行：node tests/cli/selftest.mjs

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signRelease } from '../../lib/release-sign.mjs';
import { JSON_SCHEMA_ID, decorateJson, normalizePage, validateEnvelope } from '../../cli/lib/json-contract.mjs';
import { COMMAND_SPECS, COMMAND_TOPICS, COMMON_EXAMPLES, renderCommandHelp, validateInvocation } from '../../cli/lib/command-specs.mjs';
import { projectRecipeSteps } from '../../cli/commands/recipe.mjs';

const NODE = process.execPath;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
const SERVER = path.join(REPO, 'daemon', 'server.mjs');
const CLI = path.join(REPO, 'cli', 'bridge.mjs');
const MOCK = path.join(HERE, 'mock-extension.mjs');
const DAEMON_JSON = () => path.join(homeDir, 'daemon.json');

let homeDir = '';
let port = 0;
let daemonProc = null;
let mockProc = null;
let daemonOutput = [];
let mockOutput = [];

let passCount = 0;
let failCount = 0;
const failures = [];

// ---------------------------------------------------------------------------
// 断言与输出
// ---------------------------------------------------------------------------

function section(title) {
  console.log(`\n== ${title} ==`);
}

function check(name, ok, detail = '') {
  if (ok) {
    passCount += 1;
    console.log(`  [PASS] ${name}`);
  } else {
    failCount += 1;
    failures.push(name);
    console.log(`  [FAIL] ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true;
    } catch { /* 继续重试 */ }
    await sleep(intervalMs);
  }
  return false;
}

// ---------------------------------------------------------------------------
// HTTP 辅助
// ---------------------------------------------------------------------------

function httpRequest({ port: requestPort = port, method = 'GET', pathname = '/', headers = {}, body, timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const requestHeaders = { ...headers };
    if (payload) {
      requestHeaders['content-type'] = 'application/json';
      requestHeaders['content-length'] = payload.length;
    }
    const req = http.request({
      host: '127.0.0.1',
      port: requestPort,
      path: pathname,
      method,
      agent: false,
      headers: requestHeaders,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function health() {
  try {
    const res = await httpRequest({ pathname: '/health', timeoutMs: 800 });
    return res.json && res.json.service === 'browser-bridge' ? res.json : null;
  } catch {
    return null;
  }
}

function readDaemonInfo() {
  try {
    return JSON.parse(fs.readFileSync(DAEMON_JSON(), 'utf8'));
  } catch {
    return null;
  }
}

async function directRpc(method, params = {}) {
  const info = readDaemonInfo();
  if (!info) return null;
  try {
    const res = await httpRequest({
      port: info.port,
      method: 'POST',
      pathname: '/rpc',
      headers: { 'x-bridge-token': info.token },
      body: { method, params },
      timeoutMs: 5000,
    });
    return res.json;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 子进程辅助
// ---------------------------------------------------------------------------

function baseEnv() {
  // BB_NO_PROBE：测试机可能还有别的 daemon 占着 52900，猜孤儿端口会污染自动拉起用例。
  return { ...process.env, BB_HOME: homeDir, BB_PORT: String(port), BB_NO_PROBE: '1' };
}

function runNode(args, { timeoutMs = 30_000, env = baseEnv() } = {}) {
  return new Promise((resolve) => {
    const child = spawn(NODE, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* 忽略 */ }
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function runCli(args, options = {}) {
  return runNode([CLI, ...args], options);
}

function jsonOf(result) {
  try {
    return JSON.parse(String(result.stdout).trim());
  } catch {
    return null;
  }
}

function singleLineJson(result) {
  const lines = String(result.stdout).trim().split('\n');
  return lines.length === 1 && jsonOf(result) !== null;
}

function startDaemonProcess() {
  daemonProc = spawn(NODE, [SERVER, '--foreground', '--port', String(port)], {
    env: baseEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  daemonProc.stdout.on('data', (chunk) => daemonOutput.push(String(chunk)));
  daemonProc.stderr.on('data', (chunk) => daemonOutput.push(String(chunk)));
  return daemonProc;
}

function startMockProcess(extraArgs = []) {
  mockProc = spawn(NODE, [MOCK, '--port', String(port), ...extraArgs], {
    env: baseEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  mockProc.stdout.on('data', (chunk) => mockOutput.push(String(chunk)));
  mockProc.stderr.on('data', (chunk) => mockOutput.push(String(chunk)));
  return mockProc;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

// ---------------------------------------------------------------------------
// 自测主体
// ---------------------------------------------------------------------------

async function runTests() {
  homeDir = path.join(os.tmpdir(), `bb-selftest-${process.pid}-${Date.now().toString(36)}`);
  fs.mkdirSync(homeDir, { recursive: true });
  port = await freePort();
  console.log(`[setup] BB_HOME=${homeDir}`);
  console.log(`[setup] BB_PORT=${port}`);
  console.log(`[setup] node=${NODE}`);

  // -------------------------------------------------------------------------
  section('1. daemon 启动与 daemon.json');
  startDaemonProcess();
  const ready = await waitFor(async () => !!(await health()), 12_000, 120);
  if (!ready) {
    throw new Error(`daemon 未能启动：\n${daemonOutput.join('')}`);
  }
  check('daemon /health 就绪', true);

  const healthInfo = await health();
  check('health 字段齐全', Boolean(
    healthInfo
    && healthInfo.ok === true
    && healthInfo.service === 'browser-bridge'
    && healthInfo.pid === daemonProc.pid
    && healthInfo.port === port
    && healthInfo.browsers === 0
    && healthInfo.sessions === 0
    && healthInfo.uptimeMs >= 0
  ), JSON.stringify(healthInfo));

  const info = readDaemonInfo();
  check('daemon.json 已原子写入', Boolean(info));
  check('daemon.json pid 指向本 daemon', info && info.pid === daemonProc.pid, `json=${info && info.pid} child=${daemonProc.pid}`);
  check('daemon.json port 是实际监听端口', info && info.port === port, `json=${info && info.port} expect=${port}`);
  check('daemon.json version=' + PKG_VERSION, info && info.version === PKG_VERSION);
  check('daemon.json token 为 32 位 hex', Boolean(info && /^[0-9a-f]{32}$/.test(info.token || '')));
  check('daemon.json startedAt 为时间戳', Boolean(info && Number.isFinite(info.startedAt)));

  // -------------------------------------------------------------------------
  section('2. HTTP 鉴权与路由（PROTOCOL §2）');
  const wrongToken = await httpRequest({
    method: 'POST',
    pathname: '/rpc',
    headers: { 'x-bridge-token': '0'.repeat(32) },
    body: { method: 'status', params: {} },
  });
  check('错误 token → 401 + E_AUTH', wrongToken.status === 401 && wrongToken.json && wrongToken.json.error.code === 'E_AUTH');
  const unknown = await httpRequest({
    method: 'POST',
    pathname: '/rpc',
    headers: { 'x-bridge-token': info.token },
    body: { method: '__nope__', params: {} },
  });
  check('未知方法 → 404 + E_UNKNOWN_METHOD', unknown.status === 404 && unknown.json && unknown.json.error.code === 'E_UNKNOWN_METHOD');
  const noRoute = await httpRequest({ pathname: '/nope' });
  check('未知路径 → 404', noRoute.status === 404);

  // -------------------------------------------------------------------------
  section('3. CLI 基础命令（无浏览器）');
  const status1 = await runCli(['status', '--json']);
  check('bridge status --json 退出码 0', status1.code === 0, status1.stderr);
  check('--json 模式 stdout 只有一行 JSON', singleLineJson(status1), status1.stdout);
  const statusJson = jsonOf(status1);
  check('status.browsers 为空', Boolean(statusJson && statusJson.ok === true && statusJson.result.browsers.length === 0));

  const browsers1 = await runCli(['browsers', '--json']);
  check('bridge browsers --json 退出码 0', browsers1.code === 0);
  check('browsers 为空数组', Boolean(jsonOf(browsers1) && jsonOf(browsers1).result.browsers.length === 0));

  const daemonStatus = await runCli(['daemon', 'status']);
  check('bridge daemon status 显示运行中', daemonStatus.code === 0 && daemonStatus.stdout.includes(`pid ${daemonProc.pid}`), daemonStatus.stdout);

  const daemonStart = await runCli(['daemon', 'start']);
  check('bridge daemon start 幂等', daemonStart.code === 0 && /daemon/.test(daemonStart.stdout), daemonStart.stdout);
  check('daemon start 未重复启动（pid 不变）', (readDaemonInfo() || {}).pid === daemonProc.pid);

  const daemonLog = await runCli(['daemon', 'log', '--tail']);
  check('bridge daemon log --tail 有内容', daemonLog.code === 0 && daemonLog.stdout.includes('daemon'), daemonLog.stderr);

  section('3b. schema / help（单一来源）');
  const schemaClick = await runCli(['schema', 'click', '--json']);
  const schemaClickJson = jsonOf(schemaClick);
  check('schema click 返回 flags 与 schema',
    schemaClick.code === 0
    && Boolean(schemaClickJson && schemaClickJson.ok === true)
    && schemaClickJson.result.flags.includes('--wait-timeout')
    && schemaClickJson.result.schema.properties.trusted.type === 'boolean',
    schemaClick.stdout + schemaClick.stderr);
  const helpClick = await runCli(['help', 'click']);
  check('help click 由 schema 生成',
    helpClick.code === 0
    && helpClick.stdout.includes('scope=session')
    && helpClick.stdout.includes('--wait-timeout'),
    helpClick.stdout + helpClick.stderr);
  const helpUnknown = await runCli(['help', 'not.a.method']);
  check('help 未知方法退出码 2', helpUnknown.code === 2, String(helpUnknown.code));

  // -------------------------------------------------------------------------
  section('3c. 参数契约（非法组合在参数层拒绝，退出码 2 + code + hint）');
  const contractProblems = (result, expectedCode) => {
    const parsed = jsonOf(result);
    const problems = [];
    if (result.code !== 2) problems.push('exit=' + result.code);
    if (!parsed) problems.push('stdout 不是 JSON');
    else {
      if (parsed.ok !== false) problems.push('ok!==false');
      if (parsed.schema !== JSON_SCHEMA_ID) problems.push('schema=' + parsed.schema);
      if (!parsed.error || typeof parsed.error.code !== 'string') problems.push('缺 error.code');
      else if (parsed.error.code !== expectedCode) problems.push('code=' + parsed.error.code);
      if (!parsed.error || typeof parsed.error.hint !== 'string' || !parsed.error.hint) problems.push('缺 error.hint');
      if (!parsed.error || typeof parsed.error.usage !== 'string' || !parsed.error.usage) problems.push('缺 error.usage');
    }
    return problems.join('；');
  };
  const contractCases = [
    ['session start --share 缺 --tab', ['session', 'start', '--share'], 'E_ARG_REQUIRES'],
    ['session start --project 缺 --agent-name', ['session', 'start', '--project', 'p1'], 'E_ARG_REQUIRES'],
    ['session start --focus/--no-focus 互斥', ['session', 'start', '--focus', '--no-focus'], 'E_ARG_CONFLICT'],
    ['session start --tab 0 越界', ['session', 'start', '--tab', '0'], 'E_ARG_RANGE'],
    ['session start --control 非法枚举', ['session', 'start', '--control', 'shared'], 'E_ARG_ENUM'],
    ['session start --min-interval 非法时长', ['session', 'start', '--min-interval', '5x'], 'E_ARG_TYPE'],
    ['session stop 缺 id 与 --all', ['session', 'stop'], 'E_ARG_MISSING'],
    ['session stop --all 与位置 id 同时给', ['session', 'stop', '--all', 'abcd'], 'E_ARG_CONFLICT'],
    ['session rebind 缺 --tab', ['session', 'rebind', 'abcd'], 'E_ARG_MISSING'],
    ['session claim-control --lease 非时长', ['session', 'claim-control', 'abcd', '--lease', 'soon'], 'E_ARG_TYPE'],
    ['session control --mode 非法', ['session', 'control', 'abcd', '--mode', 'solo'], 'E_ARG_ENUM'],
    ['session handoff --to 指向自己', ['session', 'handoff', 'abcd', '--to', 'abcd'], 'E_ARG_CONFLICT'],
    ['session list 不允许 --tab', ['session', 'list', '--tab', '3'], 'E_UNKNOWN_FLAG'],
    ['tab close 非整数 tabId', ['tab', 'close', 'abc'], 'E_ARG_TYPE'],
    ['tab list 不允许 --limit', ['tab', 'list', '--limit', '5'], 'E_UNKNOWN_FLAG'],
    ['tab move 缺 --to-window', ['tab', 'move', '12'], 'E_ARG_MISSING'],
    ['tab move --to-window 非整数', ['tab', 'move', '12', '--to-window', 'x'], 'E_ARG_TYPE'],
    ['tab policy 没有任何策略开关', ['tab', 'policy', '12'], 'E_ARG_MISSING'],
    ['tab cleanup --idle-ms 非法时长', ['tab', 'cleanup', '--idle-ms', '10x'], 'E_ARG_TYPE'],
    ['plan --steps 为空数组', ['plan', '--steps', '[]'], 'E_ARG_TYPE'],
    ['plan --steps 非 JSON', ['plan', '--steps', 'not-json'], 'E_ARG_TYPE'],
    ['plan 同时给 --steps/--steps-file', ['plan', '--steps', '[]', '--steps-file', 'p.json'], 'E_ARG_REQUIRES'],
    ['plan 不允许 --grep', ['plan', '--steps', '[{"method":"click"}]', '--grep', 'x'], 'E_UNKNOWN_FLAG'],
    ['recipe approve 缺 --confirm-human', ['recipe', 'approve', 'x'], 'E_HUMAN_GATE'],
    ['recipe save 缺 --file', ['recipe', 'save', 'x'], 'E_ARG_MISSING'],
    ['recipe run 缺名字', ['recipe', 'run'], 'E_ARG_MISSING'],
    ['open --observe 缺 URL', ['open', '--observe'], 'E_ARG_REQUIRES'],
    ['open 非 http(s) URL', ['open', 'ftp://example.com/'], 'E_ARG_TYPE'],
    ['open 多余位置参数', ['open', 'https://a.example/', 'https://b.example/'], 'E_ARG_UNEXPECTED'],
    ['open 不允许 --session', ['open', 'https://a.example/', '--session', 'abcd'], 'E_ARG_CONFLICT'],
    ['extract --format 非法枚举', ['extract', '--format', 'xml'], 'E_ARG_ENUM'],
    ['extract --format csv 缺 --out', ['extract', '--format', 'csv'], 'E_ARG_REQUIRES'],
    ['extract --csv-safe 非 csv', ['extract', '--csv-safe'], 'E_ARG_REQUIRES'],
    ['extract discover 不接受 --out', ['extract', 'discover', '--out', 'x.csv'], 'E_ARG_CONFLICT'],
    ['extract table 缺目标', ['extract', 'table'], 'E_ARG_MISSING'],
    ['extract list --fields-json 非 JSON', ['extract', 'list', '--selector', '#x', '--fields-json', 'nope'], 'E_ARG_TYPE'],
    ['wait-for-element 缺目标', ['wait-for-element'], 'E_ARG_MISSING'],
    ['wait-for-element --state 非法', ['wait-for-element', '#x', '--state', 'solid'], 'E_ARG_ENUM'],
    ['wait-for-element 位置目标与 --ref 冲突', ['wait-for-element', '#x', '--ref', '@e1'], 'E_ARG_CONFLICT'],
    ['wait-for-navigation --wait-until 非法', ['wait-for-navigation', '--wait-until', 'paint'], 'E_ARG_ENUM'],
    ['view 文件模式不接受 --grep', ['view', 'notes.txt', '--grep', 'x'], 'E_ARG_CONFLICT'],
    ['session 未知子命令', ['session', 'frobnicate'], 'E_BAD_SUBCOMMAND'],
    ['tab 缺子命令', ['tab'], 'E_BAD_SUBCOMMAND'],
    // W7：video/longshot/record/debug/trace 的严格契约（与 E2E 的调用形状逐条对齐）
    ['video start 不接受 --ref', ['video', 'start', '--ref', '@e1'], 'E_UNKNOWN_FLAG'],
    ['video save 缺 --out', ['video', 'save', 'rec-1'], 'E_ARG_MISSING'],
    ['video split --parts 0 越界', ['video', 'split', 'f.webm', '--out-dir', 'd', '--parts', '0'], 'E_ARG_RANGE'],
    ['video 未知子命令', ['video', 'frobnicate'], 'E_BAD_SUBCOMMAND'],
    ['longshot recover 缺 --out', ['longshot', 'recover', 'ls-1'], 'E_ARG_MISSING'],
    ['record start 不接受 --limit', ['record', 'start', '--limit', '3'], 'E_UNKNOWN_FLAG'],
    ['trace view 缺文件', ['trace', 'view'], 'E_ARG_MISSING'],
    ['trace diff 只有一个文件', ['trace', 'diff', 'a.json'], 'E_ARG_MISSING'],
    ['debug requests --kind 非法', ['debug', 'requests', '--kind', 'nope'], 'E_ARG_ENUM'],
    ['debug requests --status 越界', ['debug', 'requests', '--status', '999'], 'E_ARG_RANGE'],
    ['debug request 非整数 id', ['debug', 'request', 'abc'], 'E_ARG_TYPE'],
    ['debug rule_add --rule/--rule-file 互斥', ['debug', 'rule_add', '--rule', '{"a":1}', '--rule-file', 'r.json'], 'E_ARG_CONFLICT'],
    ['debug query 缺 --file/--dir', ['debug', 'query'], 'E_ARG_MISSING'],
    ['debug archive 缺 --output', ['debug', 'archive'], 'E_ARG_MISSING'],
    ['debug 缺子命令', ['debug'], 'E_BAD_SUBCOMMAND'],
  ];
  for (const [label, args, code] of contractCases) {
    const result = await runCli([...args, '--json']);
    const problems = contractProblems(result, code);
    check(`参数层拒绝：${label}（${code}）`, problems === '', problems + ' | ' + String(result.stderr).split('\n')[0]);
  }
  const humanArg = await runCli(['session', 'start', '--share']);
  check('人类模式参数错误：退出码 2 + 代码 + 提示 + 用法',
    humanArg.code === 2
    && humanArg.stderr.includes('参数错误：')
    && humanArg.stderr.includes('E_ARG_REQUIRES')
    && humanArg.stderr.includes('提示：')
    && humanArg.stderr.includes('用法：')
    && humanArg.stderr.includes('运行 bridge -h 查看用法'),
    humanArg.stderr.slice(0, 300));
  const badSub = jsonOf(await runCli(['tab', 'frobnicate', '--json']));
  check('未知子命令给出可用子命令清单', Boolean(badSub && badSub.error && /可用子命令/.test(badSub.error.hint || '') && /close/.test(badSub.error.hint || '')));

  // -------------------------------------------------------------------------
  section('3d. 契约模块与帮助文本（纯函数/命令主题）');
  const pageFromLimit = normalizePage({ returned: 2, limit: 2 });
  check('normalizePage: returned>=limit → hasMore 且 total 是下界',
    Boolean(pageFromLimit && pageFromLimit.hasMore === true && pageFromLimit.total === 2 && pageFromLimit.totalExact === false));
  const pageExact = normalizePage({ returned: 1, total: 7, truncated: false });
  check('normalizePage: 声明总数 → totalExact=true 且不虚报 hasMore',
    Boolean(pageExact && pageExact.total === 7 && pageExact.totalExact === true && pageExact.hasMore === false && pageExact.truncated === false));
  const decorated = decorateJson({ ok: true, result: { a: 1 } }, { command: 'tab', subcommand: 'list', flags: {} });
  check('decorateJson 只追加 schema/command 且保留 result 语义',
    decorated.schema === JSON_SCHEMA_ID && decorated.command === 'tab' && decorated.subcommand === 'list' && decorated.result.a === 1 && decorated.ok === true);
  const undecorated = decorateJson({ foo: 1 }, { command: 'x' });
  check('decorateJson 不改写非 ok 对象', undecorated.schema === undefined && undecorated.foo === 1);
  const failureEnvelope = decorateJson({ ok: false, error: { code: 'E_NO_SESSION', message: 'x' } }, { command: 'observe' });
  check('失败信封补 error.hint（错误码单一来源）', Boolean(failureEnvelope.schema === JSON_SCHEMA_ID && failureEnvelope.error.hint));
  check('validateEnvelope 接受合规成功信封', validateEnvelope(decorated).length === 0);
  check('validateEnvelope 接受合规失败信封', validateEnvelope(failureEnvelope).length === 0);
  check('validateEnvelope 能发现坏 page/hint', validateEnvelope({ schema: 'nope', ok: true, page: { hasMore: 'x' }, command: 3 }).length >= 3);
  const requiredTopics = ['session', 'tab', 'plan', 'recipe', 'open', 'extract', 'wait-for-element', 'wait-for-navigation'];
  check('command specs 覆盖 8 个目标命令（另有 step/view 主题）',
    requiredTopics.every((topic) => COMMAND_TOPICS.includes(topic) && Boolean(COMMAND_SPECS[topic]))
    && COMMAND_TOPICS.length >= 8);
  check('每个子命令都有 usage/风险/示例', COMMAND_TOPICS.every((topic) => {
    const spec = COMMAND_SPECS[topic];
    return spec.order.every((name) => {
      const sub = spec.subs[name];
      return Boolean(sub && sub.usage && sub.risk && Array.isArray(sub.examples) && sub.examples.length >= 1);
    });
  }));
  const tabHelp = renderCommandHelp('tab');
  check('renderCommandHelp 含用法/参数/风险/示例',
    tabHelp.includes('用法：') && tabHelp.includes('--scope') && tabHelp.includes('风险：') && tabHelp.includes('示例') && tabHelp.includes('bridge tab close 123'));
  let invocationError = null;
  try {
    validateInvocation('tab', { share: true }, ['tab', 'close', '12']);
  } catch (error) {
    invocationError = error;
  }
  check('validateInvocation 拒绝该子命令不支持的参数', Boolean(invocationError && invocationError.code === 'E_UNKNOWN_FLAG'));
  const invocationOk = validateInvocation('session', { limit: '5' }, ['session', 'run-log', 'abcd']);
  check('validateInvocation 返回解析后的命令上下文',
    Boolean(invocationOk && invocationOk.command === 'session' && invocationOk.sub === 'run-log' && invocationOk.subSpec.usage.includes('run-log')));
  const projection = projectRecipeSteps([
    { method: 'click' },
    { type: 'human', reason: '人工登录' },
    { type: 'loop', times: 2, steps: [{ method: 'fill' }] },
    { type: 'if', when: { urlIncludes: '/a' }, then: [{ method: 'press' }], else: [] },
  ]);
  check('recipe 投影展开 human/loop/if 分支',
    projection.humanNodes.length === 1
    && projection.loopCounts[0] === 2
    && projection.methods.filter((method) => method === 'fill').length === 2
    && projection.methods.includes('click')
    && projection.methods.includes('press'));
  const helpSession = await runCli(['help', 'session']);
  check('bridge help session 给出参数表与可执行示例',
    helpSession.code === 0
    && helpSession.stdout.includes('bridge session start')
    && helpSession.stdout.includes('--share')
    && helpSession.stdout.includes('示例')
    && helpSession.stdout.includes('bridge session start --browser edge'),
    helpSession.stdout.slice(0, 200));
  const helpTabFlag = await runCli(['tab', '--help']);
  check('bridge tab --help 等价命令帮助',
    helpTabFlag.code === 0 && helpTabFlag.stdout.includes('bridge tab') && helpTabFlag.stdout.includes('browser_mutation'),
    helpTabFlag.stdout.slice(0, 200));
  const helpExtract = await runCli(['help', 'extract']);
  check('bridge help extract 含 CSV/游标示例',
    helpExtract.code === 0
    && helpExtract.stdout.includes('extract table')
    && helpExtract.stdout.includes('--format csv')
    && helpExtract.stdout.includes('extract --cursor'),
    helpExtract.stdout.slice(0, 200));
  const helpRecipe = await runCli(['help', 'recipe']);
  check('bridge help recipe 含审批闸门说明',
    helpRecipe.code === 0 && helpRecipe.stdout.includes('recipe approve') && helpRecipe.stdout.includes('confirm-human'),
    helpRecipe.stdout.slice(0, 200));
  const helpWait = await runCli(['help', 'wait-for-element']);
  check('bridge help wait-for-element 含 state 枚举与示例',
    helpWait.code === 0 && helpWait.stdout.includes('visible|hidden') && helpWait.stdout.includes('wait-for-element "#submit"'),
    helpWait.stdout.slice(0, 200));
  const globalHelp = await runCli(['-h']);
  check('全局帮助含命令主题与常用示例',
    globalHelp.code === 0
    && globalHelp.stdout.includes('常用示例')
    && globalHelp.stdout.includes('bridge session start --browser edge')
    && globalHelp.stdout.includes('bridge tab close 123 --dry-run'),
    globalHelp.stdout.slice(0, 200));

  // -------------------------------------------------------------------------
  section('4. mock 扩展连接（PROTOCOL §3 握手）');
  startMockProcess();
  const mockUp = await waitFor(async () => {
    const result = await directRpc('status');
    return Boolean(result && result.ok && result.result.browsers.length === 1);
  }, 12_000, 150);
  check('mock 扩展连上 daemon', mockUp, mockOutput.join('').slice(-400));
  if (!mockUp) throw new Error(`mock extension 未连接：\n${mockOutput.join('')}`);

  const status2 = jsonOf(await runCli(['status', '--json']));
  const browser = status2 && status2.result && status2.result.browsers[0];
  const instanceId = browser && browser.instanceId;
  check('status 显示 edge 实例', Boolean(browser && browser.browser === 'edge'), JSON.stringify(browser));
  check('instanceId 为 8 位 hex', /^[0-9a-f]{8}$/.test(instanceId || ''), instanceId);

  const statusHuman = await runCli(['status']);
  check('status 人类输出含 edge 与实例号', statusHuman.code === 0 && statusHuman.stdout.includes('edge') && statusHuman.stdout.includes(instanceId));
  const browsersHuman = await runCli(['browsers']);
  check('browsers 人类输出含实例号', browsersHuman.code === 0 && browsersHuman.stdout.includes(instanceId));

  // -------------------------------------------------------------------------
  section('5. session start / list / stop');
  const start1 = await runCli(['session', 'start', '--browser', 'edge', '--json']);
  check('session start 退出码 0', start1.code === 0, start1.stderr);
  check('session start --json 单行 JSON', singleLineJson(start1), start1.stdout);
  const startJson = jsonOf(start1);
  const session1 = startJson && startJson.result;
  const sessionId = session1 && session1.sessionId;
  check('sessionId 为 4 位小写字母', /^[a-z]{4}$/.test(sessionId || ''), sessionId);
  check('session.start 返回 tabId/windowId', Boolean(session1 && typeof session1.tabId === 'number' && typeof session1.windowId === 'number'));
  check('session.start 返回 instanceId', Boolean(session1 && session1.instanceId === instanceId));

  const framesGate = await runCli(['observe', '--frames', '--session', sessionId, '--json']);
  const framesGateJson = jsonOf(framesGate);
  check('能力降级：mock 未声明 frames → 降级主文档观察', framesGate.code === 0 && framesGateJson && framesGateJson.result && framesGateJson.result.downgraded === true && Array.isArray(framesGateJson.result.frames) && framesGateJson.result.frames.length === 1, framesGate.stdout + framesGate.stderr);

  const badBrowser = await runCli(['session', 'start', '--browser', 'chrome', '--json']);
  check('--browser chrome 无匹配 → 退出码 1 + E_NO_BROWSER', badBrowser.code === 1 && jsonOf(badBrowser) && jsonOf(badBrowser).error.code === 'E_NO_BROWSER', badBrowser.stdout + badBrowser.stderr);

  const list1 = jsonOf(await runCli(['session', 'list', '--json']));
  check('session list 有 1 个 session', Boolean(list1 && list1.ok === true && list1.result.sessions.length === 1 && list1.result.sessions[0].sessionId === sessionId));
  check('status.sessions 计数为 1', Boolean(jsonOf(await runCli(['status', '--json'])).result.sessions.length === 1));

  // -------------------------------------------------------------------------
  section('5b. dry-run 预检（不触达 daemon、不改浏览器）');
  // 用一个"没有 daemon.json 且禁止自动拉起"的 BB_HOME：dry-run 若真的发 RPC 会 E_DAEMON 退出 1。
  const dryEnv = { ...baseEnv(), BB_HOME: path.join(homeDir, 'dry-run-home'), BB_AUTO_START: '0' };
  const dryNoDaemon = await runCli(['tab', 'close', '12', '--dry-run', '--json'], { env: dryEnv });
  const dryNoDaemonJson = jsonOf(dryNoDaemon);
  check('dry-run 在无 daemon 时仍退出 0（证明没有 RPC）',
    dryNoDaemon.code === 0 && Boolean(dryNoDaemonJson) && dryNoDaemonJson.dryRun === true,
    `${dryNoDaemon.stdout}${dryNoDaemon.stderr}`);
  const dryStopNoDaemon = jsonOf(await runCli(['session', 'stop', sessionId, '--dry-run', '--json'], { env: dryEnv }));
  check('session stop --dry-run 不触达 daemon',
    Boolean(dryStopNoDaemon && dryStopNoDaemon.dryRun === true
      && dryStopNoDaemon.result.risk === 'browser_mutation'
      && dryStopNoDaemon.result.steps[0].method === 'session.stop'
      && dryStopNoDaemon.result.steps[0].params.session === sessionId),
    JSON.stringify(dryStopNoDaemon));
  const dryPlanNoDaemon = jsonOf(await runCli(['plan', '--steps', '[{"method":"click","params":{"ref":"@e1"}}]', '--dry-run', '--json'], { env: dryEnv }));
  check('plan --dry-run 不触达 daemon 且给出 plan 请求',
    Boolean(dryPlanNoDaemon && dryPlanNoDaemon.dryRun === true
      && dryPlanNoDaemon.result.steps[0].method === 'plan'
      && dryPlanNoDaemon.result.steps[0].params.steps.length === 1
      && dryPlanNoDaemon.result.risk === 'browser_mutation'
      && dryPlanNoDaemon.result.mutatesBrowser === true),
    JSON.stringify(dryPlanNoDaemon));
  check('dry-run --json 仍是单行 JSON 契约', singleLineJson(dryNoDaemon) && validateEnvelope(dryNoDaemonJson).length === 0);

  const dryTabMove = jsonOf(await runCli(['tab', 'move', '12', '--to-window', '3', '--dry-run', '--json']));
  check('tab move dry-run 给出真实请求参数',
    Boolean(dryTabMove && dryTabMove.result.steps[0].params.tabId === 12
      && dryTabMove.result.steps[0].params.windowId === 3
      && dryTabMove.result.requests[0].body.method === 'tab.move'
      && dryTabMove.result.requests[0].body.params.windowId === 3),
    JSON.stringify(dryTabMove));
  const dryTabNew = jsonOf(await runCli(['tab', 'new', 'https://dry.example/', '--dry-run', '--json']));
  check('tab new dry-run 含 URL 且标注 browser_mutation',
    Boolean(dryTabNew && dryTabNew.result.steps[0].method === 'tab.new'
      && dryTabNew.result.steps[0].params.url === 'https://dry.example/'
      && dryTabNew.result.risk === 'browser_mutation'),
    JSON.stringify(dryTabNew));
  const dryExtract = jsonOf(await runCli(['extract', '--selector', 'table', '--dry-run', '--json']));
  check('extract dry-run 标注 read_only 且不改浏览器',
    Boolean(dryExtract && dryExtract.result.risk === 'read_only'
      && dryExtract.result.mutatesBrowser === false
      && dryExtract.result.steps[0].method === 'extract'
      && dryExtract.result.steps[0].params.selector === 'table'),
    JSON.stringify(dryExtract));
  const dryWait = jsonOf(await runCli(['wait-for-element', '#x', '--dry-run', '--json']));
  check('wait-for-element dry-run 给出 state/timeout 与 read_only',
    Boolean(dryWait && dryWait.result.risk === 'read_only'
      && dryWait.result.steps[0].method === 'wait-for-element'
      && dryWait.result.steps[0].params.state === 'visible'
      && dryWait.result.steps[0].params.timeoutMs === 10000
      && dryWait.result.mutatesBrowser === false),
    JSON.stringify(dryWait));
  const dryWaitNav = jsonOf(await runCli(['wait-for-navigation', '--wait-until', 'networkidle', '--dry-run', '--json']));
  check('wait-for-navigation dry-run 带 waitUntil 阶段',
    Boolean(dryWaitNav && dryWaitNav.result.steps[0].method === 'wait-for-navigation'
      && dryWaitNav.result.steps[0].params.waitUntil === 'networkidle'
      && dryWaitNav.result.risk === 'read_only'),
    JSON.stringify(dryWaitNav));
  const dryReadOnlyPlan = jsonOf(await runCli(['plan', '--steps', '[{"method":"observe","params":{}}]', '--dry-run', '--json']));
  check('plan dry-run 对只读步骤不误报 browser_mutation',
    Boolean(dryReadOnlyPlan && dryReadOnlyPlan.result.risk === 'read_only'
      && dryReadOnlyPlan.result.mutatesBrowser === false
      && dryReadOnlyPlan.result.warnings.length === 0),
    JSON.stringify(dryReadOnlyPlan));
  const dryRebind = jsonOf(await runCli(['session', 'rebind', sessionId, '--tab', '12', '--dry-run', '--json']));
  check('session rebind dry-run 参数完整',
    Boolean(dryRebind && dryRebind.result.steps[0].method === 'session.rebind'
      && dryRebind.result.steps[0].params.tab === 12
      && dryRebind.result.steps[0].params.session === sessionId),
    JSON.stringify(dryRebind));
  const dryOpen = jsonOf(await runCli(['open', 'https://dry.example/', '--observe', '--dry-run', '--json']));
  check('open dry-run 展示 session.start+navigate+observe 三步',
    Boolean(dryOpen && dryOpen.result.steps.length === 3
      && dryOpen.result.steps[0].method === 'session.start'
      && dryOpen.result.steps[1].method === 'navigate'
      && dryOpen.result.steps[2].method === 'observe'
      && dryOpen.result.steps[1].params.session === '<sessionId>'
      && dryOpen.result.notes.some((note) => note.includes('<sessionId>'))),
    JSON.stringify(dryOpen && dryOpen.result && dryOpen.result.steps));
  const dryHuman = await runCli(['tab', 'close', '12', '--dry-run']);
  check('dry-run 人类输出含风险/请求/执行提示',
    dryHuman.code === 0
    && dryHuman.stdout.includes('dry-run：')
    && dryHuman.stdout.includes('browser_mutation')
    && dryHuman.stdout.includes('POST /rpc')
    && dryHuman.stdout.includes('去掉 --dry-run'),
    dryHuman.stdout.slice(0, 300));
  const dryInvalid = await runCli(['open', '--observe', '--dry-run']);
  check('dry-run 也先走参数校验（open --observe 缺 URL → 2）', dryInvalid.code === 2, String(dryInvalid.code));
  const sessionsAfterDry = jsonOf(await runCli(['session', 'list', '--json']));
  check('dry-run 后会话数不变（没有真的 stop/start）',
    Boolean(sessionsAfterDry && sessionsAfterDry.result.sessions.length === 1 && sessionsAfterDry.result.sessions[0].sessionId === sessionId),
    JSON.stringify(sessionsAfterDry && sessionsAfterDry.result.sessions));
  const tabEnvelope = jsonOf(await runCli(['tab', 'list', '--json']));
  check('tab list JSON 信封：page.returned 与 tabs 长度一致',
    Boolean(tabEnvelope
      && tabEnvelope.schema === JSON_SCHEMA_ID
      && tabEnvelope.command === 'tab'
      && tabEnvelope.subcommand === 'list'
      && tabEnvelope.page
      && tabEnvelope.page.returned === tabEnvelope.result.tabs.length
      && tabEnvelope.page.hasMore === false
      && validateEnvelope(tabEnvelope).length === 0),
    JSON.stringify(tabEnvelope && tabEnvelope.page));

  // -------------------------------------------------------------------------
  section('5c. recipe dry-run 与本地写入预检');
  const recipeDryFile = path.join(homeDir, 'recipe-dry.json');
  const recipeStoreFile = path.join(homeDir, 'recipes', 'dry-recipe.json');
  fs.writeFileSync(recipeDryFile, JSON.stringify({
    name: 'dry-recipe',
    steps: [
      { method: 'click', params: { selector: '#btn' } },
      { type: 'human', reason: '人工确认' },
    ],
  }), 'utf8');
  const recipeSaveDry = jsonOf(await runCli(['recipe', 'save', 'dry-recipe', '--file', recipeDryFile, '--dry-run', '--json']));
  check('recipe save dry-run 列出目标文件且不写入',
    Boolean(recipeSaveDry && recipeSaveDry.dryRun === true
      && recipeSaveDry.result.risk === 'local_write'
      && String(recipeSaveDry.result.steps[0].paths[0]).includes('dry-recipe.json')
      && !fs.existsSync(recipeStoreFile)),
    JSON.stringify(recipeSaveDry && recipeSaveDry.result));
  const recipeSaveReal = jsonOf(await runCli(['recipe', 'save', 'dry-recipe', '--file', recipeDryFile, '--json']));
  check('recipe save 真正写入草稿', Boolean(recipeSaveReal && recipeSaveReal.ok === true && fs.existsSync(recipeStoreFile)));
  const recipeRunUnapproved = await runCli(['recipe', 'run', 'dry-recipe', '--dry-run', '--json']);
  check('未审批 recipe 即使 dry-run 也被本地闸门拒绝',
    recipeRunUnapproved.code === 1 && Boolean(jsonOf(recipeRunUnapproved)) && jsonOf(recipeRunUnapproved).error.code === 'E_RECIPE_NOT_APPROVED',
    recipeRunUnapproved.stdout + recipeRunUnapproved.stderr);
  const recipeApprove = jsonOf(await runCli(['recipe', 'approve', 'dry-recipe', '--confirm-human', '--by', 'selftest', '--json']));
  check('recipe approve 记录审批人', Boolean(recipeApprove && recipeApprove.result.approved === true && recipeApprove.result.approver === 'selftest'));
  const recipeRunDry = jsonOf(await runCli(['recipe', 'run', 'dry-recipe', '--dry-run', '--json']));
  check('recipe run dry-run 展开块结构（plan + request-help）并标注风险',
    Boolean(recipeRunDry && recipeRunDry.dryRun === true
      && recipeRunDry.result.risk === 'browser_mutation'
      && recipeRunDry.result.steps.some((step) => step.method === 'plan')
      && recipeRunDry.result.steps.some((step) => step.method === 'request-help')
      && recipeRunDry.result.confirmations.some((line) => line.includes('已审批'))),
    JSON.stringify(recipeRunDry && recipeRunDry.result));
  const recipeRmDry = jsonOf(await runCli(['recipe', 'rm', 'dry-recipe', '--dry-run', '--json']));
  check('recipe rm dry-run 不删除文件', Boolean(recipeRmDry && recipeRmDry.dryRun === true && fs.existsSync(recipeStoreFile)));
  const recipeRm = jsonOf(await runCli(['recipe', 'rm', 'dry-recipe', '--json']));
  check('recipe rm 清理草稿', Boolean(recipeRm && recipeRm.ok === true && !fs.existsSync(recipeStoreFile)));

  // -------------------------------------------------------------------------
  section('6. navigate / observe / screenshot / evaluate');
  const nav = await runCli(['navigate', 'https://example.com/', '--session', sessionId, '--json']);
  check('navigate 退出码 0 且 url 正确', nav.code === 0 && jsonOf(nav) && jsonOf(nav).result.url === 'https://example.com/', nav.stdout + nav.stderr);

  const autoSelect = await runCli(['navigate', 'https://auto.example/', '--json']);
  check('省略 --session 自动选用唯一 session', autoSelect.code === 0 && jsonOf(autoSelect) && jsonOf(autoSelect).ok === true, autoSelect.stdout + autoSelect.stderr);
  const status4 = jsonOf(await runCli(['status', '--json']));
  check('session.url 已同步（navigate 结果回写）', Boolean(status4 && status4.result.sessions[0] && status4.result.sessions[0].url === 'https://auto.example/'), JSON.stringify(status4 && status4.result.sessions));

  const observeHuman = await runCli(['observe', '--session', sessionId]);
  check('observe 人类输出含 url/title/@ref', observeHuman.code === 0 && observeHuman.stdout.includes('url:') && observeHuman.stdout.includes('Mock Page') && observeHuman.stdout.includes('@e2'), observeHuman.stdout);
  const observeJson = jsonOf(await runCli(['observe', '--json', '--session', sessionId]));
  check('observe result 含 observation/refs', Boolean(observeJson && observeJson.result.refs === 3 && String(observeJson.result.observation).includes('textbox')));

  const savedObs = path.join(homeDir, 'obs', 'observation.txt');
  const savedRes = jsonOf(await runCli(['observe', '--save-full', savedObs, '--json', '--session', sessionId]));
  check(
    'observe --save-full 原子落盘且无临时文件',
    Boolean(
      savedRes && savedRes.result.savedTo === savedObs &&
      fs.existsSync(savedObs) && fs.readFileSync(savedObs, 'utf8').includes('textbox') &&
      !fs.readdirSync(path.dirname(savedObs)).some((name) => name.includes('.tmp-')),
    ),
  );

  const shotPath = path.join(homeDir, 'shots', 'shot.png');
  const shot = await runCli(['screenshot', '--out', shotPath, '--full', '--session', sessionId]);
  check('screenshot 退出码 0', shot.code === 0, shot.stderr);
  check('screenshot 输出尺寸 300x200', shot.stdout.includes('300x200'), shot.stdout);
  const pngOk = fs.existsSync(shotPath);
  check('screenshot --out 落盘', pngOk);
  if (pngOk) {
    const buffer = fs.readFileSync(shotPath);
    check('screenshot 文件为 PNG 魔数', buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47);
    check('screenshot PNG IHDR 宽高 300x200', buffer.length >= 24 && buffer.readUInt32BE(16) === 300 && buffer.readUInt32BE(20) === 200);
    check('screenshot 文件大小 > 100 字节', buffer.length > 100, `${buffer.length} bytes`);
    check('screenshot 无 dataUrl 残留（纯 PNG）', buffer.length > 8 && buffer.indexOf(Buffer.from('data:image')) === -1);
  }

  const shotJsonPath = path.join(homeDir, 'shots', 'shot-json.png');
  const shotJsonRes = await runCli(['screenshot', '--out', shotJsonPath, '--json', '--session', sessionId]);
  const shotJson = jsonOf(shotJsonRes);
  check('screenshot --json 输出落盘摘要（不含巨大 dataUrl）', Boolean(
    shotJsonRes.code === 0
    && singleLineJson(shotJsonRes)
    && shotJson
    && shotJson.result
    && shotJson.result.path === path.resolve(shotJsonPath)
    && shotJson.result.width === 300
    && shotJson.result.height === 200
    && shotJson.result.dataUrl === undefined
    && fs.existsSync(shotJsonPath)
    && shotJsonRes.stdout.length < 2000
  ), shotJsonRes.stdout.slice(0, 300));

  const evaluateJson = jsonOf(await runCli(['evaluate', '1+1', '--json', '--session', sessionId]));
  check('evaluate --json 返回 value=2', Boolean(evaluateJson && evaluateJson.result.value === 2), JSON.stringify(evaluateJson));
  const evaluateHuman = await runCli(['evaluate', '2+3', '--session', sessionId]);
  check('evaluate 人类输出 5', evaluateHuman.code === 0 && evaluateHuman.stdout.trim() === '5', evaluateHuman.stdout);

  const unverified = jsonOf(await runCli(['evaluate', '1+1', '--unverified', '--json', '--session', sessionId]));
  check('evaluate --unverified 返回 verified=false', Boolean(unverified && unverified.result.value === 2 && unverified.result.verified === false), JSON.stringify(unverified));
  const unverifiedConflict = await runCli(['evaluate', '1+1', '--unverified', '--observation', 'x', '--session', sessionId]);
  check('evaluate --unverified 与 --observation 互斥', unverifiedConflict.code === 2, unverifiedConflict.stderr.slice(0, 200));

  // -------------------------------------------------------------------------
  section('7. 页面动作 / tab / window');
  const getHtml = jsonOf(await runCli(['get-html', '--selector', 'h1', '--json', '--session', sessionId]));
  check('get-html 返回 html', Boolean(getHtml && String(getHtml.result.html).includes('Mock Page')));

  const actions = [
    ['click @e2', ['click', '@e2', '--session', sessionId]],
    ['hover @e2', ['hover', '@e2', '--session', sessionId]],
    ['fill @e2 --value hello', ['fill', '@e2', '--value', 'hello', '--session', sessionId]],
    ['press Enter --ref @e2', ['press', 'Enter', '--ref', '@e2', '--session', sessionId]],
    ['select @e2 --value v1', ['select', '@e2', '--value', 'v1', '--session', sessionId]],
    ['focus @e2', ['focus', '@e2', '--session', sessionId]],
    ['scroll-to @e2', ['scroll-to', '@e2', '--session', sessionId]],
    ['reload', ['reload', '--session', sessionId]],
    ['back', ['back', '--session', sessionId]],
    ['forward', ['forward', '--session', sessionId]],
    ['wait-ms 30', ['wait-ms', '30', '--session', sessionId]],
    ['wait-for-element #x', ['wait-for-element', '#x', '--state', 'visible', '--json', '--session', sessionId]],
    ['window resize', ['window', 'resize', '--width', '800', '--height', '600', '--session', sessionId]],
    ['tab select', ['tab', 'select', '12', '--session', sessionId]],
    ['tab close', ['tab', 'close', '12', '--session', sessionId]],
  ];
  for (const [label, args] of actions) {
    const result = await runCli(args);
    const expectsJson = args.includes('--json');
    const ok = result.code === 0 && (expectsJson ? Boolean(jsonOf(result) && jsonOf(result).ok === true) : true);
    check(`${label} 成功`, ok, `${result.stdout}${result.stderr}`);
  }

  const snapshot = await runCli(['snapshot', '--session', sessionId]);
  check('snapshot 输出 document 行', snapshot.code === 0 && snapshot.stdout.includes('document'), snapshot.stdout);
  const consoleJson = jsonOf(await runCli(['console', '--json', '--session', sessionId]));
  check('console 返回 1 条记录', Boolean(consoleJson && consoleJson.result.entries.length === 1));
  const tabList = jsonOf(await runCli(['tab', 'list', '--json']));
  check('tab list 无需 session 可用', Boolean(tabList && tabList.ok === true && Array.isArray(tabList.result.tabs) && tabList.result.tabs.length >= 1));
  const tabNew = jsonOf(await runCli(['tab', 'new', 'https://new.example/', '--json']));
  check('tab new 返回 tabId', Boolean(tabNew && tabNew.ok === true && typeof tabNew.result.tabId === 'number'));

  // -------------------------------------------------------------------------
  section('7b. v0.2 方法面（mock 扩展，无真实浏览器）');
  const readRes = jsonOf(await runCli(['read', '--all', '--json', '--session', sessionId]));
  check('read --all 返回 fields', Boolean(readRes && readRes.ok === true && readRes.result.fields.length >= 1));

  const extractJson = jsonOf(await runCli(['extract', '--selector', 'table', '--json', '--session', sessionId]));
  check('extract 返回列与行', Boolean(extractJson && extractJson.result.rowCount === 1 && extractJson.result.columns[0].label === '姓名'));
  check('extract JSON 信封：page.returned/truncated/hasMore 与兜底 total',
    Boolean(extractJson
      && extractJson.schema === JSON_SCHEMA_ID
      && extractJson.command === 'extract'
      && extractJson.page
      && extractJson.page.returned === 1
      && extractJson.page.truncated === false
      && extractJson.page.hasMore === false
      && extractJson.page.total === 1
      && extractJson.page.totalExact === false
      && validateEnvelope(extractJson).length === 0),
    JSON.stringify(extractJson && extractJson.page));
  const csvPath = path.join(homeDir, 'extract.csv');
  const extractCsv = await runCli(['extract', '--selector', 'table', '--format', 'csv', '--out', csvPath, '--json', '--session', sessionId]);
  check('extract --format csv 落盘', extractCsv.code === 0 && fs.existsSync(csvPath) && fs.readFileSync(csvPath, 'utf8').includes('姓名'));

  const dragRes = await runCli(['drag', '@e1', '--to', '@e3', '--synthetic', '--json', '--session', sessionId]);
  check('drag 成功', dragRes.code === 0 && Boolean(jsonOf(dragRes) && jsonOf(dragRes).ok === true), JSON.stringify({ code: dragRes.code, out: dragRes.stdout, err: dragRes.stderr }).slice(0, 500));
  const wheelRes = await runCli(['wheel', '--delta-y', '-300', '--json', '--session', sessionId]);
  check('wheel 支持负 delta', wheelRes.code === 0 && Boolean(jsonOf(wheelRes) && jsonOf(wheelRes).ok === true));
  const blurRes = await runCli(['blur', '--json', '--session', sessionId]);
  check('blur 成功', blurRes.code === 0 && Boolean(jsonOf(blurRes) && jsonOf(blurRes).ok === true));

  const uploadFile = path.join(homeDir, 'up.txt');
  fs.writeFileSync(uploadFile, 'x', 'utf8');
  const uploadRes = jsonOf(await runCli(['upload', '@e2', '--file', uploadFile, '--json', '--session', sessionId]));
  check('upload 返回文件名', Boolean(uploadRes && uploadRes.ok === true && uploadRes.result.names[0] === 'up.txt'));

  const downloadRes = jsonOf(await runCli(['download', '#dl', '--json', '--session', sessionId]));
  check('download 返回文件路径', Boolean(downloadRes && downloadRes.ok === true && String(downloadRes.result.filename).length > 0));

  const planRes = jsonOf(await runCli(['plan', '--steps', '[{"method":"click","params":{"ref":"@e1"}},{"method":"fill","params":{"ref":"@e2","value":"x"}}]', '--json', '--session', sessionId]));
  check('plan 返回两步结果', Boolean(planRes && planRes.result.completed === 2 && planRes.result.failedAt === null));
  check('plan JSON 信封：page.returned 标记执行步数',
    Boolean(planRes
      && planRes.schema === JSON_SCHEMA_ID
      && planRes.command === 'plan'
      && planRes.page
      && planRes.page.returned === 2
      && planRes.page.total === 2
      && planRes.page.totalExact === false
      && validateEnvelope(planRes).length === 0),
    JSON.stringify(planRes && planRes.page));

  const dialogList = jsonOf(await runCli(['dialog', 'list', '--json', '--session', sessionId]));
  check('dialog list 返回记录', Boolean(dialogList && dialogList.result.dialogs.length === 1));
  const networkList = jsonOf(await runCli(['network', 'list', '--json', '--session', sessionId]));
  check('network list 返回条目', Boolean(networkList && networkList.result.entries.length === 1));

  const manualFrame = jsonOf(await runCli(['screenshot', '--mode', 'manual', '--json', '--session', sessionId]));
  check('screenshot --mode manual 返回帧数', Boolean(manualFrame && manualFrame.result.frames === 1));
  const stitchPath = path.join(homeDir, 'stitch.png');
  const stitch = await runCli(['screenshot', '--mode', 'manual', '--stitch', '--out', stitchPath, '--json', '--session', sessionId]);
  check('screenshot --stitch 落盘', stitch.code === 0 && fs.existsSync(stitchPath));

  const settingsBlocked = jsonOf(await runCli(['settings', 'set', '--borrow-confirm', 'off', '--json']));
  check('settings set --borrow-confirm 被拒绝（人工开关）', Boolean(settingsBlocked && settingsBlocked.ok === false && settingsBlocked.error && settingsBlocked.error.code === 'E_FORBIDDEN'));
  const settingsSet = jsonOf(await runCli(['settings', 'set', '--label', 'selftest', '--json']));
  check('settings set 生效', Boolean(settingsSet && settingsSet.result.settings.instanceLabel === 'selftest'));

  const borrowRes = await runCli(['tab', 'borrow', '12', '--json']);
  check('tab borrow 成功', borrowRes.code === 0 && Boolean(jsonOf(borrowRes) && jsonOf(borrowRes).ok === true));
  const returnRes = await runCli(['tab', 'return', '12', '--json']);
  check('tab return 成功', returnRes.code === 0 && Boolean(jsonOf(returnRes) && jsonOf(returnRes).ok === true));

  const helpRes = jsonOf(await runCli(['request-help', '--reason', 'x', '--json', '--session', sessionId]));
  check('request-help 返回 action', Boolean(helpRes && helpRes.ok === true && helpRes.result.action === 'done'));

  const viewRes = jsonOf(await runCli(['view', '--grep', 'textbox', '--json', '--session', sessionId]));
  check('view 命中观察缓存', Boolean(viewRes && viewRes.ok === true && viewRes.result.lines.length >= 1));

  section('7c. transfer.* staging（分块 / 偏移 / 读取 / 释放）');
  const transferBegin = await directRpc('transfer.begin', { session: sessionId, name: 'probe.txt', byteSize: 5 });
  const transferId = transferBegin && transferBegin.result && transferBegin.result.transferId;
  check(
    'transfer.begin 返回 transferId/chunkSize',
    Boolean(transferId && /^tr_[0-9a-f]{16}$/.test(transferId) && transferBegin.result.chunkSize > 0),
    JSON.stringify(transferBegin && transferBegin.result),
  );
  const transferChunk = await directRpc('transfer.chunk', { transferId, offset: 0, dataBase64: Buffer.from('hello').toString('base64') });
  check(
    'transfer.chunk 写入并标记 eof',
    Boolean(transferChunk && transferChunk.ok === true && transferChunk.result.nextOffset === 5 && transferChunk.result.eof === true),
    JSON.stringify(transferChunk),
  );
  const transferBadOffset = await directRpc('transfer.chunk', { transferId, offset: 0, dataBase64: 'YQ==' });
  check('transfer.chunk 拒绝不连续 offset', Boolean(transferBadOffset && transferBadOffset.error && transferBadOffset.error.code === 'E_TRANSFER_OFFSET'));
  const transferFinish = await directRpc('transfer.finish', { transferId });
  check(
    'transfer.finish 校验字节数',
    Boolean(transferFinish && transferFinish.ok === true && transferFinish.result.byteSize === 5),
    JSON.stringify(transferFinish),
  );
  const transferRead1 = await directRpc('transfer.read', { transferId, offset: 0, maxBytes: 3 });
  const transferRead2 = await directRpc('transfer.read', { transferId, offset: 3, maxBytes: 3 });
  check(
    'transfer.read 分块读回',
    Boolean(
      transferRead1 && transferRead1.ok === true &&
      Buffer.from(transferRead1.result.dataBase64, 'base64').toString() === 'hel' &&
      transferRead1.result.eof === false &&
      transferRead2 && Buffer.from(transferRead2.result.dataBase64, 'base64').toString() === 'lo' &&
      transferRead2.result.eof === true,
    ),
  );
  const transferRelease = await directRpc('transfer.release', { transferId });
  const transferRelease2 = await directRpc('transfer.release', { transferId });
  check(
    'transfer.release 幂等',
    Boolean(transferRelease && transferRelease.result.released === true && transferRelease2 && transferRelease2.result.released === false),
  );
  const transferBadName = await directRpc('transfer.begin', { session: sessionId, name: '../evil.txt', byteSize: 1 });
  check('transfer 拒绝路径穿越文件名', Boolean(transferBadName && transferBadName.error && transferBadName.error.code === 'E_BAD_ARG'));

  // -------------------------------------------------------------------------
  section('7c-2. daemon 深度：ledger 快照/恢复、transfer 配额/续传/校验、queue 诊断、doctor');

  // ---- 默认 status 载荷不变（只增字段/新子命令的硬证据）----
  const plainStatus = await directRpc('status', {});
  const plainKeys = Object.keys((plainStatus && plainStatus.result) || {});
  check(
    '默认 status 不新增视图字段（ledger/transfers/queue/doctor 都不出现）',
    Boolean(plainStatus && plainStatus.ok === true
      && !plainKeys.includes('ledger')
      && !plainKeys.includes('transfers')
      && !plainKeys.includes('queue')
      && !plainKeys.includes('doctor')),
    plainKeys.join(','),
  );
  check(
    '默认 status 既有字段仍在（queues/recovery/compatibility/inflight）',
    ['service', 'version', 'browsers', 'sessions', 'inflight', 'queues', 'auth', 'recovery', 'compatibility']
      .every((key) => plainKeys.includes(key)),
    plainKeys.join(','),
  );

  // ---- status 增量视图：transfers / queues / doctor ----
  const viewTransfers = await directRpc('status', { views: ['transfers'], limit: 5 });
  check(
    'status views=transfers 返回配额与计数（真实 daemon 数据）',
    Boolean(viewTransfers && viewTransfers.ok === true
      && viewTransfers.result.transfers
      && viewTransfers.result.transfers.quota.maxConcurrent > 0
      && typeof viewTransfers.result.transfers.counts.active === 'number'
      && Array.isArray(viewTransfers.result.transfers.transfers)),
    JSON.stringify(viewTransfers && viewTransfers.result && viewTransfers.result.transfers && viewTransfers.result.transfers.quota),
  );
  const viewQueue = await directRpc('status', { views: ['queues'], limitSessions: 10 });
  check(
    'status views=queues 返回队列诊断（限流/等待/公平性）',
    Boolean(viewQueue && viewQueue.ok === true
      && viewQueue.result.queue
      && viewQueue.result.queue.limits.capacity >= 1
      && viewQueue.result.queue.fairness.strategy === 'round-robin-per-tab'
      && typeof viewQueue.result.queue.totals.dispatch === 'number'),
    JSON.stringify(viewQueue && viewQueue.result && viewQueue.result.queue && viewQueue.result.queue.limits),
  );
  const viewUnknown = await directRpc('status', { views: ['ledger', 'nope'] });
  check(
    'status 未知视图名不报错但回显 unknownViews',
    Boolean(viewUnknown && viewUnknown.ok === true
      && viewUnknown.result.ledger
      && Array.isArray(viewUnknown.result.unknownViews)
      && viewUnknown.result.unknownViews.includes('nope')),
    JSON.stringify(viewUnknown && viewUnknown.result && viewUnknown.result.unknownViews),
  );

  // ---- 账本：默认载荷不变 + 快照/持久化/恢复对账 ----
  const ledgerPlain = await directRpc('ledger.status', {});
  check(
    'ledger.status 默认载荷不变（pending/recent/recovery/wal/durability，无 snapshot）',
    Boolean(ledgerPlain && ledgerPlain.ok === true
      && Array.isArray(ledgerPlain.result.pending)
      && Array.isArray(ledgerPlain.result.recent)
      && ledgerPlain.result.wal && ledgerPlain.result.durability
      && ledgerPlain.result.snapshot === undefined),
    JSON.stringify(Object.keys((ledgerPlain && ledgerPlain.result) || {})),
  );
  const ledgerSnapshot = await directRpc('ledger.status', { snapshot: true });
  const ledgerSnapshotPayload = ledgerSnapshot && ledgerSnapshot.result && ledgerSnapshot.result.snapshot;
  check(
    'ledger.status snapshot=true 返回结构化快照（schema/digest/tabs/counts）',
    Boolean(ledgerSnapshot && ledgerSnapshot.ok === true
      && ledgerSnapshotPayload
      && ledgerSnapshotPayload.schema === 1
      && /^[0-9a-f]{16}$/.test(ledgerSnapshotPayload.digest || '')
      && Array.isArray(ledgerSnapshotPayload.tabs)
      && typeof ledgerSnapshotPayload.counts.pending === 'number'),
    JSON.stringify(ledgerSnapshotPayload && ledgerSnapshotPayload.counts),
  );
  const ledgerPersisted = await directRpc('ledger.status', { snapshot: true, persist: true, compare: true });
  check(
    'ledger.status persist=true 把对账快照写入 BB_HOME',
    Boolean(ledgerPersisted && ledgerPersisted.ok === true
      && ledgerPersisted.result.persisted && ledgerPersisted.result.persisted.ok === true
      && fs.existsSync(path.join(homeDir, 'ledger-snapshot.json'))),
    JSON.stringify(ledgerPersisted && ledgerPersisted.result && ledgerPersisted.result.persisted),
  );
  check(
    'ledger.status compare=true 返回恢复对账（digest ok、exists、无漂移）',
    Boolean(ledgerPersisted && ledgerPersisted.result.restore
      && ledgerPersisted.result.restore.ok === true
      && ledgerPersisted.result.restore.exists === true
      && ledgerPersisted.result.restore.digestOk === true
      && ledgerPersisted.result.restore.drift && ledgerPersisted.result.restore.drift.drift === false),
    JSON.stringify(ledgerPersisted && ledgerPersisted.result && ledgerPersisted.result.restore),
  );
  const ledgerBadResolve = await directRpc('ledger.resolve', {});
  check(
    'ledger.resolve 缺 id 仍是 E_BAD_ARG（默认行为不变）',
    Boolean(ledgerBadResolve && ledgerBadResolve.ok === false && ledgerBadResolve.error.code === 'E_BAD_ARG'),
    JSON.stringify(ledgerBadResolve && ledgerBadResolve.error),
  );
  const ledgerBulkDry = await directRpc('ledger.resolve', { all: true, outcome: 'reconciled', dryRun: true });
  check(
    'ledger.resolve all+dryRun 返回批量和解报告（不落库）',
    Boolean(ledgerBulkDry && ledgerBulkDry.ok === true
      && ledgerBulkDry.result.ok === true
      && ledgerBulkDry.result.dryRun === true
      && typeof ledgerBulkDry.result.candidates === 'number'),
    JSON.stringify(ledgerBulkDry && ledgerBulkDry.result),
  );

  // ---- 第十批 F：租约所有权视图 / 命令边界矩阵 / 崩溃恢复报告 / 人工 resolve 两段式 ----
  const leaseView = await directRpc('status', { views: ['leases'], limit: 5 });
  check(
    'status views=leases 返回 tab 所有权矩阵/冲突/回收计划（dryRun）',
    Boolean(leaseView && leaseView.ok === true
      && leaseView.result.leases
      && leaseView.result.leases.kind === 'bridge/tab-ownership'
      && typeof leaseView.result.leases.totals.tabs === 'number'
      && leaseView.result.leases.reclaim
      && leaseView.result.leases.reclaim.dryRun === true),
    JSON.stringify(leaseView && leaseView.result && leaseView.result.leases && leaseView.result.leases.totals),
  );
  const boundaryView = await directRpc('status', { views: ['boundary'], limit: 5 });
  check(
    'status views=boundary 返回命令边界矩阵且不变量全绿',
    Boolean(boundaryView && boundaryView.ok === true
      && boundaryView.result.boundary
      && boundaryView.result.boundary.kind === 'bridge/command-boundary'
      && boundaryView.result.boundary.counts.total >= 150
      && boundaryView.result.boundary.invariantOk === true),
    JSON.stringify(boundaryView && boundaryView.result && boundaryView.result.boundary && boundaryView.result.boundary.counts),
  );
  const plainStatusAfterViews = await directRpc('status', {});
  check(
    '显式租约/边界视图后默认 status 载荷仍不变（无 leases/boundary）',
    Boolean(plainStatusAfterViews && plainStatusAfterViews.ok === true
      && plainStatusAfterViews.result.leases === undefined
      && plainStatusAfterViews.result.boundary === undefined),
    JSON.stringify(Object.keys((plainStatusAfterViews && plainStatusAfterViews.result) || {})),
  );
  const ledgerRecovery = await directRpc('ledger.status', { recovery: true });
  check(
    'ledger.status recovery=true 返回崩溃恢复报告（autoResolved=0 + 人工策略）',
    Boolean(ledgerRecovery && ledgerRecovery.ok === true
      && ledgerRecovery.result.recoveryReport
      && ledgerRecovery.result.recoveryReport.summary
      && ledgerRecovery.result.recoveryReport.summary.autoResolved === 0
      && ledgerRecovery.result.recoveryReport.manualResolve
      && ledgerRecovery.result.recoveryReport.manualResolve.policy.autoResolve === false),
    JSON.stringify(ledgerRecovery && ledgerRecovery.result && ledgerRecovery.result.recoveryReport && ledgerRecovery.result.recoveryReport.summary),
  );
  const resolveDry = await directRpc('ledger.resolve', { id: 'lt_missing_selftest', outcome: 'confirmed', dryRun: true });
  check(
    'ledger.resolve id+dryRun 返回计划（missing 不写账本、不报 404）',
    Boolean(resolveDry && resolveDry.ok === true
      && resolveDry.result.dryRun === true
      && resolveDry.result.counts.missing === 1
      && resolveDry.result.counts.resolved === undefined),
    JSON.stringify(resolveDry && resolveDry.result && resolveDry.result.counts),
  );
  const resolveEmptyIds = await directRpc('ledger.resolve', { ids: [], outcome: 'confirmed', dryRun: true });
  check(
    'ledger.resolve ids=[] 仍是 E_BAD_ARG（空目标在参数层拒绝）',
    Boolean(resolveEmptyIds && resolveEmptyIds.ok === false && resolveEmptyIds.error.code === 'E_BAD_ARG'),
    JSON.stringify(resolveEmptyIds && resolveEmptyIds.error),
  );
  const resolveBadOutcome = await directRpc('ledger.resolve', { ids: ['lt_missing_selftest'], outcome: 'nope', dryRun: true });
  check(
    'ledger.resolve ids 非法 outcome 返回 E_BAD_ARG 与允许清单',
    Boolean(resolveBadOutcome && resolveBadOutcome.ok === false
      && resolveBadOutcome.error.code === 'E_BAD_ARG'
      && Array.isArray(resolveBadOutcome.error.data && resolveBadOutcome.error.data.allowedOutcomes)),
    JSON.stringify(resolveBadOutcome && resolveBadOutcome.error),
  );
  const ledgerPlainAfterRecovery = await directRpc('ledger.status', {});
  check(
    'ledger.status recovery 报告不影响默认载荷（无 snapshot/recoveryReport）',
    Boolean(ledgerPlainAfterRecovery && ledgerPlainAfterRecovery.ok === true
      && ledgerPlainAfterRecovery.result.snapshot === undefined
      && ledgerPlainAfterRecovery.result.recoveryReport === undefined),
    JSON.stringify(Object.keys((ledgerPlainAfterRecovery && ledgerPlainAfterRecovery.result) || {})),
  );
  const combinedViews = await directRpc('status', { views: ['leases', 'boundary'], limit: 3 });
  check(
    'status 可同时请求 leases+boundary 两个视图（顺序去重）',
    Boolean(combinedViews && combinedViews.ok === true
      && Array.isArray(combinedViews.result.views)
      && combinedViews.result.views.join(',') === 'leases,boundary'
      && combinedViews.result.leases.kind === 'bridge/tab-ownership'
      && combinedViews.result.boundary.kind === 'bridge/command-boundary'),
    JSON.stringify(combinedViews && combinedViews.result && combinedViews.result.views),
  );
  const cancelUnknown = await directRpc('command.cancel', { id: 'no-such-inflight' });
  check(
    'command.cancel 未知 id 仍是 E_NOT_FOUND（默认行为不变）',
    Boolean(cancelUnknown && cancelUnknown.ok === false && cancelUnknown.error.code === 'E_NOT_FOUND'),
    JSON.stringify(cancelUnknown && cancelUnknown.error),
  );

  // ---- transfer：resume 续传 / 整文件校验 / 失败清理 / 快照视图 ----
  const resumeBegin = await directRpc('transfer.begin', { session: sessionId, name: 'resume.bin', byteSize: 6 });
  const resumeId = resumeBegin && resumeBegin.result && resumeBegin.result.transferId;
  const resumeLegacy = await directRpc('transfer.chunk', { transferId: resumeId, offset: 0, dataBase64: Buffer.from('hel').toString('base64') });
  check(
    'transfer.chunk 旧调用仍只返回 nextOffset/eof（响应形状不变）',
    Boolean(resumeLegacy && resumeLegacy.ok === true
      && Object.keys(resumeLegacy.result).sort().join(',') === 'eof,nextOffset'
      && resumeLegacy.result.nextOffset === 3),
    JSON.stringify(resumeLegacy && resumeLegacy.result),
  );
  const resumeReplay = await directRpc('transfer.chunk', {
    transferId: resumeId, offset: 0, dataBase64: Buffer.from('hello!').toString('base64'), resume: true,
  });
  check(
    'transfer.chunk resume=true 重发已收区间 → replay 只追加尾巴',
    Boolean(resumeReplay && resumeReplay.ok === true
      && resumeReplay.result.mode === 'replay'
      && resumeReplay.result.verifiedBytes === 3
      && resumeReplay.result.nextOffset === 6
      && resumeReplay.result.eof === true),
    JSON.stringify(resumeReplay && resumeReplay.result),
  );
  const resumeRead = await directRpc('transfer.read', { transferId: resumeId, offset: 0 });
  check(
    'transfer.read 新增进度字段（received/byteSize/remaining/resumable）且内容正确',
    Boolean(resumeRead && resumeRead.ok === true
      && Buffer.from(resumeRead.result.dataBase64, 'base64').toString() === 'hello!'
      && resumeRead.result.received === 6
      && resumeRead.result.byteSize === 6
      && resumeRead.result.remaining === 0
      && resumeRead.result.resumable === true
      && resumeRead.result.finished === false),
    JSON.stringify(resumeRead && resumeRead.result),
  );
  const resumeBadFinish = await directRpc('transfer.finish', { transferId: resumeId, sha256: '0'.repeat(64) });
  check(
    'transfer.finish 摘要不符 → E_TRANSFER_STATE 且释放 staging（失败清理）',
    Boolean(resumeBadFinish && resumeBadFinish.ok === false
      && resumeBadFinish.error.code === 'E_TRANSFER_STATE'
      && resumeBadFinish.error.data && resumeBadFinish.error.data.released === true),
    JSON.stringify(resumeBadFinish && resumeBadFinish.error),
  );
  const resumeGone = await directRpc('transfer.read', { transferId: resumeId, offset: 0 });
  check('校验失败后 transfer 已被清理（E_TRANSFER_NOT_FOUND）', Boolean(resumeGone && resumeGone.error && resumeGone.error.code === 'E_TRANSFER_NOT_FOUND'));

  const snapshotTransfer = await directRpc('transfer.begin', { session: sessionId, name: 'visible.bin', byteSize: 4 });
  const snapshotTransferId = snapshotTransfer && snapshotTransfer.result && snapshotTransfer.result.transferId;
  await directRpc('transfer.chunk', { transferId: snapshotTransferId, offset: 0, dataBase64: Buffer.from('ab').toString('base64') });
  const transferView = await directRpc('status', { views: ['transfers'], limit: 20 });
  const transferViewList = (transferView && transferView.result && transferView.result.transfers && transferView.result.transfers.transfers) || [];
  check(
    'status views=transfers 能看到进行中的 transfer（进度字段齐全）',
    Boolean(transferView && transferView.ok === true
      && transferViewList.some((item) => item.transferId === snapshotTransferId && item.received === 2 && item.percent === 50)
      && transferView.result.transfers.counts.active >= 1),
    JSON.stringify(transferViewList.slice(0, 3)),
  );
  await directRpc('transfer.release', { transferId: snapshotTransferId });

  // ---- queue：真实 daemon 流量进入诊断 ----
  const queueView = await directRpc('status', { views: ['queues'] });
  const queueDiagnostics = queueView && queueView.result && queueView.result.queue;
  const queueSession = (queueDiagnostics && Array.isArray(queueDiagnostics.sessions) ? queueDiagnostics.sessions : [])
    .find((item) => item.sessionId === sessionId);
  check(
    'status views=queues 记录真实派发（本会话已跑过命令）',
    Boolean(queueDiagnostics
      && queueDiagnostics.totals.dispatch >= 1
      && queueDiagnostics.totals.completed >= 1
      && queueSession
      && queueSession.completed >= 1
      && typeof queueSession.wait.maxMs === 'number'),
    JSON.stringify(queueDiagnostics && { totals: queueDiagnostics.totals, sessions: queueDiagnostics.sessions.length }),
  );
  check(
    'queue 诊断含 inflight 上限与 tab 公平性指标',
    Boolean(queueDiagnostics
      && queueDiagnostics.inflight.limit >= 1
      && queueDiagnostics.fairness
      && queueDiagnostics.fairness.strategy === 'round-robin-per-tab'
      && typeof queueDiagnostics.fairness.maxConsecutive === 'number'
      && Array.isArray(queueDiagnostics.fairness.tabs)),
  );

  // ---- CLI 命令面（真实调用 daemon）----
  const cliLedger = await runCli(['daemon', 'ledger', '--json']);
  check(
    'bridge daemon ledger --json：单行 JSON + pending 数组',
    cliLedger.code === 0 && singleLineJson(cliLedger) && Array.isArray(jsonOf(cliLedger).result.pending),
    `${cliLedger.stdout}${cliLedger.stderr}`,
  );
  const cliLedgerHuman = await runCli(['daemon', 'ledger']);
  check('bridge daemon ledger 人类输出含待确认/WAL/持久化', cliLedgerHuman.code === 0
    && cliLedgerHuman.stdout.includes('账本：待确认')
    && cliLedgerHuman.stdout.includes('WAL：解析'), cliLedgerHuman.stdout);
  const cliSnapshot = await runCli(['daemon', 'ledger', 'snapshot', '--json']);
  check(
    'bridge daemon ledger snapshot --json 透出 schema/digest 与持久化证据',
    cliSnapshot.code === 0
      && jsonOf(cliSnapshot).result.snapshot.schema === 1
      && jsonOf(cliSnapshot).result.persisted.ok === true
      && /^[0-9a-f]{16}$/.test(jsonOf(cliSnapshot).result.snapshot.digest || ''),
    cliSnapshot.stdout,
  );
  const cliSnapshotOut = path.join(homeDir, 'ledger-copy.json');
  const cliSnapshotFile = await runCli(['daemon', 'ledger', 'snapshot', '--out', cliSnapshotOut]);
  let localSnapshot = null;
  try { localSnapshot = JSON.parse(fs.readFileSync(cliSnapshotOut, 'utf8')); } catch { localSnapshot = null; }
  check(
    'bridge daemon ledger snapshot --out 写出可解析的本地快照副本',
    cliSnapshotFile.code === 0 && Boolean(localSnapshot) && localSnapshot.schema === 1 && Boolean(localSnapshot.digest),
    cliSnapshotFile.stdout + cliSnapshotFile.stderr,
  );
  const cliRestore = await runCli(['daemon', 'ledger', 'restore']);
  check(
    'bridge daemon ledger restore 输出恢复对账（且不重复打印段落）',
    cliRestore.code === 0
      && cliRestore.stdout.includes('恢复对账：')
      && cliRestore.stdout.split('恢复对账：').length === 2,
    cliRestore.stdout,
  );
  const cliReconcileDry = await runCli(['daemon', 'ledger', 'reconcile', '--all', '--outcome', 'reconciled', '--dry-run', '--json']);
  check(
    'bridge daemon ledger reconcile --all --dry-run --json 返回 batch 报告',
    cliReconcileDry.code === 0
      && jsonOf(cliReconcileDry).result.ok === true
      && jsonOf(cliReconcileDry).result.dryRun === true,
    `${cliReconcileDry.stdout}${cliReconcileDry.stderr}`,
  );
  const cliReconcileBadOutcome = await runCli(['daemon', 'ledger', 'reconcile', '7', '--outcome', 'nope', '--json']);
  check('bridge daemon ledger reconcile 非法 --outcome 在参数层拒绝（退出码 2）', cliReconcileBadOutcome.code === 2, String(cliReconcileBadOutcome.code));
  const cliTransfer = await runCli(['daemon', 'transfer', '--json']);
  check(
    'bridge daemon transfer --json：result.transfers 含 quota 与 counts',
    cliTransfer.code === 0
      && jsonOf(cliTransfer).result.transfers.quota.maxConcurrent > 0
      && typeof jsonOf(cliTransfer).result.transfers.counts.active === 'number',
    `${cliTransfer.stdout}${cliTransfer.stderr}`,
  );
  const cliTransferHuman = await runCli(['daemon', 'transfer']);
  check('bridge daemon transfer 人类输出含配额与上限', cliTransferHuman.code === 0 && cliTransferHuman.stdout.includes('传输配额：并发'), cliTransferHuman.stdout);
  const cliQueue = await runCli(['daemon', 'queue', '--json']);
  check(
    'bridge daemon queue --json：result.queue 含 totals/fairness',
    cliQueue.code === 0
      && jsonOf(cliQueue).result.queue.fairness.strategy === 'round-robin-per-tab'
      && jsonOf(cliQueue).result.queue.totals.dispatch >= 1,
    `${cliQueue.stdout}${cliQueue.stderr}`,
  );
  const cliQueueHuman = await runCli(['daemon', 'queue']);
  check('bridge daemon queue 人类输出含公平性与 tab 调度', cliQueueHuman.code === 0
    && cliQueueHuman.stdout.includes('命令队列：容量')
    && cliQueueHuman.stdout.includes('公平性：'), cliQueueHuman.stdout);
  const cliDaemonDoctor = await runCli(['daemon', 'doctor', '--json']);
  const daemonDoctorReport = cliDaemonDoctor.code === 0 ? (jsonOf(cliDaemonDoctor).result.doctor || null) : null;
  check(
    'bridge daemon doctor --json：结构化自检（schema/status/checks）',
    Boolean(daemonDoctorReport
      && daemonDoctorReport.schema === 1
      && ['ok', 'warn'].includes(daemonDoctorReport.status)
      && Array.isArray(daemonDoctorReport.checks)
      && daemonDoctorReport.checks.length >= 8),
    JSON.stringify(daemonDoctorReport && { status: daemonDoctorReport.status, checks: (daemonDoctorReport.checks || []).length }),
  );
  const daemonDoctorHuman = await runCli(['daemon', 'doctor']);
  check(
    'bridge daemon doctor 人类输出含 [ok]/[warn] 检查项',
    daemonDoctorHuman.code === 0
      && daemonDoctorHuman.stdout.includes('daemon 自检：')
      && /\[(ok|warn)\]/.test(daemonDoctorHuman.stdout),
    daemonDoctorHuman.stdout,
  );
  const cliDaemonStatusAfter = await runCli(['daemon', 'status']);
  check('bridge daemon status 输出与基线一致（新子命令未改变旧命令）', cliDaemonStatusAfter.code === 0
    && cliDaemonStatusAfter.stdout.includes('daemon 运行中')
    && cliDaemonStatusAfter.stdout.includes(`pid ${daemonProc.pid}`), cliDaemonStatusAfter.stdout);
  const cliStatusPlain = await runCli(['status', '--json']);
  const cliStatusPlainJson = jsonOf(cliStatusPlain);
  check(
    'bridge status --json 默认输出不含新增视图字段（CLI 默认行为不变）',
    cliStatusPlain.code === 0
      && cliStatusPlainJson.result.queue === undefined
      && cliStatusPlainJson.result.transfers === undefined
      && cliStatusPlainJson.result.doctor === undefined
      && cliStatusPlainJson.result.ledger === undefined,
    JSON.stringify(Object.keys(cliStatusPlainJson.result || {})),
  );
  const cliDoctorAfter = await runCli(['doctor', '--json']);
  const cliDoctorJson = jsonOf(cliDoctorAfter);
  const doctorDaemonChecks = ((cliDoctorJson && cliDoctorJson.result && cliDoctorJson.result.checks) || []).map((item) => item.name);
  check(
    'bridge doctor 新增 daemon-ledger/daemon-transfer/daemon-queue/daemon-doctor 检查项',
    cliDoctorAfter.code === 0
      && ['daemon-ledger', 'daemon-transfer', 'daemon-queue', 'daemon-doctor'].every((name) => doctorDaemonChecks.includes(name)),
    doctorDaemonChecks.join(','),
  );
  check(
    'bridge doctor --json 追加 result.daemon 结构化报告（只增字段）',
    Boolean(cliDoctorJson && cliDoctorJson.result && cliDoctorJson.result.daemon
      && Array.isArray(cliDoctorJson.result.daemon.checks)
      && cliDoctorJson.result.checks.some((item) => item.name === 'pairing')),
    JSON.stringify(cliDoctorJson && cliDoctorJson.result && cliDoctorJson.result.daemon && cliDoctorJson.result.daemon.status),
  );
  const globalHelpDeep = await runCli(['-h']);
  check(
    '全局帮助列出 daemon ledger/transfer/queue/doctor',
    globalHelpDeep.code === 0
      && globalHelpDeep.stdout.includes('daemon ledger')
      && globalHelpDeep.stdout.includes('daemon transfer')
      && globalHelpDeep.stdout.includes('daemon queue')
      && globalHelpDeep.stdout.includes('daemon doctor'),
    globalHelpDeep.stdout.slice(0, 200),
  );

  // -------------------------------------------------------------------------
  section('7c-3. 第十一批 G：批处理会话/配额 + 跨会话租约裁决 + CLI schema/表格/退出码');
  const sessionsBaseline = (await directRpc('status', {})).result.sessions.length;

  // ---- 默认 status 载荷不变（新增视图不得污染默认字段集）----
  const deepPlainStatus = await directRpc('status', {});
  const deepPlainKeys = Object.keys((deepPlainStatus && deepPlainStatus.result) || {});
  check(
    '默认 status 不出现 batch/arbitration 视图字段（键集保持基线）',
    Boolean(deepPlainStatus && deepPlainStatus.ok === true
      && !deepPlainKeys.includes('batch')
      && !deepPlainKeys.includes('arbitration')
      && !deepPlainKeys.includes('views')),
    deepPlainKeys.join(','),
  );

  // ---- 配额：真实 daemon 配额池 ----
  const quotaRpc = await directRpc('batch.quota', { limit: 10 });
  check(
    'batch.quota 返回真实配额池（schema/policy/live/available）',
    Boolean(quotaRpc && quotaRpc.ok === true
      && quotaRpc.result.schema === 1
      && quotaRpc.result.kind === 'bridge/session-quota'
      && quotaRpc.result.policy.maxSessions >= 1
      && quotaRpc.result.policy.maxPerBatch >= 1
      && typeof quotaRpc.result.live === 'number'
      && typeof quotaRpc.result.available === 'number'),
    JSON.stringify(quotaRpc && quotaRpc.result && quotaRpc.result.policy),
  );

  // ---- 计划：dry-run 不创建会话 ----
  const planRpc = await directRpc('batch.plan', {
    items: [{ url: 'https://batch-a.example/' }, { url: 'https://batch-b.example/' }],
  });
  const sessionsAfterPlan = (await directRpc('status', {})).result.sessions.length;
  check(
    'batch.plan 返回 dry-run 计划且不创建会话',
    Boolean(planRpc && planRpc.ok === true
      && planRpc.result.dryRun === true
      && planRpc.result.kind === 'bridge/session-batch-plan'
      && planRpc.result.summary.total === 2
      && planRpc.result.summary.admissable >= 1
      && sessionsAfterPlan === sessionsBaseline),
    JSON.stringify(planRpc && planRpc.result && planRpc.result.summary),
  );

  // ---- 启动：真实创建两个会话并导航 ----
  const batchStart = await directRpc('batch.start', {
    batchId: 'selftest-b1',
    items: [{ url: 'https://batch-a.example/' }, { url: 'https://batch-b.example/' }],
  });
  const batchResult = batchStart && batchStart.result;
  check(
    'batch.start 真实启动 2 个会话并完成导航（outcome=ok）',
    Boolean(batchStart && batchStart.ok === true
      && batchResult.batchId === 'selftest-b1'
      && batchResult.state === 'completed'
      && batchResult.outcome === 'ok'
      && batchResult.summary.succeeded === 2
      && batchResult.summary.navigated === 2
      && batchResult.quota.committed === 2),
    JSON.stringify(batchResult && batchResult.summary),
  );
  const sessionsAfterBatch = (await directRpc('status', {})).result.sessions;
  check(
    '批处理创建的会话进入 status.sessions（+2）且 URL 已回写',
    sessionsAfterBatch.length === sessionsBaseline + 2
      && ['https://batch-a.example/', 'https://batch-b.example/'].every((url) => sessionsAfterBatch.some((session) => session.url === url)),
    JSON.stringify(sessionsAfterBatch.map((session) => session.url)),
  );

  // ---- 状态/列表/取消（已结束）----
  const batchStatusRpc = await directRpc('batch.status', { batchId: 'selftest-b1' });
  check(
    'batch.status 返回完整批次（items 与 quota 证据）',
    Boolean(batchStatusRpc && batchStatusRpc.ok === true
      && batchStatusRpc.result.batchId === 'selftest-b1'
      && batchStatusRpc.result.items.length === 2
      && batchStatusRpc.result.items.every((item) => item.state === 'succeeded' && item.sessionId)
      && batchStatusRpc.result.quota.requested === 2),
    JSON.stringify(batchStatusRpc && batchStatusRpc.result && batchStatusRpc.result.items),
  );
  const batchListRpc = await directRpc('batch.list', { limit: 10 });
  check(
    'batch.list 汇总真实批次（completed/itemsSucceeded）',
    Boolean(batchListRpc && batchListRpc.ok === true
      && batchListRpc.result.batches.some((item) => item.batchId === 'selftest-b1')
      && batchListRpc.result.totals.itemsSucceeded >= 2),
    JSON.stringify(batchListRpc && batchListRpc.result && batchListRpc.result.totals),
  );
  const batchCancelDone = await directRpc('batch.cancel', { batchId: 'selftest-b1' });
  check(
    'batch.cancel 对已结束批次幂等（cancelled=false + already-finished）',
    Boolean(batchCancelDone && batchCancelDone.ok === true
      && batchCancelDone.result.cancelled === false
      && batchCancelDone.result.reason === 'already-finished'),
    JSON.stringify(batchCancelDone && batchCancelDone.result),
  );

  // ---- 幂等：同 batchId 复用，不重复建会话 ----
  const idemFirst = await directRpc('batch.start', { batchId: 'selftest-idem', items: [{ url: 'https://batch-idem.example/' }] });
  const sessionsAfterIdemFirst = (await directRpc('status', {})).result.sessions.length;
  const idemSecond = await directRpc('batch.start', { batchId: 'selftest-idem', items: [{ url: 'https://batch-idem.example/' }] });
  const sessionsAfterIdemSecond = (await directRpc('status', {})).result.sessions.length;
  check(
    'batch.start 幂等：同 batchId 第二次 reused=true 且不再建会话',
    Boolean(idemFirst && idemFirst.ok === true
      && idemSecond && idemSecond.ok === true
      && idemSecond.result.reused === true
      && sessionsAfterIdemSecond === sessionsAfterIdemFirst),
    JSON.stringify([sessionsAfterIdemFirst, sessionsAfterIdemSecond]),
  );

  // ---- 部分失败：一条成功、一条 share 不存在的 tab → partial，CLI 退出码 3 ----
  const partialCli = await runCli([
    'daemon', 'batch', 'start', '--json',
    '--items', JSON.stringify([{ url: 'https://batch-partial.example/' }, { share: true, tab: 987654 }]),
    '--on-error', 'continue',
  ]);
  const partialJson = jsonOf(partialCli);
  check(
    'bridge daemon batch start 部分失败 → 退出码 3 + outcome=partial',
    partialCli.code === 3
      && Boolean(partialJson)
      && partialJson.result.outcome === 'partial'
      && partialJson.result.summary.succeeded >= 1
      && partialJson.result.summary.failed >= 1
      && validateEnvelope(partialJson).length === 0,
    `${partialCli.code} ${partialCli.stdout}${partialCli.stderr}`,
  );

  // ---- 跨会话租约裁决：只读报告 + dry-run 仲裁 ----
  const leaseReportRpc = await directRpc('lease.report', { limit: 10, strategy: 'fifo' });
  check(
    'lease.report 返回裁决计划（kind/policy/verdicts/steps，默认不写）',
    Boolean(leaseReportRpc && leaseReportRpc.ok === true
      && leaseReportRpc.result.kind === 'bridge/lease-arbitration'
      && leaseReportRpc.result.policy.strategy === 'fifo'
      && Array.isArray(leaseReportRpc.result.verdicts)
      && Array.isArray(leaseReportRpc.result.steps)
      && leaseReportRpc.result.applied === undefined),
    JSON.stringify(leaseReportRpc && leaseReportRpc.result && leaseReportRpc.result.summary),
  );
  const leaseArbitrateRpc = await directRpc('lease.arbitrate', { strategy: 'lru' });
  check(
    'lease.arbitrate 默认 dry-run（applied=null，policy 使用请求策略）',
    Boolean(leaseArbitrateRpc && leaseArbitrateRpc.ok === true
      && leaseArbitrateRpc.result.applied === null
      && leaseArbitrateRpc.result.policy.strategy === 'lru'),
    JSON.stringify(leaseArbitrateRpc && leaseArbitrateRpc.result && leaseArbitrateRpc.result.policy),
  );

  // ---- status 增量视图：batch / arbitration（+ 既有 leases）----
  const batchView = await directRpc('status', { views: ['batch', 'arbitration'], limit: 5, strategy: 'priority' });
  const batchViewPayload = batchView && batchView.result && batchView.result.batch;
  const arbViewPayload = batchView && batchView.result && batchView.result.arbitration;
  check(
    'status views=batch 返回配额池 + 最近批次（真实数据）',
    Boolean(batchView && batchView.ok === true
      && batchViewPayload
      && batchViewPayload.quota.policy.maxSessions >= 1
      && Array.isArray(batchViewPayload.recent)
      && batchViewPayload.recent.some((item) => item.batchId === 'selftest-b1')
      && batchViewPayload.totals.succeeded >= 2),
    JSON.stringify(batchViewPayload && batchViewPayload.totals),
  );
  check(
    'status views=arbitration 返回裁决计划且透传 strategy',
    Boolean(arbViewPayload
      && arbViewPayload.kind === 'bridge/lease-arbitration'
      && arbViewPayload.policy.strategy === 'priority'
      && Array.isArray(arbViewPayload.verdicts)),
    JSON.stringify(arbViewPayload && arbViewPayload.policy),
  );
  const defaultAfterDeepViews = await directRpc('status', {});
  check(
    '显式 batch/arbitration 视图后默认 status 载荷仍不变',
    Boolean(defaultAfterDeepViews && defaultAfterDeepViews.ok === true
      && defaultAfterDeepViews.result.batch === undefined
      && defaultAfterDeepViews.result.arbitration === undefined),
    Object.keys((defaultAfterDeepViews && defaultAfterDeepViews.result) || {}).join(','),
  );

  // ---- CLI 命令面：batch/lease 真实调用 daemon（JSON/表格/退出码）----
  const cliBatchQuota = await runCli(['daemon', 'batch', 'quota', '--json']);
  check(
    'bridge daemon batch quota --json：单行信封 + 真实配额字段',
    cliBatchQuota.code === 0
      && singleLineJson(cliBatchQuota)
      && jsonOf(cliBatchQuota).result.policy.maxSessions >= 1
      && typeof jsonOf(cliBatchQuota).result.available === 'number'
      && validateEnvelope(jsonOf(cliBatchQuota)).length === 0,
    `${cliBatchQuota.stdout}${cliBatchQuota.stderr}`,
  );
  const cliBatchQuotaHuman = await runCli(['daemon', 'batch', 'quota']);
  check(
    'bridge daemon batch quota 人类输出含配额/单批上限',
    cliBatchQuotaHuman.code === 0
      && cliBatchQuotaHuman.stdout.includes('会话配额：存活')
      && cliBatchQuotaHuman.stdout.includes('单批上限'),
    cliBatchQuotaHuman.stdout,
  );
  const cliBatchPlan = await runCli(['daemon', 'batch', 'plan', '--json', '--items', JSON.stringify([{ url: 'https://batch-plan.example/' }])]);
  check(
    'bridge daemon batch plan --json：dry-run 计划（不建会话）',
    cliBatchPlan.code === 0
      && singleLineJson(cliBatchPlan)
      && jsonOf(cliBatchPlan).result.dryRun === true
      && jsonOf(cliBatchPlan).result.kind === 'bridge/session-batch-plan',
    `${cliBatchPlan.stdout}${cliBatchPlan.stderr}`,
  );
  const cliBatchStatus = await runCli(['daemon', 'batch', 'status', 'selftest-b1', '--json', '--strict']);
  check(
    'bridge daemon batch status --strict：schema 自检通过 + 批次明细',
    cliBatchStatus.code === 0
      && singleLineJson(cliBatchStatus)
      && jsonOf(cliBatchStatus).result.batchId === 'selftest-b1'
      && jsonOf(cliBatchStatus).result.items.length === 2,
    `${cliBatchStatus.stdout}${cliBatchStatus.stderr}`,
  );
  const cliBatchListHuman = await runCli(['daemon', 'batch', 'list']);
  check(
    'bridge daemon batch list 人类表格含批处理汇总与批次 id',
    cliBatchListHuman.code === 0
      && cliBatchListHuman.stdout.includes('批处理：')
      && cliBatchListHuman.stdout.includes('selftest-b1'),
    cliBatchListHuman.stdout.slice(0, 300),
  );
  const cliBatchSchema = await runCli(['daemon', 'batch', 'schema', '--json']);
  check(
    'bridge daemon batch schema --json 列出 5 个登记 schema',
    cliBatchSchema.code === 0
      && Array.isArray(jsonOf(cliBatchSchema).result.schemas)
      && jsonOf(cliBatchSchema).result.schemas.length === 5,
    cliBatchSchema.stdout.slice(0, 200),
  );
  const cliLeaseReport = await runCli(['daemon', 'lease', 'report', '--json']);
  check(
    'bridge daemon lease report --json：真实 daemon 裁决计划信封',
    cliLeaseReport.code === 0
      && singleLineJson(cliLeaseReport)
      && jsonOf(cliLeaseReport).result.kind === 'bridge/lease-arbitration'
      && validateEnvelope(jsonOf(cliLeaseReport)).length === 0,
    `${cliLeaseReport.stdout}${cliLeaseReport.stderr}`,
  );
  const cliLeaseReportHuman = await runCli(['daemon', 'lease', 'report']);
  check(
    'bridge daemon lease report 人类输出含裁决摘要与策略',
    cliLeaseReportHuman.code === 0
      && cliLeaseReportHuman.stdout.includes('租约裁决：')
      && cliLeaseReportHuman.stdout.includes('strategy='),
    cliLeaseReportHuman.stdout.slice(0, 200),
  );
  const cliLeaseArbitrateDry = await runCli(['daemon', 'lease', 'arbitrate', '--json']);
  check(
    'bridge daemon lease arbitrate 默认 dry-run（applied=null）退出 0',
    cliLeaseArbitrateDry.code === 0
      && jsonOf(cliLeaseArbitrateDry).result.applied === null,
    `${cliLeaseArbitrateDry.stdout}${cliLeaseArbitrateDry.stderr}`,
  );
  const cliLeaseApplyNoYes = await runCli(['daemon', 'lease', 'arbitrate', '--apply', '--json']);
  check(
    'bridge daemon lease arbitrate --apply 缺 --yes → 参数层拒绝（退出码 2）',
    cliLeaseApplyNoYes.code === 2
      && Boolean(jsonOf(cliLeaseApplyNoYes))
      && jsonOf(cliLeaseApplyNoYes).ok === false,
    `${cliLeaseApplyNoYes.code} ${cliLeaseApplyNoYes.stdout}${cliLeaseApplyNoYes.stderr}`,
  );
  const cliLeaseBadStrategy = await runCli(['daemon', 'lease', 'report', '--strategy', 'bogus', '--json']);
  check(
    'bridge daemon lease report 非法 --strategy → 退出码 2（本地拒绝）',
    cliLeaseBadStrategy.code === 2 && Boolean(jsonOf(cliLeaseBadStrategy)),
    `${cliLeaseBadStrategy.code} ${cliLeaseBadStrategy.stdout}${cliLeaseBadStrategy.stderr}`,
  );
  const cliStatusViews = await runCli(['status', '--views', 'batch,arbitration', '--json']);
  check(
    'bridge status --views batch,arbitration：JSON 返回两个视图字段',
    cliStatusViews.code === 0
      && singleLineJson(cliStatusViews)
      && Array.isArray(jsonOf(cliStatusViews).result.views)
      && Boolean(jsonOf(cliStatusViews).result.batch)
      && Boolean(jsonOf(cliStatusViews).result.arbitration),
    `${cliStatusViews.stdout}${cliStatusViews.stderr}`,
  );
  const cliStatusViewsHuman = await runCli(['status', '--views', 'batch']);
  check(
    'bridge status --views batch 人类输出追加批处理/配额段落',
    cliStatusViewsHuman.code === 0
      && cliStatusViewsHuman.stdout.includes('批处理/配额：'),
    cliStatusViewsHuman.stdout.slice(-400),
  );
  const cliStatusDefaultJson = await runCli(['status', '--json']);
  check(
    'bridge status --json 默认输出仍无 batch/arbitration 字段',
    cliStatusDefaultJson.code === 0
      && jsonOf(cliStatusDefaultJson).result.batch === undefined
      && jsonOf(cliStatusDefaultJson).result.arbitration === undefined
      && jsonOf(cliStatusDefaultJson).result.views === undefined,
    Object.keys(jsonOf(cliStatusDefaultJson).result || {}).join(','),
  );
  const cliBatchBadItems = await runCli(['daemon', 'batch', 'plan', '--json', '--items', '{oops']);
  check(
    'bridge daemon batch plan 非法 --items → 退出码 2 + 错误信封',
    cliBatchBadItems.code === 2
      && jsonOf(cliBatchBadItems) && jsonOf(cliBatchBadItems).ok === false
      && jsonOf(cliBatchBadItems).error.code === 'E_ARG_USAGE',
    `${cliBatchBadItems.code} ${cliBatchBadItems.stdout}`,
  );

  // ---- 清理：停掉批处理创建的会话，恢复到基线 ----
  const sessionsToStop = (await directRpc('status', {})).result.sessions
    .filter((session) => session.sessionId !== sessionId)
    .map((session) => session.sessionId);
  for (const stopId of sessionsToStop) await runCli(['session', 'stop', stopId, '--json']);
  const sessionsAfterCleanup = (await directRpc('status', {})).result.sessions.length;
  check(
    '批处理/部分失败创建的会话已全部停止（恢复到基线）',
    sessionsAfterCleanup === sessionsBaseline,
    `baseline=${sessionsBaseline} after=${sessionsAfterCleanup}`,
  );

  // -------------------------------------------------------------------------
  section('7c-4. M6-P0②：通用 cancel / ledger.request + CLI 参数对齐（BSK 0.5.0）');
  const genericCancelUnknown = await directRpc('cancel', { rpc_id: 'no-such-rpc-selftest' });
  check(
    'cancel { rpc_id } 进入 daemon LOCAL 路由且未知 id 回 cancelled:false（BSK 语义，不报错）',
    Boolean(genericCancelUnknown && genericCancelUnknown.ok === true
      && genericCancelUnknown.result
      && genericCancelUnknown.result.cancelled === false
      && genericCancelUnknown.result.reason === 'no-inflight'),
    JSON.stringify(genericCancelUnknown),
  );
  const genericCancelBad = await directRpc('cancel', {});
  check(
    'cancel 缺 rpc_id → E_BAD_ARG（参数层错误码）',
    Boolean(genericCancelBad && genericCancelBad.ok === false && genericCancelBad.error.code === 'E_BAD_ARG'),
    JSON.stringify(genericCancelBad),
  );
  const ledgerRequestStatus = await directRpc('ledger.request', {});
  const ledgerRequestStatusPayload = (ledgerRequestStatus && ledgerRequestStatus.result) || {};
  check(
    'ledger.request 默认 action=status：BSK 形状 + 既有 pending/recent/wal/durability',
    Boolean(ledgerRequestStatus && ledgerRequestStatus.ok === true
      && ledgerRequestStatusPayload.action === 'status'
      && Array.isArray(ledgerRequestStatusPayload.pending_unknown)
      && Array.isArray(ledgerRequestStatusPayload.pending)
      && Array.isArray(ledgerRequestStatusPayload.recent)
      && typeof ledgerRequestStatusPayload.frozen === 'boolean'
      && ledgerRequestStatusPayload.wal && ledgerRequestStatusPayload.durability),
    JSON.stringify(ledgerRequestStatusPayload).slice(0, 400),
  );
  const ledgerRequestBadAction = await directRpc('ledger.request', { action: 'prune' });
  check(
    'ledger.request 非法 action → E_BAD_ARG + allowedActions=[status,resolve]',
    Boolean(ledgerRequestBadAction && ledgerRequestBadAction.ok === false
      && ledgerRequestBadAction.error.code === 'E_BAD_ARG'
      && Array.isArray(ledgerRequestBadAction.error.data
        && ledgerRequestBadAction.error.data.allowedActions)
      && ledgerRequestBadAction.error.data.allowedActions.join(',') === 'status,resolve'),
    JSON.stringify(ledgerRequestBadAction && ledgerRequestBadAction.error),
  );
  const cliCancelRpcUnknown = await runCli(['cancel', '--rpc-id', 'no-such-rpc-selftest']);
  check(
    'bridge cancel --rpc-id 走通用 cancel（未知 id 输出“没有进行中的命令可取消”，退出 0）',
    cliCancelRpcUnknown.code === 0 && cliCancelRpcUnknown.stdout.includes('没有进行中的命令可取消'),
    `${cliCancelRpcUnknown.code} ${cliCancelRpcUnknown.stdout}${cliCancelRpcUnknown.stderr}`,
  );
  const cliCancelNoArg = await runCli(['cancel']);
  check(
    'bridge cancel 缺 <commandId> 且无 --rpc-id → 参数错误（退出 2）',
    cliCancelNoArg.code === 2,
    `${cliCancelNoArg.code} ${cliCancelNoArg.stdout}${cliCancelNoArg.stderr}`,
  );
  const cliLedgerStatusBsK = await runCli(['ledger', 'status', '--json']);
  check(
    'bridge ledger status 经 ledger.request 返回 action=status（人类输出与默认载荷不变）',
    Boolean(cliLedgerStatusBsK.code === 0
      && jsonOf(cliLedgerStatusBsK)
      && jsonOf(cliLedgerStatusBsK).result
      && jsonOf(cliLedgerStatusBsK).result.action === 'status'
      && Array.isArray(jsonOf(cliLedgerStatusBsK).result.pending)),
    `${cliLedgerStatusBsK.code} ${cliLedgerStatusBsK.stdout.slice(0, 300)}`,
  );

  // CLI 参数对齐：BSK 的 6 组参数都能被解析，并在参数层拒绝非法取值（退出码 2）。
  const cliClickBadButton = await runCli(['click', '--ref', '@e1', '--button', 'bogus', '--json']);
  check(
    'bridge click --button 只接受 left|middle|right（非法值退出 2）',
    cliClickBadButton.code === 2
      && jsonOf(cliClickBadButton) && jsonOf(cliClickBadButton).error.code === 'E_ARG_USAGE',
    `${cliClickBadButton.code} ${cliClickBadButton.stdout}${cliClickBadButton.stderr}`,
  );
  const cliClickBadCount = await runCli(['click', '--ref', '@e1', '--click-count', '0', '--json']);
  check(
    'bridge click --click-count 需要 ≥1 整数（0 退出 2）',
    cliClickBadCount.code === 2,
    `${cliClickBadCount.code} ${cliClickBadCount.stdout}${cliClickBadCount.stderr}`,
  );
  const cliDragBadButton = await runCli(['drag', '@e1', '--to', '@e2', '--button', 'bogus', '--json']);
  check(
    'bridge drag --button 非法值退出 2',
    cliDragBadButton.code === 2,
    `${cliDragBadButton.code} ${cliDragBadButton.stdout}${cliDragBadButton.stderr}`,
  );
  const cliEvalBadAwait = await runCli(['evaluate', '1 + 1', '--await-promise', 'maybe', '--json']);
  check(
    'bridge evaluate --await-promise/--return-by-value 只接受 true|false（非法值退出 2）',
    cliEvalBadAwait.code === 2
      && jsonOf(cliEvalBadAwait) && jsonOf(cliEvalBadAwait).error.code === 'E_ARG_USAGE',
    `${cliEvalBadAwait.code} ${cliEvalBadAwait.stdout}${cliEvalBadAwait.stderr}`,
  );
  const cliExtractBadColumns = await runCli(['extract', '--selector', 'table', '--max-columns', '0', '--dry-run', '--json']);
  check(
    'bridge extract --max-columns 需要 ≥1（0 退出 2）',
    cliExtractBadColumns.code === 2,
    `${cliExtractBadColumns.code} ${cliExtractBadColumns.stdout}${cliExtractBadColumns.stderr}`,
  );
  const cliExtractColumnsDry = await runCli(['extract', '--selector', 'table', '--max-columns', '3', '--dry-run', '--json']);
  check(
    'extract --max-columns 真实进入 RPC 参数（dry-run 可见 maxColumns=3）',
    Boolean(cliExtractColumnsDry.code === 0
      && jsonOf(cliExtractColumnsDry)
      && jsonOf(cliExtractColumnsDry).result.steps[0].params.maxColumns === 3),
    cliExtractColumnsDry.stdout.slice(0, 300),
  );
  const cliReadBadNodes = await runCli(['read', '--ref', '@e1', '--max-nodes', '0', '--json']);
  check(
    'bridge read --max-nodes 需要 ≥1（0 退出 2）',
    cliReadBadNodes.code === 2,
    `${cliReadBadNodes.code} ${cliReadBadNodes.stdout}${cliReadBadNodes.stderr}`,
  );
  const cliOpenBadWaitTimeout = await runCli(['open', 'https://example.com/', '--wait-for', 'x', '--timeout-ms', 'abc', '--dry-run', '--json']);
  check(
    'bridge open --wait-for --timeout-ms 非整数退出 2',
    cliOpenBadWaitTimeout.code === 2,
    `${cliOpenBadWaitTimeout.code} ${cliOpenBadWaitTimeout.stdout}${cliOpenBadWaitTimeout.stderr}`,
  );
  const cliOpenWaitWithoutUrl = await runCli(['open', '--wait-for', 'x', '--dry-run', '--json']);
  check(
    'bridge open --wait-for 需要 URL（缺少时参数层拒绝）',
    cliOpenWaitWithoutUrl.code === 2,
    `${cliOpenWaitWithoutUrl.code} ${cliOpenWaitWithoutUrl.stdout}${cliOpenWaitWithoutUrl.stderr}`,
  );
  const schemaClickM6 = await runCli(['schema', 'click', '--json']);
  const schemaReadM6 = await runCli(['schema', 'read', '--json']);
  const schemaDragM6 = await runCli(['schema', 'drag', '--json']);
  const schemaEvalM6 = await runCli(['schema', 'evaluate', '--json']);
  const schemaExtractM6 = await runCli(['schema', 'extract', '--json']);
  check(
    'schema 暴露新参数：click.button/clickCount、drag.observationId/button、evaluate.awaitPromise/returnByValue、read.maxNodes、extract.maxColumns',
    Boolean(schemaClickM6.code === 0 && schemaReadM6.code === 0 && schemaDragM6.code === 0
      && schemaEvalM6.code === 0 && schemaExtractM6.code === 0
      && jsonOf(schemaClickM6).result.schema.properties.button
      && jsonOf(schemaClickM6).result.schema.properties.clickCount
      && jsonOf(schemaDragM6).result.schema.properties.observationId
      && jsonOf(schemaDragM6).result.schema.properties.button
      && jsonOf(schemaEvalM6).result.schema.properties.awaitPromise
      && jsonOf(schemaEvalM6).result.schema.properties.returnByValue
      && jsonOf(schemaReadM6).result.schema.properties.maxNodes
      && jsonOf(schemaExtractM6).result.schema.properties.maxColumns),
    JSON.stringify({
      click: Object.keys((jsonOf(schemaClickM6).result || {}).schema.properties || {}),
      read: Object.keys((jsonOf(schemaReadM6).result || {}).schema.properties || {}),
    }),
  );

  // -------------------------------------------------------------------------
  section('7d. 恢复摘要 / debug 与 trace 摘要 / 帮助与 README 文档门禁');

  // ---- video recover：文本结论 + --json summary（复用扩展 recovery/recovery_scan）----
  const videoRecover = await runCli(['video', 'recover', '--session', sessionId]);
  check(
    'video recover 文本含分类/分片计划/下一步',
    videoRecover.code === 0
    && videoRecover.stdout.includes('恢复摘要：recovered-partial（')
    && videoRecover.stdout.includes('分片计划：保留 12 / 丢弃 2 / 截断 1')
    && videoRecover.stdout.includes('扫描：候选 2，未封存 1，可恢复 1')
    && videoRecover.stdout.includes('bridge video save rec-mock-1'),
    `${videoRecover.stdout}${videoRecover.stderr}`,
  );
  const videoRecoverJson = jsonOf(await runCli(['video', 'recover', '--json', '--session', sessionId]));
  check(
    'video recover --json 新增 summary（分类/警告/下一步/扫描）',
    Boolean(videoRecoverJson
      && videoRecoverJson.result.summary.kind === 'video-recovery'
      && videoRecoverJson.result.summary.classification.code === 'recovered-partial'
      && videoRecoverJson.result.summary.classification.severity === 'warn'
      && videoRecoverJson.result.summary.scan.candidates === 2
      && videoRecoverJson.result.summary.warnings.length > 0
      && Array.isArray(videoRecoverJson.result.summary.nextSteps)
      && videoRecoverJson.result.summary.nextSteps.some((step) => step.includes('bridge video save'))),
    JSON.stringify(videoRecoverJson && videoRecoverJson.result && videoRecoverJson.result.summary),
  );
  check(
    'video recover --json 保留扩展原始字段（只做加法）',
    Boolean(videoRecoverJson
      && videoRecoverJson.result.recording_state === 'recovered'
      && videoRecoverJson.result.recovery.plan.dropped === 2
      && videoRecoverJson.result.recovery_scan.candidates === 2),
    JSON.stringify(videoRecoverJson && videoRecoverJson.result && videoRecoverJson.result.recovery),
  );

  // ---- longshot recover：文本结论 + --json summary（复用扩展 recovery 分片校验）----
  const longshotOut = path.join(homeDir, 'recovered-longshot.png');
  const longshot = await runCli(['longshot', 'recover', 'ls-mock', '--out', longshotOut, '--session', sessionId]);
  const longshotBytes = fs.existsSync(longshotOut) ? fs.readFileSync(longshotOut) : Buffer.alloc(0);
  check(
    'longshot recover 文本含分类/分片校验/下一步',
    longshot.code === 0
    && longshot.stdout.includes('恢复摘要：hash-mismatch（')
    && longshot.stdout.includes('分片校验：action=rebuild-partial')
    && longshot.stdout.includes('missing=1')
    && longshot.stdout.includes('补齐缺失分片'),
    `${longshot.stdout}${longshot.stderr}`,
  );
  check(
    'longshot recover 落盘为 PNG（魔数正确）',
    longshotBytes.length > 100 && longshotBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    String(longshotBytes.length),
  );
  const longshotJson = jsonOf(await runCli(['longshot', 'recover', 'ls-mock', '--out', path.join(homeDir, 'recovered-longshot2.png'), '--json', '--session', sessionId]));
  check(
    'longshot recover --json summary.verification 具备缺片/refetch/hash 结论',
    Boolean(longshotJson
      && longshotJson.result.summary.kind === 'longshot-recovery'
      && longshotJson.result.summary.verification.missing[0] === '2'
      && longshotJson.result.summary.verification.refetch === 1
      && longshotJson.result.summary.verification.hashVerified === false
      && longshotJson.result.summary.nextSteps.length > 0),
    JSON.stringify(longshotJson && longshotJson.result && longshotJson.result.summary),
  );
  check(
    'longshot recover --json 不输出 dataUrl（避免巨型 base64）',
    Boolean(longshotJson && !JSON.stringify(longshotJson).includes('data:image')),
  );

  // ---- debug：status/coverage/performance/analyze/stop 的关键摘要字段 ----
  const debugStart = await runCli(['debug', 'start', '--name', 'selftest', '--session', sessionId]);
  check('debug start 成功', debugStart.code === 0, `${debugStart.stdout}${debugStart.stderr}`);
  const debugStatus = await runCli(['debug', 'status', '--session', sessionId]);
  check(
    'debug status 文本含采集摘要/journal 规模',
    debugStatus.code === 0
    && debugStatus.stdout.includes('采集摘要：')
    && debugStatus.stdout.includes('journal：1 条（debug=1')
    && debugStatus.stdout.includes('覆盖：complete=false'),
    `${debugStatus.stdout}${debugStatus.stderr}`,
  );
  const debugStatusJson = jsonOf(await runCli(['debug', 'status', '--json', '--session', sessionId]));
  check(
    'debug status --json summary 对齐 coverage/journal/correlation',
    Boolean(debugStatusJson
      && debugStatusJson.result.summary.active === true
      && debugStatusJson.result.summary.journal.total === 1
      && debugStatusJson.result.summary.coverage.gaps === 2
      && debugStatusJson.result.summary.correlation.requests === 3),
    JSON.stringify(debugStatusJson && debugStatusJson.result && debugStatusJson.result.summary && debugStatusJson.result.summary.coverage),
  );
  const debugCoverage = await runCli(['debug', 'coverage', '--session', sessionId]);
  check(
    'debug coverage 文本含缺口根因分类',
    debugCoverage.code === 0
    && debugCoverage.stdout.includes('覆盖摘要：complete=false（缺口 2 条）')
    && debugCoverage.stdout.includes('缺口分类：')
    && debugCoverage.stdout.includes('未订阅'),
    `${debugCoverage.stdout}${debugCoverage.stderr}`,
  );
  const debugCoverageJson = jsonOf(await runCli(['debug', 'coverage', '--json', '--session', sessionId]));
  check(
    'debug coverage --json summary.categories 按根因聚合',
    Boolean(debugCoverageJson
      && debugCoverageJson.result.summary.categories['not-subscribed'] === 1
      && debugCoverageJson.result.summary.categories.incomplete === 1
      && debugCoverageJson.result.summary.score.overall === 0.82),
    JSON.stringify(debugCoverageJson && debugCoverageJson.result && debugCoverageJson.result.summary && debugCoverageJson.result.summary.categories),
  );
  const debugPerf = await runCli(['debug', 'performance', '--insight', '--session', sessionId]);
  check(
    'debug performance --insight 可用（历史接线缺口回归）且输出性能结论',
    debugPerf.code === 0
    && debugPerf.stdout.includes('[warn] TTFB')
    && debugPerf.stdout.includes('性能结论：'),
    `${debugPerf.stdout}${debugPerf.stderr}`,
  );
  const debugPerfJson = jsonOf(await runCli(['debug', 'performance', '--insight', '--json', '--session', sessionId]));
  check(
    'debug performance --json summary.verdict 为 warn',
    Boolean(debugPerfJson
      && debugPerfJson.result.summary.verdict.severity === 'warn'
      && debugPerfJson.result.summary.warnings >= 3),
    JSON.stringify(debugPerfJson && debugPerfJson.result && debugPerfJson.result.summary),
  );
  const debugAnalyzeJson = jsonOf(await runCli(['debug', 'analyze', '--json', '--session', sessionId]));
  check(
    'debug analyze --json summary 给出失败/慢/pending 结论',
    Boolean(debugAnalyzeJson
      && debugAnalyzeJson.result.summary.verdict.code === 'http-errors'
      && debugAnalyzeJson.result.summary.errors === 1
      && debugAnalyzeJson.result.summary.findings.some((item) => item.code === 'http-errors')),
    JSON.stringify(debugAnalyzeJson && debugAnalyzeJson.result && debugAnalyzeJson.result.summary && debugAnalyzeJson.result.summary.verdict),
  );
  const debugJournalJson = jsonOf(await runCli(['debug', 'journal', '--json', '--session', sessionId]));
  check(
    'debug journal --json 新增 summary（事件数/跨度/截断）',
    Boolean(debugJournalJson
      && debugJournalJson.result.summary.total === debugJournalJson.result.counts.total
      && typeof debugJournalJson.result.summary.spanMs === 'number'),
    JSON.stringify(debugJournalJson && debugJournalJson.result && debugJournalJson.result.summary),
  );
  const debugStop = await runCli(['debug', 'stop', '--session', sessionId]);
  check(
    'debug stop 文本含采集摘要与 journal 导出校验',
    debugStop.code === 0
    && debugStop.stdout.includes('已停止：')
    && debugStop.stdout.includes('采集摘要：')
    && debugStop.stdout.includes('journal 导出：5 事件 / 校验 未通过'),
    `${debugStop.stdout}${debugStop.stderr}`,
  );
  const debugStopJson = jsonOf(await runCli(['debug', 'stop', '--json', '--session', sessionId]));
  check(
    'debug stop --json summary 汇总缺口/导出/关联',
    Boolean(debugStopJson
      && debugStopJson.result.summary.coverage.gaps === 2
      && debugStopJson.result.summary.journalExport.verified === false
      && debugStopJson.result.summary.findings.some((item) => item.code === 'journal-export-unverified')),
    JSON.stringify(debugStopJson && debugStopJson.result && debugStopJson.result.summary && debugStopJson.result.summary.findings),
  );

  // ---- trace：status/stop/summary/diff 的关键摘要字段 ----
  const traceStart = await runCli(['trace', 'start', '--session', sessionId]);
  check('trace start 成功', traceStart.code === 0, `${traceStart.stdout}${traceStart.stderr}`);
  const traceStatus = await runCli(['trace', 'status', '--session', sessionId]);
  check(
    'trace status 文本含 trace 摘要',
    traceStatus.code === 0 && traceStatus.stdout.includes('trace 摘要：') && traceStatus.stdout.includes('录制中：4 事件'),
    `${traceStatus.stdout}${traceStatus.stderr}`,
  );
  const traceStatusJson = jsonOf(await runCli(['trace', 'status', '--json', '--session', sessionId]));
  check(
    'trace status --json summary 含事件数与已录时长',
    Boolean(traceStatusJson
      && traceStatusJson.result.summary.tracing === true
      && traceStatusJson.result.summary.events === 4
      && typeof traceStatusJson.result.summary.elapsedMs === 'number'),
    JSON.stringify(traceStatusJson && traceStatusJson.result && traceStatusJson.result.summary),
  );
  const tracePath = path.join(homeDir, 'trace.json');
  const traceStop = await runCli(['trace', 'stop', '--out', tracePath, '--session', sessionId]);
  check(
    'trace stop 文本含事件/类别/热点结论',
    traceStop.code === 0
    && traceStop.stdout.includes('tracing 已停止：events=4')
    && traceStop.stdout.includes('trace 摘要：')
    && traceStop.stdout.includes('类别：devtools.timeline×3')
    && fs.existsSync(tracePath),
    `${traceStop.stdout}${traceStop.stderr}`,
  );
  const traceStopJson = jsonOf(await runCli(['trace', 'stop', '--json', '--session', sessionId]));
  check(
    'trace stop --json 在扩展 summary 上追加 verdict/findings/nextSteps',
    Boolean(traceStopJson
      && traceStopJson.result.summary.events === 4
      && traceStopJson.result.summary.verdict
      && Array.isArray(traceStopJson.result.summary.findings)
      && Array.isArray(traceStopJson.result.summary.nextSteps)),
    JSON.stringify(traceStopJson && traceStopJson.result && traceStopJson.result.summary && traceStopJson.result.summary.verdict),
  );
  const traceFile = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
  check('trace stop 落盘的 trace 是合法 traceEvents JSON', Array.isArray(traceFile.traceEvents) && traceFile.traceEvents.length === 4);
  const traceSummary = await runCli(['trace', 'summary', tracePath]);
  check(
    'trace summary 文本含阶段分布/关键路径/长任务结论',
    traceSummary.code === 0
    && traceSummary.stdout.includes('trace 结论：')
    && traceSummary.stdout.includes('阶段分布：')
    && traceSummary.stdout.includes('长任务：2 个，最长 300ms'),
    `${traceSummary.stdout}${traceSummary.stderr}`,
  );
  const traceSummaryJson = jsonOf(await runCli(['trace', 'summary', tracePath, '--json']));
  check(
    'trace summary --json diagnostics 含 span/关键路径/结论',
    Boolean(traceSummaryJson
      && traceSummaryJson.result.diagnostics.spans.total >= 3
      && traceSummaryJson.result.diagnostics.spans.criticalPath.totalMs > 0
      && traceSummaryJson.result.diagnostics.findings.some((item) => item.code === 'long-tasks')),
    JSON.stringify(traceSummaryJson && traceSummaryJson.result && traceSummaryJson.result.diagnostics && traceSummaryJson.result.diagnostics.spans),
  );
  const traceDiff = await runCli(['trace', 'diff', tracePath, tracePath]);
  check(
    'trace diff 文本含差分结论（同文件 → 无变化）',
    traceDiff.code === 0
    && traceDiff.stdout.includes('差分结论：')
    && traceDiff.stdout.includes('事件数与时长都没有变化'),
    `${traceDiff.stdout}${traceDiff.stderr}`,
  );
  const traceDiffJson = jsonOf(await runCli(['trace', 'diff', tracePath, tracePath, '--json']));
  check(
    'trace diff --json diagnostics.findings 标记 no-change',
    Boolean(traceDiffJson && traceDiffJson.result.diagnostics.findings.some((item) => item.code === 'no-change')),
    JSON.stringify(traceDiffJson && traceDiffJson.result && traceDiffJson.result.diagnostics),
  );

  // -------------------------------------------------------------------------
  section('7e. 高频命令严格 specs 与 --dry-run 预检（video/record/debug/trace/longshot）');
  // 用一个没有 daemon 的 BB_HOME：dry-run 若偷发 RPC 会 E_DAEMON 退出 1。
  const dryEnv7 = { ...baseEnv(), BB_HOME: path.join(homeDir, 'dry-run-home7'), BB_AUTO_START: '0' };
  const dryJson7 = async (args) => {
    const result = await runCli([...args, '--dry-run', '--json'], { env: dryEnv7 });
    return { result, parsed: jsonOf(result) };
  };

  const dryVideoSave = await dryJson7(['video', 'save', 'rec-1', '--out', 'demo.webm']);
  check(
    'video save --dry-run 预检：取录制 → 写文件，且不触达 daemon',
    dryVideoSave.result.code === 0
    && dryVideoSave.parsed && dryVideoSave.parsed.dryRun === true
    && dryVideoSave.parsed.result.risk === 'browser_mutation'
    && dryVideoSave.parsed.result.steps[0].method === 'video.fetch'
    && dryVideoSave.parsed.result.steps.some((step) => step.kind === 'local' && step.action === 'write'
      && step.paths.some((item) => item.endsWith('demo.webm'))),
    `${dryVideoSave.result.stdout}${dryVideoSave.result.stderr}`,
  );
  const dryVideoStart = await dryJson7(['video', 'start', '--duration', '3s']);
  check(
    'video start --dry-run 画出 video.start 与 durationMs',
    dryVideoStart.result.code === 0
    && dryVideoStart.parsed
    && dryVideoStart.parsed.result.steps[0].method === 'video.start'
    && dryVideoStart.parsed.result.steps[0].params.durationMs === 3000,
    JSON.stringify(dryVideoStart.parsed && dryVideoStart.parsed.result && dryVideoStart.parsed.result.steps),
  );
  const dryDebugRequests = await dryJson7(['debug', 'requests', '--filter', '/api/']);
  check(
    'debug requests --dry-run 是单条只读 RPC（debug.current）',
    dryDebugRequests.result.code === 0
    && dryDebugRequests.parsed
    && dryDebugRequests.parsed.result.risk === 'read_only'
    && dryDebugRequests.parsed.result.requests.length === 1
    && dryDebugRequests.parsed.result.requests[0].method === 'debug.current',
    JSON.stringify(dryDebugRequests.parsed && dryDebugRequests.parsed.result),
  );
  const dryDebugRule = await dryJson7(['debug', 'rule_add', '--rule-file', 'rule.json']);
  check(
    'debug rule_add --dry-run 先读规则文件再加规则（含警告）',
    dryDebugRule.result.code === 0
    && dryDebugRule.parsed
    && dryDebugRule.parsed.result.steps.some((step) => step.kind === 'local' && step.action === 'read')
    && dryDebugRule.parsed.result.steps.some((step) => step.method === 'debug.rule_add')
    && dryDebugRule.parsed.result.warnings.length >= 1,
    JSON.stringify(dryDebugRule.parsed && dryDebugRule.parsed.result && dryDebugRule.parsed.result.steps),
  );
  const dryDebugArchives = await dryJson7(['debug', 'archives', '--dir', 'out', '--prune', '--max', '5']);
  check(
    'debug archives --prune --dry-run 列出删除步骤（不真的删）',
    dryDebugArchives.result.code === 0
    && dryDebugArchives.parsed
    && dryDebugArchives.parsed.result.steps.some((step) => step.kind === 'local' && step.action === 'delete')
    && dryDebugArchives.parsed.result.warnings.some((item) => item.includes('删除')),
    JSON.stringify(dryDebugArchives.parsed && dryDebugArchives.parsed.result && dryDebugArchives.parsed.result.steps),
  );
  const dryTraceView = await dryJson7(['trace', 'view', 'trace.json', '--out', 'viewer.html']);
  check(
    'trace view --dry-run 纯本地：读 trace 后写 HTML，没有 RPC',
    dryTraceView.result.code === 0
    && dryTraceView.parsed
    && dryTraceView.parsed.result.requests.length === 0
    && dryTraceView.parsed.result.risk === 'local_write'
    && dryTraceView.parsed.result.steps.some((step) => step.paths && step.paths.some((item) => item.endsWith('viewer.html'))),
    JSON.stringify(dryTraceView.parsed && dryTraceView.parsed.result),
  );
  const dryRecordExport = await dryJson7(['record', 'export', '--out', 'trace-dir', '--screenshot']);
  check(
    'record export --dry-run 预检 record.list + screenshot + trace.json 落盘',
    dryRecordExport.result.code === 0
    && dryRecordExport.parsed
    && dryRecordExport.parsed.result.requests.map((item) => item.method).join(',') === 'record.list,screenshot'
    && dryRecordExport.parsed.result.steps.some((step) => step.paths && step.paths.some((item) => item.endsWith('trace.json'))),
    JSON.stringify(dryRecordExport.parsed && dryRecordExport.parsed.result),
  );
  const dryLongshot = await dryJson7(['longshot', 'recover', 'ls-1', '--out', 'shot.png']);
  check(
    'longshot recover --dry-run 预检 longshot.recover + PNG 落盘',
    dryLongshot.result.code === 0
    && dryLongshot.parsed
    && dryLongshot.parsed.result.requests[0].method === 'longshot.recover'
    && dryLongshot.parsed.result.steps.some((step) => step.kind === 'local' && step.paths.some((item) => item.endsWith('shot.png'))),
    JSON.stringify(dryLongshot.parsed && dryLongshot.parsed.result),
  );
  check('dry-run --json 仍是单行 bb.cli/1 信封', singleLineJson(dryVideoSave.result) && validateEnvelope(dryVideoSave.parsed).length === 0);
  const dryAggregate = await runCli(['debug', 'aggregate', '--slow-ms', '500', '--dry-run', '--json'], { env: dryEnv7 });
  const dryAnalyze = await runCli(['debug', 'analyze', '--file', 'a.json', '--min-duration', '100', '--dry-run', '--json'], { env: dryEnv7 });
  check(
    '--slow-ms / --min-duration 已能解析（历史漏注册回归）',
    dryAggregate.code === 0 && dryAnalyze.code === 0,
    `${dryAggregate.stderr}${dryAnalyze.stderr}`,
  );
  const newTopics = ['video', 'longshot', 'record', 'debug', 'trace'];
  check(
    '五个命令全部纳入 specs 且每个子命令声明 dryRun',
    newTopics.every((topic) => COMMAND_SPECS[topic]
      && COMMAND_SPECS[topic].order.every((name) => COMMAND_SPECS[topic].subs[name].dryRun === true)),
    newTopics.join(','),
  );
  const helpVideo = await runCli(['help', 'video']);
  check(
    'bridge help video 渲染全部子命令用法与 --dry-run',
    helpVideo.code === 0
    && COMMAND_SPECS.video.order.every((name) => helpVideo.stdout.includes(COMMAND_SPECS.video.subs[name].usage))
    && helpVideo.stdout.includes('--dry-run'),
    helpVideo.stdout.slice(0, 200),
  );

  // ---- 帮助 ↔ specs 一致性（全量主题，逐条比对渲染器输出）----
  const helpAll = await runCli(['help']);
  check(
    'bridge help 覆盖 specs 的全部命令主题与示例',
    helpAll.code === 0
    && helpAll.stdout.includes(COMMAND_TOPICS.join(' | '))
    && COMMON_EXAMPLES.every((example) => helpAll.stdout.includes(example)),
    helpAll.stdout.slice(0, 200),
  );
  const helpTopicFailures = [];
  for (const topic of COMMAND_TOPICS) {
    const result = await runCli(['help', topic]);
    if (result.code !== 0 || result.stdout.trimEnd() !== renderCommandHelp(topic)) helpTopicFailures.push(topic);
  }
  check(
    '每个 specs 主题的 bridge help <命令> 与渲染器逐字一致',
    helpTopicFailures.length === 0,
    helpTopicFailures.join(','),
  );
  const helpTabViaTopic = await runCli(['help', 'tab']);
  const helpTabViaFlag = await runCli(['tab', '--help']);
  check(
    'bridge <命令> --help 等价 bridge help <命令>',
    helpTabViaFlag.code === 0 && helpTabViaFlag.stdout === helpTabViaTopic.stdout,
    `${helpTabViaFlag.code}`,
  );

  // ---- README 命令索引漂移门禁（与 command-specs 单源）----
  const readmeCheck = await runNode([path.join(REPO, 'tools', 'readme-commands.mjs'), '--check']);
  check(
    'README 命令索引与 command-specs 一致（--check clean）',
    readmeCheck.code === 0 && readmeCheck.stdout.includes('clean'),
    `${readmeCheck.stdout}${readmeCheck.stderr}`,
  );

  // -------------------------------------------------------------------------
  section('8. 参数错误 / 业务错误与退出码');
  const noOut = await runCli(['screenshot', '--session', sessionId]);
  check('screenshot 缺 --out → 退出码 2', noOut.code === 2, `${noOut.stdout}${noOut.stderr}`);
  const fillNoValue = await runCli(['fill', '@e2']);
  check('fill 缺 --value → 退出码 2', fillNoValue.code === 2, `${fillNoValue.stdout}${fillNoValue.stderr}`);
  const unknownCommand = await runCli(['frobnicate']);
  check('未知命令 → 退出码 2', unknownCommand.code === 2, `${unknownCommand.stdout}${unknownCommand.stderr}`);
  const badSession = await runCli(['observe', '--session', 'zzzz', '--json']);
  check('不存在的 session → 退出码 1 + E_NO_SESSION', badSession.code === 1 && jsonOf(badSession) && jsonOf(badSession).error.code === 'E_NO_SESSION', badSession.stdout + badSession.stderr);
  const badSessionJson = jsonOf(badSession);
  check('失败 JSON 信封：schema/command/error.code 稳定且带 hint',
    Boolean(badSessionJson
      && badSessionJson.schema === JSON_SCHEMA_ID
      && badSessionJson.command === 'observe'
      && badSessionJson.ok === false
      && typeof badSessionJson.error.hint === 'string'
      && badSessionJson.error.hint.length > 0
      && validateEnvelope(badSessionJson).length === 0),
    JSON.stringify(badSessionJson && badSessionJson.error));

  const slow = await runCli(['evaluate', 'delay:2000', '--timeout', '300', '--json', '--session', sessionId]);
  check('命令超时 → 退出码 1 + E_TIMEOUT', slow.code === 1 && jsonOf(slow) && jsonOf(slow).error.code === 'E_TIMEOUT', `${slow.stdout}${slow.stderr}`);
  await sleep(2200); // 等 mock 的迟到回包到达 daemon（应被丢弃）
  const afterLate = await runCli(['status', '--json']);
  check('迟到回包被丢弃、daemon 仍正常', afterLate.code === 0 && jsonOf(afterLate) && jsonOf(afterLate).ok === true, `${afterLate.stdout}${afterLate.stderr}`);

  // -------------------------------------------------------------------------
  section('9. 多 session 消歧（PROTOCOL §7）');
  const start2 = jsonOf(await runCli(['session', 'start', '--json']));
  const session2 = start2 && start2.result && start2.result.sessionId;
  check('第二个 session 创建成功', /^[a-z]{4}$/.test(session2 || ''), JSON.stringify(start2));
  check('两个 session id 不同', Boolean(session2 && session2 !== sessionId));

  const ambiguous = await runCli(['navigate', 'https://x.example/', '--json']);
  const ambiguousJson = jsonOf(ambiguous);
  check('多 session 且省略 --session → 退出码 1 + E_NO_SESSION', ambiguous.code === 1 && ambiguousJson && ambiguousJson.error.code === 'E_NO_SESSION', ambiguous.stdout + ambiguous.stderr);
  check('E_NO_SESSION 消息列出候选 session', Boolean(ambiguousJson && String(ambiguousJson.error.message).includes(sessionId) && String(ambiguousJson.error.message).includes(session2)));

  const stop2 = await runCli(['session', 'stop', session2, '--json']);
  check('session stop 指定 id 成功', stop2.code === 0 && jsonOf(stop2) && jsonOf(stop2).ok === true, stop2.stdout + stop2.stderr);
  const navAgain = await runCli(['navigate', 'https://again.example/', '--json']);
  check('去掉多余 session 后自动选用恢复', navAgain.code === 0 && jsonOf(navAgain) && jsonOf(navAgain).result.url === 'https://again.example/', navAgain.stdout + navAgain.stderr);

  const stop1 = await runCli(['session', 'stop', sessionId]);
  check('session stop 人类输出成功', stop1.code === 0, stop1.stderr);
  const listAfter = jsonOf(await runCli(['session', 'list', '--json']));
  check('session stop 后 session.list 为空', Boolean(listAfter && listAfter.ok === true && listAfter.result.sessions.length === 0));
  check('daemon 无残留 session', Boolean(jsonOf(await runCli(['status', '--json'])).result.sessions.length === 0));

  // -------------------------------------------------------------------------
  section('10. 实例断开清理与重连 instanceId 复用');
  mockProc.kill();
  const cleaned = await waitFor(async () => {
    const result = await directRpc('status');
    return Boolean(result && result.ok && result.result.browsers.length === 0);
  }, 8_000, 150);
  check('mock 退出后 daemon 清理实例', cleaned);

  startMockProcess(['--instance-id', instanceId]);
  const reconnected = await waitFor(async () => {
    const result = await directRpc('status');
    return Boolean(result && result.ok && result.result.browsers.length === 1);
  }, 8_000, 150);
  check('mock 重连成功', reconnected);
  const status5 = jsonOf(await runCli(['status', '--json']));
  check('重连沿用 hello.instanceId 提示', Boolean(status5 && status5.result.browsers[0] && status5.result.browsers[0].instanceId === instanceId), JSON.stringify(status5 && status5.result.browsers));

  // -------------------------------------------------------------------------
  section('10b. update 发布清单校验');
  const updateCheck = jsonOf(await runCli(['update', 'check', '--json']));
  check(
    'update check 校验 SHA256/字节数',
    Boolean(updateCheck && updateCheck.ok === true && updateCheck.result.verified === true && (updateCheck.result.artifacts || []).length >= 2),
    JSON.stringify(updateCheck && updateCheck.result),
  );
  const updateAlias = jsonOf(await runCli(['update', '--check', '--json']));
  check('update --check 别名可用', Boolean(updateAlias && updateAlias.result && updateAlias.result.verified === true));
  const updateMissing = jsonOf(await runCli(['update', 'check', '--manifest', path.join(homeDir, 'nope.json'), '--json']));
  check('update 缺清单时明确报告', Boolean(updateMissing && updateMissing.result && updateMissing.result.verified === false && updateMissing.result.note));

  const stageDir = path.join(homeDir, 'update-stage');
  const staged = jsonOf(await runCli(['update', 'stage', '--dir', stageDir, '--json']));
  const stagedFiles = (staged && staged.result && staged.result.artifacts) || [];
  check(
    'update stage 落盘并校验 SHA256',
    Boolean(
      staged && staged.ok === true && staged.result.verified === true && stagedFiles.length >= 2 &&
      stagedFiles.every((item) => fs.existsSync(path.join(staged.result.dir, item.name))) &&
      fs.existsSync(path.join(staged.result.dir, 'staged.json')),
    ),
    JSON.stringify(staged && staged.result),
  );
  const stagedAgain = jsonOf(await runCli(['update', 'stage', '--dir', stageDir, '--json']));
  check('update stage 默认拒绝覆盖非空目录', Boolean(stagedAgain && stagedAgain.error && stagedAgain.error.code === 'E_EXISTS'));

  const keyPath = path.join(homeDir, 'release.key');
  fs.writeFileSync(keyPath, 'selftest-secret\n', 'utf8');
  const baseManifest = JSON.parse(fs.readFileSync(path.join(REPO, 'dist', 'release.json'), 'utf8'));
  const signedManifest = { ...baseManifest, signature: signRelease(baseManifest, 'selftest-secret') };
  const signedPath = path.join(homeDir, 'release-signed.json');
  fs.writeFileSync(signedPath, JSON.stringify(signedManifest, null, 2), 'utf8');
  const signedCheck = jsonOf(await runCli(['update', 'check', '--manifest', signedPath, '--key', keyPath, '--json']));
  check('update check 校验 HMAC 签名', Boolean(signedCheck && signedCheck.result && signedCheck.result.signature && signedCheck.result.signature.valid === true), JSON.stringify(signedCheck && signedCheck.result));
  const tamperedManifest = JSON.parse(JSON.stringify(signedManifest));
  tamperedManifest.artifacts[0].bytes += 1;
  const tamperedPath = path.join(homeDir, 'release-tampered.json');
  fs.writeFileSync(tamperedPath, JSON.stringify(tamperedManifest, null, 2), 'utf8');
  const tamperedCheck = jsonOf(await runCli(['update', 'check', '--manifest', tamperedPath, '--key', keyPath, '--json']));
  check('update check 发现签名被篡改', Boolean(tamperedCheck && tamperedCheck.result && tamperedCheck.result.signature && tamperedCheck.result.signature.valid === false));

  const releaseServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(signedManifest));
  });
  await new Promise((resolve) => releaseServer.listen(0, '127.0.0.1', resolve));
  const releasePort = releaseServer.address().port;
  const fetchedPath = path.join(homeDir, 'release-fetched.json');
  try {
    const fetched = jsonOf(await runCli(['update', 'fetch', '--source', 'http://127.0.0.1:' + releasePort + '/release.json', '--out', fetchedPath, '--key', keyPath, '--json']));
    check('update fetch 拉取并校验远程清单', Boolean(fetched && fetched.result && fetched.result.version === baseManifest.version && fetched.result.signature.valid === true && fs.existsSync(fetchedPath)), JSON.stringify(fetched && fetched.result));
    const state = jsonOf(await runCli(['update', 'state', '--json']));
    check('update state 记录 lastFetch', Boolean(state && state.result && state.result.state && state.result.state.lastFetch && state.result.state.lastFetch.version === baseManifest.version));

    const autoOn = jsonOf(await runCli(['update', 'auto', '--enable', '--source', 'https://example.com/release.json', '--interval', '1h', '--apply', '--target', homeDir, '--json']));
    check('update auto 配置开启', Boolean(autoOn && autoOn.result && autoOn.result.auto && autoOn.result.auto.enabled === true && autoOn.result.auto.apply === true && autoOn.result.auto.applyTarget));
    const autoOff = jsonOf(await runCli(['update', 'auto', '--disable', '--json']));
    check('update auto 配置关闭', Boolean(autoOff && autoOff.result && autoOff.result.auto && autoOff.result.auto.enabled === false));
  } finally {
    await new Promise((resolve) => releaseServer.close(resolve));
  }

  const applyTarget = path.join(homeDir, 'update-target');
  fs.mkdirSync(applyTarget, { recursive: true });
  const firstArtifact = stagedFiles[0];
  const targetFile = path.join(applyTarget, firstArtifact.name);
  fs.writeFileSync(targetFile, 'old', 'utf8');
  const applied = jsonOf(await runCli(['update', 'apply', '--staging', staged.result.dir, '--target', applyTarget, '--json']));
  check(
    'update apply 写入并备份旧文件',
    Boolean(
      applied && applied.ok === true && applied.result && applied.result.backupDir &&
      fs.existsSync(path.join(applied.result.backupDir, 'backup.json')) &&
      fs.readFileSync(targetFile).length === firstArtifact.bytes,
    ),
    JSON.stringify(applied && applied.result && applied.result.files),
  );
  const rolledBack = applied && applied.result
    ? jsonOf(await runCli(['update', 'rollback', '--backup', applied.result.backupDir, '--json']))
    : null;
  check(
    'update rollback 恢复旧文件',
    Boolean(rolledBack && rolledBack.ok === true && fs.readFileSync(targetFile, 'utf8') === 'old'),
    JSON.stringify(rolledBack),
  );

  section('10c. 可恢复会话启动（requestId 幂等）');
  const startToken = `${Date.now() + 5 * 60 * 1000}:selftest${Math.random().toString(36).slice(2, 10)}`;
  const tracked1 = jsonOf(await runCli(['session', 'start', '--request-id', startToken, '--json']));
  const tracked2 = jsonOf(await runCli(['session', 'start', '--request-id', startToken, '--json']));
  check(
    '同 requestId 重试返回同一 session',
    Boolean(tracked1 && tracked2 && tracked1.result && tracked2.result && tracked1.result.sessionId === tracked2.result.sessionId),
    JSON.stringify([tracked1, tracked2]),
  );
  check('第二次启动标记 reused=true', Boolean(tracked2 && tracked2.result && tracked2.result.reused === true));
  const expiredStart = await runCli(['session', 'start', '--request-id', `${Date.now() - 1000}:expiredid1`, '--json']);
  check('过期 requestId 被拒绝', expiredStart.code !== 0 && /过期/.test(expiredStart.stdout), expiredStart.stdout);

  const lifecycleToken = `${Date.now() + 5 * 60 * 1000}:lifecycle${Math.random().toString(36).slice(2, 8)}`;
  const prepared = jsonOf(await runCli(['session', 'prepare', '--request-id', lifecycleToken, '--json']));
  check('session prepare 留下 prepared 记录', Boolean(prepared && prepared.result && prepared.result.entry && prepared.result.entry.state === 'prepared'), JSON.stringify(prepared));
  const claimEarly = await runCli(['session', 'claim', '--request-id', lifecycleToken, '--json']);
  check('未 ready 不能 claim', claimEarly.code !== 0 && /E_START_NOT_READY/.test(claimEarly.stdout), claimEarly.stdout);
  const lifecycleStart = jsonOf(await runCli(['session', 'start', '--request-id', lifecycleToken, '--json']));
  const lifecycleSid = lifecycleStart && lifecycleStart.result ? lifecycleStart.result.sessionId : null;
  check('prepared token 可启动会话', Boolean(lifecycleSid), JSON.stringify(lifecycleStart));
  const statusReady = jsonOf(await runCli(['session', 'request', '--request-id', lifecycleToken, '--json']));
  check('request status=ready', Boolean(statusReady && statusReady.result && statusReady.result.entry && statusReady.result.entry.state === 'ready'), JSON.stringify(statusReady));
  const claimed = jsonOf(await runCli(['session', 'claim', '--request-id', lifecycleToken, '--json']));
  check('claim → claimed', Boolean(claimed && claimed.result && claimed.result.entry && claimed.result.entry.state === 'claimed'), JSON.stringify(claimed));
  const cancelled = jsonOf(await runCli(['session', 'cancel', '--request-id', lifecycleToken, '--json']));
  check('cancel → cancelled 且带 sessionId', Boolean(cancelled && cancelled.result && cancelled.result.entry.state === 'cancelled' && cancelled.result.sessionId === lifecycleSid), JSON.stringify(cancelled));
  const blockedStart = await runCli(['session', 'start', '--request-id', lifecycleToken, '--json']);
  check('墓碑 token 不能再次启动', blockedStart.code !== 0 && /E_REQUEST_CANCELLED/.test(blockedStart.stdout), blockedStart.stdout);
  if (lifecycleSid) await runCli(['session', 'stop', lifecycleSid, '--json']);
  if (tracked1 && tracked1.result && tracked1.result.sessionId) {
    await runCli(['session', 'stop', tracked1.result.sessionId, '--json']);
  }

  section('11. doctor 与 daemon stop');
  const doctor = await runCli(['doctor']);
  check('bridge doctor 退出码 0', doctor.code === 0, `${doctor.stdout}${doctor.stderr}`);
  check('doctor 输出 daemon/token 检查项', doctor.stdout.includes('daemon') && doctor.stdout.includes('token'), doctor.stdout);
  check('doctor 输出配对状态与建议', doctor.stdout.includes('pairing') && /可选模式|必需模式/.test(doctor.stdout), doctor.stdout);
  check('doctor 输出日志/磁盘/端口检查项', ['log', 'disk', 'port'].every((name) => doctor.stdout.includes(name)), doctor.stdout);
  check('doctor 输出安装/TLS/日志错误摘要', ['install', 'tls', 'log-errors'].every((name) => doctor.stdout.includes(name)), doctor.stdout);
  const doctorJson = jsonOf(await runCli(['doctor', '--json']));
  check('doctor --json 单行 JSON 且 ok=true', Boolean(doctorJson && doctorJson.ok === true));
  const pairingCheck = doctorJson && doctorJson.result && (doctorJson.result.checks || []).find((item) => item.name === 'pairing');
  check('doctor --json 含 pairing 检查项', Boolean(pairingCheck), JSON.stringify(doctorJson && doctorJson.result && doctorJson.result.checks));

  mockProc.kill();
  await waitFor(async () => {
    const current = await health();
    return Boolean(current && current.browsers === 0);
  }, 8_000, 150);

  const daemonStop = await runCli(['daemon', 'stop']);
  check('bridge daemon stop 优雅停止', daemonStop.code === 0 && daemonStop.stdout.includes('已停止'), `${daemonStop.stdout}${daemonStop.stderr}`);
  check('daemon /health 消失', await waitFor(async () => !(await health()), 6_000, 120));
  check('daemon.json 已清理', !fs.existsSync(DAEMON_JSON()));
  check('前台 daemon 进程已退出', await waitFor(async () => daemonProc.exitCode !== null, 6_000, 120));

  // -------------------------------------------------------------------------
  section('12. daemon 自动拉起（CLI detached）');
  const autoStatus = await runCli(['status', '--json']);
  check('无 daemon 时 CLI 自动拉起并返回 0', autoStatus.code === 0 && jsonOf(autoStatus) && jsonOf(autoStatus).ok === true, `${autoStatus.stdout}${autoStatus.stderr}`);
  const autoInfo = readDaemonInfo();
  check('自动拉起的 daemon 写好 daemon.json', Boolean(autoInfo && typeof autoInfo.port === 'number'));
  check('自动拉起的 daemon 监听 BB_PORT', Boolean(autoInfo && autoInfo.port === port), `json.port=${autoInfo && autoInfo.port} BB_PORT=${port}`);
  check('自动拉起的 daemon /health 正常', Boolean(await health()));

  const autoStop = await runCli(['daemon', 'stop']);
  check('自动拉起的 daemon 可被 daemon stop 清理', autoStop.code === 0, `${autoStop.stdout}${autoStop.stderr}`);
  check('CLI 自动拉起的 daemon 已退出', await waitFor(async () => !(await health()), 6_000, 120));
}

// ---------------------------------------------------------------------------
// 清理
// ---------------------------------------------------------------------------

async function cleanup() {
  try {
    if (mockProc && mockProc.exitCode === null) mockProc.kill();
  } catch { /* 忽略 */ }
  try {
    if (readDaemonInfo()) await runCli(['daemon', 'stop'], { timeoutMs: 8000 });
  } catch { /* 忽略 */ }
  await sleep(200);
  try {
    if (daemonProc && daemonProc.exitCode === null) daemonProc.kill();
  } catch { /* 忽略 */ }
  const current = await health();
  if (current && current.pid) {
    try { process.kill(current.pid); } catch { /* 忽略 */ }
    await sleep(200);
  }
  for (let i = 0; i < 5; i += 1) {
    try {
      fs.rmSync(homeDir, { recursive: true, force: true });
      break;
    } catch {
      await sleep(200);
    }
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main() {
  try {
    await runTests();
  } catch (err) {
    failCount += 1;
    failures.push('uncaught');
    console.log(`\n[FATAL] ${err && err.stack ? err.stack : err}`);
    if (daemonOutput.length) console.log(`\n--- daemon log ---\n${daemonOutput.join('')}`);
    if (mockOutput.length) console.log(`\n--- mock log ---\n${mockOutput.join('')}`);
  } finally {
    await cleanup();
  }

  console.log('\n== 结果 ==');
  console.log(`通过 ${passCount} 项，失败 ${failCount} 项`);
  if (failCount > 0) {
    console.log('失败项：');
    for (const name of failures) console.log(`  - ${name}`);
    console.log('SELFTEST FAIL');
    return 1;
  }
  console.log('SELFTEST PASS');
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
    const timer = setTimeout(() => process.exit(code), 1000);
    timer.unref();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
