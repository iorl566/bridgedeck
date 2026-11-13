import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpInputSchema, snakeName } from '../../lib/mcp-schemas.mjs';

test('snakeName 映射已知 camelCase 与兜底', () => {
  assert.equal(snakeName('waitTimeoutMs'), 'wait_timeout');
  assert.equal(snakeName('noClear'), 'no_clear');
  assert.equal(snakeName('maxTokens'), 'max_tokens');
  assert.equal(snakeName('somethingNew'), 'something_new');
  assert.equal(snakeName('ref'), 'ref');
});

test('click schema 来自规范并包含 actionability 选项', () => {
  const schema = mcpInputSchema('click');
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.session.type, 'string');
  assert.equal(schema.properties.trusted.type, 'boolean');
  assert.equal(schema.properties.force.type, 'boolean');
  assert.equal(schema.properties.wait_timeout.type, 'integer');
  assert.equal(schema.properties.waitTimeoutMs, undefined);
});

test('fill schema 保留 required value 并映射 no_clear', () => {
  const schema = mcpInputSchema('fill');
  assert.deepEqual(schema.required, ['value']);
  assert.equal(schema.properties.value.type, 'string');
  assert.equal(schema.properties.no_clear.type, 'boolean');
  assert.equal(schema.properties.session.type, 'string');
});

test('observe schema 暴露分页/AX 选项且不重复 session 字段', () => {
  const schema = mcpInputSchema('observe', { omit: ['sessionId', 'tabId'] });
  assert.equal(schema.properties.max_tokens.type, 'integer');
  assert.equal(schema.properties.max_depth.type, 'integer');
  assert.equal(schema.properties.cursor.type, 'string');
  assert.equal(schema.properties.ax.type, 'boolean');
  assert.equal(schema.properties.sessionId, undefined);
  assert.equal(schema.properties.tabId, undefined);
  assert.equal(schema.properties.session.type, 'string');
});

test('navigate/extract/evaluate 的 required 正确映射', () => {
  assert.deepEqual(mcpInputSchema('navigate', { omit: ['sessionId', 'tabId'] }).required, ['url']);
  assert.deepEqual(mcpInputSchema('extract', { omit: ['sessionId', 'tabId'], required: ['selector'] }).required, ['selector']);
  assert.deepEqual(mcpInputSchema('evaluate', { omit: ['sessionId', 'tabId'] }).required, ['expression']);
});

test('未知方法显式报错，避免静默退回空 schema', () => {
  assert.throws(() => mcpInputSchema('no.such.method'), /没有方法 schema/);
});
