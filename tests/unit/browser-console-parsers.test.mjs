import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConsoleApiCalled, parseExceptionThrown, parseLogEntry } from '../../extension/src/browser-driver/console-parsers.js';

test('parseConsoleApiCalled projects args/stack', () => {
  const entry = parseConsoleApiCalled({
    type: 'warn',
    args: [{ value: 'a' }, { description: 'b' }, { type: 'undefined' }],
    timestamp: 5,
    stackTrace: { callFrames: [{ functionName: 'f', url: 'https://x', lineNumber: 0, columnNumber: 1 }] },
  });
  assert.equal(entry.kind, 'console');
  assert.equal(entry.level, 'warn');
  assert.equal(entry.text, 'a b [undefined]');
  assert.equal(entry.url, 'https://x');
  assert.equal(entry.line, 1);
  assert.equal(entry.column, 2);
  assert.equal(entry.timestamp, 5);
});

test('parseExceptionThrown uses first line and 1-based positions', () => {
  const entry = parseExceptionThrown({ exceptionDetails: { text: 'Error: x\ny', url: 'u', lineNumber: 2, columnNumber: 3 } });
  assert.equal(entry.kind, 'exception');
  assert.equal(entry.text, 'Error: x');
  assert.equal(entry.line, 3);
  assert.equal(entry.column, 4);
});

test('parseLogEntry falls back to info and truncates long text', () => {
  const entry = parseLogEntry({ entry: { text: 'x'.repeat(5000) } });
  assert.equal(entry.level, 'info');
  assert.equal(entry.text.length, 4096);
  assert.equal(entry.truncated, true);
});
