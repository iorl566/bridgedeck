// tests/unit/protocol-proof-consumption.test.mjs —— 第二轮协议/状态机增量的“真实消费”证据。
//
// 这不是文案测试：它同时做三件事
//   1) 静态接线：断言既有 daemon 闸门 / health / status / SDK / MCP 路径确实在用协议面
//      （按源码特征定位并记录行号）；
//   2) 动态消费：用真实的 lib/protocol-features.mjs、daemon/health.js、sdk/contract.mjs、
//      mcp/tool-methods.mjs 让新增字段穿过 JSON 序列化到达调用方；
//   3) 默认语义不变：既有字段/错误码/兼容别名/negotiate 结构逐项保留。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FEATURE_NAMES,
  METHOD_NAMES,
  PROTOCOL_BASELINE,
  PROTOCOL_CURRENT,
  proofOf,
} from '../../lib/method-catalog.mjs';
import {
  LEGACY_CAPABILITY_UNSUPPORTED,
  PROTOCOL_UNSUPPORTED,
  PROTOCOL_UNSUPPORTED_ALIASES,
  assertProtocolCompatible,
  compatibilityReport,
  featureMatrix,
  featureShortfall,
  negotiate,
  protocolGate,
} from '../../lib/protocol-features.mjs';
import { compareProtocol } from '../../lib/protocol.mjs';
import { createHealthPayload } from '../../daemon/health.js';
import { methodProtocolGate, toolProtocolGate } from '../../sdk/contract.mjs';
import { TOOL_METHODS } from '../../mcp/tool-methods.mjs';
import { TOOLS } from '../../mcp/server.mjs';

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
const SDK_CONTRACT = read('sdk/contract.mjs');
const MCP_SERVER = read('mcp/server.mjs');
const MCP_TOOL_METHODS = read('mcp/tool-methods.mjs');

// ---------------------------------------------------------------------------
// 0. 静态接线（file:line 证据；断言存在，报告里给出实际行号）
// ---------------------------------------------------------------------------

test('daemon 派发闸门：assertProtocolCompatible → BridgeError(data) 接线存在', () => {
  const gateLine = lineOf(DAEMON, /assertProtocolCompatible\(instance, method, params, compareProtocol\)/);
  assert.ok(gateLine > 0, 'daemon/server.mjs 未调用共享协议闸门');
  const baseLine = lineOf(DAEMON, /const base = error\.data/);
  assert.ok(baseLine > 0, 'daemon/server.mjs 未读取 error.data');
  const spreadLine = lineOf(DAEMON, /\.\.\.base,/);
  assert.ok(spreadLine > 0, 'daemon/server.mjs 未把 error.data 展开进响应 data');
  const throwLine = lineOf(DAEMON, /throw new BridgeError\(error\.code, error\.message, data\)/);
  assert.ok(throwLine > 0, 'daemon/server.mjs 未把 data 交给 BridgeError');
});

test('daemon health/status：featureMatrix 两处消费 + createHealthPayload 注入', () => {
  assert.ok(lineOf(HEALTH, /featureMatrix\(\{ protocol: PROTOCOL_VERSION \}, compareProtocol\)/) > 0, 'daemon/health.js 未给 daemon 自己算 featureMatrix');
  assert.ok(lineOf(HEALTH, /browsers: browserList\(\)\.map/) > 0, 'daemon/health.js 未给每个浏览器算 featureMatrix');
  assert.ok(lineOf(HEALTH, /compatibility:/) > 0, 'daemon/health.js 缺少 compatibility 段');
  assert.ok(lineOf(DAEMON, /createHealthPayload\(\{/) > 0, 'daemon/server.mjs 未构造 health payload');
  assert.match(DAEMON, /featureMatrix/);
});

test('CLI status：消费 daemon status JSON（--json 输出完整 body）', () => {
  assert.ok(lineOf(CLI_STATUS, /callRpc\('status',/) > 0, 'CLI status 未调用 status RPC');
  assert.ok(lineOf(CLI_STATUS, /outputJsonBody\(body\)/) > 0, 'CLI status --json 未输出完整 body');
});

test('SDK 契约：featureShortfall / featuresForCall 驱动 methodProtocolGate', () => {
  assert.ok(lineOf(SDK_CONTRACT, /from '\.\.\/lib\/protocol-features\.mjs'/) > 0, 'SDK 未从协议特性模块派生');
  assert.ok(lineOf(SDK_CONTRACT, /featureShortfall\(peer, features/) > 0, 'SDK 未使用 featureShortfall');
  assert.ok(lineOf(SDK_CONTRACT, /featuresForCall\(method, params \|\| \{\}\)/) > 0, 'SDK 未使用 featuresForCall');
  assert.ok(lineOf(SDK_CONTRACT, /export function methodProtocolGate/) > 0, 'SDK 未导出 methodProtocolGate');
  assert.ok(lineOf(SDK_CONTRACT, /missing,/) > 0, 'SDK 未把 missing 数组返回给调用方');
});

test('MCP：browser_status → status 方法映射，且工具元数据消费 METHOD_FEATURE/floorOf', () => {
  assert.ok(lineOf(MCP_TOOL_METHODS, /browser_status: \['status'\]/) > 0, 'MCP 未把 browser_status 映射到 status');
  assert.ok(lineOf(MCP_SERVER, /import \{ METHOD_FEATURE, floorOf \}/) > 0, 'mcp/server.mjs 未读取 METHOD_FEATURE/floorOf');
  assert.ok(lineOf(MCP_SERVER, /METHOD_FEATURE\[method\]/) > 0, 'mcp/server.mjs 未使用方法级特性门');
  assert.ok(lineOf(MCP_SERVER, /floorOf\(method\)/) > 0, 'mcp/server.mjs 未使用 floorOf');
});

// ---------------------------------------------------------------------------
// 1. 动态消费：daemon 闸门拒绝 → 错误帧 → CLI/SDK/MCP
// ---------------------------------------------------------------------------

test('闸门拒绝帧携带 obligations/upgradePlan，且既有 data 字段逐项不变', () => {
  // 与 daemon/server.mjs requireFeatures 同构的 data 合成逻辑。
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
  // daemon → CLI/MCP 之间是 JSON 帧：序列化再解析，新字段不能丢。
  const wire = JSON.parse(JSON.stringify(thrown));
  assert.equal(wire.code, PROTOCOL_UNSUPPORTED);
  // ---- 既有字段（默认语义不变）
  assert.equal(wire.data.legacyCode, LEGACY_CAPABILITY_UNSUPPORTED);
  assert.deepEqual([...wire.data.aliasCodes], [...PROTOCOL_UNSUPPORTED_ALIASES]);
  assert.equal(wire.data.feature, 'video');
  assert.equal(wire.data.required, '1.9');
  assert.equal(wire.data.actual, '1.8');
  assert.equal(wire.data.severity, 'needs-user');
  assert.equal(typeof wire.data.explanation.summary, 'string');
  assert.equal(wire.data.migration.upgradeTo, PROTOCOL_CURRENT);
  assert.equal(wire.data.proof.method, 'video.start');
  assert.equal(wire.data.recovery.action, 'upgrade-extension');
  assert.equal(wire.data.degradable, false);
  // ---- 第二轮新增字段（可执行义务 + 升级计划）
  assert.ok(wire.data.obligations, '错误帧缺少 data.obligations');
  assert.equal(wire.data.obligations.method, 'video.start');
  assert.equal(wire.data.obligations.known, true);
  assert.ok(wire.data.obligations.featureScoped.length >= 1);
  assert.equal(wire.data.obligations.featureScoped[0].feature, 'video');
  assert.equal(wire.data.obligations.featureScoped[0].floor, '1.9');
  assert.match(wire.data.obligations.note, /静默忽略/);
  assert.ok(wire.data.upgradePlan, '错误帧缺少 data.upgradePlan');
  assert.equal(wire.data.upgradePlan.from, PROTOCOL_BASELINE);
  assert.equal(wire.data.upgradePlan.to, PROTOCOL_CURRENT);
  assert.equal(wire.data.upgradePlan.verdict, 'upgrade-required');
  assert.equal(wire.data.upgradePlan.feasible, true);
  assert.deepEqual([...wire.data.upgradePlan.gainedFeatures], ['video']);
  assert.equal(wire.data.upgradePlan.requiredVersion, '1.9');
  assert.ok(wire.data.upgradePlan.batches.length >= 3);
  assert.match(wire.data.upgradePlan.fingerprint, /^[0-9a-f]{8}$/);
  // 顶层也带同一份字段（调用方不必只从 data 取）
  assert.ok(thrown.data.obligations);
  const decision = protocolGate({ protocol: PROTOCOL_BASELINE }, 'video.start', {});
  assert.ok(decision.obligations);
  assert.ok(decision.upgradePlan);
});

test('可降级调用：错误帧同时带 degradation 与 obligations/upgradePlan', () => {
  let data = null;
  try {
    assertProtocolCompatible({ protocol: PROTOCOL_BASELINE }, 'screenshot', { stream: true }, compareProtocol);
  } catch (error) {
    data = error.data;
  }
  assert.ok(data);
  const wire = JSON.parse(JSON.stringify(data));
  assert.equal(wire.degradation.method, 'screenshot');
  assert.deepEqual([...wire.degradation.droppedParams], ['stream']);
  assert.equal(wire.obligations.known, true);
  assert.equal(wire.obligations.featureScoped[0].feature, 'capture.stream');
  assert.equal(wire.upgradePlan.gainedFeatures.includes('capture.stream'), true);
});

// ---------------------------------------------------------------------------
// 2. 动态消费：daemon /health 与 daemon.status 的 compatibility 段
// ---------------------------------------------------------------------------

function buildHealth() {
  return createHealthPayload({
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
    browserList: () => [
      { instanceId: 'i1', protocol: PROTOCOL_BASELINE },
      { instanceId: 'i2', protocol: PROTOCOL_CURRENT },
    ],
    sessionList: () => [],
    inflightList: () => [],
    sessionQueue: { snapshot: () => ({}) },
    authGuard: { snapshot: () => ({}) },
    featureMatrix,
    compareProtocol,
    recovery: () => ({ pending: 0 }),
  });
}

test('daemon.status compatibility 段：每个特性行带 obligations 与 support（JSON 往返）', () => {
  const health = buildHealth();
  const status = health.buildStatus();
  const wire = JSON.parse(JSON.stringify(status));
  assert.equal(Object.keys(wire.compatibility.daemon.features).length, 15);
  for (const feature of FEATURE_NAMES) {
    const row = wire.compatibility.daemon.features[feature];
    // 既有字段
    assert.equal(row.available, true, feature);
    assert.equal(row.severity, 'none', feature);
    assert.ok(row.fallback, feature + ' 缺少降级说明');
    assert.equal(typeof row.migration, 'string', feature);
    // 新增字段：义务聚合
    assert.ok(row.obligations, feature + ' 缺少 obligations');
    assert.equal(row.obligations.feature, feature);
    assert.equal(row.obligations.known, true);
    assert.ok(row.obligations.methodCount >= 1, feature);
    assert.equal(
      row.obligations.risks.safe + row.obligations.risks.guarded + row.obligations.risks.risky,
      row.obligations.methodCount,
      feature + ' 风险计数与受影响方法数不一致',
    );
    // 新增字段：版本支持画像
    assert.ok(row.support, feature + ' 缺少 support');
    assert.equal(row.support.feature, feature);
    assert.equal(row.support.floor, '1.9');
    assert.equal(row.support.baselineAllowed, false);
    assert.equal(row.support.currentAllowed, true);
    assert.equal(row.support.firstSupporting, '1.9');
    assert.equal(row.support.monotone, true);
  }
  // 旧协议浏览器：特性不可用 + 义务说明仍完整
  const oldBrowser = wire.compatibility.browsers[0];
  assert.equal(oldBrowser.protocol, PROTOCOL_BASELINE);
  assert.equal(oldBrowser.features.video.available, false);
  assert.equal(oldBrowser.features.video.severity, 'needs-user');
  assert.equal(oldBrowser.features.video.fallback.kind, 'none');
  assert.equal(oldBrowser.features.video.support.baselineAllowed, false);
  assert.ok(oldBrowser.features.video.obligations.riskyMethods.length > 0);
  // 当前协议浏览器：全可用
  assert.equal(wire.compatibility.browsers[1].features.video.available, true);
  assert.equal(wire.compatibility.browsers[1].features.video.support.currentAllowed, true);
});

test('/health 主载荷保持既有结构（新字段只进 status.compatibility）', () => {
  const payload = buildHealth().healthPayload();
  assert.equal(payload.ok, true);
  assert.equal(payload.protocol, PROTOCOL_CURRENT);
  assert.equal(payload.browsers, 1, 'payload.browsers = instances.size（既有语义）');
  assert.deepEqual(Object.keys(payload).sort(), [
    'ok', 'service', 'protocol', 'version', 'pid', 'uptimeMs', 'port', 'tls', 'bind', 'publicUrl', 'browsers', 'sessions',
  ].sort());
  assert.equal(payload.compatibility, undefined, 'healthPayload 不应新增 compatibility 字段');
});

test('CLI status --json 把 daemon.status 原样输出：新字段可被 CLI 消费', () => {
  const status = buildHealth().buildStatus();
  const cliBody = JSON.parse(JSON.stringify({ ok: true, result: status }));
  assert.ok(cliBody.result.compatibility.browsers[0].features.video.obligations);
  assert.ok(cliBody.result.compatibility.daemon.features.video.support);
});

// ---------------------------------------------------------------------------
// 3. 动态消费：SDK methodProtocolGate / toolProtocolGate
// ---------------------------------------------------------------------------

test('SDK methodProtocolGate：missing 项字段由协议面派生，并带第二轮新增解释字段', () => {
  const gate = methodProtocolGate('read', {}, PROTOCOL_BASELINE);
  assert.equal(gate.ok, false);
  assert.equal(gate.code, PROTOCOL_UNSUPPORTED);
  assert.equal(gate.missing.length, 1);
  const entry = gate.missing[0];
  assert.equal(entry.feature, 'read');
  assert.equal(entry.required, '1.9');
  assert.equal(entry.actual, '1.8');
  // 第二轮新增（featureShortfall 只加字段）
  assert.equal(entry.label, '确定性读取');
  assert.equal(entry.degradable, true);
  assert.equal(entry.fallback.kind, 'method');
  assert.equal(typeof entry.migration, 'string');
  // 当前协议放行
  assert.equal(methodProtocolGate('read', {}, PROTOCOL_CURRENT).ok, true);
  assert.equal(methodProtocolGate('click', {}, PROTOCOL_BASELINE).ok, true);
});

test('SDK toolProtocolGate：参数级特性同样带解释字段', () => {
  const gate = toolProtocolGate('browser_click', {
    methods: ['click'],
    featureGates: [],
    params: { unverified: true },
  }, PROTOCOL_BASELINE);
  assert.equal(gate.ok, false);
  assert.equal(gate.missing.length, 1);
  assert.equal(gate.missing[0].feature, 'unverified');
  assert.equal(gate.missing[0].degradable, true);
  assert.equal(typeof gate.missing[0].migration, 'string');
});

// ---------------------------------------------------------------------------
// 4. 动态消费：MCP browser_status 返回的 status
// ---------------------------------------------------------------------------

test('MCP browser_status → status：工具映射与 daemon 状态载荷里的新字段', () => {
  assert.deepEqual([...TOOL_METHODS.browser_status], ['status']);
  const tool = TOOLS.find((item) => item.name === 'browser_status');
  assert.ok(tool, 'MCP 工具表缺少 browser_status');
  assert.deepEqual([...tool.methods], ['status']);
  // MCP tools/call 的返回就是 daemon status 的 result（JSON 帧）
  const mcpToolResult = JSON.parse(JSON.stringify(buildHealth().buildStatus()));
  const features = mcpToolResult.compatibility.daemon.features;
  assert.ok(features.video.obligations);
  assert.ok(features.video.support);
  // MCP 工具元数据里的 featureGates / floors 与目录同源（protocol-check 也审计这一层）
  const gated = TOOLS.flatMap((item) => item.methods || []).filter((method) => proofOf(method) && proofOf(method).pre.length > 0);
  assert.ok(gated.length > 0);
});

// ---------------------------------------------------------------------------
// 5. 默认语义不变（回归）
// ---------------------------------------------------------------------------

test('protocolGate 放行结果：既有字段不变，新增 obligation 摘要', () => {
  const allowed = protocolGate({ protocol: PROTOCOL_CURRENT }, 'video.start', {});
  assert.equal(allowed.ok, true);
  assert.equal(allowed.code, null);
  assert.equal(allowed.method, 'video.start');
  assert.deepEqual([...allowed.features], ['video']);
  assert.deepEqual(allowed.missing, []);
  assert.equal(allowed.floor, '1.9');
  assert.equal(allowed.severity, 'none');
  assert.deepEqual([...allowed.degradation], []);
  assert.equal(allowed.migration, null);
  assert.equal(allowed.proof.method, 'video.start');
  // 新增字段
  assert.ok(allowed.obligations);
  assert.equal(allowed.obligations.method, 'video.start');
  assert.equal(allowed.obligations.risk, 'risky');
  assert.equal(allowed.obligations.policy.canAutoReplay, proofOf('video.start').replayable);
});

test('featureShortfall 既有三字段语义不变，只追加解释字段', () => {
  const missing = featureShortfall({ protocol: PROTOCOL_BASELINE }, ['video', 'har']);
  assert.equal(missing.length, 2);
  assert.deepEqual(missing.map((item) => item.feature), ['video', 'har']);
  for (const entry of missing) {
    assert.equal(entry.required, '1.9');
    assert.equal(entry.actual, '1.8');
    assert.equal(typeof entry.label, 'string');
    assert.equal(typeof entry.migration, 'string');
    assert.equal(typeof entry.degradable, 'boolean');
  }
  assert.equal(missing[0].degradable, false, 'video 没有可执行降级');
  assert.equal(missing[1].degradable, false, 'har 没有可执行降级');
  assert.deepEqual(featureShortfall({ protocol: PROTOCOL_CURRENT }, ['video']), []);
});

test('negotiate 返回结构保持第一轮字段集合（不在该结构里加字段）', () => {
  const result = negotiate({ protocol: PROTOCOL_BASELINE }, { calls: [{ method: 'read', params: {} }] });
  assert.deepEqual(Object.keys(result).sort(), [
    'calls', 'degradations', 'explanation', 'features', 'floor', 'migration',
    'missing', 'ok', 'peer', 'verdict',
  ].sort());
  assert.equal(result.verdict, 'degraded');
  assert.equal(result.missing.includes('read'), true);
});

test('compatibilityReport 新增 obligations/upgradePlan/matrix，既有字段不变', () => {
  const report = compatibilityReport({ protocol: PROTOCOL_BASELINE });
  assert.equal(report.verdict, 'incompatible');
  assert.equal(report.counts.degradable, 11);
  assert.equal(report.features.video.fallback.kind, 'none');
  assert.equal(report.denied.includes('video'), true);
  // 新增段
  assert.ok(report.obligations);
  assert.equal(report.obligations.dimensions.methods, 165);
  assert.ok(report.obligations.risks.counts.risky > 0);
  assert.equal(report.obligations.features.length, 15);
  assert.equal(report.upgradePlan.from, PROTOCOL_BASELINE);
  assert.equal(report.upgradePlan.verdict, 'upgrade-required');
  assert.equal(report.matrix.methods, 165);
  assert.equal(report.matrix.monotonic, true);
  assert.equal(report.matrix.selfCheck.ok, true);
  // 全量可 JSON 序列化（status/doctor 直接输出）
  const wire = JSON.parse(JSON.stringify(report));
  assert.equal(wire.upgradePlan.gainedFeatures.length, 15);
  assert.equal(wire.matrix.perVersion.length, 5);
});

test('METHOD_EFFECT 与协议版本事实未被第二轮改动（默认语义不变）', () => {
  assert.equal(METHOD_NAMES.length, 165);
  assert.equal(FEATURE_NAMES.length, 15);
  assert.equal(compareProtocol(PROTOCOL_BASELINE, PROTOCOL_CURRENT) < 0, true);
  // 1.8 老调用继续放行，1.9 新能力继续拒绝/放行边界一致
  assert.equal(protocolGate({ protocol: PROTOCOL_BASELINE }, 'click', {}).ok, true);
  assert.equal(protocolGate({ protocol: PROTOCOL_BASELINE }, 'read', {}).ok, false);
  assert.equal(protocolGate({ protocol: PROTOCOL_CURRENT }, 'read', {}).ok, true);
});
