// tests/unit/protocol-bsk-floors.test.mjs —— 兼容基线的 6 个 feature floor（M6-P0②）。
//
// 证明三件事（都是机械可复核的）：
//   1) 6 个门在单一目录里存在，floor=1.9，且带 基线侧原始 floor/operation 证据；
//   2) 触发面与 参考实现的 FeatureWhen 同形（Present/True/Equals/ControlPolicy/Always）；
//   3) 协议闸门在三处一致：1.8 拒绝（E_PROTOCOL_UNSUPPORTED，data.feature 精确）、
//      1.9 放行、降级声明与生成物/文档都来自同一份目录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FEATURE_FALLBACKS,
  FEATURE_FLOORS,
  FEATURE_META,
  FEATURE_MIGRATION,
  FEATURE_NAMES,
  FEATURE_PARAM_RULES,
  METHOD_FEATURE,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
} from '../../lib/method-catalog.mjs';
import {
  FEATURE_MIN_PROTOCOL,
  compatibilityMatrix,
  degradationOfCall,
  featureMatrix,
  featureShortfall,
  featuresForCall,
  floorDecision,
  protocolGate,
} from '../../lib/protocol-features.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OLD = Object.freeze({ protocol: PROTOCOL_BASELINE });
const CURRENT = Object.freeze({ protocol: PROTOCOL_CURRENT });

/** 6 个兼容门 → 我方位面与基线证据。 */
const COMPAT_FEATURES = Object.freeze({
  borrow_confirmation_timeout: {
    compatFloor: '1.2',
    compatOperation: 'tab borrow --timeout',
    trigger: ['tab.borrow', { tabId: 3, confirmationTimeoutMs: 30000 }],
    negative: ['tab.borrow', { tabId: 3 }],
    fallbackKind: 'omit-param',
    fallbackParam: 'confirmationTimeoutMs',
  },
  interaction_policy: {
    compatFloor: '1.3',
    compatOperation: 'request-help',
    trigger: ['request-help', { reason: 'need human' }],
    negative: ['click', { ref: '@e1' }],
    fallbackKind: 'none',
  },
  incognito_sessions: {
    compatFloor: '1.4',
    compatOperation: 'session start --incognito',
    trigger: ['session.start', { incognito: true }],
    negative: ['session.start', { incognito: false }],
    fallbackKind: 'omit-param',
    fallbackParam: 'incognito',
  },
  dialog_control: {
    compatFloor: '1.5',
    compatOperation: 'dialog and operation control',
    trigger: ['dialog.accept', { tabId: 5 }],
    negative: ['click', { ref: '@e1' }],
    fallbackKind: 'none',
  },
  click_move_click: {
    compatFloor: '1.7',
    compatOperation: 'click-move-click',
    trigger: ['drag', { from: '@e1', to: '@e2', mode: 'click-move-click' }],
    negative: ['drag', { from: '@e1', to: '@e2', mode: 'press-move-release' }],
    fallbackKind: 'omit-param',
    fallbackParam: 'mode',
  },
  target_control: {
    compatFloor: '1.8',
    compatOperation: 'target control',
    trigger: ['cooperate.sync', { policy: 'target' }],
    negative: ['cooperate.sync', { policy: 'strict' }],
    fallbackKind: 'omit-param',
    fallbackParam: 'policy',
  },
});

test('6 个兼容门进入单一目录：floor=1.9 + 基线 原始 floor/operation 证据', () => {
  for (const [feature, spec] of Object.entries(COMPAT_FEATURES)) {
    assert.ok(FEATURE_NAMES.includes(feature), feature + ' 不在 FEATURE_NAMES');
    assert.equal(FEATURE_FLOORS[feature], '1.9', feature + ' 我方 floor');
    assert.equal(FEATURE_MIN_PROTOCOL[feature], '1.9', feature + ' 兼容表引用');
    assert.equal(FEATURE_META[feature].compatFloor, spec.compatFloor, feature + ' floor 证据');
    assert.equal(FEATURE_META[feature].compatOperation, spec.compatOperation, feature + ' operation 证据');
    assert.equal(typeof FEATURE_META[feature].label, 'string');
    // 三处一致：降级声明与迁移建议必须与目录同名同项。
    assert.equal(FEATURE_FALLBACKS[feature].kind, spec.fallbackKind, feature + ' 降级 kind');
    if (spec.fallbackParam) assert.equal(FEATURE_FALLBACKS[feature].param, spec.fallbackParam, feature + ' 降级参数');
    assert.equal(typeof FEATURE_MIGRATION[feature], 'string');
    assert.ok(FEATURE_MIGRATION[feature].includes('1.9'), feature + ' 迁移建议必须提到 1.9');
  }
  assert.equal(Object.keys(FEATURE_FLOORS).length, 15);
});

test('触发面与 FeatureWhen 同形：每个门只由对应参数/方法触发', () => {
  for (const [feature, spec] of Object.entries(COMPAT_FEATURES)) {
    const [method, params] = spec.trigger;
    assert.deepEqual(featuresForCall(method, params), [feature], feature + ' 正向触发表');
    const [negMethod, negParams] = spec.negative;
    assert.deepEqual(featuresForCall(negMethod, negParams), [], feature + ' 反向不应触发');
    const decision = floorDecision(method, params);
    assert.equal(decision.floor, '1.9', feature);
    assert.deepEqual([...decision.features], [feature], feature);
    assert.equal(decision.sources.length, 1, feature + ' 来源唯一');
  }
  // 参数级规则的 kind 覆盖 Present/True/Equals/ControlPolicy 四种形态。
  const kinds = new Set(FEATURE_PARAM_RULES.map((rule) => rule.kind));
  for (const kind of ['defined', 'true', 'equals']) assert.ok(kinds.has(kind), '缺少参数规则 kind：' + kind);
});

test('门覆盖的方法/参数在 METHOD_FEATURE 反向表与参数规则表里可查', () => {
  // 方法级门（interaction_policy / dialog_control）
  assert.equal(METHOD_FEATURE['request-help'], 'interaction_policy');
  for (const method of ['dialog.arm', 'dialog.disarm', 'dialog.accept', 'dialog.dismiss', 'dialog.handle', 'dialog.list', 'dialog.status', 'operation.await', 'operation.cancel']) {
    assert.equal(METHOD_FEATURE[method], 'dialog_control', method);
  }
  // 参数级门（borrow/incognito/click-move-click/target-control）
  const paramsFor = (feature) => FEATURE_PARAM_RULES.filter((rule) => rule.feature === feature).map((rule) => rule.param).sort();
  assert.deepEqual(paramsFor('borrow_confirmation_timeout'), ['confirmationTimeoutMs']);
  assert.deepEqual(paramsFor('incognito_sessions'), ['incognito']);
  assert.deepEqual(paramsFor('click_move_click'), ['mode']);
  assert.deepEqual(paramsFor('target_control'), ['control_policy', 'policy']);
});

test('协议闸门三处一致：1.8 拒绝（精确 data）/ 1.9 放行 / 版本矩阵同步', () => {
  for (const [feature, spec] of Object.entries(COMPAT_FEATURES)) {
    const [method, params] = spec.trigger;
    const denied = protocolGate(OLD, method, params);
    assert.equal(denied.ok, false, feature + ' 1.8 应拒绝');
    assert.equal(denied.code, 'E_PROTOCOL_UNSUPPORTED');
    assert.equal(denied.data.feature, feature, feature + ' data.feature 精确');
    assert.equal(denied.data.required, '1.9');
    assert.equal(denied.data.actual, '1.8');
    assert.deepEqual(denied.features, [feature], feature + ' 不得夹带无关特性');
    assert.deepEqual(featureShortfall(CURRENT, [feature]), [], feature + ' 1.9 无缺口');
    assert.equal(protocolGate(CURRENT, method, params).ok, true, feature + ' 1.9 应放行');
    // 版本矩阵：基线全拒、当前全允（与 compatibilityMatrix 的单一事实一致）
    const matrix = compatibilityMatrix();
    assert.equal(matrix.matrix['1.8'][feature], false, feature + ' 矩阵基线格');
    assert.equal(matrix.matrix['1.9'][feature], true, feature + ' 矩阵当前格');
    assert.equal(featureMatrix(OLD)[feature].available, false, feature);
    assert.equal(featureMatrix(CURRENT)[feature].available, true, feature);
  }
});

test('可降级门给出可执行降级；不可降级门诚实标记 unresolved', () => {
  const borrow = degradationOfCall(OLD, 'tab.borrow', { tabId: 3, confirmationTimeoutMs: 30000 });
  assert.equal(borrow.degradable, true);
  assert.equal(borrow.degraded.method, 'tab.borrow');
  assert.deepEqual([...borrow.degraded.droppedParams], ['confirmationTimeoutMs']);

  const incognito = degradationOfCall(OLD, 'session.start', { incognito: true });
  assert.equal(incognito.degradable, true);
  assert.deepEqual([...incognito.degraded.droppedParams], ['incognito']);

  const clickMoveClick = degradationOfCall(OLD, 'drag', { from: '@e1', to: '@e2', mode: 'click-move-click' });
  assert.equal(clickMoveClick.degradable, true);
  assert.deepEqual([...clickMoveClick.degraded.droppedParams], ['mode']);

  const target = degradationOfCall(OLD, 'cooperate.sync', { policy: 'target' });
  assert.equal(target.degradable, true);
  assert.deepEqual([...target.degraded.droppedParams], ['policy']);

  const dialog = degradationOfCall(OLD, 'dialog.accept', { tabId: 5 });
  assert.equal(dialog.degradable, false);
  assert.deepEqual([...dialog.unresolved], ['dialog_control']);

  const help = degradationOfCall(OLD, 'request-help', { reason: 'need human' });
  assert.equal(help.degradable, false);
  assert.deepEqual([...help.unresolved], ['interaction_policy']);
});

test('生成物与文档同步：6 个门出现在 generated/protocol.js 与 PROTOCOL-METHODS.md', () => {
  const generated = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'generated', 'protocol.js'), 'utf8');
  const docs = fs.readFileSync(path.join(ROOT, 'docs', 'PROTOCOL-METHODS.md'), 'utf8');
  for (const feature of Object.keys(COMPAT_FEATURES)) {
    assert.ok(generated.includes('"' + feature + '"'), feature + ' 未进入生成物 FEATURE_MIN_PROTOCOL');
    assert.ok(docs.includes('| `' + feature + '` | 1.9 |'), feature + ' 未进入特性门表');
  }
  assert.ok(docs.includes('| `interaction_policy` | 1.9 |'));
  assert.ok(docs.includes('| `dialog_control` | 1.9 |'));
});
