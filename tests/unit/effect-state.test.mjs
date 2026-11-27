import test from 'node:test';
import assert from 'node:assert/strict';
import { annotateEffectSuccess, withEffectState } from '../../daemon/effect-state.js';

test('withEffectState 只补缺失值', () => {
  const error = { code: 'E_INTERNAL', data: {} };
  withEffectState(error, 'none');
  assert.equal(error.data.effect_state, 'none');
  withEffectState(error, 'unknown');
  assert.equal(error.data.effect_state, 'none');
});

test('annotateEffectSuccess 对变异成功加 committed', () => {
  const result = annotateEffectSuccess({ ok: true }, 'click');
  assert.equal(result.effectState, 'committed');
  const read = annotateEffectSuccess({ ok: true }, 'observe');
  assert.equal(read.effectState, undefined);
});

test('annotateEffectSuccess 不覆盖失败结果', () => {
  assert.equal(annotateEffectSuccess({ ok: false }, 'click').effectState, undefined);
  assert.equal(annotateEffectSuccess({ failedAt: 1 }, 'fill').effectState, undefined);
  assert.equal(annotateEffectSuccess({ effectState: 'unknown' }, 'click').effectState, 'unknown');
});
