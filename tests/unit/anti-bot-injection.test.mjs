import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 反爬回归护栏：扩展不允许在 MAIN world 静态注入任何东西。
// 静态注入会在用户浏览的每个页面留下被 patch 的 console/fetch/XHR，
// pixelscan（tamperedFunctions）、BrowserScan（CDP Robot）、
// fingerprint-scan（CDP Stack Check）、rebrowser（runtimeEnableLeak）都会命中。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8'));

test('manifest 不注册任何 MAIN world 内容脚本', () => {
  const scripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  const mainWorld = scripts.filter((entry) => String(entry.world || '').toUpperCase() === 'MAIN');
  assert.deepEqual(mainWorld, [], '不允许 MAIN world 静态注入：' + JSON.stringify(mainWorld));
});

test('main-console 只按需注入，不出现在 content_scripts', () => {
  const scripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  const listed = scripts.flatMap((entry) => (Array.isArray(entry.js) ? entry.js : []));
  assert.equal(listed.includes('injected/main-console.js'), false);
  assert.equal(listed.includes('injected/main-console-restore.js'), false);
});

test('页面钩子脚本可还原原生函数', () => {
  const source = fs.readFileSync(path.join(ROOT, 'extension', 'injected', 'main-console.js'), 'utf8');
  assert.match(source, /__BB_RESTORE_HOOKS__/, 'main-console.js 必须暴露还原入口');
  assert.match(source, /globalThis\.fetch = originalFetch/, '需要把 fetch 还原为原函数');
  assert.match(source, /XHR\.prototype\.open = originalXhrOpen/, '需要把 XHR.open 还原为原函数');
  const restore = fs.readFileSync(path.join(ROOT, 'extension', 'injected', 'main-console-restore.js'), 'utf8');
  assert.match(restore, /__BB_RESTORE_HOOKS__/);
});

test('page-hooks 模块存在且提供 ensure/release', () => {
  const source = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'page-hooks.js'), 'utf8');
  assert.match(source, /export async function ensureHooks/);
  assert.match(source, /export async function releaseHooks/);
  assert.match(source, /export function hasHooks/);
});
