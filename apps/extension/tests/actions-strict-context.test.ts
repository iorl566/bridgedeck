// tests/actions-strict-context.test.ts —— strict 策略 --context 单次消费（23w）+ select 语义（7）。
//
// 覆盖：
// 1) cooperate.sync --policy strict 之后，普通 sync（不带 --policy）不得把策略退回 auto
//    （strict 是会话级固定值，只有显式 --policy 才换）；
// 2) strict 下无 context 的动作 → E_CONTEXT_REQUIRED；同一 context 第二次使用 → E_CONTEXT_STALE；
// 3) --policy auto 恢复后无 context 可执行（borrow/守卫语义不放宽）；
// 4) select 支持 value/label 归一，回读 expected/actual/matches 与随后 click 不回归。

import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcMethodError } from '../src/rpc/registry.ts';
import { ActionRegistry } from '../src/actions/registry.ts';
import { ExtendedActionRegistry } from '../src/actions/extended.ts';
import { ReceiptStore } from '../src/actions/receipts.ts';
import { normalizePageAction } from '../src/actions/params.ts';
import { RefRegistry } from '../src/refs/registry.ts';
import { StubContentTransport } from './support/stub-content.ts';

const OBSERVE_RESULT = {
  url: 'https://example.test/',
  title: '示例',
  observation: '- combobox "类型" [@e1]\n- button "提交" [@e2]',
  refs: 2,
  revision: 3,
  documentId: 'doc-a',
  nodes: [
    { ref: '@e1', role: 'combobox', name: '类型', tag: 'select', id: 'kind' },
    { ref: '@e2', role: 'button', name: '提交', tag: 'button', id: 'submit-btn' },
  ],
};

function makeContent(): StubContentTransport {
  const content = new StubContentTransport();
  content.set('observe', () => ({ ok: true, result: { ...OBSERVE_RESULT } }));
  content.set('cooperation-state', () => ({
    ok: true,
    result: {
      frameState: {
        mutations: 0, structure: 0, texts: [], scroll: 0, document: 'https://example.test/', events: [],
        focusNeutral: true, selection: '', media: [], mediaComplete: true, textsComplete: true,
        eventsComplete: true, fieldsComplete: true, focusIsDocument: true,
        agentAttributed: 0, humanAttributed: 0, lastHumanKind: null, inputClock: 0,
        timeToleranceMs: 1.5, attribution: { owner: null, kind: null, at: null, by: null },
        expectationPending: false,
      },
      documentId: 'doc-a',
      url: 'https://example.test/',
      fingerprint: 'fp-1',
    },
  }));
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
  content.set('select', (request) => ({
    ok: true,
    result: {
      ok: true,
      ref: (request.params.ref as string | undefined) ?? null,
      selector: (request.params.selector as string | undefined) ?? null,
      expected_value: String(request.params.value ?? ''),
      actual_value: String(request.params.value ?? ''),
      matches: true,
      via: 'content-script',
    },
  }));
  return content;
}

function makeRegistries(): {
  content: StubContentTransport;
  receipts: ReceiptStore;
  actions: ActionRegistry;
  extended: ExtendedActionRegistry;
} {
  const content = makeContent();
  const refs = new RefRegistry();
  const receipts = new ReceiptStore({ now: () => 1000 });
  const actions = new ActionRegistry({ content, refs, receipts, random: () => 0, now: () => 1000 });
  const extended = new ExtendedActionRegistry({ content, refs, receipts, random: () => 0, now: () => 1000 });
  return { content, receipts, actions, extended };
}

test('23w：strict 策略是会话级固定值，普通 sync 不会退回 auto；context 单次消费', async () => {
  const { actions, extended, receipts } = makeRegistries();
  const strictSync = await extended.dispatch('cooperate.sync', { tabId: 7, policy: 'strict' }) as {
    control_policy: string;
    context_id: string;
  };
  assert.equal(strictSync.control_policy, 'strict');
  assert.equal(receipts.getPolicy(7), 'strict');

  // 1) strict 下缺 context 的动作必须拒绝。
  await assert.rejects(
    actions.dispatch('click', { tabId: 7, selector: '#submit-btn' }),
    (error: unknown) => {
      assert.ok(error instanceof RpcMethodError);
      assert.equal(error.code, 'E_CONTEXT_REQUIRED');
      assert.equal((error.data as Record<string, unknown>).dispatched, false);
      return true;
    },
  );

  // 2) 不带 --policy 的 sync 不得换掉 strict（E2E 23w 的第二段 sync）。
  const contextSync = await extended.dispatch('cooperate.sync', { tabId: 7 }) as {
    control_policy: string;
    context_id: string;
  };
  assert.equal(contextSync.control_policy, 'strict');
  assert.notEqual(contextSync.context_id, strictSync.context_id);
  assert.equal(receipts.getPolicy(7), 'strict');

  // 3) 带 context 的动作成功，且该 context 被消费。
  const clicked = await actions.dispatch('click', { tabId: 7, selector: '#submit-btn', context: contextSync.context_id }) as Record<string, unknown>;
  assert.equal(clicked.ok, true);
  assert.equal(clicked.effectState, 'committed');

  // 4) 复用同一 context → E_CONTEXT_STALE（单次消费）。
  await assert.rejects(
    actions.dispatch('click', { tabId: 7, selector: '#submit-btn', context: contextSync.context_id }),
    (error: unknown) => {
      assert.ok(error instanceof RpcMethodError);
      assert.equal(error.code, 'E_CONTEXT_STALE');
      assert.match(error.message, /已使用/);
      return true;
    },
  );

  // 5) 显式 --policy auto 恢复后，无 context 可执行（不放宽既有守卫语义）。
  const autoSync = await extended.dispatch('cooperate.sync', { tabId: 7, policy: 'auto' }) as { control_policy: string };
  assert.equal(autoSync.control_policy, 'target');
  assert.equal(receipts.getPolicy(7), 'auto');
  const autoClicked = await actions.dispatch('click', { tabId: 7, selector: '#submit-btn' }) as Record<string, unknown>;
  assert.equal(autoClicked.ok, true);
});

test('select：value/label 归一（label 只作兜底输入，不静默改语义）', () => {
  const byValue = normalizePageAction('select', { tabId: 3, selector: '#kind', value: 'b' });
  assert.equal(byValue.params.value, 'b');
  assert.equal(byValue.params.label, undefined);

  const byLabel = normalizePageAction('select', { tabId: 3, selector: '#kind', label: '乙' });
  assert.equal(byLabel.params.value, '乙');

  const both = normalizePageAction('select', { tabId: 3, selector: '#kind', value: 'b', label: '乙' });
  assert.equal(both.params.value, 'b');
  assert.equal(both.params.label, '乙');

  assert.throws(() => normalizePageAction('select', { tabId: 3, selector: '#kind' }), /value 或 label/);
  assert.throws(() => normalizePageAction('select', { tabId: 3, selector: '#kind', value: 5 }), /必须是字符串/);
  assert.throws(() => normalizePageAction('select', { tabId: 3, selector: '#kind', label: 5 }), /必须是字符串/);
});

test('7：select 回读 expected/actual/matches，随后 click 仍然 committed', async () => {
  const { actions, content } = makeRegistries();
  await actions.dispatch('observe', { tabId: 7 });

  const selected = await actions.dispatch('select', { tabId: 7, ref: '@e1', value: 'b' }) as Record<string, unknown>;
  assert.equal(selected.ok, true);
  assert.equal(selected.expected_value, 'b');
  assert.equal(selected.actual_value, 'b');
  assert.equal(selected.matches, true);
  const selectCall = content.callsFor('select')[0];
  assert.equal(selectCall?.request.params.ref, '@e1');
  assert.equal(selectCall?.request.params.value, 'b');
  assert.equal(selectCall?.request.params.documentId, 'doc-a');

  const clicked = await actions.dispatch('click', { tabId: 7, ref: '@e2' }) as Record<string, unknown>;
  assert.equal(clicked.ok, true);
  assert.equal(clicked.effectState, 'committed');
  assert.equal(clicked.via, 'content-script');
  assert.equal(clicked.trusted, false);
});
