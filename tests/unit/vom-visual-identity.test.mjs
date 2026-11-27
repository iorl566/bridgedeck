// VOM visualObjects：稳定身份（跨 observe 匹配）+ 动作闭环 + 缺证据标注。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VISUAL_CHANGE_KINDS,
  VOM_VISUAL_IDENTITY_VERSION,
  assignVisualIdentity,
  describeVisualIdentity,
  summarizeVisualIdentity,
  visualActionClosure,
  visualIoU,
  visualRect,
  visualSignature,
} from '../../extension/src/lib/vom-visual-identity.js';

function region(index, overrides = {}) {
  return { kind: 'region', index, tag: 'canvas', id: 'chart', rect: { x: 10, y: 10, width: 100, height: 50 }, ...overrides };
}

test('visualSignature：位置不入签名（移动不换身份），尺寸/结构入签名', () => {
  const base = visualSignature(region(0));
  const moved = visualSignature(region(0, { rect: { x: 200, y: 300, width: 100, height: 50 } }));
  assert.equal(base.signature, moved.signature);
  assert.match(base.signature, /^vs-/);
  const resized = visualSignature(region(0, { rect: { x: 10, y: 10, width: 160, height: 50 } }));
  assert.notEqual(base.signature, resized.signature);
  const renamed = visualSignature(region(0, { id: 'other' }));
  assert.notEqual(base.signature, renamed.signature);
  assert.equal(base.parts.width, 100);
  assert.equal(visualRect({ rect: { x: 1, y: 2, w: 3, h: 4 } }).width, 3);
  assert.equal(visualRect({}), null);
  assert.equal(visualIoU({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 10, height: 10 }), 1);
  assert.equal(visualIoU({ x: 0, y: 0, width: 10, height: 10 }, null), 0);
});

test('assignVisualIdentity：首次全部 added，第二次按 ref/签名/几何匹配并保留 voId', () => {
  const first = assignVisualIdentity([
    { kind: 'ref', ref: '@e1', role: 'button', name: '保存', rect: { x: 10, y: 10, width: 80, height: 30 } },
    region(0),
  ], { revision: 1 });
  assert.equal(first.version, VOM_VISUAL_IDENTITY_VERSION);
  assert.equal(first.objects.length, 2);
  assert.equal(new Set(first.objects.map((item) => item.voId)).size, 2, 'voId 必须唯一');
  assert.deepEqual(first.changes, { stable: 0, moved: 0, resized: 0, replaced: 0, added: 2, removed: 0 });
  assert.ok(first.objects.every((item) => item.identity.change === 'added'));
  assert.ok(VISUAL_CHANGE_KINDS.includes('moved'));

  // 下一轮：按钮位置移动（ref 匹配）、图表尺寸变化（region-index 匹配）。
  const second = assignVisualIdentity([
    { kind: 'ref', ref: '@e1', role: 'button', name: '保存', rect: { x: 20, y: 40, width: 80, height: 30 } },
    region(0, { rect: { x: 10, y: 10, width: 160, height: 50 } }),
  ], { previous: first.objects, revision: 2 });
  const button = second.objects.find((item) => item.kind === 'ref');
  const canvas = second.objects.find((item) => item.kind === 'region');
  assert.equal(button.voId, first.objects[0].voId, 'ref 匹配应保留 voId');
  assert.equal(button.identity.change, 'moved');
  assert.equal(button.identity.match, 'ref');
  assert.equal(button.identity.confidence, 0.97);
  assert.equal(canvas.voId, first.objects[1].voId, 'region 匹配应保留 voId');
  assert.equal(canvas.identity.change, 'resized');
  assert.equal(second.changes.moved, 1);
  assert.equal(second.changes.resized, 1);
  assert.equal(second.changes.removed, 0);
  assert.equal(second.counts.matched, 2);

  // 第三轮：图表消失（removed），新增一个列表（added）。
  const third = assignVisualIdentity([
    { kind: 'ref', ref: '@e1', role: 'button', name: '保存', rect: { x: 20, y: 40, width: 80, height: 30 } },
    { kind: 'region', index: 3, tag: 'canvas', id: 'new-chart', rect: { x: 300, y: 300, width: 100, height: 50 } },
  ], { previous: second.objects, revision: 3 });
  assert.equal(third.changes.removed, 1);
  assert.equal(third.changes.added, 1);
  assert.equal(third.removed[0].kind, 'region');
  assert.ok(third.removed[0].voId);
});

test('assignVisualIdentity：上限与 truncated，不匹配的几何不硬凑', () => {
  const report = assignVisualIdentity([
    region(0),
    region(1, { id: 'other', rect: { x: 500, y: 500, width: 20, height: 20 } }),
  ], { limit: 1 });
  assert.equal(report.objects.length, 1);
  assert.equal(report.truncated, true);
  const previous = [{ kind: 'region', index: 0, tag: 'canvas', id: 'chart', rect: { x: 10, y: 10, width: 100, height: 50 }, voId: 'vs-keep' }];
  const noMatch = assignVisualIdentity([
    { kind: 'region', index: 9, tag: 'img', id: 'x', rect: { x: 900, y: 900, width: 30, height: 30 } },
  ], { previous });
  assert.equal(noMatch.objects[0].identity.change, 'added');
  assert.equal(noMatch.changes.removed, 1);
  assert.equal(noMatch.removed[0].voId, 'vs-keep');
});

test('visualActionClosure：ref 类给出 click/hover/backend 目标与 DPR 图像坐标', () => {
  const object = {
    kind: 'ref', ref: '@e1', backendNodeId: 42, stableRef: 's-1', voId: 'vs-abc',
    rect: { x: 10, y: 20, width: 40, height: 20 },
  };
  const closure = visualActionClosure(object, { dpr: 2 });
  assert.equal(closure.actionable, true);
  assert.equal(closure.blockedReason, null);
  assert.equal(closure.evidence.backendNodeId, true);
  assert.deepEqual(closure.evidence.dpr, 2);
  const click = closure.targets.find((target) => target.method === 'click');
  assert.ok(click);
  assert.equal(click.ref, '@e1');
  assert.equal(click.backendNodeId, 42);
  assert.equal(click.stableRef, 's-1');
  assert.deepEqual(click.point, { x: 30, y: 30 });
  assert.deepEqual(click.image, { x: 60, y: 60 });
  assert.ok(closure.targets.some((target) => target.method === 'click-backend'));
  // 没有 DPR 时不伪造图像坐标。
  const noDpr = visualActionClosure(object);
  assert.equal(noDpr.targets[0].image, null);
  assert.equal(noDpr.targets[0].dpr, null);
  // 没有 rect 就没有闭环目标。
  const noGeometry = visualActionClosure({ kind: 'ref', ref: '@e1' }, { dpr: 1 });
  assert.equal(noGeometry.actionable, false);
  assert.equal(noGeometry.blockedReason, 'no-geometry');
  // 视口外标记 offscreen。
  const offscreen = visualActionClosure(object, { dpr: 1, viewport: { x: 0, y: 0, width: 10, height: 10 } });
  assert.equal(offscreen.actionable, false);
  assert.equal(offscreen.blockedReason, 'offscreen');
});

test('visualActionClosure：region 走 screenshot → click-capture 两步链，DPR 未知不冒充', () => {
  const closure = visualActionClosure(region(2), { dpr: 2 });
  assert.equal(closure.actionable, true);
  assert.deepEqual(closure.targets.map((target) => target.method), ['screenshot', 'click-capture']);
  assert.deepEqual(closure.targets[1].params, { visual: 2, imageX: 120, imageY: 70 });
  const noDpr = visualActionClosure(region(2));
  assert.equal(noDpr.actionable, false);
  assert.equal(noDpr.blockedReason, 'dpr-unknown');
  assert.deepEqual(noDpr.targets.map((target) => target.method), ['screenshot']);
  const noIndex = visualActionClosure({ kind: 'region', rect: { x: 0, y: 0, width: 10, height: 10 } });
  assert.equal(noIndex.blockedReason, 'no-action-target');
});

test('summarizeVisualIdentity：计费动作闭环统计 + JSON 安全 + 一行文本', () => {
  const assigned = assignVisualIdentity([
    { kind: 'ref', ref: '@e1', role: 'button', name: '保存', rect: { x: 10, y: 10, width: 80, height: 30 }, backendNodeId: 7 },
    region(0),
  ], { revision: 4 });
  const summary = summarizeVisualIdentity(assigned, {
    nodes: [{ ref: '@e1', backendNodeId: 7 }],
    dpr: 1,
  });
  assert.equal(summary.version, VOM_VISUAL_IDENTITY_VERSION);
  assert.equal(summary.available, true);
  assert.equal(summary.counts.objects, 2);
  assert.equal(summary.counts.actionable, 2);
  assert.equal(summary.counts.blocked, 0);
  assert.equal(summary.changes.added, 2);
  assert.ok(summary.objects[0].targets.length >= 1);
  assert.ok(summary.objects[0].signature.startsWith('vs-'));
  const roundTrip = JSON.parse(JSON.stringify(summary));
  assert.deepEqual(roundTrip.counts, summary.counts);
  const text = describeVisualIdentity(summary);
  assert.match(text, /visual objects=2/);
  assert.match(text, /actionable=2/);
  // 限制条数时 truncated；blockedReasons 汇总。
  const limited = summarizeVisualIdentity(assignVisualIdentity([
    { kind: 'ref', ref: '@e1', rect: { x: 0, y: 0, width: 10, height: 10 } },
    { kind: 'region', rect: { x: 0, y: 0, width: 10, height: 10 } },
  ]), { limit: 1, dpr: 1 });
  assert.equal(limited.objects.length, 1);
  assert.equal(limited.truncated, true);
  assert.equal(limited.blockedReasons['no-action-target'], 1);
});
