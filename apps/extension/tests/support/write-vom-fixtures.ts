// tests/support/write-vom-fixtures.ts —— 从 fake DOM 夹具页抽取 VOM facts JSON 并落盘。
//
// 为什么提交 facts JSON 而不是只留生成代码：
// - 差分测试（tests/vom-diff.test.ts）要把**同一组页面事实**喂给 TS（packages/vom）与
//   JS（extension/src/lib/vom-*.js），facts 必须是稳定、可 review 的输入；
// - facts JSON 就是内容脚本运行时会产出的形状（vom-facts.ts），因此差异一旦出现，
//   定位点在「投影」或「packages/vom」，而不是夹具构造。
//
// 用法（只在显式更新夹具时跑；不是测试）：
//   $env:PATH='D:\tools\node;' + $env:PATH
//   node apps/extension/tests/support/write-vom-fixtures.ts
//
// tests/vom-facts.test.ts 会重新抽取并断言与已提交 JSON 逐字段一致，防止夹具漂移。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildObservation } from '../../src/content/dom.ts';
import { assignRichElementIds, buildRichObservation, collectElements } from '../../src/content/rich.ts';
import { buildVomPageFacts } from '../../src/content/vom-facts.ts';
import type { VomFactsLimits, VomPageFacts } from '../../src/content/vom-facts.ts';
import { createFakeDom } from './fake-dom.ts';
import { vomFixturePages, type VomFixturePage } from './vom-fixture-pages.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..', '..');
export const VOM_FIXTURE_DIR = path.join(REPO, 'tests', 'fixtures', 'vom-facts');

/** 用与运行时完全相同的 DOM 流程抽取一个夹具页的 facts。 */
export function extractVomFixtureFacts(page: VomFixturePage, limits?: Partial<VomFactsLimits>): VomPageFacts {
  const fake = createFakeDom(page.elements, { title: page.title, url: page.url });
  const { collected } = collectElements(fake.env);
  const elementById = assignRichElementIds(collected);
  const built = buildObservation(fake.env, {});
  // deepFacts=false：facts JSON 是“深水区回填前”的页面事实快照（与运行时投影点一致）。
  const rich = buildRichObservation(fake.env, built, { vom: true, deepFacts: false });
  const nodes = Array.isArray(rich.nodes) ? rich.nodes : [];
  return buildVomPageFacts({
    url: built.url,
    title: built.title,
    env: fake.env,
    nodes,
    elements: collected.map((item) => item.el),
    elementById,
    ...(page.frames ? { frames: page.frames } : {}),
    ...(limits ? { limits } : {}),
  });
}

/** 抽取全部夹具页（name → facts）。 */
export function extractAllVomFixtures(): Map<string, VomPageFacts> {
  const out = new Map<string, VomPageFacts>();
  for (const page of vomFixturePages()) out.set(page.name, extractVomFixtureFacts(page));
  return out;
}

/** 写盘（生成器入口）。 */
export function writeVomFixtures(): string[] {
  fs.mkdirSync(VOM_FIXTURE_DIR, { recursive: true });
  const written: string[] = [];
  for (const [name, facts] of extractAllVomFixtures()) {
    const file = path.join(VOM_FIXTURE_DIR, name + '.json');
    fs.writeFileSync(file, JSON.stringify(facts, null, 2) + '\n', 'utf8');
    written.push(file);
  }
  return written;
}

// 作为脚本直接执行时写盘；被测试 import 时不产生副作用。
const invokedDirectly = (() => {
  try {
    return process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const written = writeVomFixtures();
  for (const file of written) console.log('wrote ' + file);
}
