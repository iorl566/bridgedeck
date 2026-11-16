import test from 'node:test';
import assert from 'node:assert/strict';

test('execPage 在注入前拒绝浏览器内部页', async () => {
  globalThis.chrome = {
    tabs: { get: async () => ({ id: 1, url: 'edge://settings' }) },
  };
  const { execPage } = await import('../../extension/src/inject.js');
  await assert.rejects(() => execPage(1, 'observe', {}), (error) => error.code === 'E_FORBIDDEN');
});

test('execPage 允许普通网页继续（缺少 scripting 时才报后续错误）', async () => {
  globalThis.chrome = {
    tabs: { get: async () => ({ id: 1, url: 'https://example.com/' }) },
    scripting: { executeScript: async () => { throw new Error('should reach injection'); } },
  };
  const { execPage } = await import('../../extension/src/inject.js');
  await assert.rejects(() => execPage(1, 'observe', {}), (error) => error.message.includes('should reach injection') || error.code === 'E_JS_ERROR' || error.code === 'E_INTERNAL');
});
