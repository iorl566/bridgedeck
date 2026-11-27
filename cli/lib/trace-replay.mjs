// cli/lib/trace-replay.mjs —— Trace v3 → plan steps 的纯函数转换（replay 命令用）。
//
// 只做“读入 trace.export JSON → plan 可执行 steps”的确定性映射，便于单测与 dry-run：
// - 输入：record export 的 trace.json（{version:3, steps:[{kind, method, params, target,...}]}）或 steps 数组；
// - 输出：{ steps: [{ method, params }], skipped: [{reason, index, kind}] }；
// - 规则：只回放 action/observe/wait；human-gate/branch 等交互步骤跳过并给出原因；
// - target.ref 在 params 缺 ref/selector 时回填（record step 的 ref 可能是过期 @eN，回放前需人工确认，
//   dry-run 会提示）。
export function normalizeTraceSteps(input) {
  const source = Array.isArray(input) ? input : (input && Array.isArray(input.steps) ? input.steps : null);
  if (!source) {
    throw new Error('trace 缺少 steps 数组（期望 {version:3, steps:[...]}）');
  }
  const replayableKinds = new Set(['action', 'observe', 'wait']);
  const steps = [];
  const skipped = [];
  source.forEach((step, index) => {
    if (!step || typeof step !== 'object') {
      skipped.push({ index, reason: 'step 不是对象' });
      return;
    }
    const method = typeof step.method === 'string' ? step.method : '';
    if (!method) {
      skipped.push({ index, reason: '缺少 method', kind: step.kind || null });
      return;
    }
    const kind = typeof step.kind === 'string' ? step.kind : 'action';
    if (!replayableKinds.has(kind)) {
      skipped.push({ index, reason: '非可回放步骤（' + kind + '）', kind });
      return;
    }
    const params = { ...(step.params && typeof step.params === 'object' ? step.params : {}) };
    const target = step.target && typeof step.target === 'object' ? step.target : null;
    if (target) {
      if (params.ref === undefined && typeof target.ref === 'string' && target.ref) params.ref = target.ref;
      if (params.selector === undefined && typeof target.selector === 'string' && target.selector) params.selector = target.selector;
      if (params.url === undefined && typeof target.url === 'string' && target.url) params.url = target.url;
    }
    steps.push({ method, params });
  });
  return { steps, skipped };
}

/** 回放前的 dry-run 摘要（不触达浏览器）。 */
export function summarizeReplayPlan(normalized, options = {}) {
  const { steps, skipped } = normalized || { steps: [], skipped: [] };
  const refs = steps
    .map((step, index) => (step.params && step.params.ref ? { index, ref: step.params.ref, method: step.method } : null))
    .filter(Boolean);
  return {
    source: options.source || null,
    totalSteps: steps.length,
    skipped: skipped.length,
    skippedReasons: skipped.slice(0, 20),
    methods: steps.map((step) => step.method),
    staleRefWarning: refs.length
      ? refs.slice(0, 10).map((item) => item.method + ' 使用记录时的 @ref ' + item.ref + '；回放前请确认目标仍在原位置')
      : [],
  };
}
