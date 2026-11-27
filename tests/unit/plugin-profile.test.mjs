// DSH profile/apply 契约深度测试：配置容错、工具+技能注册、agent 作用域、失败渲染、启动回收。
// 通过临时目录里的 dsh-plugin/lib 副本 + stub 的 schemastery/dsh-tools 运行真实 index.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PLUGIN = path.join(ROOT, 'dsh-plugin');

async function prepareEntry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-plugin-profile-'));
  fs.cpSync(path.join(PLUGIN, 'lib'), path.join(dir, 'lib'), { recursive: true });
  const stubRoot = path.join(dir, 'node_modules', '@deepseek-ai');
  fs.mkdirSync(path.join(stubRoot, 'dsh-tools'), { recursive: true });
  fs.writeFileSync(path.join(stubRoot, 'dsh-tools', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', type: 'module', main: 'index.mjs' }), 'utf8');
  fs.writeFileSync(path.join(stubRoot, 'dsh-tools', 'index.mjs'), 'export function defineTool(spec) { return spec; }\n', 'utf8');
  fs.mkdirSync(path.join(stubRoot, 'schemastery'), { recursive: true });
  fs.writeFileSync(path.join(stubRoot, 'schemastery', 'package.json'), JSON.stringify({ name: '@deepseek-ai/schemastery', type: 'module', main: 'index.mjs' }), 'utf8');
  fs.writeFileSync(path.join(stubRoot, 'schemastery', 'index.mjs'), [
    'function chain() {',
    '  const api = {};',
    '  for (const key of ["default", "volatile", "min", "max", "step", "pattern"]) api[key] = () => api;',
    '  return api;',
    '}',
    'export default { string: () => chain(), number: () => chain(), object: () => chain(), union: () => chain() };',
  ].join('\n'), 'utf8');
  const entry = await import(pathToFileURL(path.join(dir, 'lib', 'index.mjs')).href);
  return { dir, entry };
}

function writeCli(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

const OK_CLI = [
  'const args = process.argv.slice(2);',
  'if (args[0] === "status") {',
  '  process.stdout.write(JSON.stringify({ ok: true, result: { port: 52900, version: "0.3.0", browsers: [{ instanceId: "abcd1234" }], sessions: [] } }) + "\\n");',
  '} else {',
  '  process.stdout.write(JSON.stringify({ ok: true, result: { argv: args } }) + "\\n");',
  '}',
].join('\n');

const FAIL_CLI = [
  'process.stdout.write(JSON.stringify({ ok: false, error: { code: "E_CACHE_EMPTY", message: "没缓存" } }) + "\\n");',
  'process.exitCode = 1;',
].join('\n');

const SLOW_CLI = [
  'setTimeout(() => {',
  '  process.stdout.write(JSON.stringify({ ok: true, result: { port: 1 } }) + "\\n");',
  '}, 400);',
].join('\n');

const ORPHAN_CLI = [
  'import fs from "node:fs";',
  'const args = process.argv.slice(2);',
  'const log = process.env.BB_TEST_LOG;',
  'if (log) fs.appendFileSync(log, JSON.stringify(args) + "\\n");',
  'if (args[0] === "session" && args[1] === "request") {',
  '  process.stdout.write(JSON.stringify({ ok: true, result: { entry: { state: "ready", result: { sessionId: "s-orphan" } } } }) + "\\n");',
  '} else if (args[0] === "session" && args[1] === "stop") {',
  '  process.stdout.write(JSON.stringify({ ok: true, result: { ok: true } }) + "\\n");',
  '} else {',
  '  process.stdout.write(JSON.stringify({ ok: true, result: {} }) + "\\n");',
  '}',
].join('\n');

function makeCtx() {
  const state = {
    tools: [],
    skills: [],
    effects: [],
    disposers: [],
    handlers: {},
    warnings: [],
    infos: [],
  };
  const ctx = {
    logger: {
      info(...args) { state.infos.push(args.map(String).join(' ')); },
      warn(...args) { state.warnings.push(args.map(String).join(' ')); },
    },
    effect(fn, label) {
      state.effects.push(label);
      const dispose = fn();
      if (typeof dispose === 'function') state.disposers.push(dispose);
      return dispose;
    },
    on(event, fn) {
      state.handlers[event] = fn;
      return () => { state.handlers[event] = null; };
    },
    get(name) {
      if (name !== 'skills') return null;
      return {
        register(skill) {
          state.skills.push(skill);
          return () => {};
        },
      };
    },
    tools: {
      register(tool) {
        state.tools.push(tool);
        return () => {};
      },
    },
  };
  return { ctx, state };
}

function makeAgentCtx() {
  const state = { skills: [], disposed: 0 };
  const agentCtx = {
    logger: { warn() {}, info() {} },
    effect(fn) { return fn(); },
    get(name) {
      if (name !== 'skills') return null;
      return {
        register(skill) {
          state.skills.push(skill);
          return () => { state.disposed += 1; };
        },
      };
    },
  };
  return { agentCtx, state };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await sleep(50);
  }
  return false;
}

test('apply()：注册 37 个工具 + 技能，配置默认值/生效值可知', async (t) => {
  const { dir, entry } = await prepareEntry();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-profile-home-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const { ctx, state } = makeCtx();
  entry.apply(ctx, { bridgeCli: writeCli(dir, 'ok-cli.mjs', OK_CLI), home, timeoutMs: 10000 });

  assert.equal(state.tools.length, 37, '应注册 37 个工具');
  assert.equal(state.skills.length, 1, '技能应注册一次');
  assert.ok(state.skills[0].content.includes('## 插件专属参考（DSH 插件补充）'));
  assert.ok(state.effects.includes('browser-bridge-tools:skill'));
  assert.ok(state.effects.includes('browser-bridge-tools:skill-agents'));
  for (const tool of state.tools) {
    assert.match(tool.name, /^browser_/);
    assert.equal(typeof tool.execute, 'function');
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(tool.output.schema.type, 'object');
  }
  // 工具 spec 的元数据没有被入口吞掉（annotations 随 defineTool 的 spec 走）。
  const observe = state.tools.find((tool) => tool.name === 'browser_observe');
  assert.equal(observe.description.length > 20, true);
  assert.ok(state.handlers['agent/created'] && state.handlers['agent/disposed'], '应挂 agent 生命周期');
});

test('apply()：agent/created 注册独立技能，agent/disposed 释放', async (t) => {
  const { dir, entry } = await prepareEntry();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-profile-home-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const { ctx, state } = makeCtx();
  entry.apply(ctx, { bridgeCli: writeCli(dir, 'ok-cli.mjs', OK_CLI), home });
  const { agentCtx, state: agentState } = makeAgentCtx();
  const agent = { ctx: agentCtx };
  state.handlers['agent/created']({ agent });
  assert.equal(agentState.skills.length, 1, 'agent ctx 应注册技能');
  // 同一个 agent 重复触发只注册一次（按 agent 对象去重）。
  state.handlers['agent/created']({ agent });
  assert.equal(agentState.skills.length, 1);
  state.handlers['agent/disposed']({ agent });
  assert.equal(agentState.disposed, 1, 'dispose 应被调用');
  // 没有 skills 服务的 agent 不崩。
  state.handlers['agent/created']({ agent: { ctx: { get() { return null; }, logger: { warn() {} } } } });
});

test('apply()：CLI 缺失只告警、不注册工具，但技能仍可发现（不拖垮 profile）', async (t) => {
  const { dir, entry } = await prepareEntry();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-profile-home-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  const { ctx, state } = makeCtx();
  entry.apply(ctx, { bridgeCli: path.join(dir, 'missing-cli.mjs'), home });
  assert.equal(state.tools.length, 0, 'CLI 缺失时不应注册工具');
  assert.equal(state.warnings.length, 1);
  assert.match(state.warnings[0], /BridgeDeck插件未注册工具/);
  assert.equal(state.skills.length, 1, '技能注册不依赖 CLI');
});

test('apply()：配置 get() 包装生效（timeoutMs 真的传给运行器）', async (t) => {
  const saved = process.env.BB_PLUGIN_DIRECT_RPC;
  const { dir, entry } = await prepareEntry();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-profile-home-'));
  t.after(() => {
    if (saved === undefined) delete process.env.BB_PLUGIN_DIRECT_RPC;
    else process.env.BB_PLUGIN_DIRECT_RPC = saved;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  process.env.BB_PLUGIN_DIRECT_RPC = '0'; // 强制走 CLI，验证 timeout 配置
  const { ctx, state } = makeCtx();
  entry.apply(ctx, {
    bridgeCli: writeCli(dir, 'slow-cli.mjs', SLOW_CLI),
    home,
    timeoutMs: { get: () => 200 },
  });
  const status = state.tools.find((tool) => tool.name === 'browser_status');
  const startedAt = Date.now();
  const value = await status.execute({}, {});
  const elapsed = Date.now() - startedAt;
  assert.equal(value.ok, false);
  assert.equal(value.error.code, 'E_TIMEOUT', '应使用配置里的 200ms 超时');
  assert.ok(elapsed < 1200, '超时应在配置时间内触发，实际 ' + elapsed + 'ms');
});

test('apply()：成功值渲染 JSON，失败值渲染错误码 + 下一步动作', async (t) => {
  const saved = process.env.BB_PLUGIN_DIRECT_RPC;
  const { dir, entry } = await prepareEntry();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-profile-home-'));
  t.after(() => {
    if (saved === undefined) delete process.env.BB_PLUGIN_DIRECT_RPC;
    else process.env.BB_PLUGIN_DIRECT_RPC = saved;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  process.env.BB_PLUGIN_DIRECT_RPC = '0';
  const okHome = home;
  const okCtx = makeCtx();
  entry.apply(okCtx.ctx, { bridgeCli: writeCli(dir, 'ok-cli.mjs', OK_CLI), home: okHome });
  const okStatus = okCtx.state.tools.find((tool) => tool.name === 'browser_status');
  const okValue = await okStatus.execute({}, {});
  assert.equal(okValue.port, 52900);
  assert.match(okStatus.output.render({}, okValue)[0].text, /abcd1234/);

  const failCtx = makeCtx();
  entry.apply(failCtx.ctx, { bridgeCli: writeCli(dir, 'fail-cli.mjs', FAIL_CLI), home: okHome });
  const failStatus = failCtx.state.tools.find((tool) => tool.name === 'browser_status');
  const failValue = await failStatus.execute({}, {});
  assert.equal(failValue.ok, false);
  assert.equal(failValue.error.code, 'E_CACHE_EMPTY');
  const text = failStatus.output.render({}, failValue)[0].text;
  assert.match(text, /^\[失败\] browser_status：E_CACHE_EMPTY/);
  assert.match(text, /下一步：/);
});

test('apply()：后台回收上次崩溃遗留的 starting 会话（journal → session request → stop）', async (t) => {
  const saved = process.env.BB_PLUGIN_DIRECT_RPC;
  const { dir, entry } = await prepareEntry();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-profile-home-'));
  const logPath = path.join(dir, 'orphan-calls.log');
  t.after(() => {
    if (saved === undefined) delete process.env.BB_PLUGIN_DIRECT_RPC;
    else process.env.BB_PLUGIN_DIRECT_RPC = saved;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });
  process.env.BB_PLUGIN_DIRECT_RPC = '0';
  process.env.BB_TEST_LOG = logPath;
  t.after(() => { delete process.env.BB_TEST_LOG; });
  const staleAt = Date.now() - 300000;
  const token = '900000000000:orphan-test';
  fs.writeFileSync(path.join(home, 'dsh-starts.json'), JSON.stringify({
    version: 1,
    entries: { [token]: { state: 'starting', at: staleAt, meta: { browser: 'edge' } } },
  }), 'utf8');
  const { ctx } = makeCtx();
  entry.apply(ctx, { bridgeCli: writeCli(dir, 'orphan-cli.mjs', ORPHAN_CLI), home });
  const journalPath = path.join(home, 'dsh-starts.json');
  const stopped = await waitFor(() => {
    // 先等 CLI 调用留下日志，再等 journal 落到 recovered：并行跑全量单测时
    // 两者之间有窗口，只看日志会读到旧状态（曾据此复现 1 次假失败）。
    if (!fs.existsSync(logPath)) return false;
    if (!fs.readFileSync(logPath, 'utf8').includes('s-orphan')) return false;
    try {
      const current = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      return current.entries[token] && current.entries[token].state === 'recovered';
    } catch {
      return false;
    }
  }, 15000);
  assert.ok(stopped, '应调用 session stop 回收孤儿会话并落盘 recovered');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.equal(journal.entries[token].state, 'recovered');
  assert.equal(journal.entries[token].recoveredSessionId, 's-orphan');
});

test('profile 组合静态契约：cordis.patch.yml / package.json / README 与入口一致', () => {
  const patch = fs.readFileSync(path.join(PLUGIN, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /id:\s*browser-bridge-tools/);
  assert.match(patch, /name:\s*dsh-browser-bridge/);
  for (const key of ['bridgeCli', 'nodePath', 'home', 'timeoutMs']) assert.ok(patch.includes(key + ':'), 'patch 缺少配置项 ' + key);
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-browser-bridge');
  assert.equal(pkg.main, 'lib/index.mjs');
  assert.equal(pkg.exports['.'], './lib/index.mjs');
  assert.equal(pkg.exports['./tools'], './lib/tools.mjs');
  assert.equal(pkg.dsh.manifestVersion, 1);
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  for (const dirName of ['lib', 'skill', 'scripts']) assert.ok(pkg.files.includes(dirName), 'files 缺少 ' + dirName);
  assert.equal(pkg.scripts['build:skill'], 'node scripts/build-skill-content.mjs');
  const readme = fs.readFileSync(path.join(PLUGIN, 'README.md'), 'utf8');
  assert.match(readme, /37 个/);
  assert.ok(readme.includes('TOOLS.md'), 'README 应指向工具索引');
});
