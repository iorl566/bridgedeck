// tests/unit/mcp-completion.test.mjs —— completion/complete 补全引擎测试。
//
// 覆盖：params 校验（ref/argument 形状）、候选归一化/去重/超长丢弃、前缀优先排序、
// prompt 枚举补全与自由文本参数（空候选不是错误）、资源模板变量补全（技能参考/会话）、
// 100 值上限与游标续读、主入口 complete 的应答与 _meta、auditCompletions 自洽、
// completionSnapshot 声明。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPLETION_ERRORS,
  COMPLETION_LIMITS,
  COMPLETION_REF_TYPES,
  COMPLETION_TEMPLATES,
  CompletionError,
  auditCompletions,
  complete,
  completePromptArgument,
  completeResourceArgument,
  completionSnapshot,
  isKnownPrompt,
  matchCandidates,
  normalizeCandidates,
  paginateCompletionValues,
  validateCompletionParams,
} from '../../mcp/completion.mjs';
import { PROMPT_DEFINITIONS } from '../../mcp/prompts.mjs';

const ENUM_PROMPT = PROMPT_DEFINITIONS.find((prompt) => prompt.arguments.some((argument) => Array.isArray(argument.enum)));
const ENUM_ARGUMENT = ENUM_PROMPT.arguments.find((argument) => Array.isArray(argument.enum));
const FREE_PROMPT = PROMPT_DEFINITIONS.find((prompt) => prompt.arguments.some((argument) => !Array.isArray(argument.enum)));

test('normalizeCandidates：去空白/去重/超长丢弃/保序', () => {
  const values = normalizeCandidates(['  b ', 'a', 'a', '', null, 'c'.repeat(COMPLETION_LIMITS.maxValueLength + 1), 42]);
  assert.deepEqual(values, ['b', 'a', '42']);
  assert.deepEqual(normalizeCandidates(null), []);
});

test('matchCandidates：空值全量、精确/前缀/子串排序、大小写不敏感', () => {
  const candidates = ['payloads', 'errors', 'timings', 'network', 'har-errors'];
  const all = matchCandidates(candidates, '');
  assert.deepEqual(all.values, [...candidates].sort());
  assert.equal(all.matchKind, 'all');

  // 排序口径：精确 > 前缀 > 子串；同一档内字典序。matchKind 表示命中的最高档。
  const prefix = matchCandidates(candidates, 'err');
  assert.deepEqual(prefix.values, ['errors', 'har-errors']);
  assert.equal(prefix.matchKind, 'prefix');

  const exact = matchCandidates(candidates, 'errors');
  assert.equal(exact.values[0], 'errors');
  assert.equal(exact.matchKind, 'exact');

  const substring = matchCandidates(['alpha', 'x-beta'], 'beta');
  assert.deepEqual(substring.values, ['x-beta']);
  assert.equal(substring.matchKind, 'substring');

  const none = matchCandidates(candidates, 'zzz');
  assert.deepEqual(none.values, []);
  assert.equal(none.matchKind, 'none');
  assert.equal(matchCandidates(['Errors', 'errors-2'], 'ERRORS').matchKind, 'exact');
  assert.equal(matchCandidates(['Errors', 'errors-2'], 'ERRORS').values[0], 'Errors');
});

test('validateCompletionParams：ref/argument 形状校验', () => {
  assert.throws(() => validateCompletionParams({}), (error) => error instanceof CompletionError && error.code === COMPLETION_ERRORS.BAD_REF);
  assert.throws(() => validateCompletionParams({ ref: { type: 'ref/unknown' }, argument: { name: 'x' } }), /ref.type/);
  assert.throws(() => validateCompletionParams({ ref: { type: 'ref/prompt', name: 'x' } }), (error) => error.code === COMPLETION_ERRORS.MISSING_ARG);
  assert.throws(() => validateCompletionParams({ ref: { type: 'ref/prompt', name: 'x' }, argument: { name: '' } }), /argument.name/);
  assert.throws(() => validateCompletionParams({ ref: { type: 'ref/prompt', name: 'x' }, argument: { name: 'a'.repeat(200) } }), /超长/);
  const parsed = validateCompletionParams({ ref: { type: 'ref/prompt', name: 'p' }, argument: { name: 'focus', value: null } });
  assert.equal(parsed.type, 'ref/prompt');
  assert.equal(parsed.argument.value, '');
  assert.equal(COMPLETION_REF_TYPES.includes(parsed.type), true);
});

test('prompt 枚举补全：候选全部来自声明 enum，可按前缀过滤', () => {
  const result = completePromptArgument({
    ref: { type: 'ref/prompt', name: ENUM_PROMPT.name },
    argument: { name: ENUM_ARGUMENT.name, value: '' },
  });
  assert.equal(result.freeForm, false);
  assert.equal(result.source, 'prompt-enum');
  assert.deepEqual([...result.values].sort(), [...ENUM_ARGUMENT.enum].sort());
  assert.equal(result.total, ENUM_ARGUMENT.enum.length);

  const first = ENUM_ARGUMENT.enum[0];
  const filtered = completePromptArgument({
    ref: { type: 'ref/prompt', name: ENUM_PROMPT.name },
    argument: { name: ENUM_ARGUMENT.name, value: first.slice(0, 1) },
  });
  assert.ok(filtered.values.includes(first));
  assert.ok(filtered.values.every((value) => value.toLowerCase().includes(first.slice(0, 1).toLowerCase())));
});

test('prompt 自由文本参数：空候选 + freeForm 标记（不是错误）', () => {
  const freeArgument = FREE_PROMPT.arguments.find((argument) => !Array.isArray(argument.enum));
  const result = completePromptArgument({
    ref: { type: 'ref/prompt', name: FREE_PROMPT.name },
    argument: { name: freeArgument.name, value: 'anything' },
  });
  assert.deepEqual(result.values, []);
  assert.equal(result.total, 0);
  assert.equal(result.freeForm, true);
  assert.equal(result.matchKind, 'none');
  assert.equal(typeof result.hint, 'string');
});

test('prompt 补全：未知 prompt/参数抛 E_NOT_FOUND / E_ARG_UNEXPECTED', () => {
  assert.throws(
    () => completePromptArgument({ ref: { type: 'ref/prompt', name: 'nope_prompt' }, argument: { name: 'x' } }),
    (error) => error.code === COMPLETION_ERRORS.NOT_FOUND,
  );
  assert.throws(
    () => completePromptArgument({ ref: { type: 'ref/prompt', name: ENUM_PROMPT.name }, argument: { name: 'not_declared' } }),
    (error) => error.code === COMPLETION_ERRORS.UNKNOWN_ARG,
  );
});

test('资源模板补全：技能参考名 / 会话 id / 未知模板', () => {
  const skill = completeResourceArgument({
    ref: { type: 'ref/resource', uri: 'bridge://skill/references/{name}' },
    argument: { name: 'name', value: 'env' },
    catalog: { skillReferences: ['environment.md', 'debug.md'] },
  });
  assert.deepEqual(skill.values, ['environment.md']);
  assert.equal(skill.source, 'skill-references');

  const sessions = completeResourceArgument({
    ref: { type: 'ref/resource', uri: 'bridge://observation/{session}' },
    argument: { name: 'session', value: '' },
    catalog: { sessions: ['s2', 's1'] },
  });
  assert.deepEqual(sessions.values, ['s1', 's2']);
  assert.equal(sessions.source, 'sessions');

  const noSessions = completeResourceArgument({
    ref: { type: 'ref/resource', uri: 'bridge://debug/journal/{session}' },
    argument: { name: 'session', value: '' },
    catalog: {},
  });
  assert.deepEqual(noSessions.values, []);
  assert.match(noSessions.hint, /session_start/);

  assert.throws(
    () => completeResourceArgument({ ref: { type: 'ref/resource', uri: 'bridge://mystery/{x}' }, argument: { name: 'x' } }),
    (error) => error.code === COMPLETION_ERRORS.NOT_FOUND,
  );
  assert.throws(
    () => completeResourceArgument({ ref: { type: 'ref/resource', uri: 'bridge://observation/{session}' }, argument: { name: 'wrong' } }),
    (error) => error.code === COMPLETION_ERRORS.UNKNOWN_ARG,
  );
  assert.equal(COMPLETION_TEMPLATES.length, 4);
});

test('complete 主入口：应答结构、total/hasMore、_meta 说明', () => {
  const response = complete({
    ref: { type: 'ref/prompt', name: ENUM_PROMPT.name },
    argument: { name: ENUM_ARGUMENT.name, value: '' },
  });
  assert.ok(Array.isArray(response.completion.values));
  assert.equal(response.completion.total, ENUM_ARGUMENT.enum.length);
  assert.equal(response.completion.hasMore, false);
  const meta = response._meta['browser-bridge/completion'];
  assert.equal(meta.refType, 'ref/prompt');
  assert.equal(meta.prompt, ENUM_PROMPT.name);
  assert.equal(meta.argument, ENUM_ARGUMENT.name);
  assert.equal(meta.candidates, ENUM_ARGUMENT.enum.length);
  assert.equal(meta.maxValues, COMPLETION_LIMITS.maxValues);
  assert.equal('nextCursor' in response, false);

  const resource = complete({
    ref: { type: 'ref/resource', uri: 'bridge://skill/references/{name}' },
    argument: { name: 'name', value: '' },
  }, { catalog: { skillReferences: ['a.md', 'b.md'] } });
  assert.equal(resource._meta['browser-bridge/completion'].uriTemplate, 'bridge://skill/references/{name}');
  assert.deepEqual(resource.completion.values, ['a.md', 'b.md']);
});

test('100 值上限与游标续读：超出时给 nextCursor，按页取完不丢值', () => {
  const many = Array.from({ length: COMPLETION_LIMITS.maxValues + 25 }, (_, index) => 'ref-' + String(index).padStart(3, '0'));
  assert.equal(COMPLETION_LIMITS.maxValues, 100);
  const first = paginateCompletionValues(many);
  assert.equal(first.page.length, COMPLETION_LIMITS.maxValues);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const second = paginateCompletionValues(many, { cursor: first.nextCursor });
  assert.equal(second.page.length, 25);
  assert.equal(second.hasMore, false);
  assert.equal(new Set([...first.page, ...second.page]).size, many.length);
  assert.throws(() => paginateCompletionValues(many, { cursor: 'bad-cursor' }), (error) => error.code === 'E_BAD_ARG');

  const overLimit = paginateCompletionValues(['x'], { limit: 9999 });
  assert.equal(overLimit.limit, COMPLETION_LIMITS.maxValues);
});

test('auditCompletions：所有 prompt/模板自洽且 strict 不抛错', () => {
  const report = auditCompletions();
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.prompts, PROMPT_DEFINITIONS.length);
  assert.equal(report.templates, COMPLETION_TEMPLATES.length);
  assert.ok(report.enumArguments >= 1);
});

test('completionSnapshot / isKnownPrompt', () => {
  const snapshot = completionSnapshot({ skillReferences: ['a.md'], sessions: ['s1'] });
  assert.equal(snapshot.supported, true);
  assert.deepEqual([...snapshot.refTypes], [...COMPLETION_REF_TYPES]);
  assert.equal(snapshot.catalog.skillReferences, 1);
  assert.equal(snapshot.catalog.sessions, 1);
  assert.equal(snapshot.freeFormReturnsEmpty, true);
  assert.equal(snapshot.limits.maxValues, 100);
  assert.equal(isKnownPrompt(ENUM_PROMPT.name), true);
  assert.equal(isKnownPrompt('nope'), false);
  assert.equal(isKnownPrompt(null), false);
});
