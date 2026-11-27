// tools/compare/web2-tasks.mjs —— 真实公开网站上的第二轮功能测试（DemoQA）。
import fs from 'node:fs';
import os from 'node:os';
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

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 把命令输出压成一段可读的失败原因。 */
function brief(...texts) {
  return texts.map((text) => String(text || '').slice(0, 160)).join(' | ');
}

export const web2Tasks = [
  {
    id: 'X1',
    phase: 'web2',
    title: 'DemoQA：原生 confirm（对话框）',
    async run(tool, ctx) {
      const open = await tool.cli(['open', 'https://demoqa.com/alerts', '--json']);
      const sid = webSession(open.stdout);
      await sleep(1200);
      let click;
      if (tool.name === 'bridge') {
        click = await tool.cli(withSession(['click', '#confirmButton', '--accept-dialog', '--json'], sid));
      } else {
        click = await tool.cli(withSession(['click', '#confirmButton', '--json'], sid));
        const parsed = parseJson(click.stdout);
        const data = parsed && parsed.data ? parsed.data : null;
        if (data && data.dialog && data.dialog.id) {
          await tool.cli(withSession(['dialog', 'accept', String(data.dialog.id), '--json'], sid));
          if (data.operation_id) await tool.cli(withSession(['operation', 'await', String(data.operation_id), '--json'], sid));
        }
      }
      await sleep(800);
      const probe = await tool.cli(withSession(['read', '--selector', '#confirmResult', '--json'], sid));
      const ok = open.code === 0 && click.code === 0 && /Ok/i.test(probe.stdout);
      return {
        ok,
        steps: 3,
        ms: open.ms + click.ms + probe.ms,
        detail: ok ? 'confirm 已接受，页面显示 Ok' : '失败：' + brief(click.stdout, probe.stdout),
        raw: (click.stdout + '\n' + probe.stdout).slice(0, 2000),
      };
    },
  },
  {
    id: 'X2',
    phase: 'web2',
    title: 'DemoQA：文件上传',
    async run(tool, ctx) {
      const open = await tool.cli(['open', 'https://demoqa.com/upload-download', '--json']);
      const sid = webSession(open.stdout);
      await sleep(1200);
      const file = path.join(ctx.runDir, 'demoqa-upload.txt');
      ensureDir(path.dirname(file));
      fs.writeFileSync(file, 'demoqa upload\n', 'utf8');
      const upload = tool.name === 'bsk'
        ? await tool.cli(withSession(['upload', '--selector', '#uploadFile', '--file', file, '--json'], sid))
        : await tool.cli(withSession(['upload', '#uploadFile', '--file', file, '--json'], sid));
      await sleep(600);
      const probe = await tool.cli(withSession(['evaluate', "document.querySelector('#uploadedFilePath') ? document.querySelector('#uploadedFilePath').innerText : ''", '--json'], sid));
      const ok = open.code === 0 && upload.code === 0 && /demoqa-upload/.test(probe.stdout);
      return {
        ok,
        steps: 3,
        ms: open.ms + upload.ms + probe.ms,
        detail: ok ? '文件已进入页面（uploadedFilePath 显示文件名）' : '失败：' + brief(upload.stdout, probe.stdout),
        raw: (upload.stdout + '\n' + probe.stdout).slice(0, 2000),
      };
    },
  },
  {
    id: 'X3',
    phase: 'web2',
    title: 'DemoQA：练习表单填写并提交',
    async run(tool, ctx) {
      const open = await tool.cli(['open', 'https://demoqa.com/automation-practice-form', '--json']);
      const sid = webSession(open.stdout);
      const fillA = tool.name === 'bsk'
        ? await tool.cli(withSession(['fill', '--selector', '#firstName', '--value', 'Bridge', '--json'], sid))
        : await tool.cli(withSession(['fill', '#firstName', '--value', 'Bridge', '--json'], sid));
      const fillB = tool.name === 'bsk'
        ? await tool.cli(withSession(['fill', '--selector', '#lastName', '--value', 'Deck', '--json'], sid))
        : await tool.cli(withSession(['fill', '#lastName', '--value', 'Deck', '--json'], sid));
      const click = await tool.cli(withSession(['click', '#submit', '--json'], sid));
      await sleep(1200);
      const probe = tool.name === 'bridge'
        ? await tool.cli(withSession(['evaluate', "document.body.innerText.includes('Thanks for submitting the form')", '--json'], sid))
        : await tool.cli(withSession(['read', '--selector', 'body', '--json'], sid));
      const ok = open.code === 0 && fillA.code === 0 && fillB.code === 0 && click.code === 0 && /Thanks|true/i.test(probe.stdout);
      return {
        ok,
        steps: 5,
        ms: open.ms + fillA.ms + fillB.ms + click.ms + probe.ms,
        detail: ok ? '提交成功（出现 Thanks for submitting the form）' : '失败：' + brief(fillA.stdout, click.stdout, probe.stdout),
        raw: (fillA.stdout + '\n' + click.stdout + '\n' + probe.stdout).slice(0, 2500),
      };
    },
  },
  {
    id: 'X4',
    phase: 'web2',
    title: 'DemoQA：动态元素等待（5s 后可用）',
    async run(tool, ctx) {
      const open = await tool.cli(['open', 'https://demoqa.com/dynamic-properties', '--json']);
      const sid = webSession(open.stdout);
      const wait = tool.name === 'bsk'
        ? await tool.cli(withSession(['wait-for-element', '--selector', '#enableAfter', '--state', 'visible', '--timeout', '12s', '--json'], sid))
        : await tool.cli(withSession(['wait-for-element', '#enableAfter', '--state', 'visible', '--timeout', '12s', '--json'], sid));
      const ok = open.code === 0 && wait.code === 0 && /"satisfied":\s*true/.test(wait.stdout);
      return {
        ok,
        steps: 2,
        ms: open.ms + wait.ms,
        detail: ok ? '等到按钮 5s 后变为可用' : '失败：' + brief(wait.stdout),
        raw: wait.stdout.slice(0, 2000),
      };
    },
  },
  {
    id: 'X5',
    phase: 'web2',
    title: 'DemoQA：移动端仿真 + 截图',
    async run(tool, ctx) {
      const open = await tool.cli(['open', 'https://demoqa.com/text-box', '--json']);
      const sid = webSession(open.stdout);
      const emulate = await tool.cli(withSession(['emulate', '--device', 'iphone-14', '--json'], sid));
      await sleep(900);

      const out = path.join(ctx.runDir, 'shots', `${tool.name}-emulated.png`);
      const tmpOut = path.join(os.tmpdir(), `emu-${tool.name}-${Date.now()}.png`);
      const shot = await tool.cli(withSession(['screenshot', '--out', tmpOut, '--json'], sid));
      const source = fs.existsSync(tmpOut) ? tmpOut : out;
      if (source !== out && fs.existsSync(source)) fs.copyFileSync(source, out);
      const mobile = /390/.test(emulate.stdout);
      const ok = open.code === 0 && emulate.code === 0 && mobile && shot.code === 0 && fs.existsSync(out);
      return {
        ok,
        steps: 3,
        ms: open.ms + emulate.ms + shot.ms,
        detail: ok ? '仿真宽度进入手机区间且截图成功' : '失败：' + brief(emulate.stdout, shot.stdout),
        raw: (emulate.stdout + '\n' + shot.stdout).slice(0, 2500),
      };
    },
  },
];
