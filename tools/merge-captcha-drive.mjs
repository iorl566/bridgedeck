#!/usr/bin/env node
// tools/merge-captcha-drive.mjs —— 把多轮驱动矩阵结果合并成基线。
//
// 判定口径与 HANDOFF 一致：**至少一次 rejected 即视为通道已验证**；
// 每次判定都保留，不因为结果不一致就丢掉某次采样。
//   rejected            -> 页面报错 / 题目被重置（事件被接收并判定）
//   no-feedback         -> 没有可观测反馈（不等于通道不通）
//   no-widget           -> 控件没渲染出来，不算一次有效采样（但保留计数）
//   advanced            -> 页面推进（说明这一步本来就不需要解）
//   dispatch-error / no-target -> 手势没发出去，算混合，不算"没反应"
//
// 用法：
//   node tools/merge-captcha-drive.mjs --dir .tmp-bench/captcha-drive --out tests/anti-bot/captcha-drive-baseline.json
//   ... --min 3        每个题型至少 N 次有效采样，否则退出码 3 且不写基线
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = { dir: '', out: '', min: 3, files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i] || '';
    else if (a === '--out') args.out = argv[++i] || '';
    else if (a === '--min') args.min = Number(argv[++i]) || 3;
    else if (a === '-h' || a === '--help') {
      console.log('用法：node tools/merge-captcha-drive.mjs --dir <目录> --out <基线文件> [--min 3] [run 文件...]');
      process.exit(0);
    } else if (!a.startsWith('--')) args.files.push(a);
  }
  return args;
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 数字友好的排序：run-2 排在 run-10 前面。 */
function naturalCompare(a, b) {
  return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
}

function collectFiles(args) {
  if (args.files.length) return args.files.map((f) => path.resolve(f));
  const base = path.resolve(args.dir);
  // 多轮结果按子目录存放（run-1/、run-2/…）；目录本身也有 matrix.json 时以子目录为准，
  // 否则会把上一轮留下的单个旧结果当成全部轮次。
  const subdirs = fs.readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(base, d.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'matrix.json')))
    .sort(naturalCompare);
  if (subdirs.length) return subdirs.map((dir) => path.join(dir, 'matrix.json'));
  const own = path.join(base, 'matrix.json');
  if (fs.existsSync(own)) return [own];
  return [];
}

const args = parseArgs(process.argv.slice(2));
if (!args.dir && !args.files.length) {
  console.error('需要 --dir <矩阵结果目录> 或若干 matrix.json 路径');
  process.exit(2);
}
if (!args.out) {
  console.error('需要 --out <基线 JSON 路径>');
  process.exit(2);
}

const files = collectFiles(args).filter((f) => fs.existsSync(f));
if (!files.length) {
  console.error('找不到 matrix.json：' + (args.dir || args.files.join(', ')));
  process.exit(2);
}

const cases = new Map();
files.forEach((file, index) => {
  const raw = JSON.parse(stripBom(fs.readFileSync(file, 'utf8')));
  const run = index + 1;
  for (const item of raw.cases || []) {
    if (!item || !item.id) continue;
    let entry = cases.get(item.id);
    if (!entry) {
      entry = { id: item.id, title: item.title || '', gesture: item.gesture || '', attempts: [], noWidget: 0 };
      cases.set(item.id, entry);
    }
    if (item.verdict === 'no-widget') {
      entry.noWidget += 1;
      continue;
    }
    entry.attempts.push({
      run,
      verdict: String(item.verdict || 'unknown'),
      detail: String(item.detail || ''),
      feedback: String(item.feedback || ''),
      trust: String(item.trust || ''),
      signals: Array.isArray(item.signals) ? item.signals : [],
    });
  }
});

const merged = [];
let channelVerified = 0;
let neverReacted = 0;
let mixed = 0;
const shortfall = [];

for (const entry of cases.values()) {
  const verdicts = entry.attempts.map((a) => a.verdict);
  const rejectedOnce = verdicts.includes('rejected');
  const stableNoFeedback = verdicts.length > 0 && verdicts.every((v) => v === 'no-feedback');
  let finalVerdict = 'mixed';
  if (rejectedOnce) { finalVerdict = 'channel-verified'; channelVerified += 1; }
  else if (stableNoFeedback) { finalVerdict = 'never-reacted'; neverReacted += 1; }
  else { mixed += 1; }

  if (entry.attempts.length < args.min) {
    shortfall.push(entry.id + ' 只有 ' + entry.attempts.length + ' 次有效采样（需要 ' + args.min + '）');
  }

  merged.push({
    id: entry.id,
    title: entry.title,
    gesture: entry.gesture,
    attempts: entry.attempts,
    verdicts,
    rejectedOnce,
    stableNoFeedback,
    finalVerdict,
    noWidget: entry.noWidget,
  });
}

const baseline = {
  suite: 'captcha-drive',
  mergedAt: new Date().toISOString(),
  runs: files.length,
  minAttempts: args.min,
  channelVerified,
  neverReacted,
  mixed,
  files: files.map((f) => path.relative(process.cwd(), f)),
  cases: merged,
};

if (shortfall.length) {
  console.error('有效采样次数不足，未写基线：');
  for (const line of shortfall) console.error('  - ' + line);
  process.exit(3);
}

fs.writeFileSync(path.resolve(args.out), JSON.stringify(baseline, null, 2) + '\n', 'utf8');
console.log('channel-verified=' + channelVerified + '  never-reacted=' + neverReacted + '  mixed=' + mixed
  + '  runs=' + files.length + ' -> ' + args.out);
