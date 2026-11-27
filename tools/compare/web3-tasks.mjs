// tools/compare/web3-tasks.mjs —— 第三轮：下载 / 网络抓包 / 多标签页 / 视频录制。
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseJson(text) {
  const start = String(text).indexOf('{');
  const end = String(text).lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(String(text).slice(start, end + 1));
  } catch {
    return null;
  }
}

function webSession(stdout) {
  const json = parseJson(stdout);
  if (!json) return null;
  return (json.result && json.result.sessionId) || json.session_id || json.sessionId || null;
}

function withSession(args, sessionId) {
  if (!sessionId) return args;
  return [...args, '--session', String(sessionId)];
}

const brief = (...texts) => texts.map((text) => String(text || '').slice(0, 150)).join(' | ');

export const web3Tasks = [
  {
    id: 'Y1',
    phase: 'web3',
    title: 'DemoQA：点击下载文件',
    async run(tool, ctx) {
      const open = await tool.cli(['open', 'https://demoqa.com/upload-download', '--json']);
      const sid = webSession(open.stdout);
      await sleep(1000);
      const out = path.join(ctx.runDir, 'downloads', `${tool.name}-demoqa-download.bin`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.rmSync(out, { force: true });
      const download = tool.name === 'bsk'
        ? await tool.cli(withSession(['download', '--selector', '#downloadButton', '--out', out, '--json'], sid))
        : await tool.cli(withSession(['download', '#downloadButton', '--out', out, '--json'], sid));
      const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
      const ok = open.code === 0 && download.code === 0 && size > 0;
      return { ok, steps: 3, ms: open.ms + download.ms, detail: ok ? `下载落盘 ${size} 字节` : `失败：${brief(download.stdout)} size=${size}`, raw: download.stdout.slice(0, 2000) };
    },
  },
  {
    id: 'Y2',
    phase: 'web3',
    title: 'DemoQA：网络抓包（debug start → requests）',
    async run(tool, ctx) {
      const url = 'https://demoqa.com/text-box';
      const open = await tool.cli(['open', url, '--json']);
      const sid = webSession(open.stdout);
      await sleep(600);
      const start = await tool.cli(withSession(['debug', 'start', '--name', 'web3', '--json'], sid));
      await sleep(400);
      const nav = await tool.cli(withSession(['navigate', url, '--json'], sid));
      await sleep(1800);
      const requests = await tool.cli(withSession(['debug', 'requests', '--json'], sid));
      const stop = await tool.cli(withSession(['debug', 'stop', '--json'], sid)).catch(() => ({ code: 0, stdout: '' }));
      const hasRequests = /"url"/.test(requests.stdout) && (requests.stdout.match(/"url"/g) || []).length >= 3;
      const ok = open.code === 0 && start.code === 0 && nav.code === 0 && requests.code === 0 && hasRequests;
      return { ok, steps: 5, ms: open.ms + start.ms + nav.ms + requests.ms + (stop.ms || 0), detail: ok ? '抓到 ≥3 条请求' : `失败：${brief(start.stdout, nav.stdout, requests.stdout)}`, raw: (start.stdout + '\n' + requests.stdout).slice(0, 2500) };
    },
  },
  {
    id: 'Y3',
    phase: 'web3',
    title: '多标签页：新开 + 列出 + 关闭',
    async run(tool, ctx) {
      const open = await tool.cli(['open', 'https://example.com/', '--json']);
      const sid = webSession(open.stdout);
      await sleep(400);
      const create = tool.name === 'bsk'
        ? await tool.cli(withSession(['tab', 'create', '--url', 'https://learn.microsoft.com/en-us/microsoft-edge/extensions/', '--json'], sid))
        : await tool.cli(withSession(['tab', 'new', 'https://learn.microsoft.com/en-us/microsoft-edge/extensions/', '--json'], sid));
      await sleep(1000);
      const list = await tool.cli(withSession(['tab', 'list', '--json'], sid));
      const parsed = parseJson(create.stdout);
      const tabId = (parsed && (parsed.tab_id || (parsed.result && (parsed.result.tabId || parsed.result.tab_id)))) || null;
      let close = { code: 0, stdout: '' };
      if (tabId !== null) close = await tool.cli(withSession(['tab', 'close', String(tabId), '--json'], sid));
      const listed = /learn\.microsoft\.com|microsoft-edge/.test(list.stdout);
      const ok = open.code === 0 && create.code === 0 && list.code === 0 && listed && (tabId === null || close.code === 0);
      return { ok, steps: 4, ms: open.ms + create.ms + list.ms + (close.ms || 0), detail: ok ? `新标签已创建并关闭（tabId=${tabId}）` : `失败：${brief(create.stdout, list.stdout, close.stdout)}`, raw: (create.stdout + '\n' + list.stdout).slice(0, 2500) };
    },
  },
  {
    id: 'Y4',
    phase: 'web3',
    title: 'DemoQA：视频录制 3s',
    async run(tool, ctx) {
      const open = await tool.cli(['open', 'https://demoqa.com/text-box', '--json']);
      const sid = webSession(open.stdout);
      await sleep(500);
      const start = await tool.cli(withSession(['video', 'start', '--duration', '3s', '--quality', 'standard', '--json'], sid), 120000);
      const startJson = parseJson(start.stdout);
      const recordingId = (startJson && ((startJson.result && startJson.result.recordingId) || startJson.recordingId)) || null;
      await sleep(3500);
      let status = { code: null, stdout: '' };
      let list = { code: null, stdout: '' };
      if (recordingId) {
        status = await tool.cli(withSession(['video', 'status', recordingId, '--json'], sid)).catch(() => ({ code: null, stdout: '' }));
        await tool.cli(withSession(['video', 'stop', recordingId, '--json'], sid)).catch(() => null);
      }
      list = await tool.cli(withSession(['video', 'list', '--json'], sid)).catch(() => ({ code: null, stdout: '' }));
      const out = path.join(ctx.runDir, 'videos', tool.name + '-3s.mp4');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.rmSync(out, { force: true });
      let save = { code: null, stdout: '' };
      if (recordingId) save = await tool.cli(withSession(['video', 'save', recordingId, '--out', out, '--json'], sid), 120000).catch(() => ({ code: null, stdout: '' }));
      const size = fs.existsSync(out) ? fs.statSync(out).size : 0;
      const finished = size > 0 || /completed|stopped|ready|saved|available/i.test(status.stdout + list.stdout) || (recordingId && list.stdout.includes(recordingId));
      const ok = open.code === 0 && start.code === 0 && !!recordingId && finished;
      return { ok, steps: 3, ms: open.ms + start.ms + (status.ms || 0) + (list.ms || 0), detail: ok ? '录制已结束并可查询' : `失败：${brief(start.stdout, status.stdout, list.stdout)}`, raw: (start.stdout + '\n' + status.stdout + '\n' + list.stdout).slice(0, 2500) };
    },
  },
];
