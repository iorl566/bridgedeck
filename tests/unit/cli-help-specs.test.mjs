// tests/unit/cli-help-specs.test.mjs —— `bridge help` / `bridge <命令> --help` 与
// cli/lib/command-specs.mjs 的一致性门禁。
//
// 断言目标不是“帮助文本长什么样”，而是“specs 里声明的每一条都真的出现在帮助里”：
// 命令、子命令、用法、参数名、风险、示例；并且 `help <topic>` 与 `<topic> --help`
// 是同一份渲染。这样 specs 改了而帮助漏改会在单测里直接失败。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  COMMAND_SPECS,
  COMMAND_TOPICS,
  COMMON_EXAMPLES,
  GLOBAL_FLAGS,
  renderCommandHelp,
} from '../../cli/lib/command-specs.mjs';
import { RISK_INFO } from '../../cli/lib/arg-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CLI = path.join(REPO, 'cli', 'bridge.mjs');
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-help-specs-'));

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, BB_HOME: tempHome, BB_NO_PROBE: '1' },
  });
}

/** 从渲染文本里提取所有 `--flag` 名字（去重）。 */
function flagsIn(text) {
  return new Set((String(text).match(/--[a-z][a-z0-9-]*/g) || []).map((item) => item.slice(2)));
}

const fullHelp = runCli(['help']);
const dashHelp = runCli(['--help']);

test('bridge help 退出码 0 且列出全部命令主题', () => {
  assert.equal(fullHelp.status, 0, fullHelp.stderr);
  assert.match(fullHelp.stdout, /BridgeDeck CLI v\d/);
  assert.ok(fullHelp.stdout.includes(COMMAND_TOPICS.join(' | ')), '缺少命令主题清单');
  for (const topic of COMMAND_TOPICS) {
    assert.ok(fullHelp.stdout.includes(topic), '总览缺少命令主题 ' + topic);
  }
});

test('bridge --help 与 bridge help 输出一致', () => {
  assert.equal(dashHelp.status, 0, dashHelp.stderr);
  assert.equal(dashHelp.stdout, fullHelp.stdout);
});

test('全局帮助覆盖 specs 的 GLOBAL_FLAGS 与 COMMON_EXAMPLES', () => {
  for (const name of GLOBAL_FLAGS) {
    assert.ok(fullHelp.stdout.includes('--' + name), '全局帮助缺少 --' + name);
  }
  for (const example of COMMON_EXAMPLES) {
    assert.ok(fullHelp.stdout.includes(example), '全局帮助缺少示例：' + example);
  }
});

test('COMMAND_SPECS 形状自洽：command/order/subs/risk/usage', () => {
  assert.deepEqual(COMMAND_TOPICS, Object.keys(COMMAND_SPECS));
  for (const topic of COMMAND_TOPICS) {
    const spec = COMMAND_SPECS[topic];
    assert.equal(spec.command, topic, topic + ' 的 command 字段不一致');
    assert.ok(spec.summary && spec.summary.length > 0, topic + ' 缺少 summary');
    assert.ok(Array.isArray(spec.order) && spec.order.length > 0, topic + ' 缺少 order');
    assert.equal(new Set(spec.order).size, spec.order.length, topic + ' order 有重复');
    for (const name of spec.order) {
      const subSpec = spec.subs[name];
      assert.ok(subSpec, topic + ' 缺少子命令 ' + name);
      assert.ok(subSpec.usage && subSpec.usage.length > 0, topic + ' ' + name + ' 缺少 usage');
      assert.ok(subSpec.risk && RISK_INFO[subSpec.risk], topic + ' ' + name + ' 的 risk 未登记');
      assert.ok(Array.isArray(subSpec.examples) && subSpec.examples.length > 0, topic + ' ' + name + ' 缺少 examples');
    }
  }
});

test('renderCommandHelp 覆盖每个子命令的 usage/summary/风险/示例', () => {
  for (const topic of COMMAND_TOPICS) {
    const spec = COMMAND_SPECS[topic];
    const text = renderCommandHelp(topic);
    assert.ok(text.includes('bridge ' + topic + ' —— ' + spec.summary), topic + ' 标题/summary 缺失');
    for (const name of spec.order) {
      const subSpec = spec.subs[name];
      assert.ok(text.includes(subSpec.usage), topic + ' 缺少用法：' + subSpec.usage);
      if (subSpec.summary && name !== 'default') {
        assert.ok(text.includes(subSpec.summary), topic + ' ' + name + ' 缺少 summary');
      }
      for (const example of subSpec.examples) {
        assert.ok(text.includes(example), topic + ' 缺少示例：' + example);
      }
    }
    const risks = new Set(spec.order.map((name) => spec.subs[name].risk).filter(Boolean));
    for (const risk of risks) {
      assert.ok(text.includes(risk), topic + ' 缺少风险分级 ' + risk);
    }
  }
});

test('每个命令主题：bridge help <topic> 与 specs 渲染逐字一致', () => {
  for (const topic of COMMAND_TOPICS) {
    const result = runCli(['help', topic]);
    assert.equal(result.status, 0, topic + ' 失败：' + result.stderr);
    assert.equal(result.stdout.trimEnd(), renderCommandHelp(topic), topic + ' 帮助与渲染器不一致');
  }
});

test('每个命令主题：bridge <topic> --help 等价于 bridge help <topic>', () => {
  for (const topic of COMMAND_TOPICS) {
    const viaTopic = runCli(['help', topic]);
    const viaFlag = runCli([topic, '--help']);
    assert.equal(viaFlag.status, 0, topic + ' --help 失败：' + viaFlag.stderr);
    assert.equal(viaFlag.stdout, viaTopic.stdout, topic + ' 两种帮助写法不一致');
  }
});

test('每个命令主题：子命令名、参数名、全局参数齐全', () => {
  const globalFlags = new Set(GLOBAL_FLAGS);
  for (const topic of COMMAND_TOPICS) {
    const spec = COMMAND_SPECS[topic];
    const result = runCli(['help', topic]);
    assert.equal(result.status, 0, topic + ' 失败：' + result.stderr);
    const renderedFlags = flagsIn(result.stdout);
    for (const name of spec.order) {
      if (name !== 'default') {
        assert.ok(result.stdout.includes(name), topic + ' 帮助缺少子命令名 ' + name);
      }
      const subSpec = spec.subs[name];
      // 子命令声明里的每个参数都必须能在帮助里找到（--flag）。
      for (const flag of Object.keys(subSpec.flags || {})) {
        assert.ok(renderedFlags.has(flag), topic + ' ' + name + ' 帮助缺少参数 --' + flag);
      }
      // 命令级 flags 也算（例如 tab 的公共参数）。
      for (const flag of Object.keys(spec.flags || {})) {
        assert.ok(renderedFlags.has(flag), topic + ' 帮助缺少命令级参数 --' + flag);
      }
      for (const required of subSpec.requires || []) {
        assert.ok(result.stdout.includes('--' + required.flag), topic + ' ' + name + ' 帮助缺少 requires 参数 --' + required.flag);
        for (const dependency of required.requires || []) {
          assert.ok(result.stdout.includes('--' + dependency), topic + ' ' + name + ' 帮助缺少依赖参数 --' + dependency);
        }
      }
    }
    // 全局参数每个 topic 帮助都渲染一遍（防止某个 topic 只渲染子集）。
    for (const flag of globalFlags) {
      assert.ok(renderedFlags.has(flag), topic + ' 帮助缺少全局参数 --' + flag);
    }
  }
});

test('未知命令主题回落到 schema 帮助；未知方法退出码 2', () => {
  const unknown = runCli(['help', 'definitely.not.a.topic']);
  assert.equal(unknown.status, 2, '未知主题应退出 2');
  assert.match(unknown.stdout, /没有命令或方法帮助/);
});

test('用法行里的命令位置参数与 specs.positionals 不矛盾', () => {
  for (const topic of COMMAND_TOPICS) {
    const spec = COMMAND_SPECS[topic];
    for (const name of spec.order) {
      const subSpec = spec.subs[name];
      const min = Number((subSpec.positionals && subSpec.positionals.min) || 0);
      assert.ok(Number.isInteger(min) && min >= 0, topic + ' ' + name + ' positionals.min 非法');
      assert.ok(min <= Number((subSpec.positionals && subSpec.positionals.max) ?? min), topic + ' ' + name + ' positionals.max < min');
      const requiredPositionals = (subSpec.usage.match(/<[^>]+>/g) || []).length;
      assert.ok(requiredPositionals >= min, topic + ' ' + name + ' 用法里的必填位置参数少于 positionals.min');
    }
  }
});

test('COMMON_EXAMPLES 都指向现存命令（防止示例漂移到已删命令）', () => {
  // specs 主题之外，全局帮助里还有零仪式别名（status/observe）等手动维护的命令。
  const known = new Set([...COMMAND_TOPICS, 'status', 'observe']);
  for (const example of COMMON_EXAMPLES) {
    const match = /^bridge\s+([a-z][a-z0-9-]*)/.exec(example);
    assert.ok(match, '示例格式不对：' + example);
    assert.ok(known.has(match[1]), '示例命令不在已知命令里：' + example);
  }
});
