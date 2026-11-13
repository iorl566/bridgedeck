import test from 'node:test';
import assert from 'node:assert/strict';
import { describeScopes, matchSessionsByScope, resolveSessionByScope, sessionMatchesScope } from '../../lib/session-scope.mjs';

const sessions = [
  { sessionId: 'a1', controller: { name: 'Agent A', project: 'proj-a' } },
  { sessionId: 'b2', controller: { name: 'Agent B', project: 'proj-b' } },
  { sessionId: 'c3' },
];

test('按 sessionId / controller.name / controller.project 匹配', () => {
  assert.equal(sessionMatchesScope(sessions[0], 'a1'), true);
  assert.equal(sessionMatchesScope(sessions[0], 'Agent A'), true);
  assert.equal(sessionMatchesScope(sessions[0], 'proj-a'), true);
  assert.equal(sessionMatchesScope(sessions[0], 'proj-b'), false);
  assert.equal(sessionMatchesScope(sessions[2], 'c3'), true);
  assert.equal(sessionMatchesScope(sessions[2], 'whatever'), false);
  assert.equal(sessionMatchesScope(null, 'a1'), false);
  assert.equal(sessionMatchesScope(sessions[0], ''), false);
});

test('matchSessionsByScope 返回全部命中', () => {
  assert.deepEqual(matchSessionsByScope(sessions, 'Agent A').map((item) => item.sessionId), ['a1']);
  assert.deepEqual(matchSessionsByScope(sessions, 'nope'), []);
});

test('唯一命中时返回 session', () => {
  const resolved = resolveSessionByScope(sessions, 'proj-b');
  assert.equal(resolved.session.sessionId, 'b2');
  assert.equal(resolved.error, undefined);
});

test('空 scope 报 E_BAD_ARG', () => {
  assert.equal(resolveSessionByScope(sessions, '   ').error, 'E_BAD_ARG');
});

test('未命中报 E_NO_SESSION 并列出可用 scope', () => {
  const resolved = resolveSessionByScope(sessions, 'missing');
  assert.equal(resolved.error, 'E_NO_SESSION');
  assert.match(resolved.message, /没有匹配 scope/);
  assert.match(resolved.message, /a1\(Agent A\/proj-a\)/);
  assert.match(resolved.message, /c3/);
});

test('多个命中时提示用 --session 指定', () => {
  const duplicated = [
    ...sessions,
    { sessionId: 'd4', controller: { name: 'Agent D', project: 'proj-a' } },
  ];
  const resolved = resolveSessionByScope(duplicated, 'proj-a');
  assert.equal(resolved.error, 'E_NO_SESSION');
  assert.match(resolved.message, /匹配多个会话/);
  assert.match(resolved.message, /a1\(Agent A\/proj-a\)/);
  assert.match(resolved.message, /d4\(Agent D\/proj-a\)/);
});

test('describeScopes 包含 name/project 与空列表兜底', () => {
  assert.match(describeScopes(sessions), /a1\(Agent A\/proj-a\)/);
  assert.equal(describeScopes([]), '(无)');
});
