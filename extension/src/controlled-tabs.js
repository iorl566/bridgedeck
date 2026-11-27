import { withTimeout } from './timeout.js';
import { log } from './log.js';

const CONTROLLED_KEY = 'bb.controlledTabs';

export async function readControlledTabs() {
  try {
    const stored = await withTimeout(chrome.storage.session.get(CONTROLLED_KEY), 3000, 'session tabs read');
    const list = stored ? stored[CONTROLLED_KEY] : null;
    return Array.isArray(list) ? list.filter((id) => Number.isInteger(id)) : [];
  } catch {
    return [];
  }
}

export async function writeControlledTabs(list) {
  const unique = [...new Set(list.filter((id) => Number.isInteger(id)))];
  try {
    await withTimeout(chrome.storage.session.set({ [CONTROLLED_KEY]: unique }), 3000, 'session tabs write');
  } catch (error) {
    log('保存受控标签页失败', error && error.message);
  }
  return unique;
}

export async function isControlledTab(tabId) {
  const list = await readControlledTabs();
  return list.includes(tabId);
}

/** 将 Agent 自己打开的新标签页登记为受控，避免自动跟随时再次弹借用确认。 */
export async function markControlledTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  const list = await readControlledTabs();
  if (!list.includes(tabId)) await writeControlledTabs([...list, tabId]);
}

