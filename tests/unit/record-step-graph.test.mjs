// tests/unit/record-step-graph.test.mjs —— step 图模型（分支 / 并发 / 取消）：
//   1) 线性程序 → 全 serial 批次，与原回放顺序一致（默认行为不变）；
//   2) 分支选项解析（index/ref/条件求值/未知目标/回退目标）；
//   3) 并发区 fork/join/arm 配对、边类型、批次、宽度上限、交叉检测；
//   4) 取消域（close 语义、部分重叠、覆盖过长）与节点归属；
//   5) digest 确定性 + 摘要体积 + 校验分级。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BATCH_KINDS,
  CANCEL_MODES,
  GRAPH_CODES,
  GRAPH_LIMITS,
  PARALLEL_MODES,
  PARALLEL_ROLES,
  STEP_GRAPH_VERSION,
  buildStepGraph,
  cancelScopeAt,
  describeStepGraph,
  graphSuccessors,
  normalizeBranchOptions,
  normalizeCancel,
  normalizeGraphNode,
  normalizeParallel,
  parallelRegionAt,
  planStepBatches,
  stepGraphDigest,
  summarizeStepGraph,
  validateStepGraph,
} from '../../extension/src/lib/record-step-graph.js';

let refCounter = 0;
function step(overrides = {}) {
  refCounter += 1;
  const base = {
    model: 2,
    ref: 'g' + refCounter,
    kind: 'action',
    type: 'action',
    method: 'click',
    params: { selector: '#go' },
    target: { selector: '#go' },
    idempotent: false,
    fallback: { onError: 'stop', skipReason: '' },
    risk: 'browser_mutation',
    evidence: { seq: refCounter, index: refCounter - 1, frameId: 0, documentId: 'doc-1', revision: 1, actor: 'human', url: 'https://a.test/f', at: 1_700_000_000_000 + refCounter },
    sourceKind: 'click',
  };
  return {
    ...base,
    ...overrides,
    params: { ...base.params, ...(overrides.params || {}) },
    evidence: { ...base.evidence, ...(overrides.evidence || {}) },
  };
}

function fork(groupId, overrides = {}) {
  return step({ kind: 'wait', method: 'wait', idempotent: true, parallel: { groupId, role: PARALLEL_ROLES.FORK }, ...overrides });
}

function arm(groupId, armIndex, overrides = {}) {
  return step({ parallel: { groupId, role: PARALLEL_ROLES.ARM, arm: armIndex }, ...overrides });
}

function join(groupId, overrides = {}) {
  return step({ kind: 'wait', method: 'wait', idempotent: true, parallel: { groupId, role: PARALLEL_ROLES.JOIN }, ...overrides });
}

function navigate(overrides = {}) {
  return step({
    kind: 'branch',
    type: 'branch',
    method: 'navigate',
    params: { url: 'https://a.test/next' },
    idempotent: true,
    risk: 'read_only',
    branch: { boundary: 'document', source: 'navigation', url: 'https://a.test/next' },
    sourceKind: 'navigate',
    ...overrides,
  });
}

test('normalizeParallel：默认无并发；显式 fork/arm/join 保留；非法/缺 group 返回 null', () => {
  assert.equal(normalizeParallel(null), null);
  assert.equal(normalizeParallel(undefined), null);
  assert.equal(normalizeParallel(false), null);
  const auto = normalizeParallel(true, { index: 2 });
  assert.equal(auto.groupId, 'group-3');
  assert.equal(auto.role, 'auto', '没写角色时交给图构建阶段推断');
  assert.equal(auto.roleExplicit, false);
  assert.equal(auto.waitFor, PARALLEL_MODES.ALL);

  const explicit = normalizeParallel({ group: 'g1', role: 'fork', waitFor: 'race', label: '双开', failFast: true });
  assert.equal(explicit.groupId, 'g1');
  assert.equal(explicit.role, 'fork');
  assert.equal(explicit.roleExplicit, true);
  assert.equal(explicit.waitFor, 'race');
  assert.equal(explicit.label, '双开');
  assert.equal(explicit.failFast, true);

  const armValue = normalizeParallel({ groupId: 'g1', arm: 3, mode: 'any' });
  assert.equal(armValue.role, 'auto');
  assert.equal(armValue.arm, 3);
  assert.equal(armValue.waitFor, 'any');
  assert.equal(normalizeParallel({ waitFor: 'all' }).groupId, 'group-1', '缺 groupId 时按位置兜底一个组');
  assert.equal(normalizeParallel({ groupId: '' }, { index: 9 }).groupId, 'group-10');
  assert.equal(normalizeParallel(42), null);
});

test('normalizeCancel：scope/模式/超时/close 规整；非法返回 null', () => {
  assert.equal(normalizeCancel(null), null);
  assert.equal(normalizeCancel({}).scope, 'scope-1', '没有 scope/id/name 时按位置兜底');
  assert.equal(normalizeCancel({ id: '' }, { index: 4 }).scope, 'scope-5');
  const value = normalizeCancel(true, { index: 4 });
  assert.equal(value.scope, 'scope-5');
  assert.equal(value.onCancel, CANCEL_MODES.ABORT);
  assert.equal(value.modeExplicit, false);

  const explicit = normalizeCancel({ scope: 'pay', onCancel: 'skip', afterMs: 900, reason: '超时', close: true, token: 't1' });
  assert.equal(explicit.scope, 'pay');
  assert.equal(explicit.onCancel, 'skip');
  assert.equal(explicit.modeExplicit, true);
  assert.equal(explicit.afterMs, 900);
  assert.equal(explicit.reason, '超时');
  assert.equal(explicit.close, true);
  assert.equal(explicit.token, 't1');

  const end = normalizeCancel({ id: 'x', end: true, mode: 'continue' });
  assert.equal(end.close, true);
  assert.equal(end.onCancel, 'continue');
  assert.equal(normalizeCancel('nope'), null);
});

test('normalizeBranchOptions：when/expect 归一化、to 数字/ref、label 兜底', () => {
  assert.deepEqual(normalizeBranchOptions(step()), []);
  const options = normalizeBranchOptions({
    branch: {
      options: [
        { label: 'a', when: { urlIncludes: '/a', selector: '#x', status: 'ok' }, to: 3 },
        { when: { urlIncludes: '/b' }, next: 4 },
        { to: 'ref-b', expect: { urlIncludes: '/c' } },
        'bad',
      ],
    },
  });
  assert.equal(options.length, 3);
  assert.equal(options[0].label, 'a');
  assert.equal(options[0].to, 3);
  assert.deepEqual(options[0].when, { urlIncludes: '/a', selector: '#x', status: 'ok' });
  assert.equal(options[1].label, 'option-2');
  assert.equal(options[1].to, 4);
  assert.equal(options[2].to, 'ref-b');
  assert.equal(options[2].expect.urlIncludes, '/c');
});

test('normalizeGraphNode：旧 step 只多出 parallel/cancel/branchOptions=null/[]', () => {
  const node = normalizeGraphNode(step({ signature: 'action|click|#go' }), 7);
  assert.equal(node.signature, 'action|click|#go');
  assert.equal(node.parallel, null);
  assert.equal(node.cancel, null);
  assert.deepEqual(node.branchOptions, []);
  assert.equal(node.targetText, '#go');
  assert.equal(node.documentId, 'doc-1');
  assert.equal(normalizeGraphNode(null, 0), null);
  assert.equal(normalizeGraphNode(42, 0), null);
});

test('buildStepGraph：线性程序 = 一条链 + 全 serial 批次（默认行为不变）', () => {
  const steps = [step({ ref: 'l1' }), step({ ref: 'l2' }), step({ ref: 'l3' })];
  const graph = buildStepGraph(steps);
  assert.equal(graph.version, STEP_GRAPH_VERSION);
  assert.equal(graph.nodes.length, 3);
  assert.deepEqual(graph.nodes.map((node) => node.ref), ['l1', 'l2', 'l3']);
  assert.equal(graph.edges.length, 2);
  assert.deepEqual(graph.edges.map((edge) => edge.kind), ['linear', 'linear']);
  assert.equal(graph.branches.length, 0);
  assert.equal(graph.parallel.length, 0);
  assert.equal(graph.cancels.length, 0);
  assert.equal(graph.schedule.length, 3);
  assert.deepEqual(graph.schedule.map((batch) => batch.kind), [BATCH_KINDS.SERIAL, BATCH_KINDS.SERIAL, BATCH_KINDS.SERIAL]);
  assert.deepEqual(graph.schedule.map((batch) => batch.node.ref), ['l1', 'l2', 'l3']);
  assert.equal(graph.stats.total, 3);
  assert.equal(graph.stats.serial, 3);
  assert.equal(graph.stats.branches, 0);
  assert.match(graph.digest, /^g[0-9a-f]{8}-3$/);
  assert.deepEqual(graphSuccessors(graph, 0), [1]);
  assert.deepEqual(graphSuccessors(graph, 2), []);
  assert.equal(parallelRegionAt(graph, 1), null);
  assert.equal(cancelScopeAt(graph, 1), null);
});

test('buildStepGraph：空程序 → 空节点/空批次 + GRAPH_EMPTY warning，digest 确定', () => {
  const graph = buildStepGraph([]);
  assert.equal(graph.nodes.length, 0);
  assert.equal(graph.schedule.length, 0);
  assert.equal(graph.digest, 'g' + graph.digest.slice(1));
  const check = validateStepGraph(graph);
  assert.equal(check.ok, true);
  assert.equal(check.byCode[GRAPH_CODES.GRAPH_EMPTY], 1);
  assert.equal(summarizeStepGraph(graph).nodes, 0);
  assert.equal(summarizeStepGraph(null), null);
  assert.match(describeStepGraph(graph), /nodes=0/);
});

test('buildStepGraph：分支选项按 index/ref 解析，命中方向与未知目标分级', () => {
  const steps = [
    navigate({ ref: 'nav' }),
    step({ ref: 'after', method: 'click' }),
    step({ ref: 'target', method: 'hover', idempotent: true }),
    step({ ref: 'bad' }),
  ];
  const graph = buildStepGraph([
    { ...navigate({ ref: 'nav' }), branch: { boundary: 'document', url: 'https://a.test/x', options: [{ label: 'byIndex', to: 2 }, { label: 'byRef', to: 'target' }, { label: 'missing', to: 99 }] } },
    ...steps.slice(1),
  ]);
  assert.equal(graph.branches.length, 1);
  const branch = graph.branches[0];
  assert.equal(branch.index, 0);
  assert.equal(branch.ref, 'nav');
  assert.equal(branch.fallthrough, 1);
  assert.equal(branch.options.length, 3);
  assert.equal(branch.options[0].to, 2);
  assert.equal(branch.options[1].to, 2, 'byRef 解析成同一下标');
  assert.equal(branch.options[2].to, null);
  assert.equal(graph.issues.some((issue) => issue.code === GRAPH_CODES.BRANCH_TARGET_UNKNOWN), true);
  // 分支边只连解析成功的目标；未知目标不产生边。
  const branchEdges = graph.edges.filter((edge) => edge.kind === 'branch');
  assert.equal(branchEdges.length, 2);
  assert.deepEqual(branchEdges.map((edge) => edge.to), [2, 2]);
  assert.equal(graph.stats.branches, 1);
  const batches = planStepBatches(graph);
  assert.equal(batches[0].kind, BATCH_KINDS.BRANCH);
  assert.equal(batches[1].kind, BATCH_KINDS.SERIAL);
});

test('buildStepGraph：分支回退目标 = warning（条件边不构成环）；无条件选项按命中', () => {
  const graph = buildStepGraph([
    { ...navigate({ ref: 'loop' }), branch: { boundary: 'document', url: 'https://a.test/', options: [{ label: 'back', to: 0 }] } },
    step({ ref: 'next' }),
  ]);
  assert.equal(graph.issues.some((issue) => issue.code === GRAPH_CODES.BRANCH_TARGET_BACKWARD), true);
  assert.equal(graph.issues.some((issue) => issue.code === GRAPH_CODES.CYCLE_DETECTED), false, 'branch 是条件边，不算环');
  assert.equal(validateStepGraph(graph).ok, true);
});

test('buildStepGraph：并发区 fork/arm/join 配对、边类型、批次与 arm 分组', () => {
  const steps = [
    step({ ref: 'pre' }),
    fork('grp', { ref: 'grp-fork' }),
    arm('grp', 0, { ref: 'a0', params: { selector: '#a0' } }),
    arm('grp', 1, { ref: 'a1', params: { selector: '#a1' } }),
    join('grp', { ref: 'grp-join' }),
    step({ ref: 'post' }),
  ];
  const graph = buildStepGraph(steps);
  assert.equal(graph.parallel.length, 1);
  const region = graph.parallel[0];
  assert.equal(region.groupId, 'grp');
  assert.equal(region.forkIndex, 1);
  assert.equal(region.joinIndex, 4);
  assert.equal(region.mode, 'paired');
  assert.equal(region.waitFor, PARALLEL_MODES.ALL);
  assert.equal(region.arms.length, 2);
  assert.deepEqual(region.arms[0].memberIndexes, [2]);
  assert.deepEqual(region.arms[1].memberIndexes, [3]);
  assert.deepEqual(region.arms[0].refs, ['a0']);
  assert.equal(graph.edges.filter((edge) => edge.kind === 'fork').length, 2);
  assert.equal(graph.edges.filter((edge) => edge.kind === 'join').length, 2);
  assert.equal(graph.edges.filter((edge) => edge.kind === 'arm').length, 0, '每个 arm 只有一个节点');
  // fork 之后不再有“fork→下一个兄弟”的线性边（否则会被当成串行）。
  assert.equal(graph.edges.some((edge) => edge.from === 1 && edge.to === 2 && edge.kind === 'linear'), false);
  assert.deepEqual(graphSuccessors(graph, 1), [2, 3]);
  assert.deepEqual(graphSuccessors(graph, 2), [4]);
  assert.deepEqual(graphSuccessors(graph, 4), [5]);
  const batches = planStepBatches(graph);
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map((batch) => batch.kind), [BATCH_KINDS.SERIAL, BATCH_KINDS.PARALLEL, BATCH_KINDS.SERIAL]);
  assert.equal(batches[1].arms.length, 2);
  assert.equal(batches[1].arms[0].steps[0].ref, 'a0');
  assert.equal(batches[1].joinIndex, 4);
  assert.equal(batches[2].node.ref, 'post');
  assert.equal(graph.stats.parallelGroups, 1);
  assert.equal(graph.stats.parallelArms, 2);
  assert.equal(graph.stats.maxWidth, 2);
  assert.equal(parallelRegionAt(graph, 2).groupId, 'grp');
  assert.equal(parallelRegionAt(graph, 0), null);
});

test('buildStepGraph：并发区推断（只写 groupId 时首=fork 尾=join）与缺 join 报错', () => {
  const inferred = buildStepGraph([
    step({ ref: 'f', kind: 'wait', method: 'wait', idempotent: true, parallel: { groupId: 'auto' } }),
    step({ ref: 'a', parallel: { groupId: 'auto', arm: 0 } }),
    step({ ref: 'b', parallel: { groupId: 'auto', arm: 1 } }),
    step({ ref: 'j', kind: 'wait', method: 'wait', idempotent: true, parallel: { groupId: 'auto' } }),
  ]);
  assert.equal(inferred.parallel[0].forkIndex, 0);
  assert.equal(inferred.parallel[0].joinIndex, 3);
  assert.equal(inferred.parallel[0].arms.length, 2);

  const open = buildStepGraph([
    step({ ref: 'f', kind: 'wait', method: 'wait', idempotent: true, parallel: { groupId: 'open', role: 'fork' } }),
    step({ ref: 'a', parallel: { groupId: 'open', role: 'arm', arm: 0 } }),
  ]);
  assert.equal(open.issues.some((issue) => issue.code === GRAPH_CODES.FORK_NO_JOIN), true);
  assert.equal(validateStepGraph(open).ok, false);
});

test('buildStepGraph：并发宽度上限 / 多 join 警告 / 交叉并发区报错 / arm 内 human-gate', () => {
  const wide = buildStepGraph([
    fork('w', { ref: 'f' }),
    arm('w', 0, { ref: 'w0' }),
    arm('w', 1, { ref: 'w1' }),
    join('w', { ref: 'j' }),
  ], { maxParallelArms: 1 });
  assert.equal(wide.issues.some((issue) => issue.code === GRAPH_CODES.PARALLEL_TOO_WIDE), true);
  assert.equal(validateStepGraph(wide).ok, false);

  const humanArm = buildStepGraph([
    fork('h', { ref: 'hf' }),
    arm('h', 0, { ref: 'h0', humanGate: { reason: '补值', valueKind: 'text' }, params: {} }),
    join('h', { ref: 'hj' }),
  ]);
  assert.equal(humanArm.issues.some((issue) => issue.code === GRAPH_CODES.HUMAN_GATE_IN_PARALLEL), true);
  assert.equal(humanArm.stats.humanGates, 1);

  const crossing = buildStepGraph([
    fork('a', { ref: 'af' }),
    arm('a', 0, { ref: 'a0' }),
    fork('b', { ref: 'bf' }),
    arm('b', 0, { ref: 'b0' }),
    join('a', { ref: 'aj' }),
    join('b', { ref: 'bj' }),
  ]);
  assert.equal(crossing.issues.some((issue) => issue.code === GRAPH_CODES.PARALLEL_NESTED), true);
});

test('buildStepGraph：取消域 close 语义 / 覆盖范围 / 节点归属取最内层', () => {
  const graph = buildStepGraph([
    step({ ref: 'c1', cancel: { scope: 'pay', onCancel: 'skip', afterMs: 200 } }),
    step({ ref: 'c2', cancel: { scope: 'pay' } }),
    step({ ref: 'c3', cancel: { scope: 'pay', close: true } }),
    step({ ref: 'c4', cancel: { scope: 'tiny', onCancel: 'continue' } }),
  ]);
  assert.equal(graph.cancels.length, 2);
  const pay = graph.cancels.find((scope) => scope.scope === 'pay');
  assert.equal(pay.from, 0);
  assert.equal(pay.to, 2);
  assert.equal(pay.mode, 'skip', 'close 节点不贡献取消模式');
  assert.equal(pay.afterMs, 200);
  assert.equal(pay.nodes, 3);
  const tiny = graph.cancels.find((scope) => scope.scope === 'tiny');
  assert.equal(tiny.from, 3);
  assert.equal(tiny.to, 3);
  assert.equal(tiny.mode, 'continue');
  assert.equal(cancelScopeAt(graph, 1).scope, 'pay');
  assert.equal(cancelScopeAt(graph, 3).scope, 'tiny');
  assert.equal(cancelScopeAt(graph, 9), null);
  assert.equal(graph.stats.cancels, 2);
  assert.equal(graph.stats.cancelNodes, 4);
});

test('buildStepGraph：取消域部分重叠 = error；覆盖过长 = warning；上限 = error', () => {
  const overlap = buildStepGraph([
    step({ ref: 'o1', cancel: { scope: 'x' } }),
    step({ ref: 'o2', cancel: { scope: 'y' } }),
    step({ ref: 'o3', cancel: { scope: 'x', close: true } }),
    step({ ref: 'o4', cancel: { scope: 'y', close: true } }),
  ]);
  assert.equal(overlap.issues.some((issue) => issue.code === GRAPH_CODES.CANCEL_SCOPE_OVERLAP), true);
  assert.equal(validateStepGraph(overlap).ok, false);

  const long = buildStepGraph([
    step({ ref: 'p1', cancel: { scope: 'long' } }),
    step({ ref: 'p2' }),
    step({ ref: 'p3' }),
    step({ ref: 'p4', cancel: { scope: 'long', close: true } }),
  ], { maxCancelNodes: 2 });
  assert.equal(long.issues.some((issue) => issue.code === GRAPH_CODES.CANCEL_SCOPE_TOO_LONG), true);

  const tooMany = buildStepGraph([
    step({ ref: 'q1', cancel: { scope: 's1' } }),
    step({ ref: 'q2', cancel: { scope: 's2' } }),
  ], { maxCancelScopes: 1 });
  assert.equal(tooMany.issues.some((issue) => issue.code === GRAPH_CODES.CANCEL_SCOPE_UNKNOWN), true);
  assert.equal(validateStepGraph(tooMany).ok, false);
});

test('buildStepGraph：未知 kind/缺 ref 有分级警告；节点数上限截断', () => {
  const graph = buildStepGraph([step({ ref: '', kind: 'teleport' }), step({ ref: 'x' })]);
  assert.equal(graph.issues.some((issue) => issue.code === GRAPH_CODES.UNKNOWN_STEP_KIND), true);
  assert.equal(graph.issues.some((issue) => issue.code === GRAPH_CODES.EDGE_UNKNOWN), true);
  assert.equal(validateStepGraph(graph).ok, true, '未知 kind 只是 warning');

  const limited = buildStepGraph([step({ ref: 'n1' }), step({ ref: 'n2' }), step({ ref: 'n3' })], { maxNodes: 2 });
  assert.equal(limited.nodes.length, 2);
  assert.equal(validateStepGraph(limited).ok, false, '节点数超上限是 error');
  assert.equal(validateStepGraph(limited).byCode[GRAPH_CODES.GRAPH_TOO_LARGE] >= 1, true);
});

test('digest/摘要/描述：结构确定、参数值不影响图 digest、摘要体积有界', () => {
  const left = buildStepGraph([step({ ref: 'd1', params: { selector: '#a', value: 'one' } })]);
  const right = buildStepGraph([step({ ref: 'd1', params: { selector: '#a', value: 'two' } })]);
  assert.equal(left.digest, right.digest, '图结构相同则 digest 相同（参数值不进图 digest）');
  const other = buildStepGraph([step({ ref: 'd1', kind: 'observe', method: 'observe' })]);
  assert.notEqual(left.digest, other.digest);
  assert.equal(stepGraphDigest(left), left.digest);
  assert.equal(stepGraphDigest(null), '');

  const summary = summarizeStepGraph(left);
  assert.equal(summary.version, STEP_GRAPH_VERSION);
  assert.equal(summary.nodes, 2 - 1);
  assert.equal(summary.digest, left.digest);
  assert.ok(JSON.stringify(summary).length < 400, '挂事件的摘要必须小');
  assert.match(describeStepGraph(left), /nodes=1/);
  assert.match(describeStepGraph(null), /无图/);
  assert.ok(GRAPH_LIMITS.maxNodes >= 100);
});

test('validateStepGraph：直接传步骤数组也能校验；规则数与分级正确', () => {
  const valid = validateStepGraph([step({ ref: 'v1' }), step({ ref: 'v2' })]);
  assert.equal(valid.ok, true);
  assert.equal(valid.errors, 0);
  assert.equal(valid.checked.nodes, 2);
  assert.equal(valid.rules_evaluated >= 10, true);

  const invalid = validateStepGraph([
    fork('bad', { ref: 'bf' }),
    arm('bad', 0, { ref: 'b0' }),
  ]);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errors >= 1, true);
  assert.equal(invalid.byCode[GRAPH_CODES.FORK_NO_JOIN], 1);
});

test('normalizeGraphNode：接受 record-program 的 node 形状并保持默认字段', () => {
  const node = normalizeGraphNode({
    node: true,
    index: 2,
    ref: 'pn1',
    kind: 'action',
    method: 'click',
    signature: 'action|click|#go',
    idempotent: false,
    params: { selector: '#go' },
    target: { selector: '#go' },
    humanGate: null,
    branch: null,
    fallback: { onError: 'stop' },
    expect: null,
    repeat: 0,
    waitBeforeMs: 0,
    seq: 3,
    at: 1000,
    documentId: 'doc-n',
    frameId: 0,
    url: 'https://a.test/',
    actor: 'human',
  }, 0);
  assert.equal(node.index, 2);
  assert.equal(node.ref, 'pn1');
  assert.equal(node.signature, 'action|click|#go');
  assert.equal(node.parallel, null);
  assert.equal(node.cancel, null);
  assert.deepEqual(node.branchOptions, []);
  assert.equal(node.targetText, '#go');
  assert.equal(node.documentId, 'doc-n');
});

test('取消域嵌套：最内层优先；空图 digest 为空字符串、描述稳定', () => {
  const nested = buildStepGraph([
    step({ ref: 'n0', cancel: { scope: 'outer' } }),
    step({ ref: 'n1', cancel: { scope: 'inner', onCancel: 'skip' } }),
    step({ ref: 'n2', cancel: { scope: 'inner', close: true } }),
    step({ ref: 'n3', cancel: { scope: 'outer', close: true } }),
  ]);
  assert.equal(nested.cancels.length, 2);
  assert.equal(nested.issues.some((issue) => issue.code === GRAPH_CODES.CANCEL_SCOPE_OVERLAP), false, '包含关系不是歧义');
  assert.equal(cancelScopeAt(nested, 1).scope, 'inner', '嵌套时取最内层');
  assert.equal(cancelScopeAt(nested, 0).scope, 'outer');
  assert.equal(stepGraphDigest(null), '');
  assert.match(describeStepGraph(nested), /cancels=2/);
  assert.match(describeStepGraph(buildStepGraph([step({ ref: 'h', humanGate: { reason: 'x', valueKind: 'text' }, params: {} })])), /human=1/);
});
