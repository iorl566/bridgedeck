// tests/content.test.ts —— 内容脚本页面侧会话（fake DOM，无 jsdom 依赖）。
//
// 覆盖 M-C 第二批内容脚本最小桥的真实行为：
// observe 的可见性/角色/ref 分配、click 的 elementFromPoint 校验与证据、
// fill 的原生 setter 路径 + input/change + 读回、read/select/get-html/evaluate、
// ref/documentId/expectRevision 三层失效，以及内容脚本消息契约的畸形输入。

import test from 'node:test';
import assert from 'node:assert/strict';
import { ContentSession, failureOf, newDocumentId } from '../src/content/session.ts';
import {
  normalizeContentReply,
  parseContentRequest,
  makeContentRequest,
  type ContentRequest,
} from '../src/content/protocol.ts';
import { PageError, accessibleNameOf, classifyHit, isHiddenByStyle, jsonSafe, normalizeText, roleOfElement, setNativeValue } from '../src/content/dom.ts';
import { createFakeDom, fixtureElements } from './support/fake-dom.ts';

function makeSession(options: { documentId?: string } = {}): { session: ContentSession; dom: ReturnType<typeof createFakeDom> } {
  const dom = createFakeDom(fixtureElements());
  const session = new ContentSession(dom.env, { protocol: '1.9', documentId: options.documentId ?? 'doc-test' });
  return { session, dom };
}

function request(op: string, params: Record<string, unknown> = {}): ContentRequest {
  return makeContentRequest(op as never, params, 'req-1');
}

interface ObserveResultLike {
  observation: string;
  refs: number;
  revision: number;
  documentId: string;
  url: string;
  title: string;
  nodes: Array<{ ref: string; role: string | null; name: string | null; tag: string; id: string | null }>;
  filtered: number;
}

function observe(session: ContentSession, params: Record<string, unknown> = {}): ObserveResultLike {
  const reply = session.handle(request('observe', params));
  assert.equal(reply.ok, true, 'observe 应成功：' + JSON.stringify(reply));
  return reply.ok ? (reply.result as ObserveResultLike) : ({} as ObserveResultLike);
}

test('observe：语义行带 role/name/@eN，隐藏节点被过滤', () => {
  const { session, dom } = makeSession();
  const result = observe(session);

  assert.equal(result.documentId, 'doc-test');
  assert.equal(result.revision, 1);
  assert.equal(result.url, 'https://example.test/');
  assert.match(result.observation, /- heading "E2E 夹具页"/);
  assert.match(result.observation, /- textbox "搜索关键词" \[@e1\]/);
  assert.match(result.observation, /- combobox "类型" \[@e2\]/);
  assert.match(result.observation, /- checkbox "同意条款" \[@e3\]/);
  assert.match(result.observation, /- button "提交查询" \[@e4\]/);
  assert.ok(!result.observation.includes('默认不可见的文本'), 'display:none 的文本不应输出');
  assert.equal(result.refs, 4);
  assert.deepEqual(session.refHandles(), ['@e1', '@e2', '@e3', '@e4']);

  const roles = result.nodes.map((node) => node.role);
  assert.deepEqual(roles, ['textbox', 'combobox', 'checkbox', 'button']);
  assert.equal(dom.byId.get('kw')?.isConnected, true);
});

test('observe：第二次观察推进 revision 并重建 ref 表（同一元素仍是同一句柄）', () => {
  const { session } = makeSession();
  const first = observe(session);
  const second = observe(session);
  assert.equal(second.revision, 2);
  assert.equal(first.revision + 1, second.revision);
  assert.deepEqual(session.refHandles(), ['@e1', '@e2', '@e3', '@e4']);
});

test('observe：aria-hidden / 零尺寸节点不进观察', () => {
  const dom = createFakeDom([
    { tag: 'div', text: 'aria hidden', attrs: { 'aria-hidden': 'true' }, rect: { left: 0, top: 0, width: 100, height: 20 } },
    { tag: 'button', id: 'zero', text: '零尺寸', rect: { left: 0, top: 0, width: 0, height: 0 } },
    { tag: 'button', id: 'ok', text: '可见按钮', rect: { left: 0, top: 30, width: 100, height: 20 } },
  ]);
  const session = new ContentSession(dom.env, { protocol: '1.9', documentId: 'doc' });
  const result = observe(session);
  assert.ok(!result.observation.includes('aria hidden'));
  assert.ok(!result.observation.includes('零尺寸'));
  assert.match(result.observation, /- button "可见按钮"/);
  assert.equal(result.refs, 1);
});

test('click：ref 命中 → 命中校验 → 合成 click 证据（trusted:false）', async () => {
  const { session, dom } = makeSession();
  const observed = observe(session);
  const buttonRef = observed.nodes.find((node) => node.role === 'button')?.ref;
  assert.ok(buttonRef);

  const reply = await session.handle(request('click', { ref: buttonRef }));
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const result = reply.ok ? (reply.result as Record<string, unknown>) : {};
  assert.equal(result.ok, true);
  assert.equal(result.via, 'content-script');
  assert.equal(result.trusted, false);
  assert.equal(result.synthetic, true);
  assert.equal(result.tag, 'button');
  assert.equal(result.hit, 'self');
  assert.equal(typeof result.x, 'number');
  assert.equal(dom.byId.get('submit-btn')?.clicked, 1);
  assert.equal(dom.byId.get('submit-btn')?.focused, 1);
  assert.equal(dom.byId.get('submit-btn')?.scrolled, 1);
});

test('click：命中被别人遮挡 → E_NOT_ACTIONABLE（force 才放行）', async () => {
  const { session, dom } = makeSession();
  const observed = observe(session);
  const buttonRef = observed.nodes.find((node) => node.role === 'button')?.ref;
  assert.ok(buttonRef);
  const overlay = dom.allElements().find((element) => element.id === 'out');
  assert.ok(overlay);
  dom.document.hitTest = () => overlay;

  const blocked = await session.handle(request('click', { ref: buttonRef }));
  assert.equal(blocked.ok, false);
  if (!blocked.ok) {
    assert.equal(blocked.code, 'E_NOT_ACTIONABLE');
    assert.equal((blocked.data as { reason?: string }).reason, 'obstructed');
  }
  assert.equal(dom.byId.get('submit-btn')?.clicked, 0);

  const forced = await session.handle(request('click', { ref: buttonRef, force: true }));
  assert.equal(forced.ok, true);
  assert.equal(dom.byId.get('submit-btn')?.clicked, 1);
});

test('click：selector 路径、文本路径、未知 ref 与已断开元素', async () => {
  const { session, dom } = makeSession();
  const bySelector = await session.handle(request('click', { selector: '#submit-btn' }));
  assert.equal(bySelector.ok, true, JSON.stringify(bySelector));

  const byText = await session.handle(request('click', { text: '提交查询' }));
  assert.equal(byText.ok, true, JSON.stringify(byText));

  const unknownRef = await session.handle(request('click', { ref: '@e99' }));
  assert.equal(unknownRef.ok, false);
  if (!unknownRef.ok) assert.equal(unknownRef.code, 'E_STALE_REF');

  const observed = observe(session);
  const ref = observed.nodes[0]?.ref;
  assert.ok(ref);
  const textbox = dom.byId.get('kw');
  assert.ok(textbox);
  textbox.isConnected = false;
  const detached = await session.handle(request('click', { ref }));
  assert.equal(detached.ok, false);
  if (!detached.ok) {
    assert.equal(detached.code, 'E_STALE_REF');
    assert.match(detached.message, /已不在文档里/);
  }

  const missingSelector = await session.handle(request('click', { selector: '#nope' }));
  assert.equal(missingSelector.ok, false);
  if (!missingSelector.ok) assert.equal(missingSelector.code, 'E_NOT_FOUND');

  const badSelector = await session.handle(request('click', { selector: '###' }));
  assert.equal(badSelector.ok, false, '非法 selector 不应命中元素');
});

test('click：documentId / expectRevision 不一致 → E_STALE_REF', async () => {
  const { session } = makeSession();
  const observed = observe(session);
  const ref = observed.nodes[0]?.ref;
  assert.ok(ref);

  const wrongDocument = await session.handle(request('click', { ref, documentId: 'doc-other' }));
  assert.equal(wrongDocument.ok, false);
  if (!wrongDocument.ok) assert.equal(wrongDocument.code, 'E_STALE_REF');

  const wrongRevision = await session.handle(request('click', { ref, expectRevision: observed.revision + 1 }));
  assert.equal(wrongRevision.ok, false);
  if (!wrongRevision.ok) {
    assert.equal(wrongRevision.code, 'E_STALE_REF');
    assert.match(wrongRevision.message, /expectRevision/);
  }

  const rightRevision = await session.handle(request('click', { ref, expectRevision: observed.revision }));
  assert.equal(rightRevision.ok, true, JSON.stringify(rightRevision));
});

test('fill：setValue + input/change + 读回校验；noClear 追加', () => {
  const { session, dom } = makeSession();
  const observed = observe(session);
  const textboxRef = observed.nodes.find((node) => node.role === 'textbox')?.ref;
  assert.ok(textboxRef);

  const reply = session.handle(request('fill', { ref: textboxRef, value: 'hello bridge' }));
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const result = reply.ok ? (reply.result as Record<string, unknown>) : {};
  assert.equal(result.expected_value, 'hello bridge');
  assert.equal(result.actual_value, 'hello bridge');
  assert.equal(result.matches, true);
  assert.equal(result.cleared, true);
  assert.equal(result.via, 'content-script');
  assert.deepEqual(dom.events.map((event) => event.type), ['input', 'change']);
  assert.equal(dom.setValues[0]?.value, 'hello bridge');

  const append = session.handle(request('fill', { selector: '#kw', value: '!', noClear: true }));
  assert.equal(append.ok, true);
  const appended = append.ok ? (append.result as Record<string, unknown>) : {};
  assert.equal(appended.expected_value, 'hello bridge!');
  assert.equal(appended.cleared, false);
});

test('fill：非输入元素/禁用/只读 → E_NOT_ACTIONABLE；缺 value → E_BAD_ARG', () => {
  const { session, dom } = makeSession();
  const observeReply = observe(session);
  const checkbox = observeReply.nodes.find((node) => node.role === 'checkbox')?.ref;
  const button = observeReply.nodes.find((node) => node.role === 'button')?.ref;
  assert.ok(checkbox && button);

  const onButton = session.handle(request('fill', { ref: button, value: 'x' }));
  assert.equal(onButton.ok, false);
  if (!onButton.ok) assert.equal(onButton.code, 'E_NOT_ACTIONABLE');

  const kw = dom.byId.get('kw');
  assert.ok(kw);
  kw.disabled = true;
  const disabled = session.handle(request('fill', { ref: checkbox, value: 'x' }));
  // checkbox 不是可填写元素，先命中 not-editable；再验 disabled 输入框。
  assert.equal(disabled.ok, false);
  const disabledInput = session.handle(request('fill', { selector: '#kw', value: 'x' }));
  assert.equal(disabledInput.ok, false);
  if (!disabledInput.ok) assert.equal(disabledInput.code, 'E_NOT_ACTIONABLE');

  kw.disabled = false;
  kw.attrs.set('readonly', '');
  const readonly = session.handle(request('fill', { selector: '#kw', value: 'x' }));
  assert.equal(readonly.ok, false);
  if (!readonly.ok) assert.equal(readonly.code, 'E_NOT_ACTIONABLE');

  const missingValue = session.handle(request('fill', { selector: '#kw' }));
  assert.equal(missingValue.ok, false);
});

test('read：单目标字段与 --all 枚举（含 select 当前值）', () => {
  const { session, dom } = makeSession();
  observe(session);
  session.handle(request('fill', { selector: '#kw', value: 'read-me' }));
  session.handle(request('select', { selector: '#kind', value: 'b' }));

  const single = session.handle(request('read', { selector: '#kw' }));
  assert.equal(single.ok, true, JSON.stringify(single));
  const singleResult = single.ok ? (single.result as { fields: Array<Record<string, unknown>>; count: number }) : { fields: [], count: 0 };
  assert.equal(singleResult.count, 1);
  assert.equal(singleResult.fields[0]?.value, 'read-me');
  assert.equal(singleResult.fields[0]?.tag, 'input');
  assert.equal(singleResult.fields[0]?.checked, null);

  const all = session.handle(request('read', { all: true }));
  assert.equal(all.ok, true, JSON.stringify(all));
  const allResult = all.ok ? (all.result as { fields: Array<Record<string, unknown>> }) : { fields: [] };
  assert.ok(allResult.fields.length >= 3, '应枚举到 input/select/checkbox：' + JSON.stringify(allResult.fields));
  const select = allResult.fields.find((field) => field.tag === 'select');
  assert.ok(select);
  assert.equal(select.value, 'b');
  const checkbox = allResult.fields.find((field) => field.tag === 'input' && field.type === 'checkbox');
  assert.ok(checkbox);
  assert.equal(checkbox.checked, false);

  const noTarget = session.handle(request('read', {}));
  assert.equal(noTarget.ok, false);
  if (!noTarget.ok) assert.equal(noTarget.code, 'E_BAD_ARG');
  assert.equal(dom.byId.get('kw')?.value, 'read-me');
});

test('select：按 value 匹配成功；不存在的选项 → E_OPTION_NOT_FOUND（带 available）', () => {
  const { session, dom } = makeSession();
  observe(session);
  const ok = session.handle(request('select', { selector: '#kind', value: 'b' }));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(dom.byId.get('kind')?.value, 'b');
  assert.deepEqual(dom.events.map((event) => event.type), ['input', 'change']);

  const notFound = session.handle(request('select', { selector: '#kind', value: 'zzz' }));
  assert.equal(notFound.ok, false);
  if (!notFound.ok) {
    assert.equal(notFound.code, 'E_OPTION_NOT_FOUND');
    assert.deepEqual((notFound.data as { available?: string[] }).available, ['a', 'b']);
  }

  const wrongTag = session.handle(request('select', { selector: '#kw', value: 'a' }));
  assert.equal(wrongTag.ok, false);
  if (!wrongTag.ok) assert.equal(wrongTag.code, 'E_NOT_ACTIONABLE');
});

test('get-html / evaluate / ping', () => {
  const { session, dom } = makeSession();
  const out = dom.byId.get('out');
  assert.ok(out);
  out.innerHTML = '<b>clicked:hello bridge</b>';
  const html = session.handle(request('get-html', { selector: '#out' }));
  assert.equal(html.ok, true);
  const htmlResult = html.ok ? (html.result as { html: string }) : { html: '' };
  assert.equal(htmlResult.html, '<b>clicked:hello bridge</b>');

  const evaluated = session.handle(request('evaluate', { expression: '1 + 1' }));
  assert.equal(evaluated.ok, true, JSON.stringify(evaluated));
  const evalResult = evaluated.ok ? (evaluated.result as { value: unknown; world: string }) : { value: null, world: '' };
  assert.equal(evalResult.value, 2);
  assert.equal(evalResult.world, 'content-script');

  const badEval = session.handle(request('evaluate', { expression: 'throw new Error("boom")' }));
  assert.equal(badEval.ok, false);
  if (!badEval.ok) assert.equal(badEval.code, 'E_EVAL_FAILED');

  const emptyEval = session.handle(request('evaluate', {}));
  assert.equal(emptyEval.ok, false);
  if (!emptyEval.ok) assert.equal(emptyEval.code, 'E_BAD_ARG');

  const ping = session.handle(request('ping'));
  assert.equal(ping.ok, true);
  const pingResult = ping.ok ? (ping.result as Record<string, unknown>) : {};
  assert.equal(pingResult.runtime, 'ts');
  assert.equal(pingResult.documentId, 'doc-test');
  assert.equal(pingResult.url, 'https://example.test/');
});

test('内容脚本消息契约：畸形请求被拒绝且不拖垮会话', () => {
  assert.equal(parseContentRequest(null).ok, false);
  const unknownOp = parseContentRequest({ type: 'bb.content', requestId: 'r', op: 'screenshot' });
  assert.equal(unknownOp.ok, false);
  if (!unknownOp.ok) {
    assert.equal(unknownOp.error.code, 'E_UNKNOWN_OP');
    assert.equal(unknownOp.error.data && (unknownOp.error.data as { op: string }).op, 'screenshot');
  }
  const noId = parseContentRequest({ type: 'bb.content', op: 'observe' });
  assert.equal(noId.ok, false);
  if (!noId.ok) assert.equal(noId.error.code, 'E_BAD_REQUEST');

  assert.deepEqual(normalizeContentReply({ ok: true, result: { a: 1 } }), { ok: true, result: { a: 1 } });
  assert.deepEqual(normalizeContentReply({ ok: true }), { ok: true, result: null });
  const bad = normalizeContentReply({ ok: false, message: 'x' });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, 'E_BAD_RESPONSE');
  assert.equal(normalizeContentReply('nope').ok, false);

  const failure = failureOf(new PageError('E_STALE_REF', 'ref 过期', { ref: '@e1' }));
  assert.deepEqual(failure, { ok: false, code: 'E_STALE_REF', message: 'ref 过期', data: { ref: '@e1' } });
  assert.equal(failureOf(new Error('boom')).code, 'E_INTERNAL');
});

test('DOM 纯函数：可见性/角色/名称/命中分类/JSON 安全', () => {
  const dom = createFakeDom(fixtureElements());
  assert.equal(isHiddenByStyle({ display: 'none' }), true);
  assert.equal(isHiddenByStyle({ visibility: 'hidden' }), true);
  assert.equal(isHiddenByStyle({ opacity: '0' }), true);
  assert.equal(isHiddenByStyle({ display: 'block', opacity: '1' }), false);

  const kw = dom.byId.get('kw');
  assert.ok(kw);
  assert.equal(roleOfElement(kw), 'textbox');
  assert.equal(accessibleNameOf(kw), '搜索关键词');
  const button = dom.byId.get('submit-btn');
  assert.ok(button);
  assert.equal(roleOfElement(button), 'button');
  assert.equal(accessibleNameOf(button), '提交查询');

  assert.equal(classifyHit(button, button), 'self');
  assert.equal(classifyHit(button, null), 'obstructed');
  const span = dom.document.createElement?.('span');
  assert.ok(span);
  assert.equal(normalizeText('  a \n b  '), 'a b');

  assert.deepEqual(jsonSafe({ a: 1, b: undefined, c: [1, 'x'] }), { a: 1, b: null, c: [1, 'x'] });
  assert.equal(jsonSafe(10n), '10');
  assert.equal(jsonSafe(() => 1), null);

  const disconnected = dom.document.createElement?.('input');
  assert.ok(disconnected);
  assert.equal((disconnected as { value?: string }).value, undefined);
  setNativeValue(disconnected, 'v');
  assert.equal((disconnected as { value?: string }).value, 'v');
});

test('newDocumentId：同实例稳定、格式可读；不同输入不同', () => {
  let time = 1_000;
  let random = 0.5;
  const first = newDocumentId(() => time, () => random);
  const second = newDocumentId(() => time, () => random);
  assert.equal(first, second);
  assert.match(first, /^doc-[0-9a-z]+-[0-9a-z]+$/);
  random = 0.25;
  assert.notEqual(first, newDocumentId(() => time, () => random));
});
