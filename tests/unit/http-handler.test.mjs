import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpHandler } from '../../daemon/http-handler.js';

function make() {
  const sent = [];
  const handler = createHttpHandler({
    health: { healthPayload: () => ({ ok: true }) },
    previewHandler: { handlePreviewRequest: async () => { throw new Error('preview'); } },
    rpcHandler: async () => {},
    sendJson: (res, status, body) => sent.push({ status, body }),
    logError: () => {},
  });
  return { handler, sent };
}

function req(method, url) {
  return { method, url };
}

test('/health 返回 200', () => {
  const { handler, sent } = make();
  handler(req('GET', '/health'), {});
  assert.equal(sent[0].status, 200);
  assert.equal(sent[0].body.ok, true);
});

test('/rpc 与 404 路由', async () => {
  const { handler, sent } = make();
  handler(req('POST', '/rpc'), {});
  await new Promise((resolve) => setImmediate(resolve));
  handler(req('GET', '/nope'), {});
  assert.equal(sent.at(-1).status, 404);
});
