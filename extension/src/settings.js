// src/settings.js —— 扩展设置（chrome.storage.local 的 bb.settings）
import { withTimeout } from './timeout.js';
import { bridgeError } from './errors.js';

export const SETTINGS_KEY = 'bb.settings';

export const DEFAULT_SETTINGS = {
  instanceLabel: '',
  borrowConfirm: true,
  allowHelp: true,
  longShotMode: 'auto',
  pageGuard: true,
  connectionEnabled: true,
  controlHint: true,
  auditEnabled: false,
  daemonUrl: '',
  daemonToken: '',
};

function sanitizeDaemonUrl(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!/^wss?:\/\//i.test(text)) return '';
  try {
    const url = new URL(text);
    if (url.username || url.password) return '';
    if (url.protocol === 'ws:') {
      const host = url.hostname.toLowerCase();
      if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) return '';
    }
    return text;
  } catch {
    return '';
  }
}

export function normalizeSettings(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const label = typeof input.instanceLabel === 'string' ? input.instanceLabel.trim().slice(0, 48) : '';
  return {
    instanceLabel: label,
    borrowConfirm: input.borrowConfirm !== false,
    allowHelp: input.allowHelp !== false,
    longShotMode: input.longShotMode === 'manual' ? 'manual' : 'auto',
    pageGuard: input.pageGuard !== false,
    connectionEnabled: input.connectionEnabled !== false,
    controlHint: input.controlHint !== false,
    auditEnabled: input.auditEnabled === true,
    daemonUrl: sanitizeDaemonUrl(input.daemonUrl),
    daemonToken: typeof input.daemonToken === 'string' ? input.daemonToken.trim().slice(0, 128) : '',
  };
}

export async function readSettings() {
  try {
    const stored = await withTimeout(chrome.storage.local.get(SETTINGS_KEY), 3000, 'settings read');
    return normalizeSettings(stored ? stored[SETTINGS_KEY] : null);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function writeSettings(patch) {
  const current = await readSettings();
  const next = normalizeSettings({ ...current, ...(patch || {}) });
  await withTimeout(chrome.storage.local.set({ [SETTINGS_KEY]: next }), 3000, 'settings write');
  return next;
}

/** 设置变化时回调（SW 内注册一次）。 */
export function subscribeSettings(callback) {
  if (!chrome.storage.onChanged) return () => {};
  const listener = (changes, area) => {
    if (area !== 'local' || !changes[SETTINGS_KEY]) return;
    callback(normalizeSettings(changes[SETTINGS_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** settings.get：daemon/CLI 读扩展设置。 */
export async function settingsGet() {
  const settings = await readSettings();
  return { settings, label: settings.instanceLabel };
}

/** 只能由浏览器扩展设置页修改的字段：CLI/Agent 一侧写入一律拒绝。 */
const HUMAN_ONLY_KEYS = ['borrowConfirm'];

/** settings.set：局部更新扩展设置。 */
export async function settingsSet(params = {}) {
  const patch = params && params.patch && typeof params.patch === 'object' ? params.patch : {};
  for (const key of HUMAN_ONLY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      throw bridgeError(
        'E_FORBIDDEN',
        '借用前确认（borrowConfirm）是人工开关：只能由用户在扩展设置页修改，Agent/CLI 不可改',
      );
    }
  }
  const settings = await writeSettings(patch);
  return { settings };
}
