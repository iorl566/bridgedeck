// tests/unit/cli-command-plans.test.mjs —— video/longshot/record/debug/trace 的 dry-run 计划门禁。
//
// 这一层的断言目标不是“输出文案”，而是三件会真实出事的事情：
//   1) specs 里每个声明 dryRun 的子命令都真的有计划构造器（文档说能预检，就一定能预检）；
//   2) plan 里的 RPC 方法/参数与本机文件路径确实是要发生的事（防止预检与执行漂移）；
//   3) 只读命令的 plan 里没有变异步骤；有写入的命令必须列出目标路径。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PLAN_SUBCOMMANDS,
  buildCommandPlan,
  dryRunIo,
  preflight,
  supportsDryRun,
} from '../../cli/lib/command-plans.mjs';
import { COMMAND_SPECS } from '../../cli/lib/command-specs.mjs';
import { stepRequest } from '../../cli/lib/action-plan.mjs';
import { ArgError } from '../../cli/lib/args.mjs';

function planFor(command, sub, flags = {}, pos = [command, sub], session = {}) {
  return buildCommandPlan(command, sub, { flags, pos, session });
}

function rpcMethods(plan) {
  return plan.steps.filter((step) => step.kind === 'rpc').map((step) => step.method);
}

function localSteps(plan) {
  return plan.steps.filter((step) => step.kind === 'local');
}

function absPath(name) {
  return path.resolve(process.cwd(), name);
}

// ---------------------------------------------------------------------------
// 覆盖面：specs 的 dryRun 声明 ↔ 计划构造器
// ---------------------------------------------------------------------------

test('每个声明 dryRun 的 spec 子命令都有计划构造器，且反过来没有僵尸计划', () => {
  const declared = [];
  for (const [topic, spec] of Object.entries(COMMAND_SPECS)) {
    for (const name of spec.order) {
      if (spec.subs[name].dryRun === true) declared.push(topic + ' ' + name);
    }
  }
  assert.ok(declared.length >= 60, '声明 dryRun 的子命令太少：' + declared.length);
  for (const item of declared) {
    const [topic, name] = item.split(' ');
    assert.ok(supportsDryRun(topic, name), 'specs 声明了 dryRun 但没有构造器：' + item);
    assert.ok(buildCommandPlan(topic, name, { flags: {}, pos: [topic, name], session: {} }), '构造器返回 null：' + item);
  }
  for (const [topic, names] of Object.entries(PLAN_SUBCOMMANDS)) {
    const spec = COMMAND_SPECS[topic];
    assert.ok(spec, '计划表里的命令不在 specs：' + topic);
    for (const name of names) {
      assert.ok(spec.subs[name], '计划表里的子命令不在 specs：' + topic + ' ' + name);
    }
  }
});

test('五个命令都已纳入严格 specs，且每个子命令都有 usage/示例/风险', () => {
  for (const topic of ['video', 'longshot', 'record', 'debug', 'trace']) {
    const spec = COMMAND_SPECS[topic];
    assert.ok(spec, '缺少 spec：' + topic);
    assert.equal(spec.command, topic);
    for (const name of spec.order) {
      const subSpec = spec.subs[name];
      assert.ok(subSpec.usage && subSpec.usage.startsWith('bridge ' + topic + ' ' + name), topic + ' ' + name + ' usage 不对');
      assert.ok(subSpec.risk, topic + ' ' + name + ' 缺少 risk');
      assert.ok(Array.isArray(subSpec.examples) && subSpec.examples.length >= 1, topic + ' ' + name + ' 缺少示例');
      assert.equal(subSpec.dryRun, true, topic + ' ' + name + ' 未声明 dryRun');
    }
  }
});

test('未知命令/子命令不返回计划（避免“预检”变成静默执行）', () => {
  assert.equal(buildCommandPlan('status', 'x', { flags: {}, pos: [], session: {} }), null);
  assert.equal(buildCommandPlan('video', 'frobnicate', { flags: {}, pos: ['video', 'frobnicate'], session: {} }), null);
  assert.equal(supportsDryRun('debug', 'nope'), false);
});

// ---------------------------------------------------------------------------
// video
// ---------------------------------------------------------------------------

test('video start：RPC 参数含时长/编码偏好/forceFrames，风险为 browser_mutation', () => {
  const plan = planFor('video', 'start', { duration: '3s', quality: 'high', encoder: 'vp8', 'force-frames': true }, ['video', 'start'], { session: 'a1b2' });
  assert.equal(plan.command, 'video');
  assert.equal(plan.subcommand, 'start');
  assert.equal(plan.risk, 'browser_mutation');
  assert.equal(plan.mutatesBrowser, true);
  assert.deepEqual(rpcMethods(plan), ['video.start']);
  const step = plan.steps[0];
  assert.equal(step.params.durationMs, 3000);
  assert.equal(step.params.quality, 'high');
  assert.equal(step.params.encoder, 'vp8');
  assert.equal(step.params.forceFrames, true);
  assert.equal(step.params.session, 'a1b2');
  assert.equal(stepRequest(step).body.method, 'video.start');
});

test('video start 不给时长时不伪造 durationMs', () => {
  const plan = planFor('video', 'start');
  assert.equal(plan.steps[0].params.durationMs, undefined);
});

test('video save：先取回录制再写文件，路径是绝对路径且带覆盖警告', () => {
  const plan = planFor('video', 'save', { out: 'out/demo.webm', overwrite: true }, ['video', 'save', 'rec-1']);
  assert.deepEqual(rpcMethods(plan), ['video.fetch']);
  assert.equal(plan.steps[0].params.recording, 'rec-1');
  const writes = localSteps(plan);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].action, 'write');
  assert.deepEqual([...writes[0].paths], [absPath('out/demo.webm')]);
  assert.ok(plan.warnings.some((item) => item.includes('--overwrite')));
  assert.equal(plan.risk, 'browser_mutation');
});

test('video save 不带 --overwrite 时不出现覆盖警告', () => {
  const plan = planFor('video', 'save', { out: 'out/demo.webm' }, ['video', 'save', 'rec-1']);
  assert.equal(plan.warnings.some((item) => item.includes('--overwrite')), false);
});

test('video status：两条只读 RPC，且说明未命中录制时的回落', () => {
  const plan = planFor('video', 'status');
  assert.deepEqual(rpcMethods(plan), ['video.status', 'video.list']);
  assert.equal(plan.risk, 'read_only');
  assert.equal(plan.mutatesBrowser, false);
  assert.ok(plan.notes.some((item) => item.includes('video.list')));
});

test('video info/merge/split/trim 是纯本机操作：没有任何 RPC 步骤', () => {
  const info = planFor('video', 'info', {}, ['video', 'info', 'demo.webm']);
  assert.equal(rpcMethods(info).length, 0);
  assert.equal(info.steps.length, 1);
  assert.equal(info.steps[0].action, 'read');

  const merge = planFor('video', 'merge', { out: 'm.webm' }, ['video', 'merge', 'a.webm', 'b.webm']);
  assert.equal(rpcMethods(merge).length, 0);
  assert.deepEqual(localSteps(merge).map((step) => step.action), ['read', 'write']);
  assert.deepEqual([...localSteps(merge)[0].paths], [absPath('a.webm'), absPath('b.webm')]);

  const split = planFor('video', 'split', { 'out-dir': 'parts', parts: '3' }, ['video', 'split', 'demo.webm']);
  assert.equal(rpcMethods(split).length, 0);
  assert.ok(split.steps.find((step) => step.action === 'write').description.includes('3'));

  const trim = planFor('video', 'trim', { out: 'clip.webm', start: '1s', end: '2s' }, ['video', 'trim', 'demo.webm']);
  assert.equal(rpcMethods(trim).length, 0);
  const description = trim.steps.find((step) => step.action === 'write').description;
  assert.ok(description.includes('1s') && description.includes('2s'), description);
});

test('video prune/discard 明确标出破坏性并给警告', () => {
  const prune = planFor('video', 'prune', { ttl: '1ms' });
  assert.equal(prune.risk, 'daemon_state');
  assert.equal(prune.steps[0].params.ttlMs, 1);
  assert.ok(prune.warnings.some((item) => item.includes('删除')));

  const discard = planFor('video', 'discard', {}, ['video', 'discard', 'rec-9']);
  assert.equal(discard.risk, 'browser_mutation');
  assert.ok(discard.warnings.some((item) => item.includes('无法找回')));
});

// ---------------------------------------------------------------------------
// longshot / record
// ---------------------------------------------------------------------------

test('longshot recover：取分片 RPC + PNG 落盘，整体风险 local_write', () => {
  const plan = planFor('longshot', 'recover', { out: 'shot.png' }, ['longshot', 'recover', 'ls-1'], { session: 'a1b2' });
  assert.deepEqual(rpcMethods(plan), ['longshot.recover']);
  assert.equal(plan.steps[0].params.longshotId, 'ls-1');
  assert.equal(plan.steps[0].params.session, 'a1b2');
  const write = plan.steps.find((step) => step.kind === 'local' && step.action === 'write');
  assert.deepEqual([...write.paths], [absPath('shot.png')]);
  assert.equal(plan.risk, 'local_write');
  assert.equal(plan.mutatesBrowser, false);
});

test('record start：--include-agent/--screenshots 透传成协议字段', () => {
  const plan = planFor('record', 'start', { 'include-agent': true, screenshots: true });
  assert.equal(plan.steps[0].method, 'record.start');
  assert.equal(plan.steps[0].params.includeAgent, true);
  assert.equal(plan.steps[0].params.screenshots, true);
  assert.equal(plan.risk, 'browser_mutation');
});

test('record export：读录制（可选截图）+ 写 trace.json，默认目录是 ./trace', () => {
  const plan = planFor('record', 'export', { screenshot: true }, ['record', 'export'], { session: 'a1b2' });
  assert.deepEqual(rpcMethods(plan), ['record.list', 'screenshot']);
  const write = plan.steps.find((step) => step.kind === 'local');
  assert.deepEqual([...write.paths], [absPath(path.join('trace', 'trace.json'))]);
  assert.equal(plan.risk, 'local_write');
});

test('record export 指定 id 与 --out 时目标路径跟着变', () => {
  const plan = planFor('record', 'export', { out: 'trace-dir' }, ['record', 'export', 'rec-7']);
  assert.ok(plan.steps.find((step) => step.kind === 'local').description.includes('rec-7'));
  assert.deepEqual([...plan.steps.find((step) => step.kind === 'local').paths], [absPath(path.join('trace-dir', 'trace.json'))]);
});

// ---------------------------------------------------------------------------
// trace
// ---------------------------------------------------------------------------

test('trace stop --out：RPC 之后把 trace JSON 落盘；不带 --out 时只有 RPC', () => {
  const withOut = planFor('trace', 'stop', { out: 'trace.json' }, ['trace', 'stop'], { session: 'a1b2' });
  assert.deepEqual(rpcMethods(withOut), ['trace.stop']);
  assert.equal(withOut.steps.length, 2);
  assert.deepEqual([...withOut.steps[1].paths], [absPath('trace.json')]);
  assert.equal(withOut.risk, 'browser_mutation');

  const withoutOut = planFor('trace', 'stop');
  assert.equal(withoutOut.steps.length, 1);
});

test('trace summary/diff/view 全部不触达 daemon（requests 为空）', () => {
  const summary = planFor('trace', 'summary', { limit: '20' }, ['trace', 'summary', 'trace.json']);
  assert.equal(summary.steps.length, 1);
  assert.equal(rpcMethods(summary).length, 0);
  assert.equal(summary.risk, 'read_only');

  const diff = planFor('trace', 'diff', {}, ['trace', 'diff', 'a.json', 'b.json']);
  assert.deepEqual(localSteps(diff).map((step) => step.action), ['read', 'read']);
  assert.deepEqual([...localSteps(diff)[1].paths], [absPath('b.json')]);

  const view = planFor('trace', 'view', { debug: 'archive.json', out: 'viewer.html' }, ['trace', 'view', 'trace.json']);
  assert.equal(rpcMethods(view).length, 0);
  assert.equal(view.risk, 'local_write');
  const paths = localSteps(view).flatMap((step) => [...step.paths]);
  assert.ok(paths.includes(absPath('trace.json')));
  assert.ok(paths.includes(absPath('archive.json')));
  assert.ok(paths.includes(absPath('viewer.html')));
});

test('trace view 未给 --out 时从输入文件名推导 .html 路径', () => {
  const plan = planFor('trace', 'view', {}, ['trace', 'view', 'runs/trace.json']);
  const write = localSteps(plan).find((step) => step.action === 'write');
  assert.deepEqual([...write.paths], [absPath('runs/trace.html')]);
});

// ---------------------------------------------------------------------------
// debug
// ---------------------------------------------------------------------------

test('debug start：--name/--bodies 透传，采集是 browser_mutation', () => {
  const plan = planFor('debug', 'start', { name: 'repro', bodies: true });
  assert.equal(plan.steps[0].method, 'debug.start');
  assert.equal(plan.steps[0].params.name, 'repro');
  assert.equal(plan.steps[0].params.bodies, true);
  assert.equal(plan.risk, 'browser_mutation');
});

test('debug requests/console/pages/coverage 是单条只读 RPC', () => {
  for (const sub of ['requests', 'console', 'pages', 'coverage', 'capabilities', 'history', 'pinned']) {
    const plan = planFor('debug', sub);
    assert.equal(plan.steps.length, 1, sub);
    assert.equal(plan.risk, 'read_only', sub);
    assert.equal(plan.mutatesBrowser, false, sub);
  }
  assert.deepEqual(rpcMethods(planFor('debug', 'requests')), ['debug.current']);
  assert.deepEqual(rpcMethods(planFor('debug', 'history')), ['debug.history']);
  assert.deepEqual(rpcMethods(planFor('debug', 'capabilities')), ['debug.capabilities']);
});

test('debug request：id 转成数字，--part 枚举只影响本地打印', () => {
  const plan = planFor('debug', 'request', { part: 'metadata', pointer: '/a', 'max-chars': '100' }, ['debug', 'request', '5']);
  assert.equal(plan.steps[0].params.id, 5);
  assert.ok(plan.notes.some((item) => item.includes('--part')));
});

test('debug har-import 是纯离线转换：读 HAR + 写归档，零 RPC', () => {
  const plan = planFor('debug', 'har-import', { output: 'a.json' }, ['debug', 'har-import', 'net.har']);
  assert.equal(rpcMethods(plan).length, 0);
  assert.equal(plan.risk, 'local_write');
  assert.deepEqual(localSteps(plan).map((step) => step.action), ['read', 'write']);
});

test('debug export/archive/rule_export：读快照后写文件，输出路径进 plan', () => {
  for (const [sub, method, file] of [
    ['export', 'debug.current', 'debug.json'],
    ['archive', 'debug.current', 'archive.json'],
    ['rule_export', 'debug.rule_export', 'rules.json'],
  ]) {
    const plan = planFor('debug', sub, { output: file });
    assert.deepEqual(rpcMethods(plan), [method], sub);
    const write = localSteps(plan).find((step) => step.action === 'write');
    assert.deepEqual([...write.paths], [absPath(file)], sub);
    assert.equal(plan.risk, 'local_write', sub);
  }
});

test('debug archives --prune 会列出删除步骤与警告；不带 prune 时只读', () => {
  const plain = planFor('debug', 'archives', { dir: 'out' });
  assert.equal(plain.risk, 'read_only');
  assert.equal(plain.warnings.length, 0);

  const prune = planFor('debug', 'archives', { dir: 'out', prune: true, max: '5' });
  assert.equal(prune.risk, 'local_write');
  assert.ok(prune.steps.some((step) => step.kind === 'local' && step.action === 'delete'));
  assert.ok(prune.warnings.some((item) => item.includes('删除')));
});

test('debug query：--file 与 --dir 各自指向本机读取路径', () => {
  const byFile = planFor('debug', 'query', { file: 'a.json' });
  assert.equal(rpcMethods(byFile).length, 0);
  assert.deepEqual([...byFile.steps[0].paths], [absPath('a.json')]);

  const byDir = planFor('debug', 'query', { dir: 'out' });
  assert.equal(rpcMethods(byDir).length, 0);
  assert.deepEqual([...byDir.steps[0].paths], [absPath('out')]);
  assert.ok(byDir.steps[0].description.includes('目录'));
});

test('debug evidence：有 --file 时不触达 daemon；无 --file 时读快照 + 操作审计', () => {
  const offline = planFor('debug', 'evidence', { file: 'archive.json', output: 'evidence.json' });
  assert.equal(rpcMethods(offline).length, 0);
  assert.equal(offline.risk, 'local_write');

  const online = planFor('debug', 'evidence', {}, ['debug', 'evidence'], { session: 'a1b2' });
  assert.deepEqual(rpcMethods(online), ['debug.current', 'operations.list']);
  assert.equal(online.risk, 'read_only');
});

test('debug journal：快照 + 操作审计两条只读 RPC，--merged 只影响本地合并', () => {
  const plan = planFor('debug', 'journal', { merged: true, limit: '5' });
  assert.deepEqual(rpcMethods(plan), ['debug.current', 'operations.list']);
  assert.equal(plan.steps[1].params.limit, 5);
  assert.equal(plan.risk, 'read_only');
});

test('debug rule_add：--rule-file 先读文件再加规则；规则内容进 RPC', () => {
  const plan = planFor('debug', 'rule_add', { 'rule-file': 'rule.json' });
  const read = localSteps(plan).find((step) => step.action === 'read');
  assert.deepEqual([...read.paths], [absPath('rule.json')]);
  assert.equal(plan.steps.find((step) => step.kind === 'rpc').method, 'debug.rule_add');
  assert.ok(plan.warnings.some((item) => item.includes('rule.json')));

  const inline = planFor('debug', 'rule_add', { rule: '{"action":"block"}' });
  assert.equal(inline.steps.length, 1);
  assert.equal(inline.steps[0].params.rule, '{"action":"block"}');
});

test('debug 破坏性/暂停类命令的风险与警告', () => {
  for (const sub of ['rule_clear', 'rule_import', 'pin', 'unpin', 'replay', 'fetch_probe']) {
    const flags = sub === 'rule_import' ? { file: 'r.json' } : {};
    const pos = ['debug', sub, '7'];
    const plan = planFor('debug', sub, flags, pos);
    assert.equal(plan.mutatesBrowser, true, sub + ' 应标记 browser_mutation');
  }
  assert.ok(planFor('debug', 'fetch_probe', { ms: '3000' }).warnings.some((item) => item.includes('暂停')));
  assert.ok(planFor('debug', 'replay', {}, ['debug', 'replay', '5']).warnings.some((item) => item.includes('服务端')));
});

test('debug operations/operation/activity 使用 operations.* 审计接口（不误发 debug.current）', () => {
  assert.deepEqual(rpcMethods(planFor('debug', 'operations', { limit: '10', since: '1h' })), ['operations.list']);
  assert.equal(planFor('debug', 'operations', { limit: '10' }).steps[0].params.limit, 10);
  assert.equal(planFor('debug', 'operations', { since: '1h' }).steps[0].params.since, '1h');
  assert.deepEqual(rpcMethods(planFor('debug', 'operation', {}, ['debug', 'operation', 'op-1'])), ['operations.get']);
  assert.deepEqual(
    rpcMethods(planFor('debug', 'operation', { 'with-requests': true }, ['debug', 'operation', 'op-1'])),
    ['operations.get', 'debug.current'],
  );
  assert.deepEqual(rpcMethods(planFor('debug', 'activity', { limit: '5' })), ['operations.list']);
});

// ---------------------------------------------------------------------------
// dry-run 输出与副作用
// ---------------------------------------------------------------------------

test('preflight 输出 dryRun JSON 且返回 0（不写文件）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-preflight-'));
  const output = path.join(dir, 'demo.webm');
  const emitted = [];
  const io = dryRunIo({ isJson: () => true, emitJson: (value) => emitted.push(value), print: () => {} });
  const code = preflight('video', 'save', { flags: { out: output }, pos: ['video', 'save', 'rec-1'], session: {} }, io);
  assert.equal(code, 0);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].dryRun, true);
  assert.equal(emitted[0].result.command, 'video');
  assert.equal(emitted[0].result.steps[0].method, 'video.fetch');
  assert.equal(fs.existsSync(output), false, 'dry-run 不允许写文件');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('preflight 人类模式只打印计划文本', () => {
  const printed = [];
  const io = dryRunIo({ isJson: () => false, emitJson: () => {}, print: (line) => printed.push(line) });
  const code = preflight('trace', 'status', { flags: {}, pos: ['trace', 'status'], session: {} }, io);
  assert.equal(code, 0);
  const text = printed.join('\n');
  assert.ok(text.includes('dry-run'));
  assert.ok(text.includes('bridge trace status'));
  assert.ok(text.includes('trace.status'));
});

test('preflight 对没有计划构造器的命令抛 ArgError（绝不静默执行）', () => {
  const io = dryRunIo({ isJson: () => true, emitJson: () => {}, print: () => {} });
  assert.throws(() => preflight('status', 'x', { flags: {}, pos: ['status'], session: {} }, io), ArgError);
});

test('计划里的会话参数来自调用方（session-scope 也透传，不在本模块猜）', () => {
  const plan = buildCommandPlan('record', 'status', {
    flags: { 'session-scope': 'proj-a' },
    pos: ['record', 'status'],
    session: { sessionScope: 'proj-a' },
  });
  assert.equal(plan.steps[0].params.sessionScope, 'proj-a');
});

test('tab 别名在 dry-run 里只提示未解析，不尝试触达 daemon', () => {
  const plan = planFor('video', 'stop', { 'tab-id': 'checkout' }, ['video', 'stop'], { tabId: '<tabId:checkout>' });
  assert.ok(plan.notes.some((item) => item.includes('别名') && item.includes('未解析')));
});
