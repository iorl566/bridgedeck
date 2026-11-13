import test from 'node:test';
import assert from 'node:assert/strict';
import { COOPERATION_CONTROL, COOPERATION_MESSAGE } from '../../extension/src/cooperation/types.js';
import { ControlAuthorityError } from '../../extension/src/cooperation/control-authority.js';
import { playbackProgressMedia } from '../../extension/src/cooperation/media-progress.js';

test('cooperation constants are stable wire names', () => {
  assert.equal(COOPERATION_MESSAGE, 'cooperation.frame');
  assert.equal(COOPERATION_CONTROL, 'cooperation.control');
});

test('playback progress only accepts named timelines', () => {
  const media = [{ id: 'm1' }];
  assert.deepEqual(playbackProgressMedia({ tag: 'input', attrs: { type: 'range' }, name: 'Video progress', inForm: false }, media), media[0]);
  assert.equal(playbackProgressMedia({ tag: 'input', attrs: { type: 'range' }, name: 'Volume', inForm: false }, media), undefined);
  assert.equal(playbackProgressMedia({ tag: 'input', attrs: { type: 'range', name: 'x' }, name: 'Video progress', inForm: false }, media), undefined);
  assert.equal(playbackProgressMedia({ tag: 'progress', name: '播放进度', inForm: false }, media), media[0]);
});

test('aria-controls requires exactly one match', () => {
  const media = [{ id: 'a' }, { id: 'b' }];
  assert.deepEqual(playbackProgressMedia({ tag: 'progress', name: 'media timeline', attrs: { 'aria-controls': 'b' }, inForm: false }, media), media[1]);
  assert.equal(playbackProgressMedia({ tag: 'progress', name: 'media timeline', attrs: { 'aria-controls': 'a b' }, inForm: false }, media), undefined);
  assert.equal(playbackProgressMedia({ tag: 'progress', name: 'media timeline', inForm: false }, media), undefined);
});

test('ControlAuthorityError preserves rpc error', () => {
  const error = new ControlAuthorityError({ code: 'E_CONTROL', message: 'revoked' });
  assert.equal(error.name, 'ControlAuthorityError');
  assert.equal(error.message, 'revoked');
  assert.equal(error.rpcError.code, 'E_CONTROL');
});
