import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT = path.join(ROOT, 'extension');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));

test('manifest 的脚本与后台入口文件都存在', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(fs.existsSync(path.join(EXT, manifest.background.service_worker)), manifest.background.service_worker);
  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) {
      assert.ok(fs.existsSync(path.join(EXT, file)), '缺少 content script：' + file);
    }
  }
});

test('manifest 包含 human-watch 且 host 权限未扩大', () => {
  const scripts = (manifest.content_scripts || []).flatMap((script) => script.js || []);
  assert.ok(scripts.includes('content/human-watch.js'), '缺少人工输入监视脚本');
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
  assert.ok(!(manifest.permissions || []).includes('management'), '不应申请 management 权限');
});
