// tests/unit/release-preflight.test.mjs —— 发布 preflight 一致性闸门（tools/release-preflight.mjs）。
//
// 两层：
//   1) 逐项纯函数：真仓库输入必须全绿；任何一处漂移（版本/协议/方法数/特性门/错误码/
//      SDK 覆盖/协议门禁接线/包体积）必须变红并给出可读原因；
//   2) 真仓库 collectChecks：一次性验证七项检查与真实生成物对齐。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';

import {
  PACKAGE_LIMITS,
  checkArtifacts,
  checkErrorCoverage,
  checkFeatureTable,
  checkMethodSurface,
  checkProtocolGateWiring,
  checkProtocolVersions,
  checkVersionConsistency,
  collectChecks,
  extractErrorCodes,
  formatPreflight,
  main,
  parseArgs,
  parseMethodsDoc,
  parsePluginOnlyCodes,
  parseShaSums,
} from '../../tools/release-preflight.mjs';
import {
  DAEMON_ONLY_METHODS,
  FEATURE_FLOORS,
  FEATURE_META,
  METHOD_COUNT,
  METHOD_NAMES,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
} from '../../lib/method-catalog.mjs';
import { ERROR_CODE_LIST, ERROR_RECOVERY } from '../../lib/error-codes.mjs';
import { LEGACY_CAPABILITY_UNSUPPORTED, PROTOCOL_UNSUPPORTED, PROTOCOL_UNSUPPORTED_ALIASES } from '../../lib/protocol-features.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GENERATED_PATH = path.join(ROOT, 'extension', 'src', 'generated', 'protocol.js');
const METHODS_DOC_PATH = path.join(ROOT, 'docs', 'PROTOCOL-METHODS.md');
const DAEMON_SOURCE = fs.readFileSync(path.join(ROOT, 'daemon', 'server.mjs'), 'utf8');
const DOCS = parseMethodsDoc(fs.readFileSync(METHODS_DOC_PATH, 'utf8'));
// 生成物是纯数据模块，直接 import 与 preflight 主流程同一条事实链。
const GENERATED = await import(pathToFileURL(GENERATED_PATH).href + '?test=release-preflight');
const SDK_NODE_BLOCK = (() => {
  const text = fs.readFileSync(path.join(ROOT, 'sdk', 'index.mjs'), 'utf8');
  const begin = text.indexOf('// error-codes:begin');
  const end = text.indexOf('// error-codes:end');
  return text.slice(begin, end);
})();
const PLUGIN_TEXT = fs.readFileSync(path.join(ROOT, 'dsh-plugin', 'lib', 'error-recovery.mjs'), 'utf8');
const SDK_PYTHON = fs.readFileSync(path.join(ROOT, 'sdk', 'python', 'browser_bridge.py'), 'utf8');
const EXTENSION_ERRORS = fs.readFileSync(path.join(ROOT, 'extension', 'src', 'errors.js'), 'utf8');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bb-preflight-'));
}

test('真仓库 collectChecks：七项一致性检查全绿', { timeout: 120000 }, async () => {
  const result = await collectChecks({ root: ROOT });
  assert.equal(result.ok, true, JSON.stringify(result.checks.filter((item) => !item.ok)));
  assert.deepEqual(result.checks.map((item) => item.id), [
    'version.consistency',
    'protocol.versions',
    'methods.surface',
    'features.table',
    'errors.coverage',
    'errors.protocol-gate',
    'packages.consistency',
  ]);
  for (const item of result.checks) {
    assert.equal(item.ok, true, item.id + '：' + item.detail);
    assert.equal(typeof item.label, 'string');
  }
  const methodCheck = result.checks.find((item) => item.id === 'methods.surface');
  assert.equal(methodCheck.data.catalogCount, 165);
});

test('checkVersionConsistency：版本四方一致；任一漂移失败', () => {
  const artifactNames = ['BridgeDeck-cli-0.3.0-win32-x64.zip', 'BridgeDeck-extension-0.3.0.zip'];
  const pass = checkVersionConsistency({ packageVersion: '0.3.0', extensionVersion: '0.3.0', releaseVersion: '0.3.0', artifactNames });
  assert.equal(pass.ok, true, pass.detail);
  const extDrift = checkVersionConsistency({ packageVersion: '0.3.0', extensionVersion: '0.2.9', releaseVersion: '0.3.0', artifactNames });
  assert.equal(extDrift.ok, false);
  assert.match(extDrift.detail, /extension\/manifest\.json 版本 0\.2\.9/);
  const mixed = checkVersionConsistency({ packageVersion: '0.3.0', extensionVersion: '0.3.0', releaseVersion: '0.3.0', artifactNames: [...artifactNames, 'BridgeDeckSetup-0.4.0.exe'] });
  assert.equal(mixed.ok, false);
  assert.match(mixed.detail, /制品版本混合/);
  const empty = checkVersionConsistency({ packageVersion: '0.3.0', extensionVersion: '0.3.0', releaseVersion: '0.3.0', artifactNames: [] });
  assert.equal(empty.ok, false);
  assert.match(empty.detail, /没有 artifacts/);
});

test('checkProtocolVersions：daemon/目录/生成物一致；漂移或基线倒挂失败', () => {
  const pass = checkProtocolVersions({
    daemonSource: DAEMON_SOURCE,
    catalogCurrent: PROTOCOL_CURRENT,
    catalogBaseline: PROTOCOL_BASELINE,
    generatedCurrent: GENERATED.PROTOCOL_CURRENT,
    generatedBaseline: GENERATED.PROTOCOL_BASELINE,
  });
  assert.equal(pass.ok, true, pass.detail);
  assert.equal(pass.data.daemonVersion, '1.9');

  const daemonDrift = checkProtocolVersions({
    daemonSource: "const PROTOCOL_VERSION = '1.8';",
    catalogCurrent: PROTOCOL_CURRENT,
    catalogBaseline: PROTOCOL_BASELINE,
    generatedCurrent: GENERATED.PROTOCOL_CURRENT,
    generatedBaseline: GENERATED.PROTOCOL_BASELINE,
  });
  assert.equal(daemonDrift.ok, false);
  assert.match(daemonDrift.detail, /daemon PROTOCOL_VERSION 1\.8/);

  const generatedDrift = checkProtocolVersions({
    daemonSource: DAEMON_SOURCE,
    catalogCurrent: PROTOCOL_CURRENT,
    catalogBaseline: PROTOCOL_BASELINE,
    generatedCurrent: '1.10',
    generatedBaseline: GENERATED.PROTOCOL_BASELINE,
  });
  assert.equal(generatedDrift.ok, false);
  assert.match(generatedDrift.detail, /生成物 PROTOCOL_CURRENT 1\.10/);

  const inverted = checkProtocolVersions({
    daemonSource: DAEMON_SOURCE,
    catalogCurrent: '1.8',
    catalogBaseline: '1.9',
    generatedCurrent: '1.8',
    generatedBaseline: '1.9',
  });
  assert.equal(inverted.ok, false);
  assert.match(inverted.detail, /高于当前协议/);
});

test('checkMethodSurface：165 方法四处一致；生成物/文档任一漂移失败', () => {
  const pass = checkMethodSurface({
    catalogCount: METHOD_COUNT,
    catalogNames: METHOD_NAMES,
    generatedCount: GENERATED.METHOD_COUNT,
    generatedNames: GENERATED.METHODS,
    daemonOnlyNames: DAEMON_ONLY_METHODS,
    docs: DOCS,
  });
  assert.equal(pass.ok, true, pass.detail);
  assert.match(pass.detail, /165 方法/);

  const fewer = checkMethodSurface({
    catalogCount: METHOD_COUNT,
    catalogNames: METHOD_NAMES,
    generatedCount: 164,
    generatedNames: GENERATED.METHODS.slice(0, 164),
    daemonOnlyNames: DAEMON_ONLY_METHODS,
    docs: DOCS,
  });
  assert.equal(fewer.ok, false);
  assert.match(fewer.detail, /生成物 METHOD_COUNT 164/);

  const docDrift = checkMethodSurface({
    catalogCount: METHOD_COUNT,
    catalogNames: METHOD_NAMES,
    generatedCount: GENERATED.METHOD_COUNT,
    generatedNames: GENERATED.METHODS,
    daemonOnlyNames: DAEMON_ONLY_METHODS,
    docs: { ...DOCS, indexNames: [...DOCS.indexNames, 'ghost.method'] },
  });
  assert.equal(docDrift.ok, false);
  assert.match(docDrift.detail, /文档方法索引/);

  const countDrift = checkMethodSurface({
    catalogCount: METHOD_COUNT,
    catalogNames: METHOD_NAMES,
    generatedCount: GENERATED.METHOD_COUNT,
    generatedNames: GENERATED.METHODS,
    daemonOnlyNames: DAEMON_ONLY_METHODS,
    docs: { ...DOCS, counts: { ...DOCS.counts, local: DOCS.counts.local + 1 } },
  });
  assert.equal(countDrift.ok, false);
  assert.match(countDrift.detail, /文档本地方法表/);
});

test('checkFeatureTable：15 个特性门三方一致；floor/标签/生成物漂移失败', () => {
  const pass = checkFeatureTable({
    catalogFloors: FEATURE_FLOORS,
    catalogMeta: FEATURE_META,
    catalogMethods: METHOD_NAMES,
    generatedFloors: GENERATED.FEATURE_MIN_PROTOCOL,
    generatedFeatureNames: GENERATED.FEATURE_NAMES,
    generatedMethods: GENERATED.METHOD_FEATURE,
    docsFeatureRows: DOCS.featureRows,
    currentProtocol: PROTOCOL_CURRENT,
  });
  assert.equal(pass.ok, true, pass.detail);
  assert.equal(pass.data.features, 15);

  const floorDrift = checkFeatureTable({
    catalogFloors: { ...FEATURE_FLOORS, video: '1.8' },
    generatedFloors: GENERATED.FEATURE_MIN_PROTOCOL,
    docsFeatureRows: DOCS.featureRows,
  });
  assert.equal(floorDrift.ok, false);

  const generatedFloorDrift = checkFeatureTable({
    catalogFloors: FEATURE_FLOORS,
    generatedFloors: { ...GENERATED.FEATURE_MIN_PROTOCOL, har: '1.8' },
    generatedFeatureNames: GENERATED.FEATURE_NAMES,
    generatedMethods: GENERATED.FEATURE_METHODS ? GENERATED.METHOD_FEATURE : GENERATED.METHOD_FEATURE,
    docsFeatureRows: DOCS.featureRows,
  });
  assert.equal(generatedFloorDrift.ok, false);
  assert.match(generatedFloorDrift.detail, /生成物特性 har floor 1\.8/);

  const labelDrift = checkFeatureTable({
    catalogFloors: FEATURE_FLOORS,
    catalogMeta: { ...FEATURE_META, har: { ...FEATURE_META.har, label: 'HAR 重放（新）' } },
    generatedFloors: GENERATED.FEATURE_MIN_PROTOCOL,
    docsFeatureRows: DOCS.featureRows,
  });
  assert.equal(labelDrift.ok, false);
  assert.match(labelDrift.detail, /标签/);

  const missingRow = checkFeatureTable({
    catalogFloors: FEATURE_FLOORS,
    generatedFloors: GENERATED.FEATURE_MIN_PROTOCOL,
    docsFeatureRows: DOCS.featureRows.slice(1),
  });
  assert.equal(missingRow.ok, false);
  assert.match(missingRow.detail, /文档特性门表/);
});

test('checkErrorCoverage：五方覆盖；SDK 缺码/扩展多码/插件缺别名失败', () => {
  const pluginOnly = parsePluginOnlyCodes(PLUGIN_TEXT);
  assert.deepEqual(pluginOnly, ['E_ABORTED', 'E_FAKE']);
  const base = {
    registeredCodes: ERROR_CODE_LIST,
    sdkNodeCodes: extractErrorCodes(SDK_NODE_BLOCK),
    sdkPythonCodes: extractErrorCodes(SDK_PYTHON),
    extensionCodes: extractErrorCodes(EXTENSION_ERRORS),
    pluginCodes: extractErrorCodes(PLUGIN_TEXT),
    pluginOnlyCodes: pluginOnly,
    recoveryKeys: Object.keys(ERROR_RECOVERY),
  };
  const pass = checkErrorCoverage(base);
  assert.equal(pass.ok, true, pass.detail);
  assert.equal(pass.data.registered, ERROR_CODE_LIST.length);
  assert.ok(pass.detail.includes(String(ERROR_CODE_LIST.length)));

  const sdkMissing = checkErrorCoverage({ ...base, sdkNodeCodes: base.sdkNodeCodes.filter((code) => code !== PROTOCOL_UNSUPPORTED) });
  assert.equal(sdkMissing.ok, false);
  assert.match(sdkMissing.detail, /Node SDK（sdk\/index\.mjs） 缺少错误码/);

  const pythonMissing = checkErrorCoverage({ ...base, sdkPythonCodes: base.sdkPythonCodes.slice(1) });
  assert.equal(pythonMissing.ok, false);
  assert.match(pythonMissing.detail, /Python SDK/);

  const extensionUnknown = checkErrorCoverage({ ...base, extensionCodes: [...base.extensionCodes, 'E_NOT_A_REAL_CODE'] });
  assert.equal(extensionUnknown.ok, false);
  assert.match(extensionUnknown.detail, /含未登记错误码/);

  const pluginMissingAlias = checkErrorCoverage({ ...base, pluginCodes: base.pluginCodes.filter((code) => code !== LEGACY_CAPABILITY_UNSUPPORTED) });
  assert.equal(pluginMissingAlias.ok, false);
  assert.match(pluginMissingAlias.detail, /缺少必需错误码/);

  const badRecovery = checkErrorCoverage({ ...base, recoveryKeys: [...base.recoveryKeys, 'E_GHOST'] });
  assert.equal(badRecovery.ok, false);
  assert.match(badRecovery.detail, /ERROR_RECOVERY/);
});

test('checkProtocolGateWiring：新码/别名/daemon 接线；旧手写逻辑或名次错误失败', () => {
  const pass = checkProtocolGateWiring({ registeredCodes: ERROR_CODE_LIST, daemonSource: DAEMON_SOURCE, aliases: PROTOCOL_UNSUPPORTED_ALIASES });
  assert.equal(pass.ok, true, pass.detail);

  const notWired = checkProtocolGateWiring({
    registeredCodes: ERROR_CODE_LIST,
    daemonSource: DAEMON_SOURCE.replace(/assertProtocolCompatible\s*\(/g, 'legacyGate('),
    aliases: PROTOCOL_UNSUPPORTED_ALIASES,
  });
  assert.equal(notWired.ok, false);
  assert.match(notWired.detail, /assertProtocolCompatible/);

  const oldLogic = checkProtocolGateWiring({
    registeredCodes: ERROR_CODE_LIST,
    daemonSource: DAEMON_SOURCE + '\nconst missing = featureShortfall(instance, features, compare);\n',
    aliases: PROTOCOL_UNSUPPORTED_ALIASES,
  });
  assert.equal(oldLogic.ok, false);
  assert.match(oldLogic.detail, /featureShortfall/);

  const aliasOrder = checkProtocolGateWiring({
    registeredCodes: ERROR_CODE_LIST,
    daemonSource: DAEMON_SOURCE,
    aliases: [LEGACY_CAPABILITY_UNSUPPORTED, PROTOCOL_UNSUPPORTED],
  });
  assert.equal(aliasOrder.ok, false);
  assert.match(aliasOrder.detail, /别名表首位/);

  const missingCode = checkProtocolGateWiring({
    registeredCodes: ERROR_CODE_LIST.filter((code) => code !== LEGACY_CAPABILITY_UNSUPPORTED),
    daemonSource: DAEMON_SOURCE,
    aliases: PROTOCOL_UNSUPPORTED_ALIASES,
  });
  assert.equal(missingCode.ok, false);
  assert.match(missingCode.detail, /兼容别名/);
});

test('checkArtifacts：大小/sha256/SHA256SUMS/签名/体积上限全对齐才通过', () => {
  const dir = tempDir();
  try {
    const files = {
      'BridgeDeck-extension-0.3.0.zip': 'extension-bytes',
      'BridgeDeck-dsh-plugin-0.3.0.zip': 'plugin',
      'BridgeDeck-cli-bundle-0.3.0.zip': 'bundle',
      'BridgeDeckSetup-0.3.0.exe': 'setup',
      'BridgeDeck-cli-0.3.0-win32-x64.zip': 'win',
      'BridgeDeck-cli-0.3.0-darwin-arm64.tar.gz': 'mac-arm',
      'BridgeDeck-cli-0.3.0-darwin-x64.tar.gz': 'mac-x64',
      'BridgeDeck-cli-0.3.0-linux-x64.tar.gz': 'linux',
    };
    const artifacts = [];
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, content, 'utf8');
      artifacts.push({ name, file, exists: true, bytes: fs.statSync(file).size, sha256: crypto.createHash('sha256').update(content).digest('hex') });
    }
    const manifest = {
      version: '0.3.0',
      artifacts: artifacts.map((item) => ({ name: item.name, file: path.relative(dir, item.file), bytes: item.bytes, sha256: item.sha256 })),
      signature: { alg: 'ed25519', value: 'sig' },
    };
    const sums = artifacts.map((item) => item.sha256 + '  ' + item.name).join('\n');
    const limits = { ...PACKAGE_LIMITS, minArtifacts: 1 };
    const pass = checkArtifacts({ manifest, actual: artifacts, shaSumsText: sums, limits });
    assert.equal(pass.ok, true, pass.detail);

    const corrupted = checkArtifacts({
      manifest,
      actual: artifacts.map((item) => ({ ...item, sha256: 'f'.repeat(64) })),
      shaSumsText: sums,
      limits,
    });
    assert.equal(corrupted.ok, false);
    assert.match(corrupted.detail, /sha256 不一致/);

    const sizeDrift = checkArtifacts({
      manifest: { ...manifest, artifacts: manifest.artifacts.map((item) => ({ ...item, bytes: item.bytes + 1 })) },
      actual: artifacts,
      shaSumsText: sums,
      limits,
    });
    assert.equal(sizeDrift.ok, false);
    assert.match(sizeDrift.detail, /大小不一致/);

    const sumsMissing = checkArtifacts({ manifest, actual: artifacts, shaSumsText: sums.split('\n')[0], limits });
    assert.equal(sumsMissing.ok, false);
    assert.match(sumsMissing.detail, /SHA256SUMS/);

    const unsigned = checkArtifacts({ manifest: { ...manifest, signature: undefined }, actual: artifacts, shaSumsText: sums, limits });
    assert.equal(unsigned.ok, false);
    assert.match(unsigned.detail, /缺少签名/);

    const tooBig = checkArtifacts({ manifest, actual: artifacts, shaSumsText: sums, limits: { ...limits, maxTotalBytes: 1 } });
    assert.equal(tooBig.ok, false);
    assert.match(tooBig.detail, /总体积/);

    const missingKindManifest = {
      ...manifest,
      artifacts: manifest.artifacts.filter((item) => !/(cli-bundle|setup)/i.test(item.name)),
    };
    const missingKind = checkArtifacts({
      manifest: missingKindManifest,
      actual: artifacts.filter((item) => !/(cli-bundle|setup)/i.test(item.name)),
      shaSumsText: sums,
      limits: { ...limits, minArtifacts: 1 },
    });
    assert.equal(missingKind.ok, false);
    assert.match(missingKind.detail, /缺少CLI bundle|缺少Setup 安装器/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('解析器：parseMethodsDoc/parseShaSums/extractErrorCodes 对固定输入稳定', () => {
  const docs = parseMethodsDoc([
    '# t',
    '## daemon 本地方法（owner=local）',
    '| 方法 | 副作用 | scope |',
    '| --- | --- | --- |',
    '| `status` | read | local |',
    '## 会话方法（owner=session → 扩展）',
    '| `read` | read | session |',
    '## 实例方法（owner=instance → 扩展）',
    '| `tab.list` | read | instance |',
    '## 特性门与最低协议版本（1 个）',
    '| `har` | 1.9 | HAR 重放 |',
    '## 方法状态机（五维快照）',
    '| `status` | local | read | no | no | none |',
  ].join('\n'));
  assert.deepEqual(docs.indexNames, ['status', 'read', 'tab.list']);
  assert.deepEqual(docs.stateNames, ['status']);
  assert.deepEqual(docs.featureRows, [{ feature: 'har', floor: '1.9', label: 'HAR 重放' }]);
  assert.deepEqual(docs.counts, { local: 1, session: 1, instance: 1 });

  const sums = parseShaSums('a'.repeat(64) + '  a.zip\n' + 'b'.repeat(64) + '  dir/b.tgz\nbad line\n');
  assert.equal(sums.get('a.zip'), 'a'.repeat(64));
  assert.equal(sums.get('b.tgz'), 'b'.repeat(64));
  assert.equal(sums.size, 2);
  assert.deepEqual(extractErrorCodes("x 'E_BAD_ARG' y E_TIMEOUT E_BAD_ARG"), ['E_BAD_ARG', 'E_TIMEOUT']);
});

test('formatPreflight/parseArgs：报告与参数契约', () => {
  const text = formatPreflight({
    version: '0.3.0',
    checks: [{ id: 'version.consistency', label: '版本一致性', ok: true, detail: 'ok' }],
    gates: [{ name: 'source-guard', ok: true, status: 0 }],
    artifacts: [{ name: 'a.zip', exists: true, hashMatch: true, bytes: 1 }],
    warnings: [],
    blockers: [],
    ok: true,
  });
  assert.match(text, /release preflight v0\.3\.0/);
  assert.match(text, /\[ok\] version\.consistency/);
  assert.match(text, /PREFLIGHT PASS/);
  const failed = formatPreflight({
    version: '0.3.0', checks: [{ id: 'protocol.versions', label: '协议版本', ok: false, detail: '漂移' }],
    gates: [], artifacts: [], warnings: ['w'], blockers: ['protocol.versions：漂移'], ok: false,
  });
  assert.match(failed, /PREFLIGHT BLOCKED/);
  assert.match(failed, /blocker: protocol\.versions/);

  assert.deepEqual(parseArgs([]).json, false);
  assert.equal(parseArgs(['--json', '--check']).json, true);
  assert.equal(parseArgs(['--key', 'k.pem']).keyPath, 'k.pem');
  assert.equal(parseArgs(['--key=k.pem']).keyPath, 'k.pem');
  assert.match(parseArgs(['--root', 'dist']).root, /dist$/);
  assert.throws(() => parseArgs(['--nope']), /未知参数/);
});

test('main：真实根目录产出 JSON 结构与退出码（外部门禁如实计入 blocker）', { timeout: 300000 }, async () => {
  const chunks = [];
  const code = await main(['--json'], { stdout: (text) => chunks.push(text), stderr: () => {} });
  const result = JSON.parse(chunks.join('\n'));
  assert.ok(code === 0 || code === 1);
  assert.equal(result.checks.length, 7);
  assert.equal(result.checks.every((item) => item.ok), true, JSON.stringify(result.checks.filter((item) => !item.ok)));
  assert.equal(result.artifacts.length, 9);
  assert.equal(result.ok, code === 0);
  if (code === 0) assert.deepEqual(result.blockers, []);
  else assert.ok(result.blockers.length > 0);
});
