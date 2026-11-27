import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkCommand } from '../../cli/commands/network.mjs';
import { createEmulateCommand, DEVICE_PRESETS } from '../../cli/commands/emulate.mjs';
import { ArgError, intFlag, requirePos } from '../../cli/lib/args.mjs';
import { renderTable, truncateText } from '../../cli/lib/format.mjs';

function makeNetwork(handler) {
  const printed = [];
  return {
    printed,
    cmd: createNetworkCommand({
      withControl: (flags, base) => ({ session: 's1', ...base }),
      callRpc: async (method, params) => handler(method, params),
      timeoutOf: () => 5000,
      outputFailure: (body) => { throw new Error(body.error.code); },
      outputJsonBody: () => 0,
      renderPageBody: (body, render) => { render(); return 0; },
      isJson: () => false,
      print: (line) => printed.push(line),
      renderTable,
      truncateText,
      requirePos,
      intFlag,
      ArgError,
    }),
  };
}

test('network list 空提示；start 打印正文开关', async () => {
  const { cmd, printed } = makeNetwork((method) => (method === 'network.start'
    ? { ok: true, result: { bodies: true } }
    : { ok: true, result: { entries: [] } }));
  assert.equal(await cmd({}, ['network', 'start']), 0);
  assert.match(printed.join('\n'), /已开始采集（正文：开）/);
  assert.equal(await cmd({}, ['network', 'list']), 0);
  assert.match(printed.join('\n'), /没有抓到请求/);
});

test('network detail 缺 id 抛 ArgError', async () => {
  const { cmd } = makeNetwork(() => ({ ok: true, result: {} }));
  await assert.rejects(() => cmd({}, ['network', 'detail']), ArgError);
});

function makeEmulate(handler) {
  const printed = [];
  return {
    printed,
    cmd: createEmulateCommand({
      withControl: (flags, base) => ({ session: 's1', ...base }),
      callRpc: async (method, params) => handler(method, params),
      timeoutOf: () => 5000,
      renderPageBody: (body, render) => { render(); return 0; },
      print: (line) => printed.push(line),
      intFlag,
      ArgError,
    }),
  };
}

test('emulate 设备预设与未知设备', async () => {
  let seen = null;
  const { cmd } = makeEmulate((method, params) => { seen = params; return { ok: true, result: {} }; });
  assert.equal(await cmd({ device: 'iphone-14' }, []), 0);
  assert.equal(seen.viewport.width, DEVICE_PRESETS['iphone-14'].width);
  assert.match(seen.userAgent, /iPhone/);
  await assert.rejects(() => cmd({ device: 'nope' }, []), ArgError);
});

test('emulate 无参数/非法 geolocation 抛 ArgError', async () => {
  const { cmd } = makeEmulate(() => ({ ok: true, result: {} }));
  await assert.rejects(() => cmd({}, []), ArgError);
  await assert.rejects(() => cmd({ geolocation: 'abc' }, []), ArgError);
});
