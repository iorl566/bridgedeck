// lib/session-scope.mjs —— 会话作用域解析（--session-scope / controller）。
//
// 解析顺序由调用方保证：--session 显式指定 > --session-scope > BB_SESSION > 单会话默认。
// 这里只负责“scope 字符串 → 唯一会话”，避免 CLI/daemon 各自实现一套匹配规则。

function normalizeScope(scope) {
  return String(scope == null ? '' : scope).trim();
}

/** 一个会话的 scope 身份：sessionId、controller.name、controller.project。 */
export function sessionMatchesScope(session, scope) {
  const wanted = normalizeScope(scope);
  if (!wanted || !session) return false;
  if (session.sessionId === wanted) return true;
  const controller = session.controller;
  if (!controller || typeof controller !== 'object') return false;
  return controller.name === wanted || controller.project === wanted;
}

export function matchSessionsByScope(sessions, scope) {
  const list = Array.isArray(sessions) ? sessions : [];
  return list.filter((session) => sessionMatchesScope(session, scope));
}

function describeScope(session) {
  const controller = session && session.controller ? session.controller : {};
  const labels = [controller.name, controller.project].filter(Boolean);
  return session.sessionId + (labels.length ? '(' + labels.join('/') + ')' : '');
}

export function describeScopes(sessions) {
  return (Array.isArray(sessions) ? sessions : []).map(describeScope).join(', ') || '(无)';
}

/**
 * @returns {{session: object} | {error: string, message: string}}
 */
export function resolveSessionByScope(sessions, scope) {
  const wanted = normalizeScope(scope);
  if (!wanted) {
    return { error: 'E_BAD_ARG', message: '--session-scope 不能为空' };
  }
  const matched = matchSessionsByScope(sessions, wanted);
  if (matched.length === 1) return { session: matched[0] };
  if (matched.length === 0) {
    return {
      error: 'E_NO_SESSION',
      message: '没有匹配 scope "' + wanted + '" 的会话；可用：' + describeScopes(sessions),
    };
  }
  return {
    error: 'E_NO_SESSION',
    message: 'scope "' + wanted + '" 匹配多个会话（' + matched.map(describeScope).join(', ') + '）；请用 --session 指定',
  };
}
