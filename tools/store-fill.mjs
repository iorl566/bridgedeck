#!/usr/bin/env node
// tools/store-fill.mjs —— 用 BridgeDeck 自己把 Edge 商店 listing 填完（描述 + 徽标 + 保存草稿）。
//
// 前提：Partner Center 已登录，bridge 会话指向该页面（--session）。
// 用法：
//   node tools/store-fill.mjs --session ecuv --only zh-CN
//   node tools/store-fill.mjs --session ecuv --languages ja-JP,ko-KR
//   node tools/store-fill.mjs --session ecuv --skip-upload   # 徽标已经传过
//
// 流程（每个语言）：进 listings → 打开行 → 上传徽标并等预览出现 → 填描述（setter + input/change + blur）
// → 等“保存草稿”可用 → 保存 → 回 listings 路由回读行状态。

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;
const BRIDGE = path.join(ROOT, 'cli', 'bridge.mjs');
const LOGO = path.join(ROOT, 'docs', 'assets', 'store', 'icon-300.png');
const LISTINGS_URL = 'https://partner.microsoft.com/zh-cn/dashboard/microsoftedge/0fc99cde-b63d-40a6-9101-1849797a0d8f/listings';

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const SESSION = arg('--session');
const ONLY = arg('--only');
const SKIP_UPLOAD = process.argv.includes('--skip-upload');
if (!SESSION) {
  console.error('用法：node tools/store-fill.mjs --session <id> [--only <locale>] [--languages a,b] [--skip-upload]');
  process.exit(2);
}

// Partner Center 中文界面里的语言名 → 文案文件
const LANGUAGES = [
  ['英语', 'en-US'],
  ['中文(中国)', 'zh-CN'],
  ['中文(台湾)', 'zh-TW'],
  ['日语', 'ja-JP'],
  ['朝鲜语', 'ko-KR'],
  ['德语', 'de-DE'],
  ['法语', 'fr-FR'],
  ['西班牙语', 'es-ES'],
  ['意大利语', 'it-IT'],
  ['葡萄牙语(巴西)', 'pt-BR'],
  ['葡萄牙语(葡萄牙)', 'pt-PT'],
  ['阿拉伯语', 'ar-SA'],
  ['希伯来语', 'he-IL'],
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function descriptionOf(locale) {
  const file = path.join(ROOT, 'docs', 'store-listing', `${locale}.md`);
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf('\n## Description');
  if (start < 0) throw new Error(`${locale} 缺少 ## Description`);
  const rest = text.slice(start + '\n## Description'.length);
  const end = rest.search(/\n## /);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

function bridge(args, timeoutMs = 120000) {
  const result = spawnSync(NODE, [BRIDGE, ...args, '--session', SESSION, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  let json = null;
  try {
    json = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  } catch {
    json = null;
  }
  if (result.status !== 0 || (json && json.ok === false)) {
    const error = json && json.error ? json.error : { message: (result.stderr || result.stdout || '').slice(0, 500) };
    throw new Error(`bridge ${args.join(' ').slice(0, 60)} 失败：${error.code || ''} ${error.message || ''}`);
  }
  return json;
}

function evaluate(expression) {
  const json = bridge(['evaluate', expression, '--unverified']);
  return json.result ? json.result.value : null;
}

function clickText(text, { tag = '' } = {}) {
  const expression = `(() => {
    const all = [];
    const walk = (root) => { for (const e of root.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot); } };
    walk(document);
    const candidates = all.filter((e) => (e.textContent || '').trim() === ${JSON.stringify(text)}${tag ? ` && e.tagName === ${JSON.stringify(tag)}` : ''});
    if (!candidates.length) return JSON.stringify({ ok: false, count: 0 });
    candidates[0].click();
    return JSON.stringify({ ok: true, tag: candidates[0].tagName });
  })()`;
  return JSON.parse(evaluate(expression));
}

/** 面板状态：是否打开、描述长度、徽标预览、保存按钮可用性。 */
function panelState() {
  const expression = `(() => {
    const text = document.body.innerText || '';
    const area = [...document.querySelectorAll('textarea')].find((e) => /textarea_description/.test(e.id));
    const heads = [...document.querySelectorAll('*')].filter((e) => (e.textContent || '').trim() === '扩展徽标 *');
    const logoSection = heads.length ? heads[0].parentElement : null;
    const logoImg = logoSection ? [...logoSection.querySelectorAll('img')].some((i) => i.naturalWidth > 0) : false;
    const save = [...document.querySelectorAll('*')].find((e) => e.tagName === 'V6_HE-BUTTON' && (e.textContent || '').trim() === '保存草稿');
    return JSON.stringify({
      open: text.includes('保存草稿'),
      header: (text.split('\\n').find((line) => line.includes('的详细信息')) || '').trim(),
      descLen: area ? area.value.length : -1,
      logoReady: logoImg || text.includes('为所有语言复制此徽标'),
      saveDisabled: save ? save.hasAttribute('disabled') : null,
    });
  })()`;
  return JSON.parse(evaluate(expression));
}

async function waitFor(label, fn, timeoutMs, intervalMs = 800) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = fn();
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`${label} 超时（${timeoutMs}ms）`);
}

function openRow(label) {
  const expression = `(() => {
    const all = [];
    const walk = (root) => { for (const e of root.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot); } };
    walk(document);
    const cell = all.find((e) => e.tagName === 'TD' && (e.textContent || '').trim() === ${JSON.stringify(label)});
    if (!cell) return JSON.stringify({ ok: false, reason: 'cell-not-found' });
    let row = cell;
    for (let i = 0; i < 6 && row && row.tagName !== 'TR'; i += 1) {
      const root = row.getRootNode();
      row = row.parentElement || (root && root.host) || null;
    }
    if (!row) return JSON.stringify({ ok: false, reason: 'row-not-found' });
    const edit = [...row.querySelectorAll('*')].find((e) => (e.textContent || '').trim() === '编辑详细信息');
    if (!edit) return JSON.stringify({ ok: false, reason: 'edit-not-found' });
    edit.click();
    return JSON.stringify({ ok: true });
  })()`;
  return JSON.parse(evaluate(expression));
}

function setDescription(text) {
  const expression = `(() => {
    const area = [...document.querySelectorAll('textarea')].find((e) => /textarea_description/.test(e.id));
    if (!area) return JSON.stringify({ ok: false, reason: 'no-textarea' });
    area.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(area, ${JSON.stringify(text)});
    area.dispatchEvent(new Event('input', { bubbles: true }));
    area.dispatchEvent(new Event('change', { bubbles: true }));
    area.blur();
    return JSON.stringify({ ok: true, len: area.value.length });
  })()`;
  return JSON.parse(evaluate(expression));
}

function tagLogoInput() {
  const expression = `(() => {
    const inputs = [...document.querySelectorAll('input[name="fileuploader"]')];
    if (!inputs.length) return JSON.stringify({ ok: false });
    inputs.forEach((e) => e.removeAttribute('id'));
    inputs[0].id = 'bb-logo-input';
    return JSON.stringify({ ok: true, total: inputs.length });
  })()`;
  return JSON.parse(evaluate(expression));
}

function rowStatus(label) {
  const expression = `(() => {
    const all = [];
    const walk = (root) => { for (const e of root.querySelectorAll('*')) { all.push(e); if (e.shadowRoot) walk(e.shadowRoot); } };
    walk(document);
    const cell = all.find((e) => e.tagName === 'TD' && (e.textContent || '').trim() === ${JSON.stringify(label)});
    if (!cell) return JSON.stringify({ status: null });
    let row = cell;
    for (let i = 0; i < 6 && row && row.tagName !== 'TR'; i += 1) {
      const root = row.getRootNode();
      row = row.parentElement || (root && root.host) || null;
    }
    const cells = row ? [...row.querySelectorAll('td')].map((td) => (td.textContent || '').trim().slice(0, 20)) : [];
    return JSON.stringify({ status: cells.length ? cells.slice(0, 4).join(' | ') : null });
  })()`;
  const parsed = JSON.parse(evaluate(expression));
  return parsed.status;
}

/** 关掉可能挡路的原生对话框（beforeunload 等）。 */
function dismissDialogs() {
  try {
    const list = bridge(['dialog', 'list']);
    const dialogs = list.result && list.result.dialogs ? list.result.dialogs : [];
    for (const dialog of dialogs) {
      bridge(['dialog', 'accept', String(dialog.id)]);
    }
    return dialogs.length;
  } catch {
    return 0;
  }
}

async function goListings() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    dismissDialogs();
    try {
      bridge(['navigate', LISTINGS_URL]);
      break;
    } catch (error) {
      if (/E_DIALOG_PENDING/.test(error.message)) {
        dismissDialogs();
        await sleep(600);
        continue;
      }
      throw error;
    }
  }
  await waitFor('listings 表格加载', () => rowStatus('英语') !== null, 25000);
}

async function fillOne(label, locale) {
  const description = descriptionOf(locale);
  const chars = [...description].length;
  if (chars < 250) throw new Error(`${locale} 描述不足 250 字符`);
  console.log(`\n[${locale}] ${label} — 描述 ${chars} 字符`);

  dismissDialogs();
  if (panelState().open) {
    await goListings();
  }
  let opened = openRow(label);
  for (let attempt = 0; attempt < 10 && !opened.ok; attempt += 1) {
    await sleep(1200);
    opened = openRow(label);
  }
  if (!opened.ok) throw new Error(`打开 ${label} 行失败：${opened.reason}`);
  await sleep(2500);

  const state = panelState();
  if (!state.open || state.descLen < 0) throw new Error(`${label} 详情面板没出来：${JSON.stringify(state)}`);
  if (!(state.header || '').includes(label)) throw new Error(`面板语言不匹配：期望 ${label}，实际 ${state.header}`);
  console.log(`  面板：${state.header}`);

  if (!SKIP_UPLOAD) {
    const tagged = tagLogoInput();
    if (!tagged.ok) throw new Error('找不到徽标 file input');
    const upload = bridge(['upload', '#bb-logo-input', '--file', LOGO], 180000);
    console.log('  上传：' + JSON.stringify((upload.result && upload.result.names) || upload.result));
    const ready = await waitFor('徽标预览出现', () => panelState().logoReady, 30000);
    console.log('  徽标预览：已出现');
    if (!ready) throw new Error('徽标预览没出现');
  }

  const set = setDescription(description);
  if (!set.ok) throw new Error(`填描述失败：${JSON.stringify(set)}`);
  await sleep(700);
  const after = panelState();
  if (after.descLen !== chars) throw new Error(`描述长度不符：${after.descLen} vs ${chars}`);
  const enabled = await waitFor('保存按钮可用', () => panelState().saveDisabled === false, 15000);
  console.log(`  描述已填：${after.descLen} 字符，保存按钮可用`);

  const saved = clickText('保存草稿', { tag: 'V6_HE-BUTTON' });
  if (!saved.ok) throw new Error('没找到“保存草稿”按钮');
  await sleep(3000);

  await goListings();
  const status = await waitFor('行状态回读', () => rowStatus(label), 15000).catch(() => null);
  console.log(`  行状态：${status}`);
  return status || '';
}

async function main() {
  const targets = ONLY
    ? LANGUAGES.filter(([, locale]) => locale === ONLY)
    : (arg('--languages') ? LANGUAGES.filter(([, locale]) => arg('--languages').split(',').includes(locale)) : LANGUAGES);
  if (!targets.length) throw new Error('没有匹配的语言');

  for (const [label, locale] of targets) {
    try {
      const status = await fillOne(label, locale);
      if (!/已完成|完整|Complete/.test(status || '')) console.log(`  ⚠ ${locale} 行状态尚未变“已完成”：${status}`);
    } catch (error) {
      console.log(`  ✗ ${locale}：${error.message}`);
    }
  }
  console.log('\n完成。');
}

main().catch((error) => {
  console.error('\n失败：' + error.message);
  process.exit(1);
});
