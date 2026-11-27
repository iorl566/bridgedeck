import test from 'node:test';
import assert from 'node:assert/strict';
import { browserVersionOf, detectBrowser } from '../../extension/src/lib/browser-detect.js';

test('Edge/Opera/Vivaldi/Brave/Helium/Arc/Chrome 识别', () => {
  assert.equal(detectBrowser({ userAgent: 'Mozilla/5.0 Chrome/157.0 Edg/157.0' }), 'edge');
  assert.equal(detectBrowser({ userAgent: 'Mozilla/5.0 Chrome/157.0 OPR/120.0' }), 'opera');
  assert.equal(detectBrowser({ userAgent: 'Mozilla/5.0 Chrome/157.0 Vivaldi/7.0' }), 'vivaldi');
  assert.equal(detectBrowser({ userAgent: 'Mozilla/5.0 Chrome/157.0 Brave/157.0' }), 'brave');
  assert.equal(detectBrowser({ userAgent: 'Mozilla/5.0 Chrome/157.0 Helium/1.0' }), 'helium');
  assert.equal(detectBrowser({ userAgent: 'Mozilla/5.0 Chrome/157.0 Arc/1.0' }), 'arc');
  assert.equal(detectBrowser({ userAgent: 'Mozilla/5.0 Chrome/157.0' }), 'chrome');
});

test('Brave 注入对象 / brands 兜底', () => {
  assert.equal(detectBrowser({ userAgent: 'Mozilla/5.0 Chrome/157.0', hasBrave: true }), 'brave');
  assert.equal(detectBrowser({ userAgent: 'Mozilla/5.0', brands: [{ brand: 'Arc' }] }), 'arc');
  assert.equal(detectBrowser({ userAgent: 'Mozilla/5.0 Chromium/157.0' }), 'chromium');
});

test('版本解析', () => {
  assert.equal(browserVersionOf('Mozilla/5.0 Chrome/157.0.1 Edg/157.0.1'), '157.0.1');
  assert.equal(browserVersionOf('no version'), '');
});
