import test from 'node:test';
import assert from 'node:assert/strict';
import { createScreenshotStorage, screenshotFilename } from '../../extension/src/long-screenshot/storage.js';

test('screenshotFilename sanitizes and dates', () => {
  assert.equal(screenshotFilename('a/b  c', 0), 'a b c-1970-01-01T00-00-00-000Z.png');
  assert.equal(screenshotFilename('', 0), 'Screenshot-1970-01-01T00-00-00-000Z.png');
});

test('fallback screenshot storage read/write', async () => {
  const storage = createScreenshotStorage({ factory: undefined });
  assert.equal(await storage.readScreenshot('x'), undefined);
  await storage.writeScreenshot({ id: 'x', title: 't' });
  assert.equal((await storage.readScreenshot('x')).title, 't');
});
