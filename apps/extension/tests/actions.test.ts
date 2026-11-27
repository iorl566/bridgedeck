// tests/actions.test.ts —— 动作入参归一 + 注册表全链路（stub 内容脚本）。
//
// 验证 M-C 第二批动作面的四件事：
// 1) 参数校验：别名归一（snake_case→camelCase）、目标唯一性、必填字段、明确拒绝
//    未迁移的 observe 开关（E_NOT_IMPLEMENTED）；
// 2) feature gate：peer 1.8 时 read（floor 1.9）与 click --expect 参数被
//    E_PROTOCOL_UNSUPPORTED 拒绝，且 data 带 missing/required 证据；
// 3) ref 生命周期：observe → ref 表 → click/fill/read 前校验，未 observe 即 E_STALE_REF，
//    expectRevision 不匹配时命令不会下发到内容脚本；
// 4) 结果形状：click 的合成输入证据（trusted:false）、fill 的 matches/expected_value、
//    read 的 fields、observe 的 observationId/refDetails/refsRegistered。

import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcMethodError } from '../src/rpc/registry.ts';
import { isProtocolError } from '../src/protocol.ts';
import {
  ActionRegistry,
  ACTION_METHODS,
  type ActionRegistryOptions,
} from '../src/actions/registry.ts';
import {
  applyParamAliases,
  normalizePageAction,
  normalizeTarget,
  PARAM_ALIASES,
  UNSUPPORTED_OBSERVE_FLAGS,
} from '../src/actions/params.ts';
import { newObservationId, buildObservationRefDetails } from '../src/actions/observation.ts';
import { RefRegistry } from '../src/refs/registry.ts';
import { StubContentTransport } from './support/stub-content.ts';
import type { ContentObserveResult } from '../src/content/protocol.ts';

// ---------------------------------------------------------------------------
// 参数层
// ---------------------------------------------------------------------------

test('applyParamAliases：本批方法的 snake_case 别名与 JS PARAM_ALIASES 同义', () => {
  const observe = applyParamAliases('observe', { max_tokens: 500, tab_id: 7, session_id: 'abcd' });
  assert.deepEqual(observe.params, { maxTokens: 500, tabId: 7, sessionId: 'abcd' });
  assert.deepEqual(observe.applied.sort(), ['max_tokens→maxTokens', 'session_id→sessionId', 'tab_id→tabId']);

  // 已给 camelCase 时不覆盖（与 JS normalizeParams 一致：snake_case 键保留原样）。
  const click = applyParamAliases('click', { stable_ref: 's-1', stableRef: 's-2' });
  assert.equal(click.params.stableRef, 's-2');
  assert.equal(click.params.stable_ref, 's-1');

  const fill = applyParamAliases('fill', { no_clear: true, expect_revision: 3 });
  assert.deepEqual(fill.params, { noClear: true, expectRevision: 3 });

  // 未登记的方法原样返回（前向兼容）。
  const other = applyParamAliases('unknown.method', { a_b: 1 });
  assert.deepEqual(other.params, { a_b: 1 });
  assert.deepEqual(PARAM_ALIASES.observe?.max_tokens, 'maxTokens');
});

test('normalizeTarget：四种目标只能给一个，ref/stableRef 形态校验', () => {
  assert.deepEqual(normalizeTarget({}), { ref: null, selector: null, stableRef: null, text: null });
  assert.equal(normalizeTarget({ ref: '@e3' }).ref, '@e3');
  assert.equal(normalizeTarget({ selector: '#kw' }).selector, '#kw');
  assert.equal(normalizeTarget({ stableRef: 's-abc' }).stableRef, 's-abc');
  assert.equal(normalizeTarget({ text: '提交' }).text, '提交');

  assert.throws(() => normalizeTarget({ ref: 'e3' }), /@eN/);
  assert.throws(() => normalizeTarget({ stableRef: 'abc' }), /s-/);
  assert.throws(() => normalizeTarget({ ref: '@e1', selector: '#kw' }), /只能给一个/);
  assert.throws(() => normalizeTarget({ selector: '  ' }), /非空/);
});

test('normalizePageAction：目标/必填字段/预算映射与未迁移开关的显式拒绝', () => {
  // tabId 由 daemon 注入，缺失回 E_BAD_ARG。
  assert.throws(() => normalizePageAction('observe', {}), (error: unknown) => {
    assert.ok(error instanceof RpcMethodError);
    assert.equal(error.code, 'E_BAD_ARG');
    return true;
  });

  const observe = normalizePageAction('observe', { tab_id: 3, max_tokens: 500 });
  assert.equal(observe.tabId, 3);
  assert.equal(observe.params.maxTokens, 500);
  assert.equal(observe.params.maxChars, 2000);
  assert.equal(observe.params.maxNodes, 250);

  const click = normalizePageAction('click', { tabId: 3, ref: '@e1', expect_revision: 2, trusted: true });
  assert.equal(click.target.ref, '@e1');
  assert.equal(click.params.expectRevision, 2);
  assert.equal(click.params.trusted, false, '本批没有原生输入，规范化后 trusted 必须是 false');
  assert.equal(click.params.trustedRequested, true, '调用方要求 trusted 时要留证据');
  assert.equal(click.params.synthetic, true);

  const fill = normalizePageAction('fill', { tabId: 3, selector: '#kw', value: 'x', no_clear: true });
  assert.equal(fill.params.value, 'x');
  assert.equal(fill.params.noClear, true);

  const readAll = normalizePageAction('read', { tabId: 3, all: true });
  assert.equal(readAll.params.all, true);
  assert.equal(readAll.target.ref, null);

  assert.throws(() => normalizePageAction('click', { tabId: 3 }), /需要 ref/);
  assert.throws(() => normalizePageAction('click', { tabId: 3, ref: '@e1', expectRevision: -1 }), /expectRevision/);
  assert.throws(() => normalizePageAction('fill', { tabId: 3, selector: '#kw' }), /需要 value/);
  assert.throws(() => normalizePageAction('fill', { tabId: 3, selector: '#kw', value: 5 }), /必须是字符串/);
  assert.throws(() => normalizePageAction('read', { tabId: 3 }), /all/);
  assert.throws(() => normalizePageAction('evaluate', { tabId: 3, expression: '  ' }), /expression/);
  assert.throws(() => normalizePageAction('select', { tabId: 3, selector: '#kind' }), /需要 value/);

  // 第四批已迁移 VOM/AX/facts 等开关：归一后原样保留（由 rich.ts 在内容脚本侧消费），
  // 不再以 E_NOT_IMPLEMENTED 拒绝；未迁移面清单因此为空。
  for (const flag of ['vom', 'ax', 'facts', 'closedShadow', 'fallbackAx', 'compareAx', 'debugSurfaces'] as const) {
    const normalizedObserve = normalizePageAction('observe', { tabId: 3, [flag]: true });
    assert.equal(normalizedObserve.params[flag], true, '已迁移开关应保留：' + flag);
  }
  assert.equal(normalizePageAction('observe', { tabId: 3, pipeline: 'ax' }).params.pipeline, 'ax');
  // 非本运行时游标格式仍明确拒绝（与“迁移了哪些”无关）。
  assert.throws(
    () => normalizePageAction('observe', { tabId: 3, cursor: 'cur' }),
    (error: unknown) => {
      assert.ok(error instanceof RpcMethodError);
      assert.equal(error.code, 'E_NOT_IMPLEMENTED');
      assert.match(error.message, /cursor/);
      return true;
    },
  );
  assert.deepEqual([...UNSUPPORTED_OBSERVE_FLAGS], []);
});

// ---------------------------------------------------------------------------
// observe 结果归一
// ---------------------------------------------------------------------------

const OBSERVE_RESULT: ContentObserveResult = {
  url: 'https://example.test/',
  title: '示例页',
  observation: '- textbox "关键词" [@e1]\n- button "提交" [@e2]',
  refs: 2,
  revision: 4,
  documentId: 'doc-a',
  nodes: [
    { ref: '@e1', role: 'textbox', name: '关键词', tag: 'input', id: 'kw' },
    { ref: '@e2', role: 'button', name: '提交', tag: 'button', id: 'submit' },
  ],
  filtered: 3,
};

test('buildObservationRefDetails：identity/stableRef 稳定且能区分同名节点', () => {
  const details = buildObservationRefDetails(OBSERVE_RESULT, { documentId: 'doc-a' });
  assert.equal(details.length, 2);
  const first = details[0];
  assert.ok(first);
  assert.equal(first.ref, '@e1');
  assert.equal(first.identity, '|doc-a|0|input|kw|textbox|关键词');
  assert.match(first.stableRef, /^s-[0-9a-z]+$/);
  assert.equal(first.backendNodeId, null);
  assert.equal(first.revision, 4);
  assert.equal(first.frameId, 0);
  assert.equal(first.cdpSessionId, null);

  // 同 tag/id/role/name 的重复节点共享 identityKey（身份相同），但 stableRef 用出现序号区分。
  const duplicate = buildObservationRefDetails({
    ...OBSERVE_RESULT,
    nodes: [
      { ref: '@e1', role: 'button', name: '确定', tag: 'button', id: null },
      { ref: '@e2', role: 'button', name: '确定', tag: 'button', id: null },
    ],
  });
  assert.equal(duplicate[0]?.identityKey, duplicate[1]?.identityKey);
  assert.notEqual(duplicate[0]?.stableRef, duplicate[1]?.stableRef);
  const again = buildObservationRefDetails({
    ...OBSERVE_RESULT,
    nodes: [
      { ref: '@e1', role: 'button', name: '确定', tag: 'button', id: null },
      { ref: '@e2', role: 'button', name: '确定', tag: 'button', id: null },
    ],
  });
  assert.equal(duplicate[0]?.stableRef, again[0]?.stableRef);
});

test('newObservationId：与 JS 同形，随机源可注入', () => {
  const id = newObservationId(7, () => 0.5);
  assert.match(id, /^ob_7_([0-9a-f]{2}){6}$/);
  assert.equal(newObservationId('abcd', () => 0), 'ob_abcd_000000000000');
  assert.equal(newObservationId('', () => 0), 'ob_000000000000');
});

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

interface Harness {
  registry: ActionRegistry;
  content: StubContentTransport;
  refs: RefRegistry;
}

function makeHarness(options: Partial<ActionRegistryOptions> = {}): Harness {
  const content = new StubContentTransport();
  const refs = new RefRegistry();
  content.set('observe', () => ({ ok: true, result: { ...OBSERVE_RESULT } }));
  content.set('click', (request) => ({
    ok: true,
    result: {
      ok: true,
      ref: (request.params.ref as string | undefined) ?? null,
      selector: (request.params.selector as string | undefined) ?? null,
      tag: 'button',
      x: 120,
      y: 40,
      via: 'content-script',
      hit: 'self',
      isConnected: true,
      trusted: false,
      synthetic: true,
    },
  }));
  content.set('fill', (request) => ({
    ok: true,
    result: {
      ok: true,
      ref: (request.params.ref as string | undefined) ?? null,
      selector: (request.params.selector as string | undefined) ?? null,
      tag: 'input',
      expected_value: String(request.params.value ?? ''),
      actual_value: String(request.params.value ?? ''),
      matches: true,
      cleared: true,
      via: 'content-script',
      trusted: false,
      synthetic: true,
    },
  }));
  content.set('read', () => ({
    ok: true,
    result: {
      fields: [{ key: 'value', tag: 'input', type: 'text', text: null, value: 'hello', checked: null }],
      ref: null,
      selector: '#kw',
      count: 1,
    },
  }));
  const registry = new ActionRegistry({ content, refs, random: () => 0, ...options });
  return { registry, content, refs };
}

test('ActionRegistry：注册 7 个方法，未知方法回 E_UNKNOWN_METHOD', async () => {
  const { registry } = makeHarness();
  assert.deepEqual(registry.methods().sort(), [...ACTION_METHODS].sort());
  assert.equal(registry.size, 7);
  await assert.rejects(registry.dispatch('hover', { tabId: 7 }), (error: unknown) => {
    assert.ok(error instanceof RpcMethodError);
    assert.equal(error.code, 'E_UNKNOWN_METHOD');
    return true;
  });
});

test('observe → 建 ref 表 → click 用 refKey 下发并返回合成输入证据', async () => {
  const { registry, content, refs } = makeHarness();
  const observed = await registry.dispatch('observe', { tabId: 7 }) as Record<string, unknown>;
  assert.equal(observed.url, 'https://example.test/');
  assert.equal(observed.refs, 2);
  assert.equal(observed.refsRegistered, 2);
  assert.equal(observed.refsSkipped, 0);
  assert.equal(observed.documentId, 'doc-a');
  assert.match(String(observed.observationId), /^ob_/);
  const details = observed.refDetails as Array<Record<string, unknown>>;
  assert.equal(details.length, 2);
  assert.match(String(details[0]?.stableRef), /^s-/);

  assert.equal(refs.size(7), 2);

  const clicked = await registry.dispatch('click', { tabId: 7, ref: '@e2' }) as Record<string, unknown>;
  assert.equal(clicked.via, 'content-script');
  assert.equal(clicked.trusted, false);
  assert.equal(clicked.synthetic, true);
  assert.equal(clicked.x, 120);
  assert.equal(clicked.ref, '@e2');

  const clickCall = content.callsFor('click')[0];
  assert.ok(clickCall);
  assert.equal(clickCall.request.op, 'click');
  assert.equal(clickCall.request.params.ref, '@e2');
  assert.equal(clickCall.request.params.documentId, 'doc-a');
  const refKey = clickCall.request.params.refKey as Record<string, unknown>;
  assert.equal(refKey.documentId, 'doc-a');
  assert.equal(refKey.revision, 4);
  assert.equal(refKey.generation, refs.generationOf(7));
  assert.match(String(refKey.signature), /^sig:/);
  assert.equal(clickCall.request.params.trusted, false);
});

test('stableRef 驱动动作：注册表解析回 @eN 再下发页面', async () => {
  const { registry, content } = makeHarness();
  const observed = await registry.dispatch('observe', { tabId: 7 }) as { refDetails: Array<{ stableRef: string; ref: string }> };
  const detail = observed.refDetails[0];
  assert.ok(detail);

  await registry.dispatch('click', { tabId: 7, stableRef: detail.stableRef });
  const call = content.callsFor('click')[0];
  assert.ok(call);
  assert.equal(call.request.params.ref, detail.ref);

  await assert.rejects(registry.dispatch('click', { tabId: 7, stableRef: 's-missing' }), (error: unknown) => {
    assert.ok(error instanceof RpcMethodError);
    assert.equal(error.code, 'E_STALE_REF');
    return true;
  });
});

test('ref 生命周期：未 observe 的 ref / expectRevision 不匹配都不会下发到页面', async () => {
  const { registry, content } = makeHarness();
  await assert.rejects(registry.dispatch('click', { tabId: 7, ref: '@e1' }), (error: unknown) => {
    assert.ok(error instanceof RpcMethodError);
    assert.equal(error.code, 'E_STALE_REF');
    assert.match(error.message, /请重新 observe/);
    return true;
  });
  assert.equal(content.callsFor('click').length, 0);

  await registry.dispatch('observe', { tabId: 7 });
  await assert.rejects(registry.dispatch('fill', { tabId: 7, ref: '@e1', value: 'x', expectRevision: 99 }), (error: unknown) => {
    assert.ok(error instanceof RpcMethodError);
    assert.equal(error.code, 'E_STALE_REF');
    assert.equal((error.data as { reason?: string }).reason, 'stale_revision');
    return true;
  });
  assert.equal(content.callsFor('fill').length, 0);

  // 页面回包的 E_STALE_REF 原样上抛（内容脚本层面的失效不被吞掉）。
  content.set('click', () => ({ ok: false, code: 'E_STALE_REF', message: 'ref 不在当前 ref 表里', data: { ref: '@e2' } }));
  await assert.rejects(registry.dispatch('click', { tabId: 7, ref: '@e2' }), (error: unknown) => {
    assert.ok(error instanceof RpcMethodError);
    assert.equal(error.code, 'E_STALE_REF');
    assert.deepEqual(error.data, { ref: '@e2' });
    return true;
  });
});

test('selector 路径不需要 ref 表；read --all 与 fill 的结果字段', async () => {
  const { registry, content } = makeHarness();
  await registry.dispatch('click', { tabId: 7, selector: '#submit-btn' });
  const clickCall = content.callsFor('click')[0];
  assert.ok(clickCall);
  assert.equal(clickCall.request.params.selector, '#submit-btn');
  assert.equal('refKey' in clickCall.request.params, false);

  const fillResult = await registry.dispatch('fill', { tabId: 7, selector: '#kw', value: 'hello' }) as Record<string, unknown>;
  assert.equal(fillResult.matches, true);
  assert.equal(fillResult.expected_value, 'hello');
  assert.equal(fillResult.effectState, 'committed');

  const readResult = await registry.dispatch('read', { tabId: 7, all: true }) as Record<string, unknown>;
  assert.equal(readResult.all, true);
  assert.equal(readResult.count, 1);
  assert.equal(readResult.value, 'hello');
  const readCall = content.callsFor('read')[0];
  assert.ok(readCall);
  assert.equal(readCall.request.params.all, true);
});

test('feature gate：1.8 对端被 E_PROTOCOL_UNSUPPORTED 拒绝（read floor=1.9 / expect 参数门）', async () => {
  const { registry, content } = makeHarness();
  registry.setPeer({ protocol: '1.8' });

  await assert.rejects(registry.dispatch('read', { tabId: 7, all: true }), (error: unknown) => {
    assert.ok(isProtocolError(error), '应为 ProtocolError：' + String(error));
    const code = (error as { code?: string }).code;
    assert.equal(code, 'E_PROTOCOL_UNSUPPORTED');
    const data = (error as { data?: { required?: string | null; missing?: ReadonlyArray<{ feature: string }> } }).data;
    assert.equal(data?.required, '1.9');
    assert.equal(data?.missing?.[0]?.feature, 'read');
    return true;
  });
  assert.equal(content.callsFor('read').length, 0);

  await registry.dispatch('observe', { tabId: 7 });
  await assert.rejects(
    registry.dispatch('click', { tabId: 7, ref: '@e1', expect: [{ target: '#x', field: 'text', equals: 'y' }] }),
    (error: unknown) => {
      assert.ok(isProtocolError(error));
      const data = (error as { data?: { missing?: ReadonlyArray<{ feature: string }> } }).data;
      assert.equal(data?.missing?.[0]?.feature, 'expect');
      return true;
    },
  );
});

test('observe 高级面开关：动作层把 VOM/AX 开关下发给内容脚本（第四批已迁移）', async () => {
  const { registry, content } = makeHarness();
  await registry.dispatch('observe', { tabId: 7, vom: true, ax: true, facts: true });
  const calls = content.callsFor('observe');
  assert.equal(calls.length, 1);
  const params = calls[0]?.request.params;
  assert.equal(params?.vom, true);
  assert.equal(params?.ax, true);
  assert.equal(params?.facts, true);
});

test('内容脚本超时：注册表以 E_TIMEOUT 结束（不无限等待）', async () => {
  const { registry, content } = makeHarness();
  content.set('click', () => new Promise(() => { /* 永不返回 */ }));
  await assert.rejects(registry.dispatch('click', { tabId: 7, selector: '#x' }, { timeoutMs: 30 }), (error: unknown) => {
    assert.ok(error instanceof RpcMethodError);
    assert.equal(error.code, 'E_TIMEOUT');
    return true;
  });
});

test('旧 observation 收据：document/revision 不匹配回 E_OBSERVATION_STALE 且不下发页面', async () => {
  const { registry, content } = makeHarness();
  await registry.dispatch('observe', { tabId: 7 });
  const callsBefore = content.callsFor('read').length;

  await assert.rejects(
    registry.dispatch('read', {
      tabId: 7,
      ref: '@e1',
      observationDocumentId: 'doc-old',
      observationRevision: 4,
    }),
    (error: unknown) => {
      assert.ok(error instanceof RpcMethodError);
      assert.equal(error.code, 'E_OBSERVATION_STALE');
      assert.equal((error.data as { reason?: string }).reason, 'stale_document');
      return true;
    },
  );
  assert.equal(content.callsFor('read').length, callsBefore, '旧 observation 不应把读取命令下发到页面');

  await assert.rejects(
    registry.dispatch('read', {
      tabId: 7,
      ref: '@e1',
      observationDocumentId: 'doc-a',
      observationRevision: 99,
    }),
    (error: unknown) => {
      assert.ok(error instanceof RpcMethodError);
      assert.equal(error.code, 'E_OBSERVATION_STALE');
      assert.equal((error.data as { reason?: string }).reason, 'stale_revision');
      return true;
    },
  );
});

test('不同 tab 的 ref 表互不影响；observe 失败不破坏旧 ref', async () => {
  const { registry, refs } = makeHarness();
  await registry.dispatch('observe', { tabId: 7 });
  assert.equal(refs.size(7), 2);
  assert.equal(refs.size(8), 0);

  // 第四批：ax 已迁移，不再以“未迁移”失败；带高级面开关的 observe 正常重建 ref 表。
  await registry.dispatch('observe', { tabId: 7, ax: true });
  assert.equal(refs.size(7), 2, '成功 observe 后 ref 表应重建而不是清空');
  await registry.dispatch('click', { tabId: 7, ref: '@e1' });
});
