// tools/browser-launch.mjs —— 自动化浏览器（Edge/Chrome）的确定性启动参数与 profile 预处理。
//
// 目的：新 profile + unpacked 扩展启动时，抑制 Edge 的首次运行/同步提示和
// “关闭开发人员模式下的扩展”提示，避免原生对话框盖住被测页面。
import fs from 'node:fs';
import path from 'node:path';

export const DEV_MODE_WARNING_SNOOZE_END_TIME = '9223372036854775807';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** 在首次启动前写入最小 Preferences/Local State，抑制已知原生提示。 */
export function prepareBrowserProfile(profileDir) {
  const prefsPath = path.join(profileDir, 'Default', 'Preferences');
  const prefs = readJson(prefsPath);
  prefs.extensions = prefs.extensions && typeof prefs.extensions === 'object' ? prefs.extensions : {};
  prefs.extensions.ui = prefs.extensions.ui && typeof prefs.extensions.ui === 'object' ? prefs.extensions.ui : {};
  prefs.extensions.ui.dev_mode_warning_snooze_end_time = DEV_MODE_WARNING_SNOOZE_END_TIME;
  // Edge 的同步同意弹窗（“我们正在你的所有设备上同步…”）由这组状态控制。
  prefs.fre_sync_consent = { seen: true, confirmed: true };
  prefs.google = prefs.google && typeof prefs.google === 'object' ? prefs.google : {};
  prefs.google.services = prefs.google.services && typeof prefs.google.services === 'object' ? prefs.google.services : {};
  prefs.google.services.consented_to_sync = true;
  writeJson(prefsPath, prefs);

  const localStatePath = path.join(profileDir, 'Local State');
  const localState = readJson(localStatePath);
  localState.browser = localState.browser && typeof localState.browser === 'object' ? localState.browser : {};
  localState.browser.first_run_finished = true;
  localState.browser.has_seen_welcome_page = true;
  localState.edge = localState.edge && typeof localState.edge === 'object' ? localState.edge : {};
  localState.edge.first_run_completed = true;
  writeJson(localStatePath, localState);
}

/** 统一的确定性启动参数；windowSize 形如 "1280,900"。 */
export function browserArgs({ profileDir, extensionDir, windowSize, newWindow = false }) {
  const features = [
    'DisableLoadExtensionCommandLineSwitch',
    'FirstRunExperience',
    'msEdgeFirstRunExperience',
    'msEdgeSyncConsent',
    'msEdgeSyncFRE',
    'msEdgeIdentityFRE',
  ].join(',');
  return [
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--no-service-autorun',
    `--disable-features=${features}`,
    `--load-extension=${extensionDir}`,
    ...(windowSize ? [`--window-size=${windowSize}`] : []),
    ...(newWindow ? ['--new-window'] : []),
    'about:blank',
  ];
}
