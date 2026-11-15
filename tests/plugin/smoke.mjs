// 插件直连冒烟：真实 daemon + 真实浏览器，禁用 CLI 兜底（走 CLI 即失败）。
// 用法：BB_SMOKE_BROWSER=<instanceId> node tests/plugin/smoke.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buildToolSpecs } from '../../dsh-plugin/lib/tools.mjs';

const browser = process.env.BB_SMOKE_BROWSER || '';
if (!browser) {
  console.log('SKIP 插件冒烟：设置 BB_SMOKE_BROWSER=<instanceId> 后运行');
  process.exit(0);
}

// 直连可用性检查：daemon.json 必须存在，避免误走 CLI 兜底。
const home = process.env.BB_HOME || path.join(os.homedir(), '.browser-bridge');
const infoPath = path.join(home, 'daemon.json');
if (!fs.existsSync(infoPath)) {
  console.error('FAIL 找不到 daemon.json：' + infoPath);
  process.exit(1);
}

const fixture = fs.readFileSync(path.resolve('tests/fixtures/test.html'));
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fixture);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/test.html`;

let passed = 0;
const check = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log('  PASS  ' + name);
  } catch (error) {
    console.log('  FAIL  ' + name + ' — ' + ((error && error.message) || error));
    server.close();
    process.exit(1);
  }
};

const cliCalls = [];
const specs = buildToolSpecs(async (argv) => {
  cliCalls.push(argv);
  throw new Error('直连冒烟不应回退 CLI：' + JSON.stringify(argv));
});
const byName = new Map(specs.map((spec) => [spec.name, spec]));
const tool = (name) => byName.get(name);

let sessionId = null;
const out = path.join(os.tmpdir(), 'bb-plugin-smoke-' + Date.now() + '.png');

console.log('BridgeDeck 插件直连冒烟：browser=' + browser);

await check('browser_status 直连', async () => {
  const status = await tool('browser_status').execute({}, {});
  if (!Array.isArray(status.browsers) || status.browsers.length === 0) throw new Error('没有已连接浏览器');
});

await check('browser_session_start 直连 + journal', async () => {
  sessionId = (await tool('browser_session_start').execute({ browser, noFocus: true }, {})).sessionId;
  if (!sessionId) throw new Error('没有 sessionId');
});

await check('browser_navigate 到夹具页', async () => {
  const nav = await tool('browser_navigate').execute({ sessionId, url }, {});
  if (nav.url !== url) throw new Error('最终 URL 不对：' + nav.url);
});

let ref = null;
await check('browser_observe 直连并拿到 ref', async () => {
  const observed = await tool('browser_observe').execute({ sessionId }, {});
  const match = observed.observation.match(/textbox[^\n]*\[@(e\d+)\]/);
  if (!match) throw new Error('没有 textbox ref');
  ref = match[1];
});

await check('browser_act fill 直连', async () => {
  const result = await tool('browser_act').execute({ sessionId, action: 'fill', ref: '@' + ref, value: 'smoke' }, {});
  if (result.ok === false) throw new Error('fill 失败：' + JSON.stringify(result));
});

await check('browser_read 直连', async () => {
  const read = await tool('browser_read').execute({ sessionId, kind: 'read', selector: '#kw' }, {});
  if (!Array.isArray(read.fields) || read.fields[0].value !== 'smoke') throw new Error('read 值不对：' + JSON.stringify(read));
});

await check('browser_screenshot 直连并落盘', async () => {
  const shot = await tool('browser_screenshot').execute({ sessionId, out }, {});
  if (!shot.bytes || shot.bytes < 1000) throw new Error('截图太小：' + JSON.stringify(shot));
  if (!fs.existsSync(out)) throw new Error('截图文件不存在');
});

let newTab = null;
await check('browser_tab new/list/close 直连', async () => {
  newTab = await tool('browser_tab').execute({ action: 'new', url: 'about:blank', noFocus: true }, {});
  if (!newTab || !Number.isInteger(newTab.tabId)) throw new Error('tab.new 没有 tabId');
  const list = await tool('browser_tab').execute({ action: 'list' }, {});
  if (!Array.isArray(list.tabs)) throw new Error('tab.list 没有 tabs');
  await tool('browser_tab').execute({ action: 'close', tabId: newTab.tabId }, {});
});

await check('browser_window list 直连', async () => {
  const windows = await tool('browser_window').execute({ action: 'list' }, {});
  if (!Array.isArray(windows.windows) || windows.windows.length === 0) throw new Error('没有窗口');
});

await check('browser_session_stop 直连', async () => {
  await tool('browser_session_stop').execute({ sessionId }, {});
  sessionId = null;
});

await check('全程没有回退 CLI', async () => {
  if (cliCalls.length) throw new Error('发生了 CLI 回退：' + JSON.stringify(cliCalls));
});

server.close();
fs.rmSync(out, { force: true });
console.log('PLUGIN SMOKE PASS — ' + passed + ' 项，0 次 CLI 回退');
