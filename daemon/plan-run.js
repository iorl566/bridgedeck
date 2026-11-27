// daemon/plan-run.js —— plan 逐步派发与汇总。

export function createPlanRunner({ BridgeError, dispatchInner, extensionDispatch }) {
function wireStepError(error) {
    if (!error) return { code: 'E_INTERNAL', message: '未知错误' };
    const code = typeof error.code === 'string' && error.code.startsWith('E_') ? error.code : 'E_INTERNAL';
    return { code, message: String(error.message || code), ...(error.data && typeof error.data === 'object' ? { data: error.data } : {}) };
  }
  
  /**
   * plan：逐步骤经由正常派发路径执行。
   * 这样每一步都有自己的账本记录与结算（首步失败即停、不重试），
   * 结束后再同步观察一次并带回结果。
   */
  async function runPlan(params, timeoutMs) {
    const steps = Array.isArray(params && params.steps) ? params.steps : null;
    if (!steps || !steps.length) throw new BridgeError('E_BAD_ARG', 'plan 需要非空 steps 数组');
    if (steps.length > 50) throw new BridgeError('E_BAD_ARG', 'plan 单次最多 50 步');
    const results = [];
    let failedAt = null;
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index] && typeof steps[index] === 'object' ? steps[index] : {};
      if (step.method === 'plan') throw new BridgeError('E_BAD_ARG', 'plan 不能嵌套 plan');
      const stepParams = step.params && typeof step.params === 'object' ? { ...step.params } : {};
      if (stepParams.tabId == null && params.tabId != null) stepParams.tabId = params.tabId;
      for (const key of ['context', 'observation', 'expect']) {
        if (stepParams[key] == null && params[key] != null) stepParams[key] = params[key];
      }
      if (stepParams.session === undefined && params.session !== undefined) stepParams.session = params.session;
      if (stepParams.sessionId === undefined && params.sessionId !== undefined) stepParams.sessionId = params.sessionId;
      try {
        const result = await dispatchInner(step.method, stepParams, timeoutMs);
        results.push({ index, method: step.method, ok: true, result });
      } catch (error) {
        results.push({ index, method: step.method, ok: false, error: wireStepError(error) });
        if (params.continueOnError !== true) {
          failedAt = index;
          break;
        }
      }
    }
    let observation = null;
    try {
      const base = {};
      if (params.tabId != null) base.tabId = params.tabId;
      if (params.session !== undefined) base.session = params.session;
      if (params.sessionId !== undefined) base.sessionId = params.sessionId;
      const obs = await extensionDispatch.dispatchExtension('observe', { ...base, force: true, probeHover: false }, timeoutMs);
      if (obs && typeof obs.observation === 'string') {
        observation = { text: obs.observation, refs: obs.refs, url: obs.url };
      }
    } catch {
      // 页面可能已关闭/导航失败：plan 结果仍然有效，不因观察失败覆盖。
    }
    return {
      steps: results,
      completed: results.filter((item) => item.ok).length,
      failedAt,
      ...(observation ? { observation } : {}),
    };
  }
  
  
  return { runPlan };
}
