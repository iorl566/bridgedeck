// daemon/submit.js —— 落账/路由/effect_state 结算 + session scope。
import { hasNoEffect, isUnknownOutcome } from '../lib/intent-ledger.mjs';
import { isMutating } from '../lib/methods.mjs';

export function createSubmit(ctx) {
  const { intentLedger, routeExtension, withEffectState, annotateEffectSuccess, sessions, resolveSessionByScope, BridgeError, ledgerTargetFromRoute } = ctx;
async function submitRouted(route, method, params, timeoutMs) {
    const intent = intentLedger.begin(method, params, ledgerTargetFromRoute(route));
    try {
      const result = await routeExtension(route, method, timeoutMs);
      intentLedger.finish(intent, 'done');
      return annotateEffectSuccess(result, method);
    } catch (error) {
      // 先判"是否确定未派发"，再结算：否则 E_TIMEOUT 一类会把未派发的操作记成 unknown 并冻结标签页。
      const notDispatched = error && (error.code === 'E_TARGET_MISMATCH' || hasNoEffect(error));
      if (isMutating(method)) withEffectState(error, notDispatched ? 'none' : 'unknown');
      const noEffect = notDispatched === true || (error && (
        error.effectState === 'none' || error.effect_state === 'none'
        || (error.data && (error.data.effect_state === 'none' || error.data.effectState === 'none'))
      ));
      // evaluate 是诊断/读取通道：超时也视为已结算，避免只读命令把标签页冻结。
      const settleUnknown = noEffect !== true && isUnknownOutcome(error) && method !== 'evaluate';
      intentLedger.finish(intent, settleUnknown ? 'unknown' : 'failed');
      throw error;
    }
  }
  
  /** 解析 --session-scope：显式 session 优先；否则把 scope 解析成唯一 sessionId。 */
  function applySessionScope(params) {
    if (!params || params.sessionScope === undefined) return;
    const scope = params.sessionScope;
    delete params.sessionScope;
    if (params.session !== undefined || params.sessionId !== undefined) return;
    const resolved = resolveSessionByScope([...sessions.values()], scope);
    if (resolved.error) throw new BridgeError(resolved.error, resolved.message);
    params.session = resolved.session.sessionId;
  }
  return { submitRouted, applySessionScope };
}
