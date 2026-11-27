import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tempDir } from '../eval/helpers.mjs';
import {
  SOURCE_ESCAPE,
  SOURCE_MISSING,
  SOURCE_SYMBOL,
  clearSourceCache,
  findSymbolLine,
  groupConsumes,
  listExports,
  locatePropertySource,
  locateSymbol,
  readSource,
  relativePosix,
  resolveConsumes,
  resolveRepoFile,
  sourceLineAt,
} from '../../tools/eval/lib/source.mjs';

const PRODUCT_SYMBOLS = [
  ['lib/session-queue.mjs', 'createSessionQueue'],
  ['lib/observation-delta.mjs', 'diffObservation'],
  ['lib/observation-delta.mjs', 'applyObservationPatch'],
  ['lib/intent-ledger.mjs', 'IntentLedger'],
  ['lib/intent-ledger.mjs', 'recover'],
  ['lib/method-state-machine.mjs', 'replayDecision'],
  ['lib/method-state-machine.mjs', 'checkPreconditions'],
  ['lib/protocol.mjs', 'negotiateHandshake'],
  ['lib/protocol-features.mjs', 'protocolGate'],
  ['extension/src/lib/vom-visibility.js', 'evaluateVisibility'],
  ['extension/src/lib/vom-zorder.js', 'buildZOrderModel'],
  ['extension/src/lib/vom-weights.js', 'rankVomNodes'],
  ['extension/src/lib/vom-frames-depth.js', 'frameChainOf'],
];

test('locateSymbol：真实产品符号解析到含符号名的 file:line', () => {
  for (const [file, symbol] of PRODUCT_SYMBOLS) {
    const located = locateSymbol(file, symbol);
    assert.equal(located.file, file);
    assert.ok(located.line >= 1, file + '#' + symbol + ' 行号非法');
    assert.equal(located.location, file + ':' + located.line);
    assert.ok(located.text.includes(symbol), file + ':' + located.line + ' 行不含 ' + symbol + '：' + located.text);
    assert.equal(path.isAbsolute(located.absolute), true);
  }
});

test('findSymbolLine：导出声明优先于普通提及', () => {
  const text = [
    '// createThing is mentioned here',
    'const createThing = 1;',
    'export function createThing() {}',
    'export class Widget {}',
  ].join('\n');
  const match = findSymbolLine(text, 'createThing');
  assert.equal(match.line, 3);
  assert.equal(match.strength, 0);
  assert.equal(findSymbolLine('// nothing', 'createThing'), null);
  const method = findSymbolLine('export class A {\n  doWork() {}\n}', 'doWork');
  assert.equal(method.line, 2);
  const field = findSymbolLine('const api = {\n  finish: () => {},\n};', 'finish');
  assert.equal(field.line, 2);
});

test('listExports / readSource / sourceLineAt / relativePosix', () => {
  const exports = listExports('lib/session-queue.mjs');
  const create = exports.find((entry) => entry.name === 'createSessionQueue');
  assert(create);
  assert.equal(create.kind, 'function');
  assert.equal(create.line, locateSymbol('lib/session-queue.mjs', 'createSessionQueue').line);
  assert.ok(exports.some((entry) => entry.name === 'DEFAULT_QUEUE_CAPACITY'));
  assert.match(readSource('lib/session-queue.mjs'), /createSessionQueue/);
  assert.match(sourceLineAt('lib/session-queue.mjs', create.line), /createSessionQueue/);
  assert.equal(sourceLineAt('lib/session-queue.mjs', 999999), '');
  assert.equal(relativePosix(path.resolve('/'), path.resolve('/a/b')), 'a/b');
});

test('resolveConsumes：解析、去重、按出现顺序返回', () => {
  const resolved = resolveConsumes([
    { file: 'lib/session-queue.mjs', symbol: 'createSessionQueue' },
    { file: 'lib/session-queue.mjs', symbol: 'createSessionQueue' },
    { file: 'lib/intent-ledger.mjs', symbol: 'recover', note: '恢复入口' },
  ]);
  assert.equal(resolved.length, 2);
  assert.equal(resolved[0].location, 'lib/session-queue.mjs:' + locateSymbol('lib/session-queue.mjs', 'createSessionQueue').line);
  assert.equal(resolved[1].note, '恢复入口');
  assert.equal(Object.isFrozen(resolved[0]), true);
  assert.deepEqual(resolveConsumes([]), []);
  assert.deepEqual(resolveConsumes(null), []);
  assert.throws(() => resolveConsumes([{ file: 'lib/session-queue.mjs' }]), /file\/symbol/);
  assert.throws(() => resolveConsumes([{ file: 'lib/nope.mjs', symbol: 'x' }]), (error) => error.code === SOURCE_MISSING);
  assert.throws(() => resolveConsumes([{ file: 'lib/session-queue.mjs', symbol: 'nopeSymbol' }]), (error) => error.code === SOURCE_SYMBOL);
  assert.deepEqual(resolveConsumes([{ file: 'lib/session-queue.mjs' }], { strict: false }), []);
});

test('路径逃逸/缺文件/缺符号：错误码明确', () => {
  assert.throws(() => locateSymbol('../outside.mjs', 'x'), (error) => error.code === SOURCE_ESCAPE);
  assert.throws(() => resolveRepoFile('C:/Windows/notepad.exe'), (error) => error.code === SOURCE_ESCAPE);
  assert.throws(() => locateSymbol('lib/missing-file.mjs', 'x'), (error) => error.code === SOURCE_MISSING);
  assert.throws(() => locateSymbol('lib/session-queue.mjs', 'totallyMissingSymbol'), (error) => error.code === SOURCE_SYMBOL);
});

test('groupConsumes：按文件分组并保留符号行号', () => {
  const resolved = resolveConsumes([
    { file: 'lib/session-queue.mjs', symbol: 'createSessionQueue' },
    { file: 'lib/session-queue.mjs', symbol: 'SessionQueueError' },
    { file: 'lib/observation-delta.mjs', symbol: 'diffObservation' },
  ]);
  const groups = groupConsumes(resolved);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].file, 'lib/session-queue.mjs');
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].symbols.length, 2);
  assert.equal(groups[1].file, 'lib/observation-delta.mjs');
  assert.deepEqual(groupConsumes(null), []);
});

test('locatePropertySource：定位 corpus 模块里的 id 行', () => {
  const located = locatePropertySource('tools/eval/corpus/observe-diff.mjs', 'observe-diff/apply-roundtrip');
  assert(located);
  assert.match(located.location, /^tools\/eval\/corpus\/observe-diff\.mjs:\d+$/);
  assert.match(located.text, /apply-roundtrip/);
  assert.equal(locatePropertySource('tools/eval/corpus/observe-diff.mjs', 'no/such-property'), null);
});

test('临时文件树：源码定位器可独立于仓库根工作', () => {
  const dir = tempDir('eval-source-');
  fs.mkdirSync(path.join(dir, 'lib'));
  const target = path.join(dir, 'lib', 'target.mjs');
  fs.writeFileSync(target, '// sample\nexport function sampleFn(value) {\n  return value;\n}\nexport const CONST = 1;\n');
  clearSourceCache();
  const located = locateSymbol('lib/target.mjs', 'sampleFn', { root: dir });
  assert.equal(located.line, 2);
  assert.equal(located.location, 'lib/target.mjs:2');
  assert.equal(findSymbolLine(fs.readFileSync(target, 'utf8'), 'CONST').line, 5);
  assert.equal(pathToFileURL(target).pathname.length > 0, true);
});
