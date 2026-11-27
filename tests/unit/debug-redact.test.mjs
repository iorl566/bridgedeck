// tests/unit/debug-redact.test.mjs —— 统一脱敏层（持久化前单点脱敏）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEBUG_REDACT_VERSION,
  REDACTED,
  createRedactor,
  isSecretKey,
  redactCookiesDeep,
  redactDeep,
  redactForPersistence,
  redactHeadersDeep,
  redactJournalEvent,
  redactText,
  scanForPlaintextSecrets,
} from '../../extension/src/lib/debug-redact.js';

function assertNoPlaintext(value, secrets) {
  const text = JSON.stringify(value);
  const scan = scanForPlaintextSecrets(text, secrets);
  assert.deepEqual(scan.leaked, []);
  assert.equal(scan.clean, true);
}

test('敏感键名判定覆盖英文/连字符/中文别名', () => {
  assert.equal(DEBUG_REDACT_VERSION, 1);
  for (const key of ['password', 'PASSWORD', 'passwd', 'pwd', 'passcode', 'token', 'access_token', 'refresh-token', 'secret', 'client_secret', 'api-key', 'apikey', 'authorization', 'cookie', 'set-cookie', 'sessionid', 'session_id', 'otp', 'csrf-token', 'x-xsrf-token', 'credential', '密码', '口令', '令牌', '密钥']) {
    assert.equal(isSecretKey(key), true, '应判定为敏感键：' + key);
  }
  for (const key of ['username', 'content-type', 'x-trace-id', 'status', 'method', 'url', 'name', 'sessionCount']) {
    assert.equal(isSecretKey(key), false, '不应判定为敏感键：' + key);
  }
});

test('redactHeadersDeep 对象/数组两种形态，保留非敏感头', () => {
  const objectForm = redactHeadersDeep({
    Authorization: 'Bearer HEADER_SECRET',
    Cookie: 'sid=COOKIE_SECRET',
    'Set-Cookie': 'sid=SET_SECRET',
    'X-Api-Key': 'API_KEY_SECRET',
    'Content-Type': 'application/json',
  });
  assert.equal(objectForm.Authorization, REDACTED);
  assert.equal(objectForm.Cookie, REDACTED);
  assert.equal(objectForm['Set-Cookie'], REDACTED);
  assert.equal(objectForm['X-Api-Key'], REDACTED);
  assert.equal(objectForm['Content-Type'], 'application/json');
  assertNoPlaintext(objectForm, ['HEADER_SECRET', 'COOKIE_SECRET', 'SET_SECRET', 'API_KEY_SECRET']);

  const arrayForm = redactHeadersDeep([
    { name: 'authorization', value: 'Bearer ARRAY_SECRET' },
    { name: 'x-csrf-token', value: 'CSRF_SECRET' },
    { name: 'x-trace', value: 'trace-ok' },
  ]);
  assert.equal(arrayForm[0].value, REDACTED);
  assert.equal(arrayForm[1].value, REDACTED);
  assert.equal(arrayForm[2].value, 'trace-ok');
  // 不修改入参
  const source = [{ name: 'authorization', value: 'Bearer KEEP' }];
  const copy = redactHeadersDeep(source);
  assert.equal(source[0].value, 'Bearer KEEP');
  assert.equal(copy[0].value, REDACTED);
});

test('redactCookiesDeep 不丢名字、值一律脱敏', () => {
  const array = redactCookiesDeep([
    { name: 'sid', value: 'COOKIE_VALUE_SECRET', domain: 'x.test', path: '/' },
    { name: 'theme', value: 'dark' },
  ]);
  assert.equal(array.length, 2);
  assert.equal(array[0].name, 'sid');
  assert.equal(array[0].value, REDACTED);
  assert.equal(array[0].domain, 'x.test');
  assert.equal(array[1].value, REDACTED);
  assertNoPlaintext(array, ['COOKIE_VALUE_SECRET', 'dark']);

  const object = redactCookiesDeep({ sid: 'OBJ_SECRET', theme: 'dark' });
  assert.equal(object.sid, REDACTED);
  assert.equal(object.theme, REDACTED);
});

test('redactDeep：URL 只替换敏感 query、正文递归、文本走凭据正则', () => {
  const out = redactDeep({
    url: 'https://x.test/login?token=URL_SECRET&page=2#hash',
    requestBody: JSON.stringify({ user: 'u', password: 'BODY_PASSWORD', nested: { refresh_token: 'BODY_TOKEN' } }),
    message: 'Authorization: Bearer TEXT_SECRET and token=TEXT_TOKEN',
    plain: 'nothing sensitive here',
    count: 3,
    ok: true,
    nothing: undefined,
    when: new Date('2026-01-01T00:00:00.000Z'),
  });
  assert.match(out.url, /page=2/);
  assert.match(out.url, /#hash/);
  assert.doesNotMatch(out.url, /URL_SECRET/);
  assert.equal(JSON.parse(out.requestBody).user, 'u');
  assert.equal(JSON.parse(out.requestBody).password, REDACTED);
  assert.equal(JSON.parse(out.requestBody).nested.refresh_token, REDACTED);
  assertNoPlaintext(out, ['URL_SECRET', 'BODY_PASSWORD', 'BODY_TOKEN', 'TEXT_SECRET', 'TEXT_TOKEN']);
  assert.equal(out.plain, 'nothing sensitive here');
  assert.equal(out.count, 3);
  assert.equal(out.ok, true);
  assert.equal('nothing' in out, false);
  assert.equal(out.when, '2026-01-01T00:00:00.000Z');
});

test('redactDeep：headers/cookies 容器保留结构，值被脱敏', () => {
  const out = redactDeep({
    headers: { authorization: 'Bearer H_SECRET', accept: '*/*' },
    responseHeaders: [{ name: 'set-cookie', value: 'sid=SET_COOKIE_SECRET' }],
    cookies: [{ name: 'sid', value: 'COOKIE_ARR_SECRET' }],
    body: 'password=BODY_SECRET&x=1',
  });
  assert.equal(out.headers.authorization, REDACTED);
  assert.equal(out.headers.accept, '*/*');
  assert.equal(out.responseHeaders[0].value, REDACTED);
  assert.equal(out.responseHeaders[0].name, 'set-cookie');
  assert.equal(out.cookies[0].name, 'sid');
  assert.equal(out.cookies[0].value, REDACTED);
  assert.match(out.body, /password=\[redacted\]/);
  assertNoPlaintext(out, ['H_SECRET', 'SET_COOKIE_SECRET', 'COOKIE_ARR_SECRET', 'BODY_SECRET']);
});

test('redactDeep：循环引用/深度/数组/字符串上限都可控', () => {
  const root = { name: 'root' };
  root.self = root;
  let deep = { j: 1 };
  for (let level = 0; level < 10; level += 1) deep = { child: deep };
  root.deep = deep;
  root.list = Array.from({ length: 5 }, (_, index) => index);
  root.long = 'x'.repeat(50);
  const out = redactDeep(root, { maxDepth: 4, maxArray: 3, maxString: 10 });
  assert.equal(out.self, '[circular]');
  assert.equal(out.deep.child.child.child.child, '[truncated depth]');
  const list = out.list;
  assert.equal(list.length, 4); // 3 项 + truncated 标记
  assert.match(String(list[3]), /truncated 2 items/);
  assert.match(out.long, /truncated/);

  // 函数/symbol 被丢弃，Map 等非普通对象转文本
  const weird = redactDeep({ fn() {}, sym: Symbol('x'), map: new Map([['k', 'v']]) });
  assert.equal('fn' in weird, false);
  assert.equal('sym' in weird, false);
  assert.equal(typeof weird.map, 'string');
});

test('redactJournalEvent 用于事件流：console 文本与 replay URL 都脱敏', () => {
  const event = {
    type: 'replay',
    at: 100,
    id: 3,
    method: 'POST',
    url: 'https://x.test/api?access_token=REPLAY_SECRET',
    error: 'request failed cookie=ERROR_COOKIE',
    headers: { Authorization: 'Bearer EVENT_SECRET' },
    cookies: [{ name: 'sid', value: 'EVENT_COOKIE' }],
    body: 'token=BODY_TOKEN&user=a',
  };
  const out = redactJournalEvent(event);
  assert.equal(out.type, 'replay');
  assert.equal(out.method, 'POST');
  assert.equal(out.id, 3);
  assertNoPlaintext(out, ['REPLAY_SECRET', 'ERROR_COOKIE', 'EVENT_SECRET', 'EVENT_COOKIE', 'BODY_TOKEN']);
  assert.match(out.url, /access_token=/);
});

test('redactText 处理 JSON 文档与普通表单文本', () => {
  const json = redactText(JSON.stringify({ password: 'P', token: { nested: 'N' } }));
  assert.deepEqual(JSON.parse(json), { password: REDACTED, token: REDACTED });
  assert.match(redactText('username=a&password=P&x=1'), /password=\[redacted\]/);
  assert.equal(redactText(''), '');
  assert.equal(redactText('plain text'), 'plain text');
});

test('redactForPersistence 放宽预算但依然脱敏', () => {
  const big = {
    password: 'PERSIST_SECRET',
    url: 'https://x.test/p?token=URL_SECRET',
    events: Array.from({ length: 50 }, (_, index) => ({ at: index, type: 'rule', token: 'TOKEN_' + index })),
    text: 'x'.repeat(20000),
  };
  const out = redactForPersistence(big);
  assert.equal(out.password, REDACTED);
  assertNoPlaintext(out, ['PERSIST_SECRET', 'URL_SECRET', 'TOKEN_0', 'TOKEN_49']);
  // 50 条事件不应被默认数组上限（200）截断
  assert.equal(out.events.length, 50);
  assert.match(out.text, /truncated \d+ chars/);
});

test('createRedactor 绑定参数可复用', () => {
  const redact = createRedactor({ maxString: 4 });
  const out = redact({ value: 'abcdefgh', password: 'P' });
  assert.equal(out.password, REDACTED);
  assert.match(out.value, /truncated/);
  assert.equal(createRedactor()({ token: 'T' }).token, REDACTED);
});

test('scanForPlaintextSecrets 能发现泄漏（负向自检）', () => {
  const clean = scanForPlaintextSecrets('{"a":"ok"}', ['LEAK']);
  assert.deepEqual(clean, { clean: true, leaked: [] });
  const dirty = scanForPlaintextSecrets('{"a":"LEAK","b":"LEAK2"}', ['LEAK', 'LEAK2', '']);
  assert.equal(dirty.clean, false);
  assert.deepEqual(dirty.leaked, ['LEAK', 'LEAK2']);
  // 空 secret 列表被忽略，不会误报
  assert.equal(scanForPlaintextSecrets('abc', ['']).clean, true);
});
