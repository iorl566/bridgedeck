// tests/unit/bsk-diff-evidence.test.mjs —— 证据链与判定口径的专项校验。
//
// 目的：防止「把未验证写成等价」。这里不重复结构断言，而是盯着判定本身：
//   - equal 行必须有双向证据、且必须能被 detail 复核；
//   - unknown 行不得出现在 equal 计数里，且必须指出缺的证据类型；
//   - CLI/RPC/MCP 三轴的 equal 判定必须带可核对的 detail（覆盖率、字段集合）；
//   - 我方 extra 行必须说明"BSK 本轴没有"，而不是含糊的"未实现"。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { build } from '../../tools/bsk-diff/build.mjs';
import { renderMarkdown } from '../../tools/bsk-diff/lib/report.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MATRIX = await build();
const DOC = renderMarkdown(MATRIX);

function rowsByAxis(axis) {
  return MATRIX.axes[axis];
}

test('equal 行必须双向有证据（不允许单边判等价）', () => {
  const equals = MATRIX.rows.filter((row) => row.status === 'equal');
  assert.ok(equals.length > 0, '一个 equal 都没有，说明判定过严或数据没接上');
  for (const row of equals) {
    assert.ok(row.evidence.ours.length > 0, `${row.id} 判 equal 但我方没有证据`);
    assert.ok(row.evidence.bsk.length > 0, `${row.id} 判 equal 但 BSK 没有证据`);
  }
});

test('CLI 轴 equal 必须带覆盖率 detail（命令级契约 + 参数全覆盖 + 子命令/位置可比）', () => {
  for (const row of rowsByAxis('cli').filter((item) => item.status === 'equal')) {
    assert.equal(row.detail.uncoveredOptions.length, 0, `${row.id} 判 equal 但仍有未覆盖参数`);
    assert.equal(row.detail.commandLevelContract, true, `${row.id} 判 equal 但缺命令级契约`);
    assert.ok(row.detail.positional, `${row.id} 判 equal 但位置参数未比对`);
    assert.equal(row.detail.positional.match, true, `${row.id} 判 equal 但位置参数不一致`);
    if (row.detail.subcommands) {
      assert.equal(row.detail.subcommands.uncovered.length, 0, `${row.id} 判 equal 但仍有未覆盖子命令`);
    }
    assert.match(row.gap, /行为等价未做 E2E 验证/, `${row.id} 判 equal 必须声明"行为等价未验证"`);
  }
});

test('CLI 轴 partial 必须给出可执行的具体缺口（参数/子命令/契约/位置之一）', () => {
  for (const row of rowsByAxis('cli').filter((item) => item.status === 'partial')) {
    const hasConcrete = row.detail.uncoveredOptions.length > 0
      || (row.detail.subcommands && row.detail.subcommands.uncovered.length > 0)
      || row.detail.commandLevelContract === false
      || (row.detail.positional && row.detail.positional.match === false);
    assert.ok(hasConcrete, `${row.id} 判 partial 但没有可执行缺口 detail`);
  }
});

test('RPC 轴 equal 的字段集合必须真的相同（两侧都非空）', () => {
  const rpcEquals = rowsByAxis('rpc').filter((row) => row.status === 'equal');
  assert.ok(rpcEquals.length > 0, 'RPC 轴没有 equal，判定可能过严');
  for (const row of rpcEquals) {
    assert.ok(Array.isArray(row.detail.sharedFields), `${row.id} 缺 sharedFields`);
    assert.equal(row.detail.bskOnlyFields.length, 0, `${row.id} 判 equal 但 BSK 有独有字段`);
    assert.equal(row.detail.ourOnlyFields.length, 0, `${row.id} 判 equal 但我方有独有字段`);
    assert.ok(row.detail.sharedFields.length > 0, `${row.id} 判 equal 但共享字段为空`);
  }
});

test('RPC 轴 unknown 必须说明是"我方缺 schema / BSK 不透明 / 零交集"三者之一', () => {
  for (const row of rowsByAxis('rpc').filter((item) => item.status === 'unknown')) {
    assert.match(
      row.gap,
      /lib\/schemas\.mjs|serde_json|零交集|未被解析到/,
      `${row.id} unknown 的原因不在三类可复核原因内：${row.gap}`,
    );
  }
});

test('MCP 轴：③b 的 missing 已清零（M6-P0 两批补全直接入口）', () => {
  const missing = rowsByAxis('mcp').filter((row) => row.id.startsWith('mcp:bsk:') && row.status === 'missing');
  // M6-P0①/② 两批补齐后，BSK MCP 的每个动作都有我方直接工具入口（或已标 partial）。
  assert.equal(missing.length, 0, '仍有 BSK MCP 动作没有我方直接入口：' + missing.map((row) => row.id).join(', '));
});

test('extra 行必须说明"BSK 0.5.0 本轴没有"，不能写成能力未实现', () => {
  for (const row of MATRIX.rows.filter((item) => item.status === 'extra')) {
    assert.match(
      row.gap,
      /BSK|本轴|无对应|独有/,
      `${row.id} extra 说明没有交代 BSK 侧情况：${row.gap}`,
    );
    assert.ok(row.evidence.ours.length > 0, `${row.id} extra 必须给我方证据`);
  }
});

test('missing 行必须有 BSK 证据且写清我方缺什么', () => {
  for (const row of MATRIX.rows.filter((item) => item.status === 'missing')) {
    assert.ok(row.evidence.bsk.length > 0, `${row.id} missing 却没有 BSK 证据`);
    assert.match(row.gap, /没有|无|缺失/, `${row.id} missing 说明不具体：${row.gap}`);
  }
});

test('feature floor 轴：floor 或触发面不同就必须 partial，只有两者都同才 equal', () => {
  for (const row of rowsByAxis('feature').filter((item) => item.status !== 'extra' && item.status !== 'missing')) {
    const { floorMatch, triggerMatch, compatFloor, ourFloor } = row.detail;
    assert.ok(typeof floorMatch === 'boolean', `${row.id} 缺 floorMatch`);
    assert.ok(typeof triggerMatch === 'boolean', `${row.id} 缺 triggerMatch`);
    if (floorMatch && triggerMatch) assert.equal(row.status, 'equal', `${row.id} floor/触发面都一致却不是 equal`);
    else assert.equal(row.status, 'partial', `${row.id} 存在差异却判成 ${row.status}`);
    if (!floorMatch) {
      assert.notEqual(compatFloor, ourFloor, `${row.id} 声称 floor 不同但值相同`);
      assert.match(row.gap, /floor 不同/, `${row.id} 未在差距里写明 floor 差异`);
    }
  }
});

test('错误码轴：equal 必须是归一化名称一致，partial 必须名称不同', () => {
  for (const row of rowsByAxis('error').filter((item) => item.id.startsWith('error:bsk:'))) {
    if (row.status === 'equal') {
      const bskName = row.name;
      const ourName = String(row.oursName || '').replace(/^E_/, '').toLowerCase();
      assert.equal(bskName, ourName, `${row.id} 判 equal 但名称归一化后不同（${bskName} vs ${ourName}）`);
    }
    if (row.status === 'partial') {
      const bskName = row.name;
      const ourName = String(row.oursName || '').replace(/^E_/, '').toLowerCase();
      assert.notEqual(bskName, ourName, `${row.id} 名称相同却判 partial`);
    }
  }
});

test('扩展能力轴：8 个能力面 + manifest 权限面齐全，equal 只允许出现在入口面', () => {
  const names = rowsByAxis('extension').map((row) => row.name);
  for (const capability of ['record', 'video', 'longshot', 'overlay', 'cooperate', 'toolbar', 'human', 'borrow']) {
    assert.ok(names.includes(capability), `扩展轴缺少能力面：${capability}`);
  }
  assert.ok(names.includes('manifest-permissions'), '扩展轴缺少 manifest 权限面');
  const equals = rowsByAxis('extension').filter((row) => row.status === 'equal');
  for (const row of equals) {
    assert.equal(row.name, 'toolbar', `${row.id} 判 equal 但扩展能力面的 equal 只允许 toolbar 入口面（其余均需面板级比对）`);
  }
});

test('文档不把 unknown 说成等价：总览出现"不计入等价"且 unknown 单列', () => {
  assert.match(DOC, /unknown 不计入等价/);
  assert.match(DOC, /提升|已取证比例/);
  const overviewLines = DOC.split('\n').filter((line) => line.startsWith('| ① CLI') || line.startsWith('| ⑥ 错误码'));
  for (const line of overviewLines) {
    assert.match(line, /\([\d.]+%\)/, '总览行必须有百分比');
    assert.ok(line.split('|').length >= 8, '总览行必须含 unknown 列');
  }
});

test('文档列出证据来源且有 .ref 过期说明（对照口径透明）', () => {
  assert.match(DOC, /证据来源与采集方式/);
  assert.match(DOC, /\.ref\/bsk-help/);
  assert.match(DOC, /过期|旧/);
  assert.match(DOC, /windows-x64/);
});

test('我方方法 schema 缺口数量被如实记录为 unknown（而不是悄悄算 partial/equal）', () => {
  const unknownRpc = rowsByAxis('rpc').filter((row) => row.status === 'unknown');
  const schemaGap = unknownRpc.filter((row) => row.gap.includes('lib/schemas.mjs'));
  assert.ok(schemaGap.length > 0, '我方 schema 缺口应体现为 unknown');
  for (const row of schemaGap) {
    const noBusinessFields = row.detail.ourSchemaDefined === false || row.detail.ourFieldCount === 0;
    assert.ok(noBusinessFields, `${row.id} 声称没有可比对字段，但 detail 显示有 ${row.detail.ourFieldCount} 个字段`);
  }
});

test('矩阵里的 "我方证据" 文件都真实存在于仓库（防伪造路径）', () => {
  const files = new Set();
  for (const row of MATRIX.rows) {
    for (const evidence of row.evidence.ours) {
      const match = evidence.match(/^([^:]+):\d+$/);
      if (match) files.add(match[1]);
    }
  }
  assert.ok(files.size > 10, '我方证据文件数量异常偏少');
  for (const file of files) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, file)), `我方证据引用了不存在的文件：${file}`);
  }
});
