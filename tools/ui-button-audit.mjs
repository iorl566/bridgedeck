// tools/ui-button-audit.mjs —— 静态确认每个 UI 按钮都有事件路径。
// 只做绑定审计，不执行破坏性动作；真实点击由 E2E 的 selftest 覆盖。
import fs from 'node:fs';
import path from 'node:path';

const UI = path.join('extension', 'ui');
const JS_FILES = {
  'audit.html': ['audit.js'],
  'debug.html': ['debug.js'],
  'longshot.html': ['longshot.js'],
  'ops.html': ['ops.js'],
  'options.html': ['options.js'],
  'popup.html': ['popup.js', 'panels/audit-panel.js', 'panels/debug-panel.js', 'panels/longshot-panel.js', 'panels/ops-panel.js', 'panels/video-panel.js'],
  'quick.html': ['quick.js'],
  'privacy.html': [],
  'record.html': ['record.js'],
};

const hasClick = (js, id) => {
  const patterns = [
    new RegExp(`(?:getElementById|\\$)\\('${id}'\\)[\\s\\S]{0,160}?addEventListener\\('(?:click|submit|change|input)'`),
    new RegExp(`(?:getElementById|\\$)\\('${id}'\\)\\.onclick`),
  ];
  return patterns.some((pattern) => pattern.test(js));
};

const report = [];
let missing = 0;
for (const [page, scripts] of Object.entries(JS_FILES)) {
  const html = fs.readFileSync(path.join(UI, page), 'utf8');
  const js = scripts.map((file) => fs.readFileSync(path.join(UI, file), 'utf8')).join('\n');
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((match) => {
    const attrs = match[1];
    const text = match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
    const id = /id="([^"]+)"/.exec(attrs)?.[1] || '';
    const type = /type="([^"]+)"/.exec(attrs)?.[1] || 'submit';
    const dataPage = /data-page="([^"]+)"/.exec(attrs)?.[1] || '';
    const described = /aria-describedby="([^"]+)"/.test(attrs);
    const inline = /onclick="/.test(attrs);
    return { id, type, dataPage, described, inline, text };
  });
  for (const button of buttons) {
    let status = 'missing';
    if (button.inline) status = 'wired-inline';
    else if (button.dataPage && /\.feature\[data-page\]|\.entry/.test(js)) status = 'wired-delegated';
    else if (button.id && hasClick(js, button.id)) status = 'wired';
    else if (button.type === 'submit' && /addEventListener\('submit'/.test(js)) status = 'wired-form';
    else if (button.described) status = 'info';
    if (status === 'missing') missing += 1;
    report.push({ page, id: button.id || '(no id)', text: button.text, type: button.type, dataPage: button.dataPage, status });
  }
}

for (const item of report) {
  console.log(`${item.status === 'missing' ? 'MISSING' : 'OK     '} ${item.page.padEnd(13)} ${(item.id || '-').padEnd(16)} ${item.text}`);
}
console.log(`\nbuttons=${report.length} missing=${missing} info=${report.filter((i) => i.status === 'info').length}`);
if (missing) process.exitCode = 1;
