// tests/unit/mcp-prompt-versions.test.mjs —— MCP prompts 版本化（semver / 指纹 / 协商 / 差量）。
//
// 覆盖：版本表与指纹基线、semver 校验、版本协商（latest/exact/旧版本/未来/major/非法）、
// 签名差量分类（breaking/additive/identical）与版本位映射、审计（未升版本改 prompt 的
// 指纹漂移、重复版本、缺 changelog、非法日期、孤儿登记）、能力快照与 _meta 组装。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROMPT_STABILITY,
  PROMPT_VERSION_BUMPS,
  PROMPT_VERSION_HISTORY,
  PROMPT_VERSION_PARAM,
  PROMPT_VERSION_PATTERN,
  PROMPT_VERSION_REASONS,
  PromptVersionError,
  auditPromptVersions,
  assertPromptVersions,
  classifyVersionBump,
  diffPromptSignatures,
  promptFingerprint,
  promptSignature,
  promptVersionExists,
  promptVersionMeta,
  promptVersionOf,
  promptVersionTable,
  promptVersionsSnapshot,
  resolvePromptVersion,
  versionBumpMatches,
} from '../../mcp/prompt-versions.mjs';
import { PROMPT_DEFINITIONS, promptDefinition } from '../../mcp/prompts.mjs';

test('版本表：每个 prompt 都有 1.0.0 基线与稳定指纹', () => {
  const table = promptVersionTable();
  assert.equal(table.length, PROMPT_DEFINITIONS.length);
  assert.deepEqual(table.map((item) => item.name), PROMPT_DEFINITIONS.map((prompt) => prompt.name));
  for (const item of table) {
    assert.equal(item.version, '1.0.0');
    assert.match(item.version, PROMPT_VERSION_PATTERN);
    assert.equal(item.stability, PROMPT_STABILITY.STABLE);
    assert.equal(item.deprecated, false);
    assert.equal(item.changelog.length, 1);
    assert.equal(item.changelog[0].version, '1.0.0');
    assert.ok(item.changelog[0].changes.length >= 1);
    assert.equal(typeof item.fingerprint, 'string');
    assert.equal(item.fingerprint.length, 64);
    assert.equal(item.fingerprint, item.declaredFingerprint);
  }
  assert.equal(promptVersionTable().length, 9);
  // 指纹由“声明 + 样例渲染文本”派生：同一 prompt 两次计算结果稳定。
  const prompt = promptDefinition('har_analysis');
  assert.equal(promptFingerprint(prompt), promptFingerprint(prompt));
  assert.notEqual(promptFingerprint(prompt), promptFingerprint(promptDefinition('video_verify')));
  assert.equal(promptFingerprint(null), null);
});

test('promptVersionOf / promptVersionExists / 未知 prompt', () => {
  const entry = promptVersionOf('cooperation_handoff');
  assert.equal(entry.name, 'cooperation_handoff');
  assert.equal(entry.version, '1.0.0');
  assert.deepEqual(entry.signature.resources, ['bridge://skill/SKILL.md']);
  assert.equal(promptVersionOf('nope'), null);

  assert.equal(promptVersionExists('har_analysis', '1.0.0'), true);
  assert.equal(promptVersionExists('har_analysis', '1.1.0'), false);
  assert.equal(promptVersionExists('nope', '1.0.0'), false);

  assert.throws(() => resolvePromptVersion('nope', '1.0.0'), (error) => error instanceof PromptVersionError && error.code === 'E_NOT_FOUND');
});

test('resolvePromptVersion：latest/exact/旧版本/未来/major/非法', () => {
  const latest = resolvePromptVersion('har_analysis');
  assert.equal(latest.version, '1.0.0');
  assert.equal(latest.exact, true);
  assert.equal(latest.fallback, false);
  assert.equal(latest.reason, PROMPT_VERSION_REASONS.LATEST);
  assert.equal(latest.requested, null);
  assert.deepEqual([...latest.availableVersions], ['1.0.0']);

  const explicitLatest = resolvePromptVersion('har_analysis', 'latest');
  assert.equal(explicitLatest.exact, true);
  assert.equal(explicitLatest.reason, PROMPT_VERSION_REASONS.LATEST);

  const exact = resolvePromptVersion('har_analysis', '1.0.0');
  assert.equal(exact.exact, true);
  assert.equal(exact.reason, PROMPT_VERSION_REASONS.EXACT);
  assert.equal(exact.deprecated, false);

  const tooNew = resolvePromptVersion('har_analysis', '1.1.0');
  assert.equal(tooNew.version, '1.0.0');
  assert.equal(tooNew.fallback, true);
  assert.equal(tooNew.exact, false);
  assert.equal(tooNew.compatible, false);
  assert.equal(tooNew.reason, PROMPT_VERSION_REASONS.FUTURE);

  const major = resolvePromptVersion('har_analysis', '2.0.0');
  assert.equal(major.fallback, true);
  assert.equal(major.reason, PROMPT_VERSION_REASONS.MAJOR);

  const older = resolvePromptVersion('har_analysis', '0.9.0');
  assert.equal(older.fallback, true);
  assert.equal(older.compatible, false);

  const invalid = resolvePromptVersion('har_analysis', 'v1');
  assert.equal(invalid.fallback, true);
  assert.equal(invalid.reason, PROMPT_VERSION_REASONS.INVALID);
  assert.equal(invalid.version, '1.0.0');

  const blank = resolvePromptVersion('har_analysis', '   ');
  assert.equal(blank.reason, PROMPT_VERSION_REASONS.LATEST);
});

test('diffPromptSignatures：identical / additive / breaking 三类', () => {
  const base = promptSignature(promptDefinition('har_analysis'));
  const identical = diffPromptSignatures(base, base);
  assert.equal(identical.classification, 'identical');
  assert.equal(identical.breaking, false);
  assert.equal(identical.additive, false);
  assert.deepEqual(identical.summary, []);
  assert.equal(classifyVersionBump(base, base), PROMPT_VERSION_BUMPS.NONE);

  const withOptional = {
    ...base,
    arguments: [...base.arguments, Object.freeze({ name: 'window', required: false, enum: null })],
  };
  const additive = diffPromptSignatures(base, withOptional);
  assert.equal(additive.classification, 'additive');
  assert.equal(additive.additive, true);
  assert.deepEqual(additive.changes.addedArguments, ['window']);
  assert.equal(classifyVersionBump(base, withOptional), PROMPT_VERSION_BUMPS.MINOR);
  assert.equal(versionBumpMatches('1.0.0', '1.1.0', PROMPT_VERSION_BUMPS.MINOR), true);
  assert.equal(versionBumpMatches('1.0.0', '2.0.0', PROMPT_VERSION_BUMPS.MINOR), false);

  const withRequired = {
    ...base,
    arguments: [...base.arguments, Object.freeze({ name: 'must', required: true, enum: null })],
  };
  const breakingRequired = diffPromptSignatures(base, withRequired);
  assert.equal(breakingRequired.breaking, true);
  assert.deepEqual(breakingRequired.changes.requiredAdded, ['must']);
  assert.equal(classifyVersionBump(base, withRequired), PROMPT_VERSION_BUMPS.MAJOR);
  assert.equal(versionBumpMatches('1.0.0', '2.0.0', PROMPT_VERSION_BUMPS.MAJOR), true);

  const removed = { ...base, arguments: base.arguments.filter((argument) => argument.name !== 'focus') };
  const breakingRemoved = diffPromptSignatures(base, removed);
  assert.equal(breakingRemoved.classification, 'breaking');
  assert.deepEqual(breakingRemoved.changes.removedArguments, ['focus']);

  // 枚举收窄是 breaking，放宽是 additive。
  const narrowed = {
    ...base,
    arguments: base.arguments.map((argument) => (argument.name === 'focus'
      ? { ...argument, enum: ['timings', 'errors'] }
      : argument)),
  };
  const narrowing = diffPromptSignatures(base, narrowed);
  assert.equal(narrowing.breaking, true);
  assert.deepEqual(narrowing.changes.enumChanges[0].removed, ['payloads', 'replay']);

  const widened = {
    ...base,
    arguments: base.arguments.map((argument) => (argument.name === 'focus'
      ? { ...argument, enum: [...argument.enum, 'cache'] }
      : argument)),
  };
  const widening = diffPromptSignatures(base, widened);
  assert.equal(widening.classification, 'additive');
  assert.deepEqual(widening.changes.enumChanges[0].added, ['cache']);

  // 改名 / 删资源 / 标签变化。
  assert.equal(diffPromptSignatures(base, { ...base, name: 'other' }).breaking, true);
  assert.equal(diffPromptSignatures(base, { ...base, resources: [] }).breaking, true);
  assert.equal(diffPromptSignatures(base, { ...base, tags: [...base.tags, 'extra'] }).classification, 'additive');
});

test('promptVersionMeta：list/get 的版本元数据与协商标记', () => {
  const meta = promptVersionMeta('har_analysis');
  assert.equal(meta.version, '1.0.0');
  assert.equal(meta.fallback, false);
  assert.equal(meta.exact, true);
  assert.deepEqual([...meta.availableVersions], ['1.0.0']);
  assert.equal(meta.changelog[0].version, '1.0.0');

  const fallback = promptVersionMeta('har_analysis', { requestedVersion: '9.9.9' });
  assert.equal(fallback.fallback, true);
  assert.equal(fallback.requested, '9.9.9');
  assert.equal(fallback.reason, PROMPT_VERSION_REASONS.MAJOR);
  assert.equal(promptVersionMeta('nope'), null);
});

test('auditPromptVersions：登记表自洽且 strict 不抛错', () => {
  const report = auditPromptVersions();
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.stats.prompts, PROMPT_DEFINITIONS.length);
  assert.equal(report.stats.versions, PROMPT_DEFINITIONS.length);
  assert.equal(report.stats.stable, PROMPT_DEFINITIONS.length);
  assert.equal(report.stats.fingerprints.length, PROMPT_DEFINITIONS.length);
  assert.doesNotThrow(() => assertPromptVersions());
});

test('auditPromptVersions：指纹漂移/重复版本/缺 changelog/非法日期/孤儿登记都被抓出', () => {
  // 未升版本改渲染文本 → 指纹不匹配。
  const tampered = PROMPT_DEFINITIONS.map((prompt) => (prompt.name === 'video_verify'
    ? { ...prompt, render: () => '# 伪造的新渲染文本\n'.repeat(20) }
    : prompt));
  const tamperedReport = auditPromptVersions({ prompts: tampered });
  assert.equal(tamperedReport.ok, false);
  assert.ok(tamperedReport.errors.some((error) => error.code === 'prompt-version-fingerprint' && error.prompt === 'video_verify'));
  assert.throws(() => assertPromptVersions({ prompts: tampered }), /prompt 版本审计失败/);

  const definition = promptDefinition('page_action_plan');
  const badHistory = {
    page_action_plan: [
      { version: '1.0.0', date: '2026-11-26', changes: ['ok'], fingerprint: promptFingerprint(definition) },
      { version: '1.0.0', date: '2026-11-26', changes: ['重复'] },
      { version: '2.0.0', date: 'not-a-date', changes: [] },
    ],
  };
  const badReport = auditPromptVersions({ prompts: PROMPT_DEFINITIONS, history: { ...PROMPT_VERSION_HISTORY, ...badHistory } });
  const codes = badReport.errors.map((error) => error.code);
  assert.ok(codes.includes('prompt-version-duplicate'));
  assert.ok(codes.includes('prompt-version-changelog'));
  assert.ok(codes.includes('prompt-version-date'));

  const orphanHistory = { ...PROMPT_VERSION_HISTORY, ghost_prompt: [{ version: '1.0.0', date: '2026-11-26', changes: ['x'], fingerprint: 'a'.repeat(64) }] };
  const orphanReport = auditPromptVersions({ prompts: PROMPT_DEFINITIONS, history: orphanHistory });
  assert.ok(orphanReport.errors.some((error) => error.code === 'prompt-version-orphan'));

  const invalidVersion = auditPromptVersions({
    prompts: [promptDefinition('har_analysis')],
    history: { har_analysis: [{ version: '1.0', date: '2026-11-26', changes: ['x'] }] },
  });
  assert.ok(invalidVersion.errors.some((error) => error.code === 'prompt-version-format'));

  const missing = auditPromptVersions({ prompts: [promptDefinition('har_analysis')], history: {} });
  assert.ok(missing.errors.some((error) => error.code === 'prompt-version-missing'));
  assert.equal(auditPromptVersions({ prompts: [], history: {} }).ok, false);
});

test('auditPromptVersions：相邻版本带签名快照时，版本跳变必须匹配差量分类', () => {
  const definition = promptDefinition('har_analysis');
  const signature = promptSignature(definition);
  const breakingSignature = {
    ...signature,
    arguments: signature.arguments.filter((argument) => argument.name !== 'focus'),
  };
  const history = {
    ...PROMPT_VERSION_HISTORY,
    har_analysis: [
      { version: '1.0.0', date: '2026-11-26', changes: ['base'], fingerprint: promptFingerprint(definition), signature },
      { version: '1.1.0', date: '2026-11-26', changes: ['breaking 却只升 minor'], signature: breakingSignature },
    ],
  };
  const prompts = PROMPT_DEFINITIONS.map((prompt) => (prompt.name === 'har_analysis'
    ? { ...prompt, arguments: prompt.arguments.filter((argument) => argument.name !== 'focus') }
    : prompt));
  const report = auditPromptVersions({ prompts, history });
  assert.ok(report.errors.some((error) => error.code === 'prompt-version-bump'));
  // 正确升 major 则不报 bump 错误（但指纹要同步，否则会报 fingerprint——这里只断言 bump 不存在）。
  const correctHistory = {
    ...history,
    har_analysis: [
      history.har_analysis[0],
      { ...history.har_analysis[1], version: '2.0.0' },
    ],
  };
  const fixed = auditPromptVersions({ prompts, history: correctHistory });
  assert.equal(fixed.errors.some((error) => error.code === 'prompt-version-bump'), false);
});

test('promptVersionsSnapshot：能力声明与提示字段位置', () => {
  const snapshot = promptVersionsSnapshot();
  assert.equal(snapshot.supported, true);
  assert.equal(snapshot.param, PROMPT_VERSION_PARAM);
  assert.equal(snapshot.format, 'semver (x.y.z)');
  assert.equal(snapshot.total, PROMPT_DEFINITIONS.length);
  assert.equal(snapshot.prompts.length, PROMPT_DEFINITIONS.length);
  assert.ok(snapshot.prompts.every((item) => item.version === '1.0.0' && item.fingerprint.length === 64));
  assert.equal(snapshot.fields.get, 'prompts/get._meta["browser-bridge/prompt"].version');
  assert.equal(snapshot.reasons.NOT_SERVED, 'version-not-served');
  assert.equal(snapshot.bumps.MAJOR, 'major');
  assert.match(snapshot.rendering, /fallback/);
});
