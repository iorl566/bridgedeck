// tests/unit/longtail-tmpdir.test.mjs —— 大夹具临时工作区：只写 tmpdir、路径逃逸护栏、清理。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  LongtailWorkspaceError,
  TMP_PREFIX,
  createWorkspace,
  isInsideRepo,
  isInsideTmpRoot,
  listLeftoverWorkspaces,
  projectRoot,
  pruneLeftoverWorkspaces,
  sanitizeLabel,
  withWorkspace,
} from '../../tools/longtail/lib/tmpdir.mjs';

test('projectRoot 指向仓库根（存在 package.json）', () => {
  const root = projectRoot();
  assert.ok(fs.existsSync(path.join(root, 'package.json')));
  assert.ok(fs.existsSync(path.join(root, 'tools', 'longtail')));
});

test('isInsideRepo / isInsideTmpRoot 边界', () => {
  const root = projectRoot();
  assert.equal(isInsideRepo(root), true);
  assert.equal(isInsideRepo(path.join(root, 'tools', 'longtail', 'run.mjs')), true);
  assert.equal(isInsideRepo(path.join(os.tmpdir(), 'elsewhere')), false);
  assert.equal(isInsideTmpRoot(os.tmpdir()), false, 'tmp 根本身不算"内部"');
  assert.equal(isInsideTmpRoot(path.join(os.tmpdir(), 'x')), true);
  assert.equal(isInsideTmpRoot(root), false);
});

test('sanitizeLabel 归一非法字符', () => {
  assert.equal(sanitizeLabel('Page FIXTURE!!'), 'page-fixture');
  assert.equal(sanitizeLabel('../../evil'), 'evil');
  assert.equal(sanitizeLabel(''), 'fixture');
  assert.ok(sanitizeLabel('x'.repeat(200)).length <= 48);
});

test('createWorkspace：目录在 tmp、非仓库、默认上限', () => {
  const workspace = createWorkspace({ label: 'unit-basic', seed: 7 });
  try {
    assert.ok(fs.existsSync(workspace.dir));
    assert.ok(workspace.dir.includes(TMP_PREFIX));
    assert.equal(isInsideRepo(workspace.dir), false);
    assert.equal(workspace.isTmpOnly(), true);
    assert.equal(workspace.assertSafe(), true);
    const stats = workspace.stats();
    assert.equal(stats.files, 0);
    assert.equal(stats.bytes, 0);
    assert.equal(stats.maxBytes, DEFAULT_MAX_BYTES);
    assert.equal(stats.maxFiles, DEFAULT_MAX_FILES);
  } finally {
    workspace.cleanup();
  }
});

test('writeJson/readJson/readText/readBytes 往返', () => {
  const workspace = createWorkspace({ label: 'unit-io' });
  try {
    const written = workspace.writeJson('a/b.json', { hello: '世界', n: 3 });
    assert.ok(written.bytes > 0);
    assert.deepEqual(workspace.readJson('a/b.json'), { hello: '世界', n: 3 });
    workspace.writeText('a/plain.txt', 'text');
    assert.equal(workspace.readText('a/plain.txt'), 'text');
    // 二进制按字节读回，不能被 UTF-8 解码损坏。
    const binary = Buffer.from([0xff, 0x00, 0x80, 0x41, 0x42]);
    workspace.writeBytes('a/bin.dat', binary);
    assert.deepEqual([...workspace.readBytes('a/bin.dat')], [...binary]);
    assert.equal(workspace.readText('a/plain.txt').length, 4);
  } finally {
    workspace.cleanup();
  }
});

test('listFiles 递归排序并统计字节', () => {
  const workspace = createWorkspace({ label: 'unit-list' });
  try {
    workspace.writeText('z.txt', 'zz');
    workspace.writeText('dir/a.txt', 'a');
    workspace.writeText('dir/sub/b.txt', 'bb');
    const files = workspace.listFiles();
    assert.deepEqual(files.map((file) => file.path), ['dir/a.txt', 'dir/sub/b.txt', 'z.txt']);
    assert.equal(workspace.stats().files, 3);
    assert.deepEqual(workspace.listFiles('dir').map((file) => file.path), ['dir/a.txt', 'dir/sub/b.txt']);
  } finally {
    workspace.cleanup();
  }
});

test('路径逃逸/绝对路径一律拒绝', () => {
  const workspace = createWorkspace({ label: 'unit-path' });
  try {
    assert.throws(() => workspace.writeText('../escape.txt', 'x'), (error) => error instanceof LongtailWorkspaceError && error.code === 'E_LONGTAIL_TMP_PATH');
    assert.throws(() => workspace.writeText('a/../../escape.txt', 'x'), (error) => error.code === 'E_LONGTAIL_TMP_PATH');
    assert.throws(() => workspace.writeText(path.join(os.tmpdir(), 'abs.txt'), 'x'), (error) => error.code === 'E_LONGTAIL_TMP_PATH');
    assert.throws(() => workspace.writeText('', 'x'), (error) => error.code === 'E_LONGTAIL_TMP_PATH');
    assert.equal(workspace.exists('../escape.txt'), false);
  } finally {
    workspace.cleanup();
  }
});

test('仓库目录不能被当作 tmp 工作区根', () => {
  assert.throws(() => createWorkspace({ label: 'repo', root: projectRoot() }), (error) => error.code === 'E_LONGTAIL_TMP_REPO');
});

test('字节上限/文件数上限护栏', () => {
  const workspace = createWorkspace({ label: 'unit-budget', maxBytes: 10 });
  try {
    assert.throws(() => workspace.writeText('big.txt', 'x'.repeat(11)), (error) => error.code === 'E_LONGTAIL_TMP_BUDGET');
  } finally {
    workspace.cleanup();
  }
  const many = createWorkspace({ label: 'unit-files', maxFiles: 2 });
  try {
    many.writeText('a.txt', 'a');
    many.writeText('b.txt', 'b');
    assert.throws(() => many.writeText('c.txt', 'c'), (error) => error.code === 'E_LONGTAIL_TMP_BUDGET');
  } finally {
    many.cleanup();
  }
});

test('remove/stats 同步维护字节数', () => {
  const workspace = createWorkspace({ label: 'unit-remove' });
  try {
    workspace.writeText('a.txt', 'aaaa');
    assert.equal(workspace.stats().bytes, 4);
    assert.equal(workspace.remove('a.txt'), true);
    assert.equal(workspace.stats().bytes, 0);
    assert.equal(workspace.remove('a.txt'), false);
  } finally {
    workspace.cleanup();
  }
});

test('cleanup 删除目录且幂等', () => {
  const workspace = createWorkspace({ label: 'unit-cleanup' });
  workspace.writeText('a.txt', 'a');
  const dir = workspace.dir;
  assert.equal(workspace.cleanup(), true);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(workspace.isCleaned(), true);
  assert.equal(workspace.cleanup(), false);
  assert.throws(() => workspace.writeText('b.txt', 'b'), (error) => error.code === 'E_LONGTAIL_TMP_CLEANED');
});

test('digest：逐文件 sha256 组合，内容相同则摘要相同', async () => {
  const left = createWorkspace({ label: 'unit-digest' });
  const right = createWorkspace({ label: 'unit-digest' });
  try {
    for (const workspace of [left, right]) {
      workspace.writeText('a.txt', 'alpha');
      workspace.writeJson('b.json', { b: 1 });
    }
    const digestLeft = await left.digest();
    const digestRight = await right.digest();
    assert.equal(digestLeft.files, 2);
    assert.equal(digestLeft.bytes, digestRight.bytes);
    assert.match(digestLeft.sha256, /^[0-9a-f]{64}$/);
    assert.equal(digestLeft.sha256, digestRight.sha256);
    assert.ok(Array.isArray(digestLeft.manifest));
    left.writeText('c.txt', 'extra');
    assert.notEqual((await left.digest()).sha256, digestLeft.sha256);
  } finally {
    left.cleanup();
    right.cleanup();
  }
});

test('withWorkspace：默认 finally 清理，keep=true 保留', async () => {
  let seenDir = null;
  await withWorkspace({ label: 'unit-with' }, (workspace) => {
    seenDir = workspace.dir;
    workspace.writeText('x.txt', 'x');
    return 'result';
  });
  assert.equal(fs.existsSync(seenDir), false);

  let keptDir = null;
  const kept = await withWorkspace({ label: 'unit-keep', keep: true }, (workspace) => {
    keptDir = workspace.dir;
    return 1;
  });
  assert.equal(kept, 1);
  assert.ok(fs.existsSync(keptDir));
  fs.rmSync(keptDir, { recursive: true, force: true });
});

test('listLeftoverWorkspaces / pruneLeftoverWorkspaces', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-leftover-'));
  try {
    const workspace = createWorkspace({ label: 'unit-leftover', root });
    writeLeftovers(root, workspace.dir);
    const found = listLeftoverWorkspaces({ root });
    assert.ok(found.some((dir) => path.basename(dir) === path.basename(workspace.dir)));
    const removed = pruneLeftoverWorkspaces({ root, maxAgeMs: 0 });
    assert.ok(removed.some((dir) => path.basename(dir) === path.basename(workspace.dir)));
    assert.equal(fs.existsSync(workspace.dir), false);
    workspace.cleanup();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeLeftovers(root, dir) {
  // createWorkspace 已经建好目录；这里确保它位于自定义 root 下（list 只看固定前缀）。
  assert.ok(dir.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep));
}
