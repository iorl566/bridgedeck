// tests/unit/mcp-prompt-completion.test.mjs —— prompt 参数的目录感知补全（枚举之外）。
//
// 覆盖：参数来源分派（enum/sessions/har-sources/free-form）、候选排序、无 catalog 时与旧行为
// 兼容、自由文本 hint、审计（重复参数/缺 hint/无 prompts）、strict 包装、能力快照，以及
// completion.mjs 的端到端集成（prompt session 参数能补出真实会话 id、freeForm 语义不变）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HAR_SOURCE_LATEST,
  PROMPT_ARGUMENT_HINTS,
  PROMPT_ARGUMENT_SOURCE_KINDS,
  PROMPT_ARGUMENT_SOURCES,
  PROMPT_COMPLETION_LIMITS,
  assertPromptCompletion,
  auditPromptCompletion,
  completePromptArgumentFromCatalog,
  promptArgumentPlan,
  promptArgumentSourceOf,
  promptCompletionSnapshot,
  rankCandidates,
} from '../../mcp/prompt-completion.mjs';
import {
  completionSnapshot,
  complete,
  completePromptArgument,
} from '../../mcp/completion.mjs';
import { PROMPT_DEFINITIONS, promptDefinition } from '../../mcp/prompts.mjs';

test('rankCandidates：完全匹配 → 前缀 → 子串 → 全部，保持稳定字典序', () => {
  const all = rankCandidates(['beta', 'alpha', 'Gamma', 'gamma-two'], '');
  assert.deepEqual(all.values, ['alpha', 'beta', 'Gamma', 'gamma-two']);
  assert.equal(all.matchKind, 'all');

  const prefix = rankCandidates(['errors', 'har-errors', 'timings'], 'err');
  assert.deepEqual(prefix.values, ['errors', 'har-errors']);
  assert.equal(prefix.matchKind, 'prefix');

  const exact = rankCandidates(['errors', 'har-errors'], 'errors');
  assert.deepEqual(exact.values, ['errors', 'har-errors']);
  assert.equal(exact.matchKind, 'exact');

  const substring = rankCandidates(['x-beta', 'beta-x'], 'eta');
  assert.deepEqual(substring.values, ['beta-x', 'x-beta']);
  assert.equal(substring.matchKind, 'substring');

  const none = rankCandidates(['a'], 'zzz');
  assert.deepEqual(none.values, []);
  assert.equal(none.matchKind, 'none');
  // 去重、去空白、超长丢弃。
  const normalized = rankCandidates(['a', ' a ', 'b', 'x'.repeat(PROMPT_COMPLETION_LIMITS.maxValueLength + 1)], '');
  assert.deepEqual(normalized.values, ['a', 'b']);
});

test('promptArgumentPlan：enum / sessions / har-sources / free-form 四种分派', () => {
  const har = promptDefinition('har_analysis');
  const focus = promptArgumentPlan(har, 'focus');
  assert.equal(focus.kind, PROMPT_ARGUMENT_SOURCE_KINDS.ENUM);
  assert.deepEqual([...focus.enum], ['timings', 'errors', 'payloads', 'replay']);

  const source = promptArgumentPlan(har, 'source');
  assert.equal(source.kind, PROMPT_ARGUMENT_SOURCE_KINDS.HAR_SOURCES);

  const handoff = promptDefinition('cooperation_handoff');
  const session = promptArgumentPlan(handoff, 'session');
  assert.equal(session.kind, PROMPT_ARGUMENT_SOURCE_KINDS.SESSIONS);

  const task = promptArgumentPlan(promptDefinition('browser_task_brief'), 'task');
  assert.equal(task.kind, PROMPT_ARGUMENT_SOURCE_KINDS.FREE_FORM);
  assert.equal(task.hint, PROMPT_ARGUMENT_HINTS.task);

  const unknownArgument = promptArgumentPlan(handoff, 'nope');
  assert.equal(unknownArgument.kind, PROMPT_ARGUMENT_SOURCE_KINDS.FREE_FORM);
  assert.match(unknownArgument.hint, /未声明/);

  assert.equal(promptArgumentSourceOf('session').source, PROMPT_ARGUMENT_SOURCE_KINDS.SESSIONS);
  assert.equal(promptArgumentSourceOf('source').source, PROMPT_ARGUMENT_SOURCE_KINDS.HAR_SOURCES);
  assert.equal(promptArgumentSourceOf('task'), null);
  assert.ok(PROMPT_ARGUMENT_SOURCES.length >= 2);
});

test('completePromptArgumentFromCatalog：session 候选取自 catalog、前缀过滤与空目录降级', () => {
  const handoff = promptDefinition('cooperation_handoff');
  const all = completePromptArgumentFromCatalog({ prompt: handoff, argument: 'session', value: '', catalog: { sessions: ['s-fake', 's2'] } });
  assert.deepEqual([...all.values], ['s-fake', 's2']);
  assert.equal(all.source, 'sessions');
  assert.equal(all.freeForm, false);
  assert.equal(all.matchKind, 'all');

  const filtered = completePromptArgumentFromCatalog({ prompt: handoff, argument: 'session', value: 's-f', catalog: { sessions: ['s-fake', 's2'] } });
  assert.deepEqual([...filtered.values], ['s-fake']);
  assert.equal(filtered.matchKind, 'prefix');

  const empty = completePromptArgumentFromCatalog({ prompt: handoff, argument: 'session', value: '', catalog: { sessions: [] } });
  assert.deepEqual([...empty.values], []);
  assert.equal(empty.freeForm, true);
  assert.match(empty.hint, /没有已知会话/);

  const noCatalog = completePromptArgumentFromCatalog({ prompt: handoff, argument: 'session', value: '' });
  assert.deepEqual([...noCatalog.values], []);
  assert.equal(noCatalog.freeForm, true);
});

test('completePromptArgumentFromCatalog：HAR source 候选 = latest + 注入文件，且 latest 大小写不敏感匹配', () => {
  const har = promptDefinition('har_analysis');
  const withFiles = completePromptArgumentFromCatalog({ prompt: har, argument: 'source', value: '', catalog: { harFiles: ['demo.har', 'login.har'] } });
  assert.deepEqual([...withFiles.values], ['demo.har', HAR_SOURCE_LATEST, 'login.har']);
  assert.equal(withFiles.source, 'har-sources');
  assert.equal(withFiles.hint, null);

  const onlyLatest = completePromptArgumentFromCatalog({ prompt: har, argument: 'source', value: '' });
  assert.deepEqual([...onlyLatest.values], [HAR_SOURCE_LATEST]);
  assert.match(onlyLatest.hint, /没有已知 HAR 文件/);

  const prefix = completePromptArgumentFromCatalog({ prompt: har, argument: 'source', value: 'la' });
  assert.deepEqual([...prefix.values], [HAR_SOURCE_LATEST]);
  const files = completePromptArgumentFromCatalog({ prompt: har, argument: 'source', value: 'login', catalog: { harFiles: ['demo.har', 'login.har'] } });
  assert.deepEqual([...files.values], ['login.har']);
});

test('completePromptArgumentFromCatalog：enum 参数与自由文本参数', () => {
  const har = promptDefinition('har_analysis');
  const enumResult = completePromptArgumentFromCatalog({ prompt: har, argument: 'focus', value: 'err' });
  assert.deepEqual([...enumResult.values], ['errors']);
  assert.equal(enumResult.source, 'prompt-enum');
  assert.equal(enumResult.freeForm, false);

  const free = completePromptArgumentFromCatalog({ prompt: promptDefinition('debug_investigation'), argument: 'symptom', value: 'x' });
  assert.deepEqual([...free.values], []);
  assert.equal(free.freeForm, true);
  assert.match(free.hint, /没有固定候选/);
});

test('completion.mjs 集成：session 参数补出真实会话 id；没有 catalog 时行为与旧版一致', () => {
  const withCatalog = completePromptArgument({
    ref: { type: 'ref/prompt', name: 'cooperation_handoff' },
    argument: { name: 'session', value: '' },
    catalog: { sessions: ['s-fake'] },
  });
  assert.deepEqual(withCatalog.values, ['s-fake']);
  assert.equal(withCatalog.freeForm, false);
  assert.equal(withCatalog.source, 'sessions');

  const withoutCatalog = completePromptArgument({
    ref: { type: 'ref/prompt', name: 'cooperation_handoff' },
    argument: { name: 'session', value: '' },
  });
  assert.deepEqual(withoutCatalog.values, []);
  assert.equal(withoutCatalog.freeForm, true);
  assert.equal(withoutCatalog.source, 'prompt-free-form');

  // 枚举路径不变（仍由 completion.mjs 负责，source=prompt-enum）。
  const enumArgument = completePromptArgument({
    ref: { type: 'ref/prompt', name: 'har_analysis' },
    argument: { name: 'focus', value: '' },
    catalog: { sessions: ['s1'] },
  });
  assert.equal(enumArgument.source, 'prompt-enum');
  assert.equal(enumArgument.values.length, 4);

  // complete() 入口会把 catalog 传给 prompt 分支（资源模板分支行为不变）。
  const viaComplete = complete({
    ref: { type: 'ref/prompt', name: 'recipe_from_session' },
    argument: { name: 'session', value: 's' },
  }, { catalog: { sessions: ['s-fake'] } });
  assert.deepEqual(viaComplete.completion.values, ['s-fake']);
  assert.equal(viaComplete._meta['browser-bridge/completion'].source, 'sessions');

  const resource = complete({
    ref: { type: 'ref/resource', uri: 'bridge://observation/{session}' },
    argument: { name: 'session', value: '' },
  }, { catalog: { sessions: ['s1', 's2'] } });
  assert.deepEqual(resource.completion.values, ['s1', 's2']);
  assert.equal(resource._meta['browser-bridge/completion'].source, 'sessions');

  // completionSnapshot 声明 enum 之外的动态来源（客户端可据此知道哪些参数其实有候选）。
  const snapshot = completionSnapshot({ sessions: ['s1'], skillReferences: ['a.md'] });
  assert.ok(snapshot.promptSources.some((item) => item.prompt === 'cooperation_handoff'
    && item.argument === 'session' && item.kind === 'sessions'));
  assert.ok(snapshot.promptSources.some((item) => item.prompt === 'har_analysis' && item.kind === 'har-sources'));
  assert.equal(snapshot.catalog.sessions, 1);
});

test('auditPromptCompletion：真实 prompt 表自洽且 strict 不抛错', () => {
  const report = auditPromptCompletion({ prompts: PROMPT_DEFINITIONS });
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.prompts, PROMPT_DEFINITIONS.length);
  assert.ok(report.arguments >= 15);
  assert.equal(report.dynamic, 3, '两个 session 参数 + 一个 source 参数');
  assert.doesNotThrow(() => assertPromptCompletion({ prompts: PROMPT_DEFINITIONS }));

  const empty = auditPromptCompletion({ prompts: [] });
  assert.equal(empty.ok, false);
  assert.equal(empty.errors[0].code, 'prompt-completion-empty');

  const duplicateArguments = auditPromptCompletion({
    prompts: [{
      name: 'dup_prompt',
      arguments: [
        { name: 'task', description: 'x', required: true },
        { name: 'task', description: 'y', required: false },
      ],
    }],
  });
  assert.ok(duplicateArguments.errors.some((error) => error.code === 'prompt-completion-duplicate'));

  const badEnum = auditPromptCompletion({
    prompts: [{ name: 'p', arguments: [{ name: 'focus', description: 'x', required: true, enum: ['only-one'] }] }],
  });
  assert.ok(badEnum.errors.some((error) => error.code === 'prompt-completion-enum'));
  // 未知参数名走自由文本 + 提示语，不报错（补全必须有可解释语义）。
  const unknownArgument = auditPromptCompletion({
    prompts: [{ name: 'p', arguments: [{ name: 'weird_argument', description: 'x', required: true }] }],
  });
  assert.equal(unknownArgument.ok, true);
  assert.ok(promptArgumentPlan({ name: 'p', arguments: [{ name: 'weird_argument', description: 'x', required: false }] }, 'weird_argument').hint.length > 0);
});

test('promptCompletionSnapshot：来源表/限制/hints 声明', () => {
  const snapshot = promptCompletionSnapshot();
  assert.equal(snapshot.supported, true);
  assert.ok(snapshot.sources.some((item) => item.argument === 'session' && item.source === 'sessions'));
  assert.equal(snapshot.kinds.SESSIONS, 'sessions');
  assert.equal(snapshot.limits.maxValues, 100);
  assert.equal(snapshot.freeFormReturnsEmpty, true);
  assert.equal(snapshot.hints.task, PROMPT_ARGUMENT_HINTS.task);
});
