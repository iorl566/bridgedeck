import test from 'node:test';
import assert from 'node:assert/strict';
import { requestHelpCommand } from '../../cli/commands/help.mjs';

function makeCtx(captured) {
  class ArgError extends Error {}
  return {
    parseDurationMs: (value, fallback) => {
      if (value === undefined) return fallback;
      const match = /^(\d+)(ms|s)?$/.exec(String(value));
      if (!match) return fallback;
      return Number(match[1]) * (match[2] === 's' ? 1000 : 1);
    },
    withControl: (flags, params) => params,
    callRpc: async (_method, params) => {
      captured.push(params);
      return { ok: true, result: { action: 'done' } };
    },
    outputFailure: (body) => body,
    outputJsonBody: () => 0,
    print: () => {},
    isJson: () => true,
    ArgError,
  };
}

test('request-help --target 支持逗号分隔多目标（第一个是主目标）', async () => {
  const captured = [];
  const command = requestHelpCommand(makeCtx(captured), { target: '#kw,#agree', prompt: 'need help' }, []);
  const code = await command;
  assert.equal(code, 0);
  assert.deepEqual(captured[0].targets, ['#kw', '#agree']);
  assert.equal(captured[0].target, '#kw');
});

test('request-help --target 单目标保持原样', async () => {
  const captured = [];
  const command = requestHelpCommand(makeCtx(captured), { target: '@e3', prompt: 'need help' }, []);
  const code = await command;
  assert.equal(code, 0);
  assert.deepEqual(captured[0].targets, ['@e3']);
  assert.equal(captured[0].target, '@e3');
});
