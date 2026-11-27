// src/tools/fill-actions.js —— fill/press 事务与读回。
//
// 事务层次（W2 动作事务）：
//   beginJournaledTransaction（派发前预写 journal）→ 行锚点守卫 → 快路径/程序化路径 → commit；
//   失败按证据落 abort（页面没被改）或 UNKNOWN（结果未知且禁止自动重放）。
import { bridgeError } from '../errors.js';
import { execPage } from '../inject.js';
import { acquire, isTabArmed, release, send as cdpSend } from '../debugger.js';
import { withForegroundTab } from '../background-execution.js';
import { withOverlaysHidden } from '../overlay-suppress.js';
import { acquireInputLease, releaseInputLease } from '../input-lease.js';
import { focusRequested } from '../lib/focus-policy.js';
import { committedEffect } from '../lib/transaction-ledger.js';
import { beginJournaledTransaction } from '../lib/action-journal.js';
import { checkRowAnchor, hasLegacyRowFacts } from '../lib/virtual-row-guard.js';
import { pageAction } from './page-action.js';
import { requireTabId } from './shared.js';
import { inputFocusCache, recentFillFocus } from './state.js';
import { classifyFillControl, fillPlanFields, fillVerifyFields, fillVerifyTargets, planFillSteps } from './fill-verify.js';
import { beginInput, trustedKey } from './keyboard.js';
import { guardActionRowAnchor, inputEventStamp, trustedClickPoint } from './pointer-primitives.js';
import { retryTarget, ensureInputFocus, trustedFocusPoint } from './action-common.js';
import { armCooperationExpectation } from '../cooperation.js';

const rawFill = pageAction('fill');
const rawPress = pageAction('press');

function fillObserved(plan, parts = {}) {
  const observed = {};
  for (const step of plan && Array.isArray(plan.steps) ? plan.steps : []) {
    if (parts[step] !== undefined) observed[step] = parts[step];
  }
  return observed;
}

/**
 * 行锚点守卫：params.rowAnchor（observe payload 的 node.anchor）存在时：
 *   1) 带 legacy 分类字段（previous 系列/detached/…）的先做纯函数判定；
 *   2) 再读“动作前当前行事实”并逐字段比对，不稳定抛 E_TARGET_MISMATCH（data.guard='virtual-row'）。
 */
async function guardRowAnchor(params) {
  const facts = params && (params.rowAnchor || params.row_anchor);
  if (!facts || typeof facts !== 'object') return null;
  const tabId = requireTabId(params);
  if (hasLegacyRowFacts(facts)) {
    const result = checkRowAnchor(facts);
    if (result.ok !== true) {
      throw bridgeError('E_TARGET_MISMATCH', result.message, {
        guard: 'virtual-row',
        stable: false,
        reason: result.classification.reason,
        rowIndex: result.classification.rowIndex,
        kind: result.classification.kind,
        checks: result.classification.checks,
        evidence: result.evidence,
        dispatched: false,
        replay: false,
      });
    }
  }
  return guardActionRowAnchor(tabId, params);
}

/** 读控件 tag（select/date/checkbox… 的路径分派用）：node-signature 只读，不改页面。 */
async function probeFillControl(params) {
  const tabId = requireTabId(params);
  const target = fillVerifyTargets(params);
  if (!target.ref && !target.selector) return null;
  const signature = await execPage(tabId, 'node-signature', target).catch(() => null);
  if (!signature || signature.present !== true) return null;
  return {
    tag: String(signature.tag || '').toLowerCase(),
    disabled: signature.disabled === true,
  };
}

/** select 真实路径：页面库 select 命令先匹配 option（value→文本→label），再 input/change。 */
async function selectProgrammaticFill(params, tx) {
  const tabId = requireTabId(params);
  const target = fillVerifyTargets(params);
  const value = String(params.value === undefined ? '' : params.value);
  const plan = planFillSteps({ textLike: false, tag: 'select' });
  const selection = await execPage(tabId, 'select', { ...target, value });
  if (tx) tx.markDispatched({ phase: 'select-commit' });
  const verified = await execPage(tabId, 'fill-verify', { ...target, expected: value }).catch(() => null);
  const observed = fillObserved(plan, {
    focus: { ok: true, via: 'element-focus' },
    'match-option': {
      value: selection && selection.value != null ? String(selection.value) : null,
      label: selection && selection.label ? String(selection.label) : null,
      matched_by: selection && selection.value === value ? 'value' : 'label',
    },
    commit: { matches: verified ? verified.matches === true : null, selected: selection && selection.selected ? selection.selected.length : null },
  });
  return {
    ok: true,
    trusted: false,
    programmatic: true,
    via: 'page-select',
    element: 'select',
    selection: selection || null,
    ...fillPlanFields({ ...plan, observed }),
    ...fillVerifyFields(verified),
  };
}

/** date/time 真实路径：浏览器要求完整 value，页面库用原生 setter + 合法性校验。 */
async function dateProgrammaticFill(params, inputType, tx) {
  const tabId = requireTabId(params);
  const target = fillVerifyTargets(params);
  const value = String(params.value === undefined ? '' : params.value);
  const plan = planFillSteps({ textLike: false, tag: 'input', inputType });
  const result = await rawFill(params);
  if (tx) tx.markDispatched({ phase: 'date-commit', inputType });
  const verified = await execPage(tabId, 'fill-verify', { ...target, expected: value }).catch(() => null);
  const observed = fillObserved(plan, {
    focus: { ok: true, via: 'element-focus' },
    'set-value': { input_type: String(inputType || ''), value_length: value.length, actual: verified && verified.value != null ? String(verified.value).slice(0, 40) : null },
    commit: { matches: verified ? verified.matches === true : null, formatted: verified ? verified.formatted === true : null },
  });
  return {
    ...result,
    trusted: false,
    programmatic: true,
    via: 'native-value-setter',
    element: 'input',
    input_type: String(inputType || ''),
    ...fillPlanFields({ ...plan, observed }),
    ...fillVerifyFields(verified),
  };
}

/** 其余 programmatic 控件保持既有行为：页面库一次性写值 + 读回。 */
async function legacyProgrammaticFill(params, fast, tx) {
  const result = await rawFill(params);
  const verified = await execPage(Number(params.tabId), 'fill-verify', {
    ...fillVerifyTargets(params),
    expected: String(params.value === undefined ? '' : params.value),
  }).catch(() => null);
  const plan = planFillSteps({ textLike: false, inputType: fast && fast.inputType });
  const observed = fillObserved(plan, {
    focus: { ok: true, via: 'element-focus' },
    'set-value': { actual: verified && verified.value != null ? String(verified.value).length : null },
    commit: { matches: verified ? verified.matches === true : null },
  });
  return {
    ...result,
    ...fillPlanFields({ ...plan, observed }),
    ...fillVerifyFields(verified),
    trusted: false,
    fallback: 'programmatic',
    reason: fast && fast.reason ? fast.reason : 'programmatic-only',
  };
}

async function trustedFillFast(params, tx) {
  const tabId = requireTabId(params);
  const target = params.ref ? { ref: params.ref } : (params.selector ? { selector: params.selector } : null);
  if (!target) return null;
  const now = Date.now();
  const cachedFocus = inputFocusCache.get(tabId);
  if (!cachedFocus || now - cachedFocus > 1000) {
    const focused = await ensureInputFocus(tabId, params);
    if (!focused) return null;
    inputFocusCache.set(tabId, now);
  }
  const raw = await execPage(tabId, 'fill-focus', { ...target, noClear: params.noClear === true }).catch((error) => { throw error; });
  const prep = raw && raw.value && typeof raw.value === 'object' ? raw.value : raw;
  if (prep && prep.textLike === false) return { __programmatic: true, reason: prep.reason || 'programmatic-only', inputType: prep.inputType || '' };
  if (!prep || prep.textLike !== true) return null;
  // 焦点没有真正落到目标上（常见于 closed shadow / 页面抢焦点）：不要 insertText 到错误元素，回退 trusted 点选路径。
  if (prep.focused === false) return null;
  if (prep.occluded === true && params.force !== true) {
    throw bridgeError('E_NOT_ACTIONABLE', '目标被遮挡（occluded），可用 --force 强制填写');
  }

  const value = String(params.value === undefined ? '' : params.value);
  // 空且简单 input 只 insertText 一次；已有值/富文本走 focus→clear→insert，最多 3 步。
  const plan = planFillSteps({
    textLike: prep.textLike,
    tag: prep.tag,
    inputType: prep.inputType || prep.type,
    isContentEditable: prep.tag !== 'input' && prep.tag !== 'textarea',
    hadValue: prep.hadValue,
    noClear: params.noClear === true,
  });
  const lease = acquireInputLease(tabId, 'trusted:fill');
  try {
    // 富文本没有 el.select()，只能键盘清空；普通输入框的 clear 由 fill-focus 完成。
    if (plan.needs_clear && plan.clear_via === 'keyboard') await trustedKey(tabId, 'Control+a');
    const endInput = beginInput(tabId, 'fill');
    let clock = null;
    try {
      await acquire(tabId, 'input');
      try {
        clock = inputEventStamp(tabId, 'fill-insert');
        // 预写已落盘，且从这里开始输入已发往页面：之后任何失败都必须按 UNKNOWN 收口。
        if (tx) tx.markDispatched({ phase: 'fill-insert', plan: plan.steps });
        await cdpSend(tabId, 'Input.insertText', { text: value });
      } finally {
        await release(tabId, 'input').catch(() => {});
      }
    } finally {
      endInput();
    }
    const verified = await execPage(tabId, 'fill-verify', { ...target, expected: value }).catch(() => null);
    const observed = fillObserved(plan, {
      focus: { focused: prep.focused === true, occluded: prep.occluded === true },
      ...(plan.needs_clear ? { clear: { via: plan.clear_via, ok: true } } : {}),
      insert: { matches: verified ? verified.matches === true : null, value_length: value.length },
    });
    return {
      ok: true,
      trusted: true,
      fast: true,
      ...committedEffect(),
      ...fillPlanFields({ ...plan, observed }),
      ...(clock ? { input_clock: { epoch: clock.epoch, seq: clock.seq, timestamp: clock.timestamp } } : {}),
      ...fillVerifyFields(verified),
    };
  } finally {
    releaseInputLease(tabId, lease.token);
  }
}

async function trustedFill(params, fallback, tx) {
  const tabId = requireTabId(params);
  const now = Date.now();
  const cachedFocus = inputFocusCache.get(tabId);
  if (!cachedFocus || now - cachedFocus > 1000) {
    const focused = await ensureInputFocus(tabId, params);
    if (focused) inputFocusCache.set(tabId, now);
  }
  const point = await trustedFocusPoint(tabId, params);
  if (!point) return fallback(params);
  const lease = acquireInputLease(tabId, 'trusted:fill');
  let pointerMoves = null;
  try {
    await acquire(tabId, 'input');
    try {
      // 三个 CDP 设置互不依赖；后台路径只开焦点仿真 + active 生命周期，不 bringToFront。
      const setup = [];
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || tab.active === false) {
        setup.push(cdpSend(tabId, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => {}));
      }
      setup.push(cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {}));
      await Promise.all(setup);
      const clickResult = await trustedClickPoint(tabId, point, { human: params.human === true });
      pointerMoves = clickResult && clickResult.moves ? clickResult.moves : null;
      if (params.noClear !== true) {
        await trustedKey(tabId, 'Control+a');
      } else {
        await trustedKey(tabId, 'End');
      }
      if (tx) tx.markDispatched({ phase: 'fill-insert-direct' });
      await cdpSend(tabId, 'Input.insertText', { text: String(params.value === undefined ? '' : params.value) });
    } finally {
      if (!isTabArmed(tabId)) void cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
      await release(tabId, 'input').catch(() => {});
    }
  } finally {
    releaseInputLease(tabId, lease.token);
  }
  const fillTarget = fillVerifyTargets(params);
  const verified = await execPage(tabId, 'fill-verify', {
    ...fillTarget,
    expected: String(params.value === undefined ? '' : params.value),
  }).catch(() => null);
  const plan = {
    strategy: 'trusted',
    steps: params.noClear === true ? ['focus', 'insert'] : ['focus', 'clear', 'insert'],
    step_count: params.noClear === true ? 2 : 3,
    needs_clear: params.noClear !== true,
    clear_via: params.noClear === true ? null : 'keyboard',
    kind: 'text-control',
    control_kind: 'text-control',
    path: 'trusted-click-insert',
    step_evidence: (params.noClear === true ? ['focus', 'insert'] : ['focus', 'clear', 'insert']).map((step) => ({
      step,
      via: step === 'focus' ? 'trusted-click' : step === 'clear' ? 'keyboard:Control+a' : 'cdp-insertText',
    })),
  };
  plan.observed = fillObserved(plan, {
    focus: { focused: true, via: 'trusted-click' },
    ...(plan.needs_clear ? { clear: { via: plan.clear_via, ok: true } } : {}),
    insert: { matches: verified ? verified.matches === true : null, value_length: String(params.value === undefined ? '' : params.value).length },
  });
  return {
    ok: true,
    trusted: true,
    ...committedEffect(),
    ...fillPlanFields(plan),
    ...(pointerMoves ? { pointer_moves: pointerMoves } : {}),
    ...fillVerifyFields(verified),
  };
}

async function trustedPress(params, fallback, tx) {
  const tabId = requireTabId(params);
  await ensureInputFocus(tabId, params);
  const recent = recentFillFocus.get(tabId);
  const skipClick = Boolean(params.ref && recent && recent.ref === params.ref && Date.now() - recent.at < 3000);
  const point = skipClick ? null : await trustedFocusPoint(tabId, params);
  const lease = acquireInputLease(tabId, 'trusted:press');
  try {
    await acquire(tabId, 'input');
    try {
      await cdpSend(tabId, 'Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
      await cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      if (point) await trustedClickPoint(tabId, point, { human: params.human === true });
      await armCooperationExpectation(tabId, { kinds: ['pointer', 'key', 'focus', 'scroll'], key: String(params.key) }).catch(() => {});
      if (tx) tx.markDispatched({ phase: 'press-key', key: String(params.key) });
      await trustedKey(tabId, String(params.key));
      return { ok: true, trusted: true, ...committedEffect() };
    } finally {
      if (!isTabArmed(tabId)) void cdpSend(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
      await release(tabId, 'input').catch(() => {});
    }
  } finally {
    releaseInputLease(tabId, lease.token);
  }
}

export async function fill(params = {}) {
  // 行锚点守卫必须在任何页面交互之前：读当前 anchor 失败（fail-closed）就直接拒绝派发。
  const rowGuard = await guardRowAnchor(params);
  const { tx, degraded, recovered } = await beginJournaledTransaction({ method: 'fill', params, phase: 'pointer' });
  try {
    const result = await retryTarget(params, async () => {
      if (!params || params.trusted !== true) {
        const result = await rawFill(params);
        if (params && params.ref) recentFillFocus.set(Number(params.tabId), { ref: params.ref, at: Date.now() });
        // 合成路径也回填校验结果：agent 不能只看 "ok" 就以为值真的写进去了。
        if (params && Number.isInteger(params.tabId)) {
          const verified = await execPage(params.tabId, 'fill-verify', {
            ...fillVerifyTargets(params),
            expected: String(params.value === undefined ? '' : params.value),
          }).catch(() => null);
          return { ...result, ...fillVerifyFields(verified) };
        }
        return result;
      }
      const run = async () => {
        const fast = await trustedFillFast(params, tx).catch(async (error) => {
          // 语义错误必须让调用方看到；输入时钟异常也不能改走其它派发路径。
          if (error && error.code === 'E_TARGET_NOT_FILLABLE') {
            // select 在快路径里不可填空：改走真实 select 路径（选项匹配 + input/change）。
            const detected = await probeFillControl(params).catch(() => null);
            if (detected && detected.tag === 'select') return selectProgrammaticFill(params, tx);
            throw error;
          }
          if (error && ['E_INPUT_BUSY', 'E_NOT_ACTIONABLE', 'E_BAD_ARG', 'E_OPTION_NOT_FOUND', 'E_OPTION_AMBIGUOUS'].includes(error.code)) throw error;
          if (error && error.data && error.data.cause === 'clock_regression') throw error;
          // 已经 insertText 过：结果未知，禁止回退成第二次输入（会重复写入）。
          if (tx && tx.effectState === 'unknown') throw error;
          return null;
        });
        if (fast) {
          if (fast.__programmatic === true) {
            const control = classifyFillControl({ tag: 'input', inputType: fast.inputType, textLike: false });
            if (control.kind === 'date-control') return dateProgrammaticFill(params, fast.inputType, tx);
            if (control.kind === 'file-control' || control.kind === 'check-control') {
              throw bridgeError('E_TARGET_NOT_FILLABLE', '目标控件不支持 fill（' + control.kind + '）：请改用 click / upload');
            }
            return legacyProgrammaticFill(params, fast, tx);
          }
          if (params.ref) recentFillFocus.set(Number(params.tabId), { ref: params.ref, at: Date.now() });
          return fast;
        }
        const result = await trustedFill(params, rawFill, tx).catch((error) => {
          if (error && error.code === 'E_INPUT_BUSY') throw error;
          if (error && error.data && error.data.cause === 'clock_regression') throw error;
          if (tx && tx.effectState === 'unknown') throw error;
          return rawFill(params);
        });
        if (params.ref) recentFillFocus.set(Number(params.tabId), { ref: params.ref, at: Date.now() });
        return result;
      };
      return Number.isInteger(params.tabId) ? withForegroundTab(params.tabId, () => withOverlaysHidden(params.tabId, run), { focus: focusRequested(params) }) : run();
    });
    await tx.commit({ details: { matches: result && result.matches === true, trusted: result && result.trusted === true } });
    return {
      ...result,
      ...tx.fields(),
      ...(degraded ? { journal_degraded: true } : {}),
      ...(recovered.length ? { journal_recovered: recovered } : {}),
      ...(rowGuard ? { row_guard: rowGuard } : {}),
    };
  } catch (error) {
    await tx.fail(error);
    throw error;
  }
}

export async function press(params = {}) {
  const { tx, degraded, recovered } = await beginJournaledTransaction({ method: 'press', params, phase: 'key' });
  try {
    const result = await retryTarget(params, () => {
      if (!params || params.trusted !== true) return rawPress(params);
      const run = () => trustedPress(params, rawPress, tx).catch((error) => {
        if (error && error.code === 'E_INPUT_BUSY') throw error;
        if (tx && tx.effectState === 'unknown') throw error;
        return rawPress(params);
      });
      return Number.isInteger(params.tabId) ? withForegroundTab(params.tabId, () => withOverlaysHidden(params.tabId, run), { focus: focusRequested(params) }) : run();
    });
    await tx.commit({ details: { trusted: result && result.trusted === true } });
    return { ...result, ...tx.fields(), ...(degraded ? { journal_degraded: true } : {}), ...(recovered.length ? { journal_recovered: recovered } : {}) };
  } catch (error) {
    await tx.fail(error);
    throw error;
  }
}
