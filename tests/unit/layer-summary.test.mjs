import assert from 'node:assert/strict';
import { formatLayerSummary } from '../../extension/src/lib/layer-summary.js';

assert.equal(formatLayerSummary('https://example.test/', []), '');

const text = formatLayerSummary('https://example.test/', [
  { level: 'L2', role: 'dialog', name: '确认', coverage: 0.42, bounds: { x: 10, y: 20, width: 300, height: 200 } },
]);
assert.match(text, /L1 "https:\/\/example\.test\/"/);
assert.match(text, /L2 dialog "确认" \(42%\)/);
assert.match(text, /@ 10,20 300x200/);

const overlay = formatLayerSummary('https://example.test/', [{ role: 'overlay', name: 'mask' }]);
assert.match(overlay, /L2 overlay "mask"/);

console.log('LAYER_SUMMARY_OK');
