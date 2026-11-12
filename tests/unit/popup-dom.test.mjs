import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../extension/ui/popup.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../../extension/ui/popup.js', import.meta.url), 'utf8');
const auditPanel = readFileSync(new URL('../../extension/ui/panels/audit-panel.js', import.meta.url), 'utf8');
const longshotPanel = readFileSync(new URL('../../extension/ui/panels/longshot-panel.js', import.meta.url), 'utf8');
const videoPanel = readFileSync(new URL('../../extension/ui/panels/video-panel.js', import.meta.url), 'utf8');
const debugPanel = readFileSync(new URL('../../extension/ui/panels/debug-panel.js', import.meta.url), 'utf8');
const opsPanel = readFileSync(new URL('../../extension/ui/panels/ops-panel.js', import.meta.url), 'utf8');

test('popup DOM references and views stay wired', () => {
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
  const referenced = [...js.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(referenced)].filter((id) => !ids.has(id)), []);
  const panelReferenced = [...auditPanel.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(panelReferenced)].filter((id) => !ids.has(id)), []);
  const longshotReferenced = [...longshotPanel.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(longshotReferenced)].filter((id) => !ids.has(id)), []);
  const videoReferenced = [...videoPanel.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(videoReferenced)].filter((id) => !ids.has(id)), []);
  const debugReferenced = [...debugPanel.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(debugReferenced)].filter((id) => !ids.has(id)), []);
  const opsReferenced = [...opsPanel.matchAll(/\$\('([^']+)'\)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(opsReferenced)].filter((id) => !ids.has(id)), []);
  for (const id of ['auditPanel', 'auditToggle', 'auditStatus', 'auditRuns', 'auditOpen']) {
    assert.ok(ids.has(id), `missing #${id}`);
  }
  for (const id of ['longshotPanel', 'longshotMode', 'longshotStatus', 'longshotStart', 'longshotOpen']) {
    assert.ok(ids.has(id), `missing #${id}`);
  }
  for (const id of ['videoPanel', 'videoStatus', 'videoStart', 'videoStop', 'videoOpen']) {
    assert.ok(ids.has(id), `missing #${id}`);
  }
  for (const id of ['debugPanel', 'debugStatus', 'debugSummary', 'debugStart', 'debugStop', 'debugHistory']) {
    assert.ok(ids.has(id), `missing #${id}`);
  }
  for (const id of ['opsPanel', 'opsStatus', 'opsRuns', 'opsStart', 'opsStop', 'opsOpen']) {
    assert.ok(ids.has(id), `missing #${id}`);
  }
  for (const id of ['openFeatures', 'featuresView', 'subView', 'backFromFeatures', 'mainView']) {
    assert.ok(ids.has(id), `missing #${id}`);
  }
  assert.match(html, /id="connSettings" open/);
  for (const id of ['tip-control', 'tip-borrow', 'tip-help']) assert.ok(ids.has(id), `missing ${id}`);
  const described = [...html.matchAll(/aria-describedby="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(described.sort(), ['tip-borrow', 'tip-control', 'tip-help']);
  const features = [...html.matchAll(/data-page="([^"]+)" data-title="([^"]+)"/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(features, [
    ['record.html', '视频录制'],
    ['debug.html', '网站调试'],
    ['longshot.html', '长截图'],
    ['ops.html', '操作录制'],
    ['audit.html', '操作审计'],
  ]);
});
