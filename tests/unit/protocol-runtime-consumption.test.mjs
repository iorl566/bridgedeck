// tests/unit/protocol-runtime-consumption.test.mjs —— 新增协议/状态机元数据的“真实运行时消费”证据，
// 以及“默认输出只加字段、既有语义不变”的回归证据。
//
// 这不是文案测试：它同时做三件事
//   1) 静态接线：断言 daemon/CLI/MCP/SDK 里确实读取这些元数据（按源码特征定位，记录行号）；
//   2) 动态消费：用真实的 daemon/health.js、gate 错误序列化路径模拟一次 RPC 往返，
//      验证新字段能穿过 JSON 序列化到达调用方（CLI --json / MCP error.data）；
//   3) 默认语义不变：生成物五维仍是五维、docs 表头不变、gen-protocol --check 与
//      protocol-sections --fail 仍然通过、既有错误码/兼容别名/data 字段逐项保留。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  METHOD_CATALOG,
  METHOD_EFFECT_TABLE,
  METHOD_STATE,
  METHOD_NAMES,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
} from '../../lib/method-catalog.mjs';
import {
  LEGACY_CAPABILITY_UNSUPPORTED,
  PROTOCOL_UNSUPPORTED,
  PROTOCOL_UNSUPPORTED_ALIASES,
  assertProtocolCompatible,
  compatibilityReport,
  featureMatrix,
  protocolGate,
} from '../../lib/protocol-features.mjs';
import { compareProtocol } from '../../lib/protocol.mjs';
import { createHealthPayload } from '../../daemon/health.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** 返回源码里第一个匹配的行号（1-based）；没有匹配返回 0。 */
function lineOf(source, pattern) {
  const lines = String(source || '').split('\n');
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  for (let index = 0; index < lines.length; index += 1) {
    if (regex.test(lines[index])) return index + 1;
  }
  return 0;
}

const DAEMON = read('daemon/server.mjs');
const HEALTH = read('daemon/health.js');
const CLI_STATUS = read('cli/commands/status.mjs');
const MCP_SERVER = read('mcp/server.mjs');
const MCP_AUDIT = read('mcp/schema-audit.mjs');
const SDK_CONTRACT = read('sdk/contract.mjs');
const SCHEMA_INFO = read('lib/schema-info.mjs');

// ---------------------------------------------------------------------------
// 静态接线：daemon / CLI / MCP / SDK 读取位置
// ---------------------------------------------------------------------------

test('daemon 派发点消费协议闸门：assertProtocolCompatible + BridgeError(data) 接线存在', () => {
  const gateLine = lineOf(DAEMON, /assertProtocolCompatible\(instance, method, params, compareProtocol\)/);
  assert.ok(gateLine > 0, 'daemon/server.mjs 没有调用共享闸门 assertProtocolCompatible');
  // 拒绝时把 data 原样交给 BridgeError（解释/降级/迁移/六面/恢复计划才能到调用方）。
  const baseSpread = lineOf(DAEMON, /const data = \{[\s\S]*?\}\s*=\s*error\.data|const base = error\.data/);
  assert.ok(baseSpread > 0, 'daemon 没有读取 error.data');
  const throwLine = lineOf(DAEMON, /throw new BridgeError\(error\.code, error\.message, data\)/);
  assert.ok(throwLine > 0, 'daemon 没有把闸门 data 透传给 BridgeError');
  // 旧兼容逻辑仍然存在（不得被新字段挤掉）
  assert.match(DAEMON, /legacyCode:\s*base\.legacyCode \|\| LEGACY_CAPABILITY_UNSUPPORTED/);
  assert.match(DAEMON, /aliasCodes:\s*Array\.isArray\(base\.aliasCodes\)/);
});

test('daemon 状态面消费 featureMatrix：/health 与 daemon.status 都带 compatibility', () => {
  assert.ok(lineOf(HEALTH, /featureMatrix\(\{ protocol: PROTOCOL_VERSION \}, compareProtocol\)/) > 0, 'daemon/health.js 未给 daemon 自己算 featureMatrix');
  assert.ok(lineOf(HEALTH, /browsers: browserList\(\)\.map/) > 0, 'daemon/health.js 未给每个浏览器算 featureMatrix');
  assert.ok(lineOf(HEALTH, /compatibility:/) > 0, 'daemon/health.js 缺少 compatibility 段');
  assert.ok(lineOf(DAEMON, /createHealthPayload\(\{[\s\S]*featureMatrix/) > 0 || /featureMatrix/.test(DAEMON), 'daemon/server.mjs 未把 featureMatrix 注入 health');
});

test('CLI 状态面消费 daemon status JSON（compatibility 原样透传）', () => {
  // 第十一批 G 给 status 增加 --views（默认仍是 {}），因此这里只断言“调用 status RPC”，
  // 参数占位不再写死为 {}，但消费链路（RPC → 完整 body → --json 输出 → 文本读 protocol）不变。
  assert.ok(lineOf(CLI_STATUS, /callRpc\('status',/) > 0, 'CLI status 未调用 status RPC');
  assert.ok(lineOf(CLI_STATUS, /outputJsonBody\(body\)/) > 0, 'CLI status --json 未输出完整 body');
  assert.ok(lineOf(CLI_STATUS, /result\.protocol/) > 0, 'CLI status 文本模式读取 protocol');
});

test('MCP 工具面消费方法级特性门与 floor', () => {
  assert.ok(lineOf(MCP_SERVER, /import \{ METHOD_FEATURE, floorOf \}/) > 0, 'mcp/server.mjs 未读取 METHOD_FEATURE/floorOf');
  assert.ok(lineOf(MCP_SERVER, /METHOD_FEATURE\[method\]/) > 0, 'mcp/server.mjs 未使用方法级特性门');
  assert.ok(lineOf(MCP_SERVER, /floorOf\(method\)/) > 0, 'mcp/server.mjs 未使用 floorOf');
  assert.ok(lineOf(MCP_AUDIT, /FEATURE_FLOORS\[METHOD_FEATURE\[method\]\]/) > 0, 'mcp/schema-audit.mjs 未审计特性门 floor');
});

test('SDK 契约消费 featureShortfall/featuresForCall（协商结果与 daemon 同源）', () => {
  assert.ok(lineOf(SDK_CONTRACT, /from '\.\.\/lib\/protocol-features\.mjs'/) > 0, 'SDK 未从协议特性模块派生');
  assert.ok(lineOf(SDK_CONTRACT, /featureShortfall\(peer, features/) > 0, 'SDK 未使用 featureShortfall');
  assert.ok(lineOf(SDK_CONTRACT, /featuresForCall\(method, params \|\| \{\}\)/) > 0, 'SDK 未使用 featuresForCall');
  assert.match(SDK_CONTRACT, /unsupportedCode: PROTOCOL_UNSUPPORTED/);
});

test('CLI schema 面消费五维状态（methodStateOf）', () => {
  assert.ok(lineOf(SCHEMA_INFO, /methodStateOf/) > 0, 'lib/schema-info.mjs 未读取方法状态');
  assert.ok(lineOf(SCHEMA_INFO, /floorOf\(name\)/) > 0, 'lib/schema-info.mjs 未读取 floor');
});

// ---------------------------------------------------------------------------
// 动态消费 1：闸门拒绝 → daemon BridgeError(data) → JSON 序列化到 CLI/MCP
// ---------------------------------------------------------------------------

test('闸门拒绝的 data 穿过 JSON 序列化后，解释/降级/迁移/六面/恢复计划仍完整', () => {
  // 模拟 daemon/server.mjs requireFeatures 的 data 合成逻辑（与源码同构）。
  let thrown = null;
  try {
    assertProtocolCompatible({ protocol: PROTOCOL_BASELINE }, 'video.start', {}, compareProtocol);
  } catch (error) {
    const base = error.data && typeof error.data === 'object' ? error.data : {};
    thrown = {
      code: error.code,
      message: error.message,
      data: {
        ...base,
        legacyCode: base.legacyCode || LEGACY_CAPABILITY_UNSUPPORTED,
        aliasCodes: Array.isArray(base.aliasCodes) && base.aliasCodes.length ? base.aliasCodes : PROTOCOL_UNSUPPORTED_ALIASES,
      },
    };
  }
  assert.ok(thrown, '1.8 客户端请求 video.start 必须被拒绝');
  // daemon → CLI/MCP 之间是 JSON 帧：序列化再解析，字段不能丢。
  const wire = JSON.parse(JSON.stringify(thrown));
  assert.equal(wire.code, 'E_PROTOCOL_UNSUPPORTED');
  assert.equal(wire.data.legacyCode, 'E_UNSUPPORTED_CAPABILITY');
  assert.deepEqual([...wire.data.aliasCodes], [...PROTOCOL_UNSUPPORTED_ALIASES]);
  assert.equal(wire.data.feature, 'video');
  assert.equal(wire.data.required, '1.9');
  assert.equal(wire.data.actual, '1.8');
  assert.equal(wire.data.severity, 'needs-user');
  assert.equal(typeof wire.data.explanation.summary, 'string');
  assert.equal(wire.data.migration.upgradeTo, PROTOCOL_CURRENT);
  assert.equal(wire.data.proof.method, 'video.start');
  assert.equal(wire.data.proof.effectState, 'video');
  assert.equal(wire.data.recovery.action, 'upgrade-extension');
  assert.equal(wire.data.degradable, false);

  // 可降级调用：data.degradation 里带可执行的替代调用。
  let degradable = null;
  try {
    assertProtocolCompatible({ protocol: PROTOCOL_BASELINE }, 'screenshot', { stream: true }, compareProtocol);
  } catch (error) {
    degradable = error.data;
  }
  assert.ok(degradable);
  const degradedWire = JSON.parse(JSON.stringify(degradable));
  assert.equal(degradedWire.degradation.method, 'screenshot');
  assert.deepEqual([...degradedWire.degradation.droppedParams], ['stream']);
  assert.equal(degradedWire.migration.missingCount, 1);
});

// ---------------------------------------------------------------------------
// 动态消费 2：daemon/health.js 的真实载荷函数
// ---------------------------------------------------------------------------

test('daemon /health + daemon.status 的 compatibility 段消费 featureMatrix（含 fallback/migration）', () => {
  const health = createHealthPayload({
    SERVICE: 'browser-bridge',
    PROTOCOL_VERSION: PROTOCOL_CURRENT,
    VERSION: '0.3.0',
    startedAt: Date.now(),
    getCurrentPort: () => 52900,
    TLS_ENABLED: false,
    BIND_ADDRESS: '127.0.0.1',
    PUBLIC_URL: null,
    instances: new Map([['i1', {}]]),
    sessions: new Map(),
    browserList: () => [{ instanceId: 'i1', protocol: PROTOCOL_BASELINE }],
    sessionList: () => [],
    inflightList: () => [],
    sessionQueue: { snapshot: () => ({}) },
    authGuard: { snapshot: () => ({}) },
    featureMatrix,
    compareProtocol,
    recovery: () => ({ pending: 0 }),
  });
  const payload = health.healthPayload();
  assert.equal(payload.protocol, PROTOCOL_CURRENT);
  assert.equal(payload.browsers, 1);

  const status = health.buildStatus();
  const wire = JSON.parse(JSON.stringify(status)); // RPC 帧
  assert.ok(wire.compatibility, 'daemon.status 缺少 compatibility');
  assert.equal(wire.compatibility.daemon.protocol, PROTOCOL_CURRENT);
  const daemonFeatures = wire.compatibility.daemon.features;
  assert.equal(Object.keys(daemonFeatures).length, 15);
  for (const feature of Object.keys(daemonFeatures)) {
    assert.equal(daemonFeatures[feature].available, true, feature);
    assert.ok(daemonFeatures[feature].fallback, feature + ' 缺少降级说明');
    assert.equal(typeof daemonFeatures[feature].migration, 'string', feature);
    assert.equal(daemonFeatures[feature].severity, 'none', feature);
  }
  const oldBrowser = wire.compatibility.browsers[0];
  assert.equal(oldBrowser.protocol, PROTOCOL_BASELINE);
  assert.equal(oldBrowser.features.video.available, false);
  assert.equal(oldBrowser.features.video.severity, 'needs-user');
  assert.equal(oldBrowser.features.video.fallback.kind, 'none');
  assert.equal(oldBrowser.features['capture.stream'].fallback.kind, 'omit-params');

  // CLI status --json 的输出就是 body.result(JSON)：这里验证 compatibility 能完整到达。
  const cliBody = JSON.parse(JSON.stringify({ ok: true, result: status }));
  assert.ok(cliBody.result.compatibility.browsers[0].features.unverified);
});

// ---------------------------------------------------------------------------
// 动态消费 3：兼容性报告可直接被 status/doctor 使用
// ---------------------------------------------------------------------------

test('compatibilityReport 作为 status/doctor 的单入口快照（不再各自拼表）', () => {
  const report = compatibilityReport({ protocol: PROTOCOL_BASELINE });
  const wire = JSON.parse(JSON.stringify(report));
  assert.equal(wire.verdict, 'incompatible');
  assert.equal(wire.counts.degradable, 11);
  assert.equal(wire.migration.upgradeRequired, true);
  assert.ok(wire.skew.message.includes('1.8'));
  assert.equal(wire.features.video.fallback.kind, 'none');
  assert.equal(wire.degradable.includes('video'), false);
});

// ---------------------------------------------------------------------------
// 默认语义不变：生成物/文档/错误码/既有 data 字段
// ---------------------------------------------------------------------------

test('生成物仍只含既有五维：METHOD_STATE 每行恰好 5 个键', () => {
  assert.equal(Object.keys(METHOD_STATE).length, 165);
  for (const row of METHOD_CATALOG) {
    const keys = Object.keys(METHOD_STATE[row.method]).sort();
    assert.deepEqual(keys, ['effect', 'owner', 'partial', 'reconcile', 'unknown'], row.method);
  }
  // METHOD_EFFECT 仍然 165 项且与目录逐项一致（既有协议事实不变）
  assert.equal(Object.keys(METHOD_EFFECT_TABLE).length, 165);
  for (const row of METHOD_CATALOG) assert.equal(METHOD_EFFECT_TABLE[row.method], row.effect);
  assert.deepEqual(METHOD_NAMES, METHOD_CATALOG.map((row) => row.method));
});

test('docs/PROTOCOL-METHODS.md 的状态机表仍是 6 列（五维快照，不混入六面）', () => {
  const docs = read('docs/PROTOCOL-METHODS.md');
  const rows = docs.split('\n').map((line) => line.trim())
    .filter((line) => line.startsWith('| `'))
    .map((line) => line.split('|').map((cell) => cell.trim()).slice(1, -1));
  assert.equal(rows.filter((cells) => cells.length === 6).length, 165, '状态机表行数漂移');
  assert.equal(rows.filter((cells) => cells.length === 3).length, 172, '方法索引行数漂移');
  assert.equal(rows.filter((cells) => cells.length === 4).length, 15, '特性门表行数漂移');
  assert.match(docs, /partial=结果可能部分返回/);
});

test('生成物/文档漂移门禁仍为 0：gen-protocol --check 与 protocol-sections --fail', () => {
  const gen = execFileSync(process.execPath, ['tools/gen-protocol.mjs', '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(gen, /up to date/);
  const sections = execFileSync(process.execPath, ['tools/protocol-sections.mjs', '--fail'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(sections, /missing=0/);
  assert.match(sections, /stale=no/);
});

test('既有错误码与兼容别名语义不变（只加字段）', () => {
  assert.equal(PROTOCOL_UNSUPPORTED, 'E_PROTOCOL_UNSUPPORTED');
  assert.equal(LEGACY_CAPABILITY_UNSUPPORTED, 'E_UNSUPPORTED_CAPABILITY');
  assert.deepEqual([...PROTOCOL_UNSUPPORTED_ALIASES], ['E_PROTOCOL_UNSUPPORTED', 'E_UNSUPPORTED_CAPABILITY']);
  const denied = protocolGate({ protocol: PROTOCOL_BASELINE }, 'read', {});
  // 既有 data 字段一个不少
  for (const key of ['code', 'method', 'feature', 'features', 'missing', 'required', 'actual', 'legacyCode', 'aliasCodes']) {
    assert.ok(Object.prototype.hasOwnProperty.call(denied.data, key), 'data 缺少既有字段：' + key);
  }
  // 既有决策顶层字段一个不少
  for (const key of ['ok', 'code', 'method', 'features', 'missing', 'floor', 'message', 'data']) {
    assert.ok(Object.prototype.hasOwnProperty.call(denied, key), 'decision 缺少既有字段：' + key);
  }
  // 放行决策字段不变
  const allowed = protocolGate({ protocol: PROTOCOL_CURRENT }, 'click', {});
  for (const key of ['ok', 'code', 'method', 'features', 'missing', 'floor']) {
    assert.ok(Object.prototype.hasOwnProperty.call(allowed, key), 'allow 缺少既有字段：' + key);
  }
  assert.equal(allowed.code, null);
  assert.equal(allowed.floor, null);
});

test('新增元数据不依赖新依赖：lib/*.mjs 只 import 仓库内相对路径', () => {
  for (const file of ['lib/protocol.mjs', 'lib/protocol-features.mjs', 'lib/method-catalog.mjs', 'lib/method-state-machine.mjs']) {
    const source = read(file);
    for (const match of source.matchAll(/\bfrom\s+'([^']+)'/g)) {
      assert.ok(match[1].startsWith('./') || match[1].startsWith('../'), file + ' 引入了非相对依赖：' + match[1]);
    }
  }
  // 依赖方向：state-machine → catalog + error-codes；protocol-features → protocol + catalog + state-machine；
  // catalog 仍是叶子（不 import 任何 lib 模块）。
  const catalogSource = read('lib/method-catalog.mjs');
  assert.equal(/^import\s/m.test(catalogSource), false, 'method-catalog 必须保持叶子（无 import）');
  const stateSource = read('lib/method-state-machine.mjs');
  assert.match(stateSource, /from '\.\/method-catalog\.mjs'/);
  assert.equal(/from '\.\/protocol-features\.mjs'/.test(stateSource), false, 'state-machine 不得反向依赖 protocol-features');
  const featuresSource = read('lib/protocol-features.mjs');
  assert.match(featuresSource, /from '\.\/method-state-machine\.mjs'/);
  assert.equal(/from '\.\/methods\.mjs'/.test(featuresSource), false);
});
