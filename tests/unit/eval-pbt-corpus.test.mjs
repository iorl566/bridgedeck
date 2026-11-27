import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REQUIRED_AREAS, ROOT, loadCorpusForTest, tempDir } from '../eval/helpers.mjs';
import {
  MIN_PROPERTIES_PER_AREA,
  MIN_TOTAL_PROPERTIES,
  assertCorpusCoverage,
  corpusSummary,
  loadCorpus,
  runCorpus,
  selectProperties,
} from '../../tools/eval/lib/corpus.mjs';
import { REQUIRED_AREAS as REPORT_AREAS } from '../../tools/eval/lib/report.mjs';
import { stableStringify } from '../../tools/eval/lib/shrink.mjs';

test('真实 corpus：6 个 area、≥100 property、五个必需域齐全', async () => {
  const corpus = await loadCorpusForTest();
  assert.equal(corpus.areas.length, 6);
  assert.ok(corpus.properties.length >= 100, 'property 数量不足：' + corpus.properties.length);
  const areaNames = new Set(corpus.areas.map((area) => area.area));
  for (const area of REQUIRED_AREAS) assert.equal(areaNames.has(area), true, '缺少必需 area：' + area);
  assert.deepEqual([...REPORT_AREAS], [...REQUIRED_AREAS]);
  assert.deepEqual(assertCorpusCoverage(corpus), []);
  assert.equal(MIN_PROPERTIES_PER_AREA, 3);
  assert.equal(MIN_TOTAL_PROPERTIES, 40);
  const summary = corpusSummary(corpus);
  assert.equal(summary.properties, corpus.properties.length);
  assert.ok(summary.consumes >= 40, 'runtime 消费点过少：' + summary.consumes);
});

test('真实 corpus：每个 property 都有唯一 id、生成器、check 与可解析 file:line', async () => {
  const corpus = await loadCorpusForTest();
  const ids = new Set();
  for (const property of corpus.properties) {
    assert.match(property.id, /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/, 'id 不合法：' + property.id);
    assert.equal(ids.has(property.id), false, '重复 id：' + property.id);
    ids.add(property.id);
    assert.equal(typeof property.check, 'function', '缺少 check：' + property.id);
    assert.equal(typeof property.gen.rng, 'function', '缺少 gen：' + property.id);
    assert.ok(property.consumes.length > 0, '缺少 consumes：' + property.id);
    assert.match(property.source, /^tools\/eval\/corpus\/[a-z-]+\.mjs:\d+$/, 'source 不是 file:line：' + property.id);
    for (const consume of property.consumes) {
      assert.match(consume.location, /^[^:]+:\d+$/, '消费点不是 file:line：' + consume.location);
      assert.ok(consume.line >= 1, '消费点行号非法');
      assert.equal(typeof consume.text, 'string');
    }
  }
});

test('真实 corpus：selectProperties 支持 id/area/tag 过滤', async () => {
  const corpus = await loadCorpusForTest();
  const byArea = selectProperties(corpus, { area: 'observe-diff' });
  assert.equal(byArea.length, 12);
  assert(byArea.every((property) => property.area === 'observe-diff'));
  const byId = selectProperties(corpus, { property: 'observe-diff/apply-roundtrip' });
  assert.equal(byId.length, 1);
  const none = selectProperties(corpus, { property: 'no/such' });
  assert.equal(none.length, 0);
  const byTag = selectProperties(corpus, { tag: 'no-such-tag' });
  assert.equal(byTag.length, 0);
});

test('真实 corpus：子集运行确定性，两次结果 JSON 一致', async () => {
  const corpus = await loadCorpusForTest();
  const first = await runCorpus(corpus, { seed: 21, cases: 5, area: 'session-queue' });
  const second = await runCorpus(corpus, { seed: 21, cases: 5, area: 'session-queue' });
  assert.equal(first.errors.length, 0);
  assert.equal(first.results.length, 15);
  assert(first.results.every((result) => result.status === 'passed'), 'session-queue 子集存在失败');
  assert.equal(stableStringify(first.results), stableStringify(second.results));
  assert.equal(first.selected.length, 15);
});

test('真实 corpus：kernal 自校验域与报告 runtime 消费点一致', async () => {
  const corpus = await loadCorpusForTest();
  const kernel = corpus.properties.filter((property) => property.area === 'eval-kernel');
  assert.ok(kernel.length >= 10, 'kernel 自校验域过小');
  for (const property of kernel) {
    assert(property.consumes.some((consume) => consume.file.startsWith('tools/eval/lib/')), 'kernel property 缺少内核消费点：' + property.id);
  }
});

function writeTempCorpus(files) {
  const dir = tempDir('eval-corpus-');
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  const manifest = path.join(dir, 'manifest.mjs');
  fs.writeFileSync(manifest, files.manifest || '', 'utf8');
  return { dir, manifest: pathToFileURL(manifest).href };
}

function propertyModuleSource(area, propertyId, extra = '') {
  const lib = pathToFileURL(path.join(ROOT, 'tools/eval/lib/property.mjs')).href;
  const intGen = pathToFileURL(path.join(ROOT, 'tools/eval/lib/gen.mjs')).href;
  return [
    "import { defineProperty } from '" + lib + "';",
    "import { integer } from '" + intGen + "';",
    'export const area = {',
    "  area: '" + area + "',",
    "  title: 'temp " + area + "',",
    '  properties: [',
    '    defineProperty({',
    "      id: '" + propertyId + "',",
    "      title: 'temp property',",
    "      area: '" + area + "',",
    '      gen: integer({ min: 0, max: 1 }),',
    "      consumes: [{ file: 'lib/target.mjs', symbol: 'targetFn' }],",
    '      check: () => true,',
    '    }),',
    '  ],',
    '};',
    'export default area;',
    extra,
  ].join('\n');
}

function writeTargetLib(dir) {
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib', 'target.mjs'), '// target\nexport function targetFn(x) { return x; }\n', 'utf8');
}

test('严格加载（临时 corpus）：合法时解析 source 与 consumes', async () => {
  const source = propertyModuleSource('temp-area', 'temp-area/probe');
  const { dir, manifest } = writeTempCorpus({
    'area-a.mjs': source,
    manifest: "import area from './area-a.mjs';\nexport const AREAS = [{ module: 'area-a.mjs', loaded: area }];\n",
  });
  writeTargetLib(dir);
  const corpus = await loadCorpus({ manifestUrl: manifest, root: dir });
  assert.equal(corpus.areas.length, 1);
  assert.equal(corpus.properties.length, 1);
  assert.equal(corpus.properties[0].area, 'temp-area');
  assert.match(corpus.properties[0].source, /^area-a\.mjs:\d+$/);
  assert.equal(corpus.properties[0].consumes[0].line, 2);
  assert.equal(corpus.properties[0].consumes[0].symbol, 'targetFn');
});

test('严格加载（临时 corpus）：重复 id / 不可解析消费点 / 缺 id 行都会报错', async () => {
  const lib = pathToFileURL(path.join(ROOT, 'tools/eval/lib/property.mjs')).href;
  const areaB = [
    "import { defineProperty } from '" + lib + "';",
    'export const area = {',
    "  area: 'temp-b',",
    "  title: 'b',",
    '  properties: [',
    "    defineProperty({ id: 'temp-area/probe', title: 'dup', area: 'temp-b', gen: { kind: 'x', name: 'x', rng: () => 1, shrink: () => [], contains: () => true }, consumes: [{ file: 'lib/target.mjs', symbol: 'targetFn' }], check: () => true }),",
    '  ],',
    '};',
    'export default area;',
  ].join('\n');
  const base = propertyModuleSource('temp-area', 'temp-area/probe');
  const manifestSource = "import a from './area-a.mjs';\nimport b from './area-b.mjs';\nexport const AREAS = [{ module: 'area-a.mjs', loaded: a }, { module: 'area-b.mjs', loaded: b }];\n";
  const first = writeTempCorpus({ 'area-a.mjs': base, 'area-b.mjs': areaB, manifest: manifestSource });
  writeTargetLib(first.dir);
  await assert.rejects(() => loadCorpus({ manifestUrl: first.manifest, root: first.dir }), /id 重复/);

  const brokenConsume = propertyModuleSource('temp-area', 'temp-area/probe').replace("symbol: 'targetFn'", "symbol: 'missingFn'");
  const second = writeTempCorpus({
    'area-a.mjs': brokenConsume,
    manifest: "import a from './area-a.mjs';\nexport const AREAS = [{ module: 'area-a.mjs', loaded: a }];\n",
  });
  writeTargetLib(second.dir);
  await assert.rejects(() => loadCorpus({ manifestUrl: second.manifest, root: second.dir }), /消费点解析失败/);

  const noIdLine = propertyModuleSource('temp-area', 'temp-area/probe')
    .replace("      id: 'temp-area/probe',\n", '      id: ID_VALUE,\n')
    .replace('export const area = {', "const ID_VALUE = 'temp-area/probe';\nexport const area = {");
  const third = writeTempCorpus({
    'area-a.mjs': noIdLine,
    manifest: "import a from './area-a.mjs';\nexport const AREAS = [{ module: 'area-a.mjs', loaded: a }];\n",
  });
  writeTargetLib(third.dir);
  await assert.rejects(() => loadCorpus({ manifestUrl: third.manifest, root: third.dir }), /找不到 property id 定义行/);
});

test('覆盖面策略：缺域/域内 property 过少/总数过少都会产生 issue', async () => {
  const corpus = await loadCorpusForTest();
  const issues = assertCorpusCoverage(corpus, {
    requiredAreas: [...REQUIRED_AREAS, 'missing-area'],
    minPerArea: 1000,
    minTotal: 100000,
  });
  assert(issues.some((issue) => issue.code === 'E_CORPUS_AREA_MISSING'));
  assert(issues.some((issue) => issue.code === 'E_CORPUS_AREA_THIN'));
  assert(issues.some((issue) => issue.code === 'E_CORPUS_TOO_SMALL'));
});
