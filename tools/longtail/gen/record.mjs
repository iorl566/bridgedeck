// tools/longtail/gen/record.mjs —— 长 record program 夹具生成器（确定性、≥200 步、含分支/循环/人工门）。
//
// 输出的是真实 record step v2 形状（`extension/src/record-program.js` 的输入），场景随后用
// 真实模块消费它：
//   - buildRecordProgram（节点/边界段/循环组/human-gate/校验/指纹）
//   - validateRecordProgram / validateRecordStep（程序级 + 单步校验）
//   - preflightReplay（回放前置：幂等/人工值/重试预算/循环）
//   - programFingerprint / summarizeRecordProgram / programDiff / mergeRecordPrograms
//
// 规模契约（default）：
//   - steps ≥ 200（实际 240）；
//   - 分支（kind=branch + method=navigate）≥ 4（实际 6，切成 7 个边界段）；
//   - 至少 3 组连续重复（循环组），至少 2 个 human-gate；
//   - 校验 error = 0（这是"真实录制能被接受"的前提），但保留 warning（循环/重试/人工）。
//
// 失败注入探针（buildRecordFailureProbes）故意生成非法程序，用来证明校验器给出的
// code/severity 是可解释的（不是"某处失败"）。

import { DEFAULT_SEED, rngFor, stableHash } from '../lib/prng.mjs';

export const RECORD_FIXTURE_VERSION = 1;

/** 夹具基准时间（固定，不读时钟）。 */
export const RECORD_BASE_AT = Date.parse('2026-03-01T00:00:00.000Z');

const ACTION_CYCLE = Object.freeze(['click', 'fill', 'select', 'observe', 'wait', 'scroll', 'hover']);

const IDEMPOTENT_METHODS = Object.freeze(new Set(['observe', 'snapshot', 'wait', 'scroll', 'hover', 'read']));

function methodIdempotent(method) {
  return IDEMPOTENT_METHODS.has(String(method));
}

/**
 * 生成 step 计划 token（不涉及随机：计数/顺序完全由规模参数决定）。
 * @returns {Array<{type:'normal'|'loop'|'human'|'boundary', index?:number, to?:number}>}
 */
function planTokens({ total, boundaries, loops, humanGates }) {
  const boundaryCount = Math.min(Math.max(0, boundaries), Math.max(1, Math.floor(total / 25)));
  const segments = boundaryCount + 1;
  const loopGroups = Math.min(Math.max(0, loops), segments, Math.max(1, Math.floor(total / 8)));
  const humanCount = Math.min(Math.max(0, humanGates), segments);
  const loopSteps = loopGroups * 3;
  const normalSteps = Math.max(0, total - boundaryCount - loopSteps - humanCount);

  const plan = [];
  let loopLeft = loopGroups;
  let humanLeft = humanCount;
  let normalLeft = normalSteps;
  for (let segment = 0; segment < segments; segment += 1) {
    if (loopLeft > 0) {
      plan.push({ type: 'loop', index: loopGroups - loopLeft });
      loopLeft -= 1;
    }
    const remainingSegments = segments - segment;
    const count = Math.ceil(normalLeft / remainingSegments);
    for (let step = 0; step < count && normalLeft > 0; step += 1) {
      plan.push({ type: 'normal' });
      normalLeft -= 1;
    }
    if (humanLeft > 0) {
      plan.push({ type: 'human', index: humanCount - humanLeft });
      humanLeft -= 1;
    }
    if (segment < boundaryCount) plan.push({ type: 'boundary', to: segment + 1 });
  }
  // 补齐/裁剪到精确步数（只动 normal token，保证分支/循环/人工的规模不被破坏）。
  // 注意：loop token 展开成 3 个 step，所以按"step 数"而不是 token 数对齐。
  const stepCost = (tokens) => tokens.reduce((sum, token) => sum + (token.type === 'loop' ? 3 : 1), 0);
  let padding = 0;
  while (stepCost(plan) < total) {
    plan.push({ type: 'normal' });
    padding += 1;
    if (padding > total) break;
  }
  while (stepCost(plan) > total) {
    let lastNormal = -1;
    for (let index = plan.length - 1; index >= 0; index -= 1) {
      if (plan[index].type === 'normal') {
        lastNormal = index;
        break;
      }
    }
    if (lastNormal < 0) break;
    plan.splice(lastNormal, 1);
  }
  return { plan, boundaryCount, loopGroups, humanCount };
}

/**
 * 生成长 record 夹具。
 * @param {{steps?:number, boundaries?:number, loops?:number, humanGates?:number,
 *          seed?:string|number, profile?:string, baseAt?:number}} [options]
 */
export function buildRecordFixture(options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const total = Math.max(16, Math.floor(Number(opts.steps) || 240));
  const boundaries = Math.max(0, Math.floor(Number(opts.boundaries) || 0));
  const loops = Math.max(0, Math.floor(Number(opts.loops) || 0));
  const humanGates = Math.max(0, Math.floor(Number(opts.humanGates) || 0));
  const seed = opts.seed == null ? DEFAULT_SEED : opts.seed;
  const profile = String(opts.profile || 'default');
  const baseAt = Number.isFinite(Number(opts.baseAt)) ? Number(opts.baseAt) : RECORD_BASE_AT;

  const { plan, boundaryCount, loopGroups, humanCount } = planTokens({ total, boundaries, loops, humanGates });
  const rng = rngFor(seed, 'record', total, boundaryCount, loopGroups, humanCount);
  const steps = [];
  let sequence = 0;
  let documentSegment = 0;
  let normalIndex = 0;
  let retries = 0;

  const push = (step) => {
    sequence += 1;
    const base = {
      model: 2,
      seq: sequence,
      at: baseAt + sequence * 250,
      url: 'https://longtail.test/app?step=' + sequence,
      documentId: 'doc-' + documentSegment,
      frameId: 0,
      actor: 'human',
      sourceKind: 'record',
      idempotent: true,
      risk: 'low',
    };
    steps.push({ ...base, ...step, ref: '@r' + sequence });
  };

  for (const token of plan) {
    if (token.type === 'boundary') {
      const from = 'doc-' + documentSegment;
      documentSegment += 1;
      const to = 'doc-' + documentSegment;
      const url = 'https://longtail.test/route/seg-' + documentSegment + '?seed=' + String(seed);
      push({
        kind: 'branch',
        method: 'navigate',
        documentId: to,
        branch: { boundary: 'navigate', from, to, url },
        params: { url },
        idempotent: true,
        risk: 'low',
      });
      continue;
    }
    if (token.type === 'loop') {
      // 连续 3 步同签名（target/method 相同、ref 不同）→ 真实 detectLoopGroups 会认成循环组。
      const n = Number(token.index) || 0;
      for (let repeat = 0; repeat < 3; repeat += 1) {
        push({
          kind: 'action',
          method: 'click',
          target: { selector: '#loop-' + String(n).padStart(2, '0') },
          params: { button: 'left', iteration: repeat },
          idempotent: false,
          risk: 'medium',
        });
      }
      continue;
    }
    if (token.type === 'human') {
      const n = Number(token.index) || 0;
      push({
        kind: 'human-gate',
        method: 'request-help',
        target: { selector: '#human-' + n },
        humanGate: { reason: '需要人工读取页面上的优惠码（第 ' + n + ' 处）', valueKind: 'text' },
        params: { value: '人工值-' + String(n + 1).padStart(2, '0') },
        idempotent: true,
        risk: 'low',
      });
      continue;
    }
    // normal：7 种动作轮转，保证签名相邻不重复（不会误判循环组）。
    const index = normalIndex;
    normalIndex += 1;
    const method = ACTION_CYCLE[index % ACTION_CYCLE.length];
    const idempotent = methodIdempotent(method);
    const common = {
      actor: index % 5 === 0 ? 'agent' : 'human',
      idempotent,
      risk: idempotent ? 'low' : 'medium',
      ...(index % 11 === 0 ? { expect: { text: '期望-' + index } } : {}),
    };
    switch (method) {
      case 'click':
        push({ kind: 'action', method, target: { selector: '#btn-' + index }, params: { button: 'left' }, ...common });
        break;
      case 'fill':
        push({ kind: 'action', method, target: { selector: '#field-' + index }, params: { value: '值-' + index }, ...common });
        break;
      case 'select':
        push({ kind: 'action', method, target: { selector: '#select-' + index }, params: { value: 'opt-' + (index % 5) }, ...common });
        break;
      case 'observe':
        push({ kind: 'observe', method: 'snapshot', target: { selector: '#region-' + index }, params: { vom: true }, ...common });
        break;
      case 'wait': {
        const retry = index % 9 === 0;
        if (retry) retries += 2;
        push({
          kind: 'wait',
          method,
          waitBeforeMs: 5 + (index % 20),
          params: { ms: 20 + (index % 40) },
          ...common,
          ...(retry ? { fallback: { onError: 'retry', retries: 2 } } : {}),
        });
        break;
      }
      case 'scroll':
        push({ kind: 'action', method, target: { selector: '#scroll-' + index }, params: { y: index * 8 }, ...common });
        break;
      default:
        push({ kind: 'action', method: 'hover', target: { selector: '#tab-' + index }, params: {}, ...common });
        break;
    }
  }

  const stats = {
    steps: steps.length,
    boundaries: steps.filter((step) => step.kind === 'branch').length,
    loops: loopGroups,
    humanGates: steps.filter((step) => step.humanGate).length,
    actions: steps.filter((step) => step.kind === 'action').length,
    observes: steps.filter((step) => step.kind === 'observe').length,
    waits: steps.filter((step) => step.kind === 'wait').length,
    idempotent: steps.filter((step) => step.idempotent).length,
    nonIdempotent: steps.filter((step) => !step.idempotent).length,
    retries,
    documents: new Set(steps.map((step) => step.documentId)).size,
  };
  const fingerprint = stableHash({
    version: RECORD_FIXTURE_VERSION,
    seed: String(seed),
    profile,
    plan: steps.map((step) => [step.kind, step.method, step.ref, step.documentId, step.idempotent ? 1 : 0,
      step.target ? (step.target.selector || '') : '', step.params ? JSON.stringify(step.params) : '']),
  });
  return {
    version: RECORD_FIXTURE_VERSION,
    kind: 'record',
    seed: String(seed),
    profile,
    baseAt,
    steps,
    stats,
    fingerprint,
  };
}

/**
 * 生成"变体程序"：用于 programDiff / mergeRecordPrograms 的真实输入。
 * 确定性地改 6 步参数、删 3 步、插 2 步。
 */
export function buildRecordVariant(fixture, { seed = DEFAULT_SEED } = {}) {
  const source = fixture && Array.isArray(fixture.steps) ? fixture.steps : [];
  const rng = rngFor(seed, 'record-variant', fixture ? fixture.fingerprint : 'empty');
  const variant = source.map((step) => ({ ...step, params: step.params ? { ...step.params } : {} }));
  const targets = [];
  for (let index = 0; index < variant.length; index += 1) {
    if (variant[index].kind === 'action' && variant[index].method === 'fill') targets.push(index);
  }
  const changed = [];
  for (let count = 0; count < Math.min(6, targets.length); count += 1) {
    const at = targets[rng.int(0, targets.length - 1)];
    if (!variant[at]) continue;
    variant[at].params.value = '变体值-' + count + '-' + rng.hex(4);
    changed.push(at);
  }
  const removed = [];
  for (let count = 0; count < 3 && variant.length > 10; count += 1) {
    const at = rng.int(2, variant.length - 3);
    if (variant[at] && variant[at].kind === 'action') {
      variant.splice(at, 1);
      removed.push(at);
    }
  }
  const added = [];
  for (let count = 0; count < 2; count += 1) {
    const step = {
      model: 2,
      seq: 900 + count,
      at: RECORD_BASE_AT + 9000 + count,
      url: 'https://longtail.test/app?added=' + count,
      documentId: 'doc-0',
      frameId: 0,
      actor: 'human',
      idempotent: true,
      risk: 'low',
      kind: 'wait',
      method: 'wait',
      waitBeforeMs: 2,
      params: { ms: 10 + count },
      ref: '@r-added-' + count,
    };
    variant.splice(rng.int(1, variant.length - 1), 0, step);
    added.push(step.ref);
  }
  return { steps: variant, changed, removed, added };
}

// ---------------------------------------------------------------------------
// 失败注入探针：验证校验器对非法程序的 code/severity 可解释
// ---------------------------------------------------------------------------

function probeStep(overrides = {}) {
  return {
    model: 2,
    seq: 1,
    at: RECORD_BASE_AT,
    url: 'https://longtail.test/app',
    documentId: 'doc-0',
    frameId: 0,
    actor: 'human',
    kind: 'action',
    method: 'click',
    target: { selector: '#probe' },
    params: { button: 'left' },
    idempotent: false,
    risk: 'medium',
    ref: '@p1',
    ...overrides,
  };
}

/** 每个探针：{name, steps, expectedCodes:[...], expectedSeverity}。 */
export function buildRecordFailureProbes() {
  return [
    {
      name: 'duplicate-ref',
      expectedCodes: ['STEP_REF_DUPLICATE'],
      expectedSeverity: 'error',
      steps: [
        probeStep({ ref: '@dup', seq: 1 }),
        probeStep({ ref: '@dup', seq: 2, target: { selector: '#probe-2' } }),
      ],
    },
    {
      name: 'retry-on-non-idempotent',
      expectedCodes: ['RETRY_NON_IDEMPOTENT'],
      expectedSeverity: 'error',
      steps: [
        probeStep({ idempotent: false, fallback: { onError: 'retry', retries: 2 } }),
      ],
    },
    {
      name: 'branch-navigate-without-url',
      expectedCodes: ['BRANCH_NAVIGATE_NO_URL'],
      expectedSeverity: 'error',
      steps: [
        probeStep({ kind: 'branch', method: 'navigate', branch: { boundary: 'navigate' }, idempotent: true }),
        probeStep({ seq: 2, ref: '@p2' }),
      ],
    },
    {
      name: 'loop-over-limit',
      expectedCodes: ['LOOP_TOO_LONG'],
      expectedSeverity: 'error',
      steps: Array.from({ length: 60 }, (_, index) => probeStep({
        ref: '@loop-' + index,
        seq: index + 1,
        target: { selector: '#loop-target' },
        idempotent: true,
      })),
    },
    {
      name: 'unknown-fallback',
      expectedCodes: ['FALLBACK_UNKNOWN'],
      expectedSeverity: 'warning',
      steps: [probeStep({ fallback: { onError: 'explode' }, ref: '@p1' })],
    },
  ];
}
