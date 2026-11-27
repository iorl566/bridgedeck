// tests/unit/cli-readme-commands.test.mjs —— README 命令索引生成器与漂移门禁
// （tools/readme-commands.mjs）。
//
// 覆盖三层：
//   1) 纯函数：specs → 表格行 / 标记区间替换 / 漂移描述；
//   2) 仓库真实 README：与 specs 一致（`--check` 必须是 clean）；
//   3) CLI：--check / 生成 / 漂移（退出码 1）/ 结构问题（退出码 2）/ --stdout / --json。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BEGIN_MARKER,
  END_MARKER,
  auditCommandSpecs,
  buildCommandIndexRows,
  checkReadmeText,
  describeDrift,
  extractCommandIndexBody,
  generateForFile,
  locateMarkers,
  renderCommandIndexBody,
  renderCommandIndexSection,
  replaceCommandIndex,
} from '../../tools/readme-commands.mjs';
import { COMMAND_SPECS, COMMAND_TOPICS, renderCommandHelp } from '../../cli/lib/command-specs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const README = path.join(REPO, 'README.md');
const TOOL = path.join(REPO, 'tools', 'readme-commands.mjs');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-readme-commands-'));

function runTool(args) {
  return spawnSync(process.execPath, [TOOL, ...args], { cwd: REPO, encoding: 'utf8', timeout: 60_000 });
}

function readmeWithMarkers(body = 'placeholder') {
  return ['# Demo', '', '前置内容', '', BEGIN_MARKER, body, END_MARKER, '', '后置内容', ''].join('\n');
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('auditCommandSpecs：真实 specs 结构完整', () => {
  assert.deepEqual(auditCommandSpecs(COMMAND_SPECS), []);
});

test('auditCommandSpecs：缺 summary/usage、order 与 subs 不一致都会报', () => {
  const broken = {
    demo: {
      command: 'wrong',
      summary: '',
      order: ['a', 'ghost'],
      subs: { a: {}, b: { usage: 'bridge demo b' } },
    },
  };
  const problems = auditCommandSpecs(broken);
  assert.ok(problems.some((item) => item.includes('command 与键名不一致')));
  assert.ok(problems.some((item) => item.includes('缺少 summary')));
  assert.ok(problems.some((item) => item.includes('a: 缺少 usage')));
  assert.ok(problems.some((item) => item.includes('ghost 不在 subs 里')));
  assert.ok(problems.some((item) => item.includes('b 不在 order 里')));
});

test('buildCommandIndexRows：每个 command 一行，子命令按 order 展开', () => {
  const rows = buildCommandIndexRows(COMMAND_SPECS);
  assert.equal(rows.length, COMMAND_TOPICS.length);
  assert.deepEqual(rows.map((row) => row[0]), COMMAND_TOPICS.map((topic) => '`bridge ' + topic + '`'));
  const sessionRow = rows.find((row) => row[0] === '`bridge session`');
  assert.ok(sessionRow[1].includes('start'));
  assert.ok(sessionRow[1].includes('handoff'));
  assert.ok(sessionRow[2].includes('browser_mutation'));
  assert.equal(sessionRow[3], COMMAND_SPECS.session.summary);
});

test('renderCommandIndexBody 幂等且覆盖全部 specs 命令', () => {
  const first = renderCommandIndexBody();
  const second = renderCommandIndexBody();
  assert.equal(first, second, '同一份 specs 必须得到逐字节相同的文本');
  assert.ok(first.includes('| 命令 | 子命令 | 风险 | 说明 |'));
  for (const topic of COMMAND_TOPICS) {
    assert.ok(first.includes('`bridge ' + topic + '`'), '缺少 ' + topic);
    assert.ok(first.includes(COMMAND_SPECS[topic].summary), '缺少 ' + topic + ' 的 summary');
  }
  // 帮助与 README 使用同一份 specs：命令数量和主题必须对得上。
  assert.equal((first.match(/^\| `bridge /gm) || []).length, COMMAND_TOPICS.length);
});

test('renderCommandIndexSection 包住标记且只在标记之间放内容', () => {
  const section = renderCommandIndexSection();
  assert.ok(section.startsWith(BEGIN_MARKER));
  assert.ok(section.endsWith(END_MARKER));
  assert.ok(section.includes(renderCommandIndexBody()));
});

test('locateMarkers / extractCommandIndexBody：正常与缺失两种情况', () => {
  const text = readmeWithMarkers('BODY');
  const located = locateMarkers(text);
  assert.equal(located.ok, true);
  assert.equal(located.beginLine, 5);
  assert.equal(located.endLine, 7);
  const extracted = extractCommandIndexBody(text);
  assert.equal(extracted.ok, true);
  assert.equal(extracted.body, 'BODY');

  assert.equal(locateMarkers('# no markers').ok, false);
  assert.match(locateMarkers('# no markers').reason, /BEGIN/);
  assert.match(locateMarkers(BEGIN_MARKER + '\n').reason, /END/);
  assert.match(locateMarkers(END_MARKER + '\n' + BEGIN_MARKER).reason, /之前/);
  assert.equal(extractCommandIndexBody('').ok, false);
});

test('replaceCommandIndex：只改标记区间，前后内容逐字保留', () => {
  const before = readmeWithMarkers('旧内容\n旧内容2');
  const result = replaceCommandIndex(before, '新内容');
  assert.equal(result.ok, true);
  assert.ok(result.text.startsWith('# Demo\n\n前置内容\n\n' + BEGIN_MARKER + '\n新内容\n' + END_MARKER));
  assert.ok(result.text.endsWith('\n\n后置内容\n'));
  assert.equal(result.text.includes('旧内容'), false);

  const missing = replaceCommandIndex('# no markers', 'x');
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /BEGIN/);
});

test('checkReadmeText：clean / drift / missing-marker / invalid-specs', () => {
  const clean = checkReadmeText(readmeWithMarkers(renderCommandIndexBody()), COMMAND_SPECS);
  assert.equal(clean.ok, true);
  assert.equal(clean.reason, 'clean');
  assert.equal(clean.commandCount, COMMAND_TOPICS.length);

  const drift = checkReadmeText(readmeWithMarkers('手写的旧表\n'), COMMAND_SPECS);
  assert.equal(drift.ok, false);
  assert.equal(drift.reason, 'drift');
  assert.match(drift.detail, /行数 expected=/);
  assert.match(drift.detail, /第一处差异/);

  const missing = checkReadmeText('# no markers', COMMAND_SPECS);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'missing-marker');
  assert.match(missing.detail, /BEGIN/);

  const invalid = checkReadmeText(readmeWithMarkers('x'), { broken: { order: [], subs: {} } });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'invalid-specs');
  assert.ok(invalid.problems.length > 0);
});

test('describeDrift：指出行数、首个差异行与缺失命令行', () => {
  const expected = 'HEAD\n| `bridge a` | x |\n| `bridge b` | y |';
  const actual = 'HEAD\n| `bridge a` | x |';
  const detail = describeDrift(expected, actual);
  assert.match(detail, /行数 expected=3 actual=2/);
  assert.match(detail, /第一处差异在第 3 行/);
  assert.match(detail, /README 未出现在 specs 里的命令行：1/);
});

test('表格单元格里的竖线与换行被转义（生成物结构不被破坏）', () => {
  const specs = {
    demo: {
      command: 'demo',
      summary: '带 | 竖线\n和换行的说明',
      order: ['default'],
      subs: { default: { usage: 'bridge demo', risk: 'read_only', examples: ['bridge demo'] } },
    },
  };
  const rows = buildCommandIndexRows(specs);
  assert.equal(rows[0][3], '带 | 竖线\n和换行的说明');
  const text = renderCommandIndexBody(specs);
  const dataRow = text.split('\n').find((line) => line.startsWith('| `bridge demo`'));
  assert.ok(dataRow.includes('带 \\| 竖线 和换行的说明'), dataRow);
  // 未被转义的竖线才是列分隔符：转义后仍是 4 列。
  assert.equal(dataRow.split(/(?<!\\)\|/).length - 2, 4, '竖线转义后仍是 4 列');
});

// ---------------------------------------------------------------------------
// 仓库真实 README
// ---------------------------------------------------------------------------

test('仓库 README 的命令索引与 specs 一致（门禁必须 clean）', () => {
  const text = fs.readFileSync(README, 'utf8');
  const result = checkReadmeText(text, COMMAND_SPECS);
  assert.equal(result.ok, true, result.detail || result.reason);
  assert.equal(result.reason, 'clean');
  // 标记之外的内容不允许被生成器改掉：README 仍应包含原有章节标题。
  for (const heading of ['## 安装', '## 更多用法', '## 升级与版本兼容', '## 文档导航']) {
    assert.ok(text.includes(heading), 'README 缺少原有章节 ' + heading);
  }
});

test('README 命令索引里的每个命令都能用 bridge help 打开', () => {
  const body = extractCommandIndexBody(fs.readFileSync(README, 'utf8')).body;
  for (const topic of COMMAND_TOPICS) {
    assert.ok(body.includes('`bridge ' + topic + '`'));
    assert.ok(renderCommandHelp(topic).includes('bridge ' + topic));
  }
});

test('generateForFile：先写后查；手改区间后 --check 漂移，再生成恢复 clean', () => {
  const file = path.join(tempDir, 'README.generated.md');
  fs.writeFileSync(file, readmeWithMarkers('旧内容'), 'utf8');

  const missingBefore = generateForFile(file, { check: true });
  assert.equal(missingBefore.ok, false);
  assert.equal(missingBefore.reason, 'drift');

  const written = generateForFile(file);
  assert.equal(written.ok, true);
  assert.equal(written.reason, 'written');
  const checkClean = generateForFile(file, { check: true });
  assert.equal(checkClean.ok, true);
  assert.equal(checkClean.reason, 'clean');

  const unchanged = generateForFile(file);
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.reason, 'unchanged');

  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace(COMMAND_SPECS.session.summary, '被手改过的说明'), 'utf8');
  const drifted = generateForFile(file, { check: true });
  assert.equal(drifted.ok, false);
  assert.equal(drifted.reason, 'drift');

  assert.equal(generateForFile(file).reason, 'written');
  assert.equal(generateForFile(file, { check: true }).reason, 'clean');
});

test('generateForFile：文件不存在/缺标记时明确失败且不写文件', () => {
  const absent = path.join(tempDir, 'nope.md');
  const result = generateForFile(absent);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing-file');

  const noMarkers = path.join(tempDir, 'no-markers.md');
  fs.writeFileSync(noMarkers, '# 没有标记\n', 'utf8');
  const failed = generateForFile(noMarkers);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'missing-marker');
  assert.equal(fs.readFileSync(noMarkers, 'utf8'), '# 没有标记\n');
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test('CLI --check：仓库 README clean 退出 0', () => {
  const result = runTool(['--check']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /clean/);
  assert.match(result.stdout, new RegExp(COMMAND_TOPICS.length + ' 个命令'));
});

test('CLI --check --json：字段可用于 CI 断言', () => {
  const result = runTool(['--check', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.reason, 'clean');
  assert.equal(payload.check, true);
  assert.equal(payload.commandCount, COMMAND_TOPICS.length);
});

test('CLI --stdout：输出带标记的生成块且不写文件', () => {
  const readmeBefore = fs.readFileSync(README, 'utf8');
  const result = runTool(['--stdout']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(BEGIN_MARKER));
  assert.ok(result.stdout.includes(END_MARKER));
  assert.ok(result.stdout.includes('| 命令 | 子命令 | 风险 | 说明 |'));
  assert.equal(fs.readFileSync(README, 'utf8'), readmeBefore);
});

test('CLI 漂移：退出码 1 并指出修复命令；结构问题退出码 2', () => {
  const driftFile = path.join(tempDir, 'readme-drift.md');
  fs.writeFileSync(driftFile, readmeWithMarkers('过期表'), 'utf8');
  const drifted = runTool(['--check', '--file', driftFile]);
  assert.equal(drifted.status, 1);
  assert.match(drifted.stderr, /漂移/);
  assert.match(drifted.stderr, /node tools\/readme-commands.mjs/);

  const missingMarkersFile = path.join(tempDir, 'readme-no-markers.md');
  fs.writeFileSync(missingMarkersFile, '# 没有标记\n', 'utf8');
  const missing = runTool(['--check', '--file', missingMarkersFile]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /BEGIN/);

  const absent = runTool(['--check', '--file', path.join(tempDir, 'absent.md')]);
  assert.equal(absent.status, 2);
  assert.match(absent.stderr, /读不到 README/);

  const badArg = runTool(['--nope']);
  assert.equal(badArg.status, 2);
  assert.match(badArg.stderr, /未知参数/);
});

test('CLI 生成：--file 指定临时 README，写入后可 --check clean', () => {
  const file = path.join(tempDir, 'readme-write.md');
  fs.writeFileSync(file, readmeWithMarkers('旧'), 'utf8');
  const written = runTool(['--file', file]);
  assert.equal(written.status, 0, written.stderr);
  assert.match(written.stdout, /已更新/);
  const checked = runTool(['--check', '--file', file]);
  assert.equal(checked.status, 0, checked.stderr);
  // 幂等：再跑一次是 unchanged。
  const again = runTool(['--file', file]);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /clean|一致/);
});

test('生成器输出不含参考实现名称（vendor-leak 门禁同样扫描 tools 目录以外的文本时安全）', () => {
  const text = fs.readFileSync(TOOL, 'utf8') + renderCommandIndexSection();
  assert.doesNotMatch(text, /\bbsk\b/i);
  assert.doesNotMatch(text, /browser\s*skill/i);
});
