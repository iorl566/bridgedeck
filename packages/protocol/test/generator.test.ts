// packages/protocol/test/generator.test.ts —— 生成器契约测试。
//
// 这里断言的不是“某个字符串长什么样”，而是三条硬约束：
// 1. `src/generated.ts` 的内容必须逐字符等于当前 JS 单源的重渲染结果（手改即失败）；
// 2. 生成物里的目录签名必须等于对当前 JS 单源算出的签名（源改了没重生成即失败）；
// 3. `--check` 子进程在仓库根目录运行时 exit 0 且输出 clean（CI/门禁口径）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CATALOG_SIGNATURE } from '../src/generated.ts';
import {
  buildSnapshot,
  describeDrift,
  renderProtocolModule,
  validateSnapshot,
} from '../scripts/gen.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT_PATH = fileURLToPath(new URL('../scripts/gen.mjs', import.meta.url));
const OUTPUT_PATH = fileURLToPath(new URL('../src/generated.ts', import.meta.url));

test('生成物 == 当前 JS 单源的重渲染结果（手改/漏生成都会失败）', async () => {
  const { snapshot, signature } = await buildSnapshot();
  const rendered = renderProtocolModule(snapshot, signature);
  const onDisk = readFileSync(OUTPUT_PATH, 'utf8');
  const drift = describeDrift(rendered, onDisk);
  assert.equal(drift, null, drift
    ? 'generated.ts 漂移：第 ' + drift.line + ' 行\n  期望: ' + drift.expected + '\n  实际: ' + drift.actual
    : '');
  assert.ok(onDisk.startsWith('// AUTO-GENERATED FILE — DO NOT EDIT.'), '缺少生成物告示头');
  assert.ok(onDisk.includes('export type MethodName ='), '缺少 MethodName 联合类型');
  assert.ok(onDisk.includes('export const METHOD_COUNT = 165;'), 'METHOD_COUNT 必须是 165');
});

test('目录签名与 JS 单源一致', async () => {
  const { signature } = await buildSnapshot();
  assert.equal(CATALOG_SIGNATURE, 'sha256:' + signature);
  assert.match(CATALOG_SIGNATURE, /^sha256:[0-9a-f]{64}$/);
});

test('--check 子进程在仓库根目录 exit 0 且输出 clean', () => {
  const stdout = execFileSync(process.execPath, [SCRIPT_PATH, '--check'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.match(stdout, /protocol gen: clean/);
  assert.match(stdout, /165 方法/);
  assert.match(stdout, /9 特性门/);
});

test('--help 输出用法且不写文件', () => {
  const before = readFileSync(OUTPUT_PATH, 'utf8');
  const stdout = execFileSync(process.execPath, [SCRIPT_PATH, '--help'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.match(stdout, /--check/);
  assert.equal(readFileSync(OUTPUT_PATH, 'utf8'), before, '--help 不得改生成物');
});

test('生成前校验能拒绝不自洽的快照（防止坏数据固化）', async () => {
  const { snapshot } = await buildSnapshot();
  const fakeCatalog = { validateMethodStates: () => [] };

  // 缺一个方法的状态行
  const missingState = JSON.parse(JSON.stringify(snapshot));
  delete missingState.states[missingState.methodNames[0]];
  assert.throws(
    () => validateSnapshot(missingState, fakeCatalog),
    /未通过生成前校验[\s\S]*缺少状态行/,
  );

  // 特性门 floor 非法
  const badFloor = JSON.parse(JSON.stringify(snapshot));
  badFloor.featureFloors[badFloor.featureNames[0]] = 'nine';
  assert.throws(() => validateSnapshot(badFloor, fakeCatalog), /floor 非法/);

  // 参数规则引用未知特性
  const badRule = JSON.parse(JSON.stringify(snapshot));
  badRule.featureParamRules.push({ feature: 'ghost', param: 'x', kind: 'true' });
  assert.throws(() => validateSnapshot(badRule, fakeCatalog), /引用了未知特性/);

  // 收敛目标不在目录
  const badReconcile = JSON.parse(JSON.stringify(snapshot));
  badReconcile.reconcileOverrides['video.start'] = 'status:no.such.method';
  assert.throws(() => validateSnapshot(badReconcile, fakeCatalog), /收敛目标不在目录/);

  // 源自己的五维状态错误必须原样上报
  assert.throws(
    () => validateSnapshot(snapshot, { validateMethodStates: () => ['fake invariant error'] }),
    /源状态不变量：fake invariant error/,
  );

  // 同一个快照配干净校验器仍然通过（证明上面的失败来自被篡改的字段）。
  assert.doesNotThrow(() => validateSnapshot(snapshot, fakeCatalog));
});

test('describeDrift：相同内容返回 null，不同内容定位到首个差异行', () => {
  assert.equal(describeDrift('a\nb\n', 'a\nb\n'), null);
  const drift = describeDrift('a\nb\n', 'a\nc\n');
  assert.ok(drift);
  assert.equal(drift.line, 2);
  assert.equal(drift.expected, 'b');
  assert.equal(drift.actual, 'c');
  const short = describeDrift('a\nb', 'a');
  assert.ok(short);
  assert.equal(short.line, 2);
  assert.equal(short.actual, '<文件已结束>');
});
