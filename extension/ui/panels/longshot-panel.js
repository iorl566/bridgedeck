/** Inline auto/visible long-screenshot panel; the full page keeps manual stitching. */

import { buildCaptureManifest, pruneManifests } from '../../src/lib/capture-manifest.js';
import { saveLongshot } from '../../src/lib/longshot-store.js';

import { errorText } from '../common.js';

const $ = (id) => document.getElementById(id);

function setStatus(text, error = false) {
  const node = $('longshotStatus');
  node.textContent = text;
  node.style.color = error ? 'var(--danger, #dc2626)' : '';
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Capture the active tab with the selected mode. */
export async function captureActiveTab() {
  const mode = $('longshotMode').value === 'visible' ? 'visible' : 'auto';
  const tab = await activeTab();
  if (!tab?.id) {
    setStatus('没有可截图的标签页', true);
    return;
  }
  $('longshotStart').disabled = true;
  setStatus('正在截图…');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'bb.capture', mode, preview: true, tabId: tab.id });
    if (!result?.ok) {
      setStatus(errorText(result?.error || '截图失败'), true);
      return;
    }
    await chrome.storage.session.set({ 'bb.longshot.last': { dataUrl: result.dataUrl, width: result.width, height: result.height } });
    const captureId = 'longshot-' + Date.now();
    const frames = Array.isArray(result.frames) && result.frames.length ? result.frames : [{ dataUrl: result.dataUrl, width: result.width, height: result.height }];
    const savedFrames = await saveLongshot(captureId, frames).catch(() => 0);
    const stored = await chrome.storage.local.get('bb.capture.manifests');
    const list = Array.isArray(stored && stored['bb.capture.manifests']) ? stored['bb.capture.manifests'] : [];
    const manifest = buildCaptureManifest({ id: captureId, width: result.width, height: result.height, tiles: savedFrames, url: tab.url || '' });
    await chrome.storage.local.set({ 'bb.capture.manifests': pruneManifests([manifest, ...list]) });
    setStatus(`完成：${result.width} × ${result.height} px`);
  } catch (error) {
    setStatus(errorText(error instanceof Error ? error.message : '截图失败'), true);
  } finally {
    $('longshotStart').disabled = false;
  }
}

/** Wire the panel controls once per popup. */
export function mountLongshotPanel() {
  $('longshotStart').addEventListener('click', () => void captureActiveTab());
  $('longshotOpen').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('ui/longshot.html') });
  });
  return { reset: () => setStatus('') };
}
