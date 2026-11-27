// tests/unit/mcp-wire.test.mjs —— MCP stdio JSON-RPC 信封层的协议边界测试。
//
// 覆盖：标准错误码表、parseWireLine（空行/语法错误/超长行）、decodeWireLine 的
// 请求/通知/响应/非法分类（batch 拒绝、id 形状、method/params 校验、jsonrpc 版本）、
// 通知方法白名单、requestIdKey 的 string/number 区分、协议版本协商、协议码→JSON-RPC
// 码映射、errorFromException、responseMode、wireSnapshot、auditWireTables。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PROTOCOL_VERSION,
  JSONRPC_ERRORS,
  JSONRPC_ERROR_NAMES,
  JSONRPC_VERSION,
  NOTIFICATION_METHODS,
  PROTOCOL_TO_JSONRPC,
  SUPPORTED_PROTOCOL_VERSIONS,
  WIRE_LIMITS,
  WIRE_METHODS,
  WireError,
  assertWireTables,
  auditWireTables,
  classifyMessage,
  decodeWireLine,
  errorFromException,
  errorResponse,
  isNotificationMessage,
  isRequestMessage,
  isResponseMessage,
  isValidId,
  jsonRpcCodeFor,
  negotiateProtocolVersion,
  notification,
  normalizeId,
  parseWireLine,
  requestIdKey,
  responseMode,
  resultResponse,
  serializeMessage,
  wireSnapshot,
} from '../../mcp/wire.mjs';

test('标准 JSON-RPC 错误码取值与名称表', () => {
  assert.equal(JSONRPC_VERSION, '2.0');
  assert.equal(JSONRPC_ERRORS.PARSE_ERROR, -32700);
  assert.equal(JSONRPC_ERRORS.INVALID_REQUEST, -32600);
  assert.equal(JSONRPC_ERRORS.METHOD_NOT_FOUND, -32601);
  assert.equal(JSONRPC_ERRORS.INVALID_PARAMS, -32602);
  assert.equal(JSONRPC_ERRORS.INTERNAL_ERROR, -32603);
  assert.equal(JSONRPC_ERRORS.RESOURCE_NOT_FOUND, -32002);
  assert.equal(JSONRPC_ERROR_NAMES[-32700], 'PARSE_ERROR');
  assert.equal(JSONRPC_ERROR_NAMES[-32602], 'INVALID_PARAMS');
  assert.equal(JSONRPC_ERROR_NAMES[-32002], 'RESOURCE_NOT_FOUND');
});

test('parseWireLine：正常对象 / 空行 / 语法错误', () => {
  const ok = parseWireLine('{"jsonrpc":"2.0","id":1,"method":"ping"}');
  assert.equal(ok.ok, true);
  assert.equal(ok.message.method, 'ping');

  const empty = parseWireLine('   ');
  assert.equal(empty.ok, false);
  assert.equal(empty.error.rpcCode, JSONRPC_ERRORS.PARSE_ERROR);

  const broken = parseWireLine('{"jsonrpc":');
  assert.equal(broken.ok, false);
  assert.equal(broken.error.rpcCode, JSONRPC_ERRORS.PARSE_ERROR);
  assert.match(broken.error.message, /Parse error/);
});

test('parseWireLine：超过单行上限按 -32600 拒绝（不尝试 JSON.parse）', () => {
  const huge = '{"x":"' + 'a'.repeat(WIRE_LIMITS.maxLineBytes + 10) + '"}';
  const result = parseWireLine(huge);
  assert.equal(result.ok, false);
  assert.equal(result.error.rpcCode, JSONRPC_ERRORS.INVALID_REQUEST);
  assert.match(result.error.message, new RegExp(String(WIRE_LIMITS.maxLineBytes)));
});

test('decodeWireLine：请求 / 通知 / 响应 / 非法四类', () => {
  const request = decodeWireLine('{"jsonrpc":"2.0","id":"abc","method":"tools/list","params":{}}');
  assert.equal(request.ok, true);
  assert.equal(request.kind, 'request');
  assert.equal(request.id, 'abc');
  assert.equal(request.method, 'tools/list');

  const notification = decodeWireLine('{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":3}}');
  assert.equal(notification.ok, true);
  assert.equal(notification.kind, 'notification');
  assert.equal(notification.id, null);

  const response = decodeWireLine('{"jsonrpc":"2.0","id":9,"result":{}}');
  assert.equal(response.ok, true);
  assert.equal(response.kind, 'response');

  const invalid = decodeWireLine('[{"jsonrpc":"2.0","id":1,"method":"ping"}]');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.rpcCode, JSONRPC_ERRORS.INVALID_REQUEST);
  assert.match(invalid.error.message, /batch/);
});

test('classifyMessage：非法信封的每一种形态', () => {
  const notObject = classifyMessage('hello');
  assert.equal(notObject.kind, 'invalid');
  assert.equal(notObject.error.code, 'WIRE_NOT_OBJECT');

  const badId = classifyMessage({ jsonrpc: '2.0', id: { nested: 1 }, method: 'ping' });
  assert.equal(badId.kind, 'invalid');
  assert.equal(badId.error.code, 'WIRE_BAD_ID');

  const boolId = classifyMessage({ jsonrpc: '2.0', id: true, method: 'ping' });
  assert.equal(boolId.kind, 'invalid');
  assert.equal(boolId.error.code, 'WIRE_BAD_ID');

  const noMethod = classifyMessage({ jsonrpc: '2.0', id: 1 });
  assert.equal(noMethod.kind, 'invalid');
  assert.equal(noMethod.error.code, 'WIRE_NO_METHOD');
  assert.equal(noMethod.error.id, 1);

  const badVersion = classifyMessage({ jsonrpc: '1.0', id: 1, method: 'ping' });
  assert.equal(badVersion.kind, 'invalid');
  assert.equal(badVersion.error.code, 'WIRE_BAD_VERSION');

  const badParams = classifyMessage({ jsonrpc: '2.0', id: 1, method: 'ping', params: [1, 2] });
  assert.equal(badParams.kind, 'invalid');
  assert.equal(badParams.error.code, 'WIRE_BAD_PARAMS');
  assert.equal(badParams.error.rpcCode, JSONRPC_ERRORS.INVALID_PARAMS);
});

test('classifyMessage：响应被识别为噪声而不是非法请求', () => {
  const withResult = classifyMessage({ jsonrpc: '2.0', id: 5, result: {} });
  assert.equal(withResult.kind, 'response');
  assert.match(withResult.note, /忽略/);
  const withError = classifyMessage({ jsonrpc: '2.0', id: 5, error: { code: -32603, message: 'x' } });
  assert.equal(withError.kind, 'response');
});

test('通知方法白名单：即使带 id 也按通知处理（不回响应）', () => {
  for (const method of NOTIFICATION_METHODS) {
    const classified = classifyMessage({ jsonrpc: '2.0', id: 7, method });
    assert.equal(classified.kind, 'notification', method);
    assert.equal(classified.id, null, method);
    assert.equal(responseMode(classified), 'silent');
  }
  assert.ok(WIRE_METHODS.includes('notifications/cancelled'));
  assert.ok(WIRE_METHODS.includes('notifications/initialized'));
});

test('isRequestMessage / isNotificationMessage / isResponseMessage 互斥', () => {
  const request = { id: 1, method: 'ping' };
  const notify = { method: 'ping' };
  const response = { id: 1, result: {} };
  assert.equal(isRequestMessage(request), true);
  assert.equal(isNotificationMessage(request), false);
  assert.equal(isNotificationMessage(notify), true);
  assert.equal(isRequestMessage(notify), false);
  assert.equal(isResponseMessage(response), true);
  assert.equal(isResponseMessage(notify), false);
  assert.equal(isResponseMessage([1]), false);
});

test('id 校验与归一化：string/number/null 接受，其余拒绝', () => {
  assert.equal(isValidId(0), true);
  assert.equal(isValidId(-1.5), true);
  assert.equal(isValidId('x'), true);
  assert.equal(isValidId(null), true);
  assert.equal(isValidId(undefined), false);
  assert.equal(isValidId(true), false);
  assert.equal(isValidId({}), false);
  assert.equal(isValidId('x'.repeat(WIRE_LIMITS.maxIdLength + 1)), false);
  assert.equal(normalizeId(undefined), null);
  assert.equal(normalizeId(0), 0);
});

test('requestIdKey：字符串 "1" 与数字 1 是不同请求', () => {
  assert.notEqual(requestIdKey(1), requestIdKey('1'));
  assert.equal(requestIdKey(1), requestIdKey(1));
  assert.equal(requestIdKey(null), 'null');
  assert.equal(requestIdKey(undefined), 'null');
});

test('协议版本协商：支持表内原样回，未知版本回默认并标记 fallback', () => {
  for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
    const negotiated = negotiateProtocolVersion(version);
    assert.equal(negotiated.version, version);
    assert.equal(negotiated.supported, true);
    assert.equal(negotiated.fallback, false);
    assert.equal(negotiated.reason, 'requested-version-supported');
  }
  const unknown = negotiateProtocolVersion('1999-01-01');
  assert.equal(unknown.version, DEFAULT_PROTOCOL_VERSION);
  assert.equal(unknown.supported, false);
  assert.equal(unknown.fallback, true);
  assert.equal(unknown.reason, 'requested-version-unsupported');

  const omitted = negotiateProtocolVersion(undefined);
  assert.equal(omitted.version, DEFAULT_PROTOCOL_VERSION);
  assert.equal(omitted.fallback, false);
  assert.equal(omitted.reason, 'client-omitted-version');

  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes(DEFAULT_PROTOCOL_VERSION));
  assert.ok(SUPPORTED_PROTOCOL_VERSIONS.includes('2024-11-05'));
});

test('协议错误码 → JSON-RPC 码：参数类 -32602、资源类 -32002、方法类 -32601、其余 -32603', () => {
  assert.equal(jsonRpcCodeFor('E_BAD_ARG'), -32602);
  assert.equal(jsonRpcCodeFor('E_ARG_MISSING'), -32602);
  assert.equal(jsonRpcCodeFor('E_ARG_UNEXPECTED'), -32602);
  assert.equal(jsonRpcCodeFor('E_NOT_FOUND'), -32002);
  assert.equal(jsonRpcCodeFor('E_STALE_REF'), -32002);
  assert.equal(jsonRpcCodeFor('E_UNKNOWN_METHOD'), -32601);
  assert.equal(jsonRpcCodeFor('E_UNSUPPORTED_CAPABILITY'), -32601);
  assert.equal(jsonRpcCodeFor('E_SESSION_STOPPED'), -32603);
  assert.equal(jsonRpcCodeFor('E_TOTALLY_UNKNOWN'), -32603);
  assert.equal(jsonRpcCodeFor(undefined), -32603);
  assert.equal(Object.keys(PROTOCOL_TO_JSONRPC).length >= 15, true);
});

test('errorFromException：带 code 的异常映射，未知异常落 -32603/E_INTERNAL', () => {
  const coded = Object.assign(new Error('bad uri'), { code: 'E_BAD_ARG' });
  assert.deepEqual(errorFromException(coded), { rpcCode: -32602, code: 'E_BAD_ARG', message: 'bad uri' });
  const plain = errorFromException(new Error('boom'));
  assert.deepEqual(plain, { rpcCode: -32603, code: 'E_INTERNAL', message: 'boom' });
  const custom = errorFromException({ code: 'E_NOT_FOUND', message: 'missing' }, { fallbackCode: 'E_X' });
  assert.equal(custom.rpcCode, -32002);
});

test('WireError 携带 code/rpcCode/data', () => {
  const error = new WireError('E_BAD_ARG', 'nope', { path: 'uri' }, { rpcCode: -32602 });
  assert.equal(error.name, 'WireError');
  assert.equal(error.code, 'E_BAD_ARG');
  assert.equal(error.rpcCode, -32602);
  assert.deepEqual(error.data, { path: 'uri' });
});

test('响应构造：success/error/notification 序列化后是一行合法 JSON', () => {
  const okMessage = resultResponse(3, { tools: [] });
  assert.equal(okMessage.jsonrpc, '2.0');
  assert.deepEqual(okMessage.result, { tools: [] });
  const error = errorResponse(4, -32602, 'bad', { field: 'x' });
  assert.equal(error.error.code, -32602);
  assert.deepEqual(error.error.data, { field: 'x' });
  assert.equal(errorResponse(null, -32700, 'parse').id, null);
  const notify = notification('notifications/progress', { progress: 1 });
  assert.equal(notify.id, undefined);
  for (const message of [okMessage, error, notify]) {
    const line = serializeMessage(message);
    assert.ok(line.endsWith('\n'));
    assert.equal(JSON.parse(line.trim()).jsonrpc, '2.0');
  }
});

test('wireSnapshot 声明 batch=false 与支持版本/限制', () => {
  const snapshot = wireSnapshot();
  assert.equal(snapshot.jsonrpc, '2.0');
  assert.equal(snapshot.batch, false);
  assert.equal(snapshot.batchErrorCode, -32600);
  assert.deepEqual([...snapshot.protocolVersions], [...SUPPORTED_PROTOCOL_VERSIONS]);
  assert.equal(snapshot.defaultProtocolVersion, DEFAULT_PROTOCOL_VERSION);
  assert.equal(snapshot.limits.maxLineBytes, WIRE_LIMITS.maxLineBytes);
  assert.ok(snapshot.methods.includes('completion/complete'));
  assert.ok(snapshot.methods.includes('resources/templates/list'));
  const negotiated = wireSnapshot({ negotiated: negotiateProtocolVersion('2025-03-26') });
  assert.equal(negotiated.negotiated.version, '2025-03-26');
});

test('auditWireTables：映射表与版本表自洽，strict 包装不抛错', () => {
  const report = auditWireTables();
  assert.equal(report.ok, true);
  assert.equal(report.errors.length, 0);
  assert.ok(report.mapped >= 15);
  assert.doesNotThrow(() => assertWireTables());
});

test('responseMode：reply / silent / ignore / error 四种动作', () => {
  assert.equal(responseMode(classifyMessage({ id: 1, method: 'ping' })), 'reply');
  assert.equal(responseMode(classifyMessage({ method: 'notifications/initialized' })), 'silent');
  assert.equal(responseMode(classifyMessage({ id: 1, result: {} })), 'ignore');
  assert.equal(responseMode(classifyMessage([1, 2])), 'error');
  assert.equal(responseMode(null), 'error');
});
