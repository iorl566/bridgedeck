#!/usr/bin/env node
// tests/plugin/selftest.mjs —— DSH 插件（dsh-plugin/）单测：工具映射 + CLI 运行器
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildToolSpecs } from '../../dsh-plugin/lib/tools.mjs';
import { createRunner, BridgeCliError } from '../../dsh-plugin/lib/bridge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let passed = 0;
let failed = 0;
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log('  [PASS] ' + name);
    })
    .catch((error) => {
      failed += 1;
      console.log('  [FAIL] ' + name + ' — ' + ((error && error.message) || error));
    });
}

const calls = [];
const fakeRun = async (argv) => {
  calls.push(argv);
  return { ok: true, argv };
};
const specs = buildToolSpecs(fakeRun);
const byName = new Map(specs.map((spec) => [spec.name, spec]));

console.log('BridgeDeck DSH 插件自测');

await check('工具数量与命名唯一', () => {
  assert.ok(specs.length >= 10, '工具太少：' + specs.length);
  assert.equal(new Set(specs.map((spec) => spec.name)).size, specs.length, '工具名重复');
  for (const spec of specs) {
    assert.match(spec.name, /^browser_/, '工具名应以 browser_ 开头：' + spec.name);
    assert.ok(spec.description && spec.description.length > 20, spec.name + ' 缺少描述');
    assert.equal(typeof spec.execute, 'function', spec.name + ' 缺少 execute');
  }
});

await check('参数与输出都有描述', () => {
  for (const spec of specs) {
    for (const [key, schema] of Object.entries(spec.parameters || {})) {
      assert.ok(schema.type, spec.name + '.' + key + ' 缺 type');
      assert.ok(schema.description && schema.description.length > 4, spec.name + '.' + key + ' 缺描述');
    }
  }
});

await check('browser_act：click 传 ref', async () => {
  calls.length = 0;
  await byName.get('browser_act').execute({ action: 'click', ref: '@e3' }, {});
  assert.deepEqual(calls[0], ['click', '@e3']);
});

await check('browser_act：fill 传 value + session', async () => {
  calls.length = 0;
  await byName.get('browser_act').execute({ action: 'fill', ref: '@e4', value: '你好', sessionId: 'abcd' }, {});
  assert.deepEqual(calls[0], ['fill', '@e4', '--value', '你好', '--session', 'abcd']);
});

await check('browser_act：press 目标位置参数', async () => {
  calls.length = 0;
  await byName.get('browser_act').execute({ action: 'press', key: 'Enter', ref: '@e2' }, {});
  assert.deepEqual(calls[0], ['press', 'Enter', '@e2']);
});

await check('browser_act：drag 带 --to/--mode', async () => {
  calls.length = 0;
  await byName.get('browser_act').execute({ action: 'drag', ref: '@e1', to: '@e3', mode: 'click-move-click' }, {});
  assert.deepEqual(calls[0], ['drag', '@e1', '--to', '@e3', '--mode', 'click-move-click']);
});

await check('browser_act：wheel 只需要 deltaY', async () => {
  calls.length = 0;
  await byName.get('browser_act').execute({ action: 'wheel', deltaY: 600 }, {});
  assert.deepEqual(calls[0], ['wheel', '--delta-y', '600']);
});

await check('browser_act：未知动作与缺目标都报错', async () => {
  await assert.rejects(() => byName.get('browser_act').execute({ action: 'explode', ref: '@e1' }, {}), /不支持的 action/);
  await assert.rejects(() => byName.get('browser_act').execute({ action: 'click' }, {}), /需要 ref/);
});

await check('browser_observe：grep 过滤 + session', async () => {
  const local = buildToolSpecs(async (argv) => ({
    url: 'https://x/',
    title: 'T',
    refs: 2,
    observation: '- document\n  - button "提交" [@e1]\n  - link "取消" [@e2]',
  }));
  const result = await local.find((spec) => spec.name === 'browser_observe').execute({ grep: '提交', sessionId: 'abcd' }, {});
  assert.equal(result.observation, '  - button "提交" [@e1]');
  assert.equal(result.refs, 2);
});

await check('browser_read：extract 带 maxRows', async () => {
  calls.length = 0;
  await byName.get('browser_read').execute({ kind: 'extract', selector: '#t', maxRows: 10 }, {});
  assert.deepEqual(calls[0], ['extract', '#t', '--max-rows', '10']);
});

await check('browser_screenshot：out 与 mode', async () => {
  calls.length = 0;
  await byName.get('browser_screenshot').execute({ out: 'a.png', mode: 'auto' }, {});
  assert.deepEqual(calls[0], ['screenshot', '--out', 'a.png', '--mode', 'auto']);
});

await check('browser_session_start：browser + tabId', async () => {
  calls.length = 0;
  await byName.get('browser_session_start').execute({ browser: '工作账号', tab: 42 }, {});
  assert.deepEqual(calls[0], ['session', 'start', '--browser', '工作账号', '--tab', '42']);
});

await check('browser_dialog：arm 策略参数', async () => {
  calls.length = 0;
  await byName.get('browser_dialog').execute({ action: 'arm', confirm: 'dismiss', prompt: 'accept', promptText: '桥' }, {});
  assert.deepEqual(calls[0], ['dialog', 'arm', '--confirm', 'dismiss', '--prompt', 'accept', '--prompt-text', '桥']);
});

// --------------------------------------------------------------------------
console.log('\n== 运行器（真实 spawn，假 CLI）==');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-plugin-'));
const okCli = path.join(workDir, 'ok.mjs');
fs.writeFileSync(okCli, [
  'const args = process.argv.slice(2);',
  'process.stdout.write(JSON.stringify({ ok: true, result: { echo: args } }) + "\\n");',
].join('\n'), 'utf8');
const failCli = path.join(workDir, 'fail.mjs');
fs.writeFileSync(failCli, [
  'process.stdout.write(JSON.stringify({ ok: false, error: { code: "E_CACHE_EMPTY", message: "没缓存" } }) + "\\n");',
  'process.exitCode = 1;',
].join('\n'), 'utf8');
const junkCli = path.join(workDir, 'junk.mjs');
fs.writeFileSync(junkCli, 'process.stdout.write("hello\\n");', 'utf8');
const envCli = path.join(workDir, 'env.mjs');
fs.writeFileSync(envCli, [
  'process.stdout.write(JSON.stringify({ ok: true, result: { scope: process.env.BB_SESSION_SCOPE || null, home: process.env.BB_HOME || null } }) + "\\n");',
].join('\n'), 'utf8');

await check('运行器：config.env 注入 BB_SESSION_SCOPE', async () => {
  const run = createRunner({ bridgeCli: envCli, timeoutMs: 10000, env: { BB_SESSION_SCOPE: 'proj-x' } });
  const result = await run(['status']);
  assert.equal(result.scope, 'proj-x');
});

await check('运行器：exec 上下文自动映射 sessionScope', async () => {
  const run = createRunner({ bridgeCli: envCli, timeoutMs: 10000 });
  const result = await run(['status'], { sessionId: 'dsh-session-1' });
  assert.equal(result.scope, 'dsh-session-1');
});

await check('运行器：显式 sessionScope 优先于 exec 上下文', async () => {
  const run = createRunner({ bridgeCli: envCli, timeoutMs: 10000, env: { BB_SESSION_SCOPE: 'configured' } });
  const result = await run(['status'], { sessionId: 'dsh-session-1' });
  assert.equal(result.scope, 'configured');
});

await check('运行器：解析 --json 结果并透传参数', async () => {
  const run = createRunner({ bridgeCli: okCli, timeoutMs: 10000 });
  const result = await run(['status', '--json']);
  assert.deepEqual(result.echo, ['status', '--json', '--json'], '参数应原样传入（含自动追加的 --json）');
});

await check('运行器：业务失败抛 BridgeCliError(code)', async () => {
  const run = createRunner({ bridgeCli: failCli, timeoutMs: 10000 });
  await assert.rejects(
    () => run(['observe']),
    (error) => error instanceof BridgeCliError && error.code === 'E_CACHE_EMPTY' && /没缓存/.test(error.message),
  );
});

await check('运行器：非 JSON 输出报 E_OUTPUT', async () => {
  const run = createRunner({ bridgeCli: junkCli, timeoutMs: 10000 });
  await assert.rejects(() => run(['status']), (error) => error instanceof BridgeCliError && error.code === 'E_OUTPUT');
});

await check('运行器：找不到 CLI 时给出可读错误', () => {
  assert.throws(() => createRunner({ bridgeCli: path.join(workDir, 'nope.mjs') }), /./);
});


// --------------------------------------------------------------------------
console.log('\n== 插件入口 apply()（stub 掉 DSH 运行时）==');
const entryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-plugin-entry-'));
fs.cpSync(path.join(ROOT, 'dsh-plugin', 'lib'), path.join(entryDir, 'lib'), { recursive: true });
const stubRoot = path.join(entryDir, 'node_modules', '@deepseek-ai');
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

const fakeCli = path.join(entryDir, 'fake-cli.mjs');
fs.writeFileSync(fakeCli, [
  'const args = process.argv.slice(2);',
  'if (args[0] === "status") {',
  '  process.stdout.write(JSON.stringify({ ok: true, result: { port: 52900, version: "0.2.0", browsers: [{ instanceId: "abcd1234" }], sessions: [] } }) + "\\n");',
  '} else {',
  '  process.stdout.write(JSON.stringify({ ok: true, result: { argv: args } }) + "\\n");',
  '}',
].join('\n'), 'utf8');

const registered = [];
const ctx = {
  logger: { info() {}, warn() {} },
  effect(fn) {
    const dispose = fn();
    if (typeof dispose === 'function') dispose();
  },
  tools: {
    register(tool) {
      registered.push(tool);
      return () => {};
    },
  },
};

await check('apply() 注册 34 个工具且结构与 defineTool 一致', async () => {
  const entry = await import('file:///' + path.join(entryDir, 'lib', 'index.mjs').replace(/\\/g, '/'));
  entry.apply(ctx, { bridgeCli: fakeCli, timeoutMs: 10000 });
  assert.equal(registered.length, 34, '注册工具数不对：' + registered.length);
  for (const tool of registered) {
    assert.match(tool.name, /^browser_/, '工具名：' + tool.name);
    assert.equal(typeof tool.execute, 'function', tool.name + ' 缺 execute');
    assert.ok(tool.output && tool.output.schema && typeof tool.output.render === 'function', tool.name + ' 缺 output');
  }
  const names = registered.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'browser_act', 'browser_audit', 'browser_brief', 'browser_cooperate', 'browser_debug', 'browser_debug_evidence',
    'browser_debug_query', 'browser_dialog', 'browser_eval', 'browser_install_skill', 'browser_navigate', 'browser_network',
    'browser_network_list', 'browser_observe', 'browser_pair', 'browser_read', 'browser_recipe', 'browser_record',
    'browser_rule_list', 'browser_screenshot', 'browser_session_start', 'browser_session_stop', 'browser_settings',
    'browser_status', 'browser_tab', 'browser_tab_borrow', 'browser_tab_close', 'browser_tab_new', 'browser_tab_select',
    'browser_update', 'browser_video', 'browser_video_list', 'browser_video_status', 'browser_window',
  ]);
});

await check('apply() 的工具真能跑通 CLI 并渲染文本', async () => {
  const status = registered.find((tool) => tool.name === 'browser_status');
  const value = await status.execute({}, {});
  assert.equal(value.port, 52900);
  assert.equal(value.browsers[0].instanceId, 'abcd1234');
  const text = status.output.render({}, value);
  assert.equal(text[0].type, 'text');
  assert.match(text[0].text, /abcd1234/);
});

await check('新工具的参数映射正确（video/debug/recipe/cooperate）', async () => {
  const clean = (argv) => argv.filter((item) => item !== '--json');
  const video = registered.find((tool) => tool.name === 'browser_video');
  const started = await video.execute({ action: 'start', duration: '20s', quality: 'high' }, {});
  assert.deepEqual(clean(started.argv), ['video', 'start', '--duration', '20s', '--quality', 'high']);

  const debug = registered.find((tool) => tool.name === 'browser_debug');
  const requests = await debug.execute({ action: 'requests', filter: '/api' }, {});
  assert.deepEqual(clean(requests.argv), ['debug', 'requests', '--filter', '/api']);

  const recipe = registered.find((tool) => tool.name === 'browser_recipe');
  const approved = await recipe.execute({ action: 'approve', name: 'flow', confirmHuman: true, by: 'me' }, {});
  assert.deepEqual(clean(approved.argv), ['recipe', 'approve', 'flow', '--confirm-human', '--by', 'me']);
  await assert.rejects(() => recipe.execute({ action: 'approve', name: 'flow' }, {}));

  const cooperate = registered.find((tool) => tool.name === 'browser_cooperate');
  const handback = await cooperate.execute({ action: 'handback' }, {});
  assert.deepEqual(clean(handback.argv), ['cooperate', 'handback']);
});

await check('apply() 在 CLI 缺失时只告警、不抛错（不拖垮 profile）', async () => {
  const before = registered.length;
  const quiet = { logger: { info() {}, warn() {} }, effect() {}, tools: { register() { throw new Error('不该注册'); } } };
  const entry = await import('file:///' + path.join(entryDir, 'lib', 'index.mjs').replace(/\\/g, '/'));
  entry.apply(quiet, { bridgeCli: path.join(entryDir, 'missing-cli.mjs') });
  assert.equal(registered.length, before);
});

fs.rmSync(entryDir, { recursive: true, force: true });

fs.rmSync(workDir, { recursive: true, force: true });
console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
if (failed) process.exit(1);
console.log('PLUGIN SELFTEST PASS');
