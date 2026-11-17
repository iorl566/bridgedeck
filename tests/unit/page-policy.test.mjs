import test from 'node:test';
import assert from 'node:assert/strict';
import { restrictedUrlReason } from '../../extension/src/lib/page-policy.js';

test('允许普通网页与 about:blank', () => {
  assert.equal(restrictedUrlReason('https://example.com/a'), '');
  assert.equal(restrictedUrlReason('http://127.0.0.1:8080'), '');
  assert.equal(restrictedUrlReason('about:blank'), '');
  assert.equal(restrictedUrlReason('about:blank#x'), '');
  assert.equal(restrictedUrlReason(''), '');
});

test('拦截浏览器内部页、扩展页、devtools、view-source', () => {
  for (const url of [
    'chrome://settings',
    'edge://extensions',
    'chrome-extension://abc/popup.html',
    'moz-extension://abc/popup.html',
    'devtools://devtools/bundled/inspector.html',
    'view-source:https://example.com',
    'javascript:alert(1)',
    'about:config',
  ]) {
    assert.notEqual(restrictedUrlReason(url), '', url);
  }
});

test('剥离浏览器会忽略的 C0/换行后再判定', () => {
  assert.notEqual(restrictedUrlReason(String.fromCharCode(0) + 'chrome://settings'), '');
  assert.notEqual(restrictedUrlReason('java\nscript:alert(1)'), '');
});
