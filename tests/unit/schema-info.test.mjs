import test from 'node:test';
import assert from 'node:assert/strict';
import { METHOD_EFFECT } from '../../lib/protocol.mjs';
import { describeMethod, listMethods, renderFlagUsage, renderMethodHelp, schemaFlags } from '../../lib/schema-info.mjs';

test('describeMethod 返回 scope/effect/mutating/schema', () => {
  const click = describeMethod('click');
  assert.equal(click.scope, 'session');
  assert.equal(click.effect, METHOD_EFFECT.click);
  assert.equal(click.mutating, true);
  assert.equal(click.schema.properties.selector.type, 'string');
  assert.equal(click.schema.properties.trusted.type, 'boolean');
  const status = describeMethod('status');
  assert.equal(status.scope, 'local');
  assert.equal(status.mutating, false);
  const focus = describeMethod('window.focus');
  assert.equal(focus.scope, 'instance');
  assert.equal(describeMethod('not.a.method'), null);
});

test('listMethods 覆盖全部协议方法且按名称排序', () => {
  const rows = listMethods();
  assert.equal(rows.length, Object.keys(METHOD_EFFECT).length);
  const names = rows.map((row) => row.method);
  assert.deepEqual(names, [...names].sort());
  assert.ok(names.includes('window.ensureAgent'));
  assert.ok(names.includes('debug.rule_add'));
});

test('schemaFlags 把 schema 属性映射成 CLI flag', () => {
  const flags = schemaFlags('click');
  assert.ok(flags.includes('--wait-timeout'));
  assert.ok(flags.includes('--trusted'));
  assert.ok(flags.includes('--force'));
  assert.ok(schemaFlags('window.focus').includes('--window-id'));
  assert.deepEqual(schemaFlags('not.a.method'), []);
});

test('renderMethodHelp 由 schema 生成单方法帮助', () => {
  const help = renderMethodHelp('click');
  assert.match(help, /^click\s+scope=session/);
  assert.match(help, /--trusted\?/);
  assert.match(help, /--wait-timeout <n>\?/);
  assert.match(renderMethodHelp('window.focus'), /--window-id <n>\?/);
  assert.equal(renderMethodHelp('not.a.method'), null);
});

test('renderFlagUsage 生成帮助片段并排除位置参数', () => {
  assert.deepEqual(renderFlagUsage('click'), ['[--trusted]', '[--force]', '[--wait-timeout <n>]']);
  assert.deepEqual(renderFlagUsage('fill'), ['[--value <text>]', '[--no-clear]', '[--trusted]', '[--force]', '[--wait-timeout <n>]']);
  assert.deepEqual(renderFlagUsage('not.a.method'), []);
});

test('每个方法都有 scope 与 effect', () => {
  for (const row of listMethods()) {
    assert.ok(row.scope, row.method + ' 缺少 scope');
    assert.ok(row.effect, row.method + ' 缺少 effect');
    assert.equal(typeof row.mutating, 'boolean');
  }
});
