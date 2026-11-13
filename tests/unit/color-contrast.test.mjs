import test from 'node:test';
import assert from 'node:assert/strict';
import { AA_CONTRAST, compositeOver, contrastRatio, relativeLuminance, srgbToLinear } from '../../lib/color-contrast.mjs';

const white = { r: 255, g: 255, b: 255 };
const black = { r: 0, g: 0, b: 0 };

test('黑白对比度为 21，同色为 1', () => {
  assert.equal(Number(contrastRatio(white, black).toFixed(1)), 21);
  assert.equal(Number(contrastRatio(white, white).toFixed(1)), 1);
});

test('#777 对白约 4.48，低于 AA 阈值', () => {
  const ratio = contrastRatio({ r: 119, g: 119, b: 119 }, white);
  assert.ok(ratio > 4.4 && ratio < 4.6, String(ratio));
  assert.ok(ratio < AA_CONTRAST);
});

test('相对亮度与 sRGB 线性化', () => {
  assert.equal(relativeLuminance(white), 1);
  assert.equal(relativeLuminance(black), 0);
  assert.equal(srgbToLinear(0), 0);
  assert.equal(srgbToLinear(255), 1);
  assert.ok(Math.abs(srgbToLinear(128) - 0.2158) < 0.001);
});

test('alpha 合成：50% 黑叠白约为 #808080', () => {
  const mixed = compositeOver({ r: 0, g: 0, b: 0, a: 0.5 }, white);
  assert.ok(Math.abs(mixed.r - 127.5) < 0.001);
  assert.ok(Math.abs(mixed.g - 127.5) < 0.001);
  assert.equal(mixed.a, 1);
});

test('全透明前景等于背景，对比度为 1', () => {
  const transparent = compositeOver({ r: 0, g: 0, b: 0, a: 0 }, white);
  assert.equal(Number(contrastRatio(transparent, white).toFixed(1)), 1);
});
