import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const TS_MANIFEST = path.join(APP, '.output', 'chrome-mv3', 'manifest.json');
const JS_MANIFEST = path.resolve(APP, '..', '..', 'extension', 'manifest.json');

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

test('TS 扩展产物 manifest 与 0.3.0 JS 扩展关键字段对齐', { skip: !fs.existsSync(TS_MANIFEST) }, () => {
  const ts = readJson(TS_MANIFEST);
  const js = readJson(JS_MANIFEST);

  assert.equal(ts.manifest_version, js.manifest_version);
  assert.equal(ts.manifest_version, 3);
  assert.equal(ts.name, js.name);
  assert.equal(ts.short_name, js.short_name);
  assert.equal(ts.version, js.version, '架构栈在合流前必须与 0.3.0 同版本号');

  const tsPerms = [...(ts.permissions as string[])].sort();
  const jsPerms = [...(js.permissions as string[])].sort();
  assert.deepEqual(tsPerms, jsPerms, 'permissions 必须与 JS 扩展一致');
  assert.deepEqual(ts.host_permissions, js.host_permissions);
  assert.equal(ts.minimum_chrome_version, js.minimum_chrome_version);

  const tsAction = ts.action as Record<string, unknown>;
  const jsAction = js.action as Record<string, unknown>;
  assert.deepEqual(tsAction.default_icon, jsAction.default_icon, 'action 图标映射必须一致');
  assert.deepEqual(ts.icons, js.icons, '扩展图标映射必须一致');

  const tsBg = ts.background as Record<string, unknown>;
  assert.equal(tsBg.service_worker, 'background.js');
  assert.ok(fs.existsSync(path.join(APP, '.output', 'chrome-mv3', String(tsBg.service_worker))), 'background 产物必须存在');

  const tsScripts = ts.content_scripts as Array<Record<string, unknown>>;
  const jsScripts = js.content_scripts as Array<Record<string, unknown>>;
  const tsFirst = tsScripts[0] ?? {};
  const jsFirst = jsScripts[0] ?? {};
  assert.equal(tsFirst.run_at, jsFirst.run_at);
  assert.equal(tsFirst.all_frames, jsFirst.all_frames);
  assert.equal((tsFirst.matches as string[] | undefined)?.[0], (jsFirst.matches as string[] | undefined)?.[0]);
});
