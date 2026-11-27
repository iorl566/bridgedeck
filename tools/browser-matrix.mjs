#!/usr/bin/env node
// tools/browser-matrix.mjs —— 探测本机可用 Chromium 浏览器；不启动、不改配置。
import { existsSync } from 'node:fs';
import process from 'node:process';

const HOME = process.env.HOME || process.env.USERPROFILE || '';
const LOCAL = process.env.LOCALAPPDATA || '';
const PROGRAMS = process.env.PROGRAMFILES || 'C:\\Program Files';
const PROGRAMS_X86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
const APPDATA = process.env.APPDATA || '';

function candidates() {
  if (process.platform === 'win32') {
    return {
      edge: [`${PROGRAMS_X86}\\Microsoft\\Edge\\Application\\msedge.exe`, `${PROGRAMS}\\Microsoft\\Edge\\Application\\msedge.exe`],
      chrome: [`${PROGRAMS}\\Google\\Chrome\\Application\\chrome.exe`, `${PROGRAMS_X86}\\Google\\Chrome\\Application\\chrome.exe`],
      brave: [`${PROGRAMS}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`, `${LOCAL}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`],
      vivaldi: [`${LOCAL}\\Vivaldi\\Application\\vivaldi.exe`, `${PROGRAMS}\\Vivaldi\\Application\\vivaldi.exe`],
      opera: [`${LOCAL}\\Programs\\Opera\\opera.exe`, `${PROGRAMS}\\Opera\\opera.exe`],
      arc: [`${LOCAL}\\Programs\\Arc\\Arc.exe`, `${PROGRAMS}\\Arc\\Arc.exe`],
      helium: [`${LOCAL}\\Programs\\Helium\\helium.exe`, `${PROGRAMS}\\Helium\\helium.exe`],
    };
  }
  if (process.platform === 'darwin') {
    return {
      edge: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      chrome: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      brave: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
      vivaldi: ['/Applications/Vivaldi.app/Contents/MacOS/Vivaldi'],
      opera: ['/Applications/Opera.app/Contents/MacOS/Opera'],
      arc: ['/Applications/Arc.app/Contents/MacOS/Arc'],
      helium: ['/Applications/Helium.app/Contents/MacOS/Helium'],
    };
  }
  return {
    edge: ['/usr/bin/microsoft-edge', '/opt/microsoft/msedge/msedge'],
    chrome: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'],
    brave: ['/usr/bin/brave-browser', '/opt/brave.com/brave/brave'],
    vivaldi: ['/usr/bin/vivaldi', '/opt/vivaldi/vivaldi'],
    opera: ['/usr/bin/opera', '/usr/lib/x86_64-linux-gnu/opera/opera'],
    arc: ['/usr/bin/arc'],
    helium: ['/usr/bin/helium', '/opt/helium/helium'],
  };
}

const found = [];
const missing = [];
for (const [name, paths] of Object.entries(candidates())) {
  const hit = paths.find((candidate) => candidate && existsSync(candidate));
  if (hit) found.push({ name, path: hit });
  else missing.push({ name, tried: paths });
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ platform: process.platform, found, missing }, null, 2));
} else {
  for (const item of found) console.log('FOUND ' + item.name + ' ' + item.path);
  for (const item of missing) console.log('MISSING ' + item.name);
  console.log('\n可用：' + (found.map((item) => item.name).join(', ') || '(none)'));
  console.log('未安装：' + missing.map((item) => item.name).join(', '));
}
process.exitCode = found.length ? 0 : 1;
