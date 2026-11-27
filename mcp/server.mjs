#!/usr/bin/env node
// mcp/server.mjs —— 把BridgeDeck暴露成 MCP（stdio，newline-delimited JSON-RPC 2.0）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readUpdateState } from '../lib/update-state.mjs';
import { createBrowserTools } from './tools.mjs';
import { TOOL_METHODS } from './tool-methods.mjs';
import { assertToolContracts } from './schema-audit.mjs';
import { createResourceRegistry, ResourceError } from './resources.mjs';
import {
  RESOURCE_UPDATED_NOTIFICATION,
  SubscriptionError,
  createSubscriptionRegistry,
} from './subscriptions.mjs';
import { getPrompt, listPrompts, PromptError, PROMPT_DEFINITIONS } from './prompts.mjs';
import {
  createProgressSession,
  progressResultMeta,
  progressSnapshot,
  progressTokenFrom,
  resolveProgressPolicy,
} from './progress.mjs';
import { createCallRegistry, raceToolCall } from './cancel.mjs';
import {
  annotationsFor,
  assertToolPolicies,
  policyFor,
  policySnapshot,
} from './tool-policy.mjs';
import {
  approvalGradeFor,
  approvalSnapshot,
  assertApprovalGrades,
  gradeSnapshot,
} from './approval-grades.mjs';
import {
  JSONRPC_ERRORS,
  assertWireTables,
  decodeWireLine,
  errorResponse,
  jsonRpcCodeFor,
  negotiateProtocolVersion,
  serializeMessage,
  wireSnapshot,
} from './wire.mjs';
import {
  CursorError,
  cursorSnapshot,
  paginateList,
} from './cursor.mjs';
import {
  queryResources,
  resourceIndexSnapshot,
} from './resource-index.mjs';
import {
  buildFreshnessEntries,
  classifyFreshness,
  freshnessSnapshot,
  summarizeFreshness,
} from './resource-freshness.mjs';
import {
  CompletionError,
  assertCompletions,
  complete,
  completionSnapshot,
} from './completion.mjs';
import {
  assertErrorMap,
  errorEnvelope,
  errorMapSnapshot,
} from './error-map.mjs';
import { formatArgErrors, validateToolArgs } from './tool-args.mjs';
import {
  buildGraphWithDiff,
  buildResourceGraph,
  relatedUris,
  resourceGraphSnapshot,
} from './resource-graph.mjs';
import {
  assertSubscriptionDiff,
  churnReport,
  coverageReport,
  diffSubscriptions,
  subscriptionDiffSnapshot,
  subscriptionHealth,
} from './subscription-diff.mjs';
import {
  assertPromptVersions,
  promptVersionMeta,
  promptVersionsSnapshot,
  resolvePromptVersion,
} from './prompt-versions.mjs';
import { assertPromptCompletion, promptCompletionSnapshot } from './prompt-completion.mjs';
import {
  approvalAuditSnapshot,
  approvalRisk,
  assertApprovalAudit,
  createApprovalLedger,
  decideApproval,
  escalationRuleFor,
} from './approval-audit.mjs';
import {
  assertRecoveryPlaybooks,
  planRecovery,
  recoverySnapshot,
} from './recovery-playbook.mjs';
import { METHOD_FEATURE, floorOf } from '../lib/method-catalog.mjs';
import { resolveSessionByScope } from '../lib/session-scope.mjs';
import { summarizeTrace } from '../lib/trace-summary.mjs';
import { parseHarReplayEntries, findHarReplayEntry } from '../lib/har-replay.mjs';

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'bridge.mjs');

async function runCliJson(args) {
  const { stdout } = await execFileAsync(process.execPath, [CLI_PATH, ...args, '--json'], { env: process.env, maxBuffer: 10 * 1024 * 1024 });
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error('CLI 输出不是 JSON：' + String(stdout).slice(0, 200));
  }
}

const VERSION = '0.1.1';
const HOME = process.env.BB_HOME || path.join(os.homedir(), '.browser-bridge');
const DAEMON_JSON = path.join(HOME, 'daemon.json');
const state = { sessionId: process.env.BB_SESSION || null, sessionScope: process.env.BB_SESSION_SCOPE || null };

function daemonInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(DAEMON_JSON, 'utf8'));
    if (!info || typeof info.port !== 'number' || typeof info.token !== 'string') return null;
    return info;
  } catch {
    return null;
  }
}

async function rpc(method, params = {}, timeoutMs = 60000) {
  const info = daemonInfo();
  if (!info) {
    const error = new Error('daemon 未运行（' + DAEMON_JSON + ' 不存在）；先运行 bridge status');
    error.code = 'E_DAEMON';
    throw error;
  }
  const response = await fetch('http://127.0.0.1:' + info.port + '/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bridge-token': info.token },
    body: JSON.stringify({ method, params, timeoutMs }),
  });
  const body = await response.json();
  if (!body.ok) {
    const error = new Error((body.error && body.error.message) || 'daemon 返回失败');
    error.code = (body.error && body.error.code) || 'E_INTERNAL';
    throw error;
  }
  return body.result;
}

async function ensureSession(args) {
  if (args && args.session) return String(args.session);
  if (args && args.session_scope) {
    state.sessionScope = String(args.session_scope);
    state.sessionId = null;
  }
  if (state.sessionId) return state.sessionId;
  if (state.sessionScope) {
    const listed = await rpc('session.list', {});
    const resolved = resolveSessionByScope(listed.sessions || [], state.sessionScope);
    if (resolved.error) {
      const error = new Error(resolved.message);
      error.code = resolved.error;
      throw error;
    }
    state.sessionId = resolved.session.sessionId;
    return state.sessionId;
  }
  const result = await rpc('session.start', {});
  state.sessionId = result.sessionId;
  return state.sessionId;
}

function withSession(sessionId, params) {
  return { ...params, session: sessionId };
}

/** "3s"/"500ms"/"2m"/数字 → 毫秒；无法解析返回 null。 */
function parseDurationMs(value) {
  if (Number.isInteger(value) && value >= 0) return value;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/i.exec(String(value || '').trim());
  if (!match) return null;
  const unit = String(match[2] || 's').toLowerCase();
  const factor = unit === 'ms' ? 1 : (unit === 'm' ? 60000 : (unit === 'h' ? 3600000 : 1000));
  return Math.round(Number(match[1]) * factor);
}



const TOOLS = createBrowserTools({ rpc, ensureSession, withSession, parseDurationMs, runCliJson, HOME, state });

// 硬门禁：工具 schema ↔ 协议方法目录 ↔ 契约声明必须双向一致。任何漂移都让 server
// 启动失败，而不是等模型调用时才静默丢参（审计维度见 mcp/schema-audit.mjs）。
export const TOOL_CONTRACT_AUDIT = assertToolContracts({ tools: TOOLS, toolMethods: TOOL_METHODS });


for (const tool of TOOLS) {
  const methods = TOOL_METHODS[tool.name];
  if (!Array.isArray(methods)) throw new Error('MCP 工具缺少协议方法映射：' + tool.name);
  tool.methods = methods;
  // 工具级协议要求由方法目录派生：调用方/文档不用再猜某个工具需要哪个 floor。
  const gates = [...new Set(methods.map((method) => METHOD_FEATURE[method]).filter(Boolean))].sort();
  tool.featureGates = gates;
  const floors = [...new Set(methods.map((method) => floorOf(method)).filter(Boolean))].sort();
  tool.minProtocol = floors.length ? floors[floors.length - 1] : null;
  // 分级视图需要的单一来源：每个工具挂上自己的策略对象（只读、不新增手工表），
  // 审批分级/超时/annotations 全部从它派生（见 mcp/approval-grades.mjs）。
  tool.policy = policyFor(tool.name, tool);
}

// 工具分级/审批/超时策略的硬审计：92 个工具必须全部有可解释的分级，destructive 必须
// 要求审批，read 不能映射变异方法（详见 mcp/tool-policy.mjs）。
export const TOOL_POLICY_AUDIT = assertToolPolicies(TOOLS);

// 第十批-B 新增硬门禁：审批分级（none/confirm/mandatory）、错误恢复映射、JSON-RPC 信封表、
// completion 补全表。与 TOOL_CONTRACT_AUDIT 同风格：漂移即启动失败，而不是运行期静默降级。
export const APPROVAL_GRADE_AUDIT = assertApprovalGrades(TOOLS);
export const ERROR_MAP_AUDIT = assertErrorMap();
export const WIRE_AUDIT = assertWireTables();
export const COMPLETION_AUDIT = assertCompletions();

// 第十一批-C 新增硬门禁：prompts 版本登记（未升版本改 prompt 会被抓出来）、prompt 参数补全
// 语义分派、审批风险/升级矩阵 + 哈希链账本自检、错误恢复剧本（每个大类都有兜底、终态不许
// 自动重试、剧本引用真实工具）。任何漂移都让 server 启动即失败。
export const PROMPT_VERSION_AUDIT = assertPromptVersions();
export const PROMPT_COMPLETION_AUDIT = assertPromptCompletion({ prompts: PROMPT_DEFINITIONS });
export const APPROVAL_HARD_AUDIT = assertApprovalAudit(TOOLS);
export const RECOVERY_AUDIT = assertRecoveryPlaybooks({ toolNames: TOOLS.map((tool) => tool.name) });
export const SUBSCRIPTION_DIFF_AUDIT = assertSubscriptionDiff();

// 审批账本（内存、有界、sha256 哈希链）：每次“需要审批”的决策都 append；成功确认的调用
// 会拿到可校验回执（见 tools/call 的 _meta['browser-bridge/approval-receipt']）。
export const APPROVAL_LEDGER = createApprovalLedger({ limit: 256, env: process.env });

// resources/list 的图差量基线：上一次 resources/list 时的图谱快照（第一次为 null → 全量 added）。
let LAST_RESOURCE_GRAPH = null;
// 订阅差量基线：上一次 subscribe/unsubscribe 回执时的订阅条目。
let LAST_SUBSCRIPTIONS = [];

// resources 订阅集合：显式 subscribe 的 URI 集合 + 有界推送（notifications/resources/updated）。
// 先于 RESOURCES 创建：RESOURCES 的快照更新 sink 直接调用 SUBSCRIPTIONS.notifyUpdated，
// 这样“工具成功 → 回填快照 → 通知订阅者”是同一条同步链路，不依赖轮询。
export const SUBSCRIPTIONS = createSubscriptionRegistry({
  notify: (message) => send(message),
  env: process.env,
});

// 只读 resources：技能文档按需读盘，观察/证据快照由 tools/call 成功后回填并落盘
// （目录 BB_HOME/mcp-snapshots，进程重启后恢复 latest；详见 mcp/snapshots.mjs）。
export const RESOURCES = createResourceRegistry({
  home: HOME,
  onUpdate: (event) => SUBSCRIPTIONS.notifyUpdated(event.uris, event),
});

/** resources/list 与 initialize 共用的订阅状态（单一来源）。 */
export function subscriptionInfo() {
  const stats = SUBSCRIPTIONS.stats();
  return Object.freeze({
    notification: RESOURCE_UPDATED_NOTIFICATION,
    uriScoped: true,
    active: stats.active,
    maxSubscriptions: stats.limits.maxSubscriptions,
    maxNotificationsPerUpdate: stats.limits.maxNotificationsPerUpdate,
    enabled: stats.enabled,
    cleanupOnDisconnect: true,
    counters: stats.counters,
  });
}

// 在途 tools/call 登记：notifications/cancelled 用它停止等待并转发 daemon 取消。
export const CALLS = createCallRegistry({ rpc });

/** 工具 → 协议要求快照（status/doctor/测试共用；纯派生，不新增手工表）。 */
export function toolProtocolRequirements(tools = TOOLS) {
  const rows = tools.map((tool) => {
    const methods = [...(tool.methods || [])];
    const featureGates = [...new Set(methods.map((method) => METHOD_FEATURE[method]).filter(Boolean))].sort();
    const floors = [...new Set(methods.map((method) => floorOf(method)).filter(Boolean))].sort();
    return {
      name: tool.name,
      methods,
      featureGates,
      minProtocol: floors.length ? floors[floors.length - 1] : null,
    };
  });
  return {
    tools: rows,
    total: rows.length,
    gated: rows.filter((row) => row.featureGates.length > 0).length,
    features: [...new Set(rows.flatMap((row) => row.featureGates))].sort(),
  };
}

export { TOOLS };

const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]));
const policyOfTool = (tool) => (tool && tool.policy) || policyFor(tool && tool.name, tool);

/** 已知会话 id（资源快照 key 派生；不访问 daemon，只用于 completion 补全）。 */
function knownSessionIds() {
  const ids = new Set();
  for (const store of [RESOURCES.observations, RESOURCES.evidence, RESOURCES.journals]) {
    try {
      for (const key of store.keys()) {
        if (key === 'latest' || key.startsWith('archive:')) continue;
        ids.add(key);
      }
    } catch {
      // 单个 store 读取失败不影响其它 store
    }
  }
  return [...ids].sort();
}

/** resources/list 与 resources/read 共用的新鲜度快照（只读派生，不复制快照内容）。 */
export function resourceFreshnessReport({ now = Date.now() } = {}) {
  let entries = [];
  try {
    entries = buildFreshnessEntries(RESOURCES, { now });
  } catch {
    entries = [];
  }
  return summarizeFreshness(entries, { now });
}

function send(message) { process.stdout.write(serializeMessage(message)); }
function ok(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message) { send(errorResponse(id, code, message)); }

/**
 * 工具成功后回填只读 resources（观察快照 / 调试证据 / 调试 journal），不改变工具返回值。
 * 返回 { snapshot, updates } 或 null：
 *   - snapshot：被回填的 resource 描述（kind/key/uri），不认识的工具为 null；
 *   - updates：本次写入产生的快照更新事件（已同步推送给订阅者），供 tools/call 的 _meta 留证。
 * 只为一轮调用收集事件：addUpdateSink 在 finally 里注销，避免跨调用串线。
 */
export function recordResources(tool, args, result) {
  const updates = [];
  let removeSink = null;
  try {
    removeSink = RESOURCES.addUpdateSink((event) => updates.push(event));
    const snapshot = RESOURCES.recordToolResult(tool && tool.name, args || {}, result);
    return { snapshot, updates };
  } catch {
    // resources 缓存失败不影响工具结果本身
    return null;
  } finally {
    if (removeSink) removeSink();
  }
}

/** 把工具结果包成 MCP tools/call result，并带上分档/耗时元数据。 */
function toolResult(payload, policy, extraMeta = {}) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: false,
    _meta: {
      'browser-bridge/tier': policy.tier,
      'browser-bridge/timeoutMs': policy.timeoutMs,
      ...extraMeta,
    },
  };
}

async function handle(request) {
  const { id, method, params } = request;
  if (method === 'initialize') {
    const progressStats = progressSnapshot(TOOLS, process.env, policyOfTool);
    // 协议版本协商：客户端请求的版本在支持表里就原样回，否则回默认版本并标记 fallback，
    // 绝不假装支持未知版本（见 mcp/wire.mjs）。
    const negotiated = negotiateProtocolVersion(params && params.protocolVersion);
    const approvalGrades = approvalSnapshot(TOOLS, { policyOf: policyOfTool });
    const completionStats = completionSnapshot({
      skillReferences: RESOURCES.skillReferences(),
      sessions: knownSessionIds(),
    });
    ok(id, {
      protocolVersion: negotiated.version,
      capabilities: {
        tools: { listChanged: false },
        resources: {
          subscribe: RESOURCES.capabilities.subscribe,
          listChanged: RESOURCES.capabilities.listChanged,
          subscription: RESOURCES.capabilities.subscription,
          pagination: RESOURCES.capabilities.pagination,
          listPagination: cursorSnapshot(),
        },
        prompts: {
          listChanged: false,
          // 第十一批-C：prompt 版本化（semver + 结构指纹）。prompts/get 可带 version，
          // 不支持/不是当前的版本会显式标 fallback（见 mcp/prompt-versions.mjs）。
          versioned: true,
          versionParam: 'version',
        },
        // MCP 标准 completion 能力（2025 版起可选）：客户端可对 prompt 参数与资源模板变量
        // 发 completion/complete 请求候选值（见 mcp/completion.mjs）。
        completions: {},
        // 扩展能力（协议允许的 experimental 面）：客户端可据此决定是否携带 progressToken、
        // 是否发 notifications/cancelled、是否订阅资源变更，以及 resources 快照能否跨进程恢复。
        experimental: {
          'browser-bridge/wire': wireSnapshot({ negotiated }),
          'browser-bridge/progress': {
            supported: true,
            tokenMeta: '_meta.progressToken',
            classes: progressStats.classes,
            byClass: progressStats.byClass,
            maxNotifications: progressStats.maxNotifications,
            notification: 'notifications/progress',
          },
          'browser-bridge/cancellation': {
            supported: true,
            notification: 'notifications/cancelled',
            response: 'suppressed',
            remoteDaemonCancel: true,
            remoteMethods: ['inflight.list', 'command.cancel'],
          },
          'browser-bridge/snapshots': {
            persisted: Boolean(RESOURCES.persistence),
            dir: RESOURCES.persistence ? RESOURCES.persistence.dir : null,
            restored: RESOURCES.restored,
            ttlMs: RESOURCES.persistence ? RESOURCES.persistence.limits.ttlMs : null,
            maxTotalBytes: RESOURCES.persistence ? RESOURCES.persistence.limits.maxTotalBytes : null,
            maxEntryBytes: RESOURCES.persistence ? RESOURCES.persistence.limits.maxEntryBytes : null,
            freshness: freshnessSnapshot(),
          },
          // 订阅推送是标准 resources 能力的扩展说明：客户端据此知道“通知里会带什么、上限多少、
          // 断开会不会自动清理”，不必猜服务端行为。
          'browser-bridge/resource-subscriptions': {
            supported: Boolean(SUBSCRIPTIONS.limits.enabled),
            notification: RESOURCE_UPDATED_NOTIFICATION,
            uriScoped: true,
            maxSubscriptions: SUBSCRIPTIONS.limits.maxSubscriptions,
            maxNotificationsPerUpdate: SUBSCRIPTIONS.limits.maxNotificationsPerUpdate,
            cleanupOnDisconnect: true,
            listChanged: false,
            methods: ['resources/subscribe', 'resources/unsubscribe'],
          },
          // 第十批-B：列表分页 / 资源索引 / 审批分级 / 错误恢复映射 / 补全的机器可读声明。
          'browser-bridge/list-pagination': cursorSnapshot(),
          'browser-bridge/resource-index': resourceIndexSnapshot({ templates: RESOURCES.templates().length }),
          'browser-bridge/approval': approvalGrades,
          'browser-bridge/error-map': errorMapSnapshot(),
          'browser-bridge/completions': completionStats,
          // 第十一批-C：关系图谱 / 订阅差量 / prompt 版本 / 审批硬审计 / 恢复剧本。
          // 每个快照都只描述结构（不包含用户数据），客户端可据此决定缓存与恢复策略。
          'browser-bridge/resource-graph': resourceGraphSnapshot({ templates: RESOURCES.templates() }),
          'browser-bridge/subscription-diff': subscriptionDiffSnapshot(),
          'browser-bridge/prompt-versions': promptVersionsSnapshot(),
          'browser-bridge/prompt-completion': promptCompletionSnapshot(),
          'browser-bridge/approval-audit': approvalAuditSnapshot(TOOLS, { ledger: APPROVAL_LEDGER }),
          'browser-bridge/recovery-playbook': recoverySnapshot({ toolNames: TOOLS.map((tool) => tool.name) }),
        },
      },
      serverInfo: { name: 'browser-bridge', version: VERSION },
      instructions: '先 browser_status 确认环境；read 级工具可直接调用，destructive 工具需要在 params._meta 传 "browser-bridge/approval": "confirmed"。长任务可在 tools/call 的 params._meta.progressToken 里带一个 string/number 令牌以接收 notifications/progress（按工具分档节流）；需要中止时发 notifications/cancelled（requestId 为原请求 id，响应会被抑制）。大块文本用 resources 按需读取（bridge://skill/SKILL.md、bridge://observation/latest、bridge://debug/journal/latest）；超过单段上限时用 ?limit=&cursor= 续读。观察/证据/journal 快照会落盘到 BB_HOME/mcp-snapshots 并在重启后恢复 latest。需要“变了就通知”时用 resources/subscribe 订阅 bridge://observation/latest、bridge://debug/evidence/latest、bridge://debug/journal/latest 或会话级 URI，快照更新会收到 notifications/resources/updated（uri 精确匹配；断开自动清理订阅）。resources/list、prompts/list、resources/templates/list 支持 limit/cursor 分页（默认全量，nextCursor 续读）；资源快照在 resources/read 的 _meta.freshnessState 里给出 fresh/recent/stale/expired；可用 completion/complete 取 prompt 参数与资源模板变量的候选值；失败时 tools/call 的 _meta["browser-bridge/error"] 给出 category/retryable/retryDelayMs 恢复建议。第十一批-C 扩展：resources/list 的 _meta 带关系图（graph/graphDiff）与订阅覆盖（subscriptionCoverage/subscriptionHealth）；resources/subscribe 回执带 diff/related 邻居；prompts/list 每个 prompt 带 version/fingerprint，prompts/get 支持 version 协商并显式标 fallback；tools/call 的 _meta["browser-bridge/approval-audit"] 记录审批决策与哈希链，确认放行会带可校验的 _meta["browser-bridge/approval-receipt"]；失败时 _meta["browser-bridge/recovery"] 给多步恢复剧本（nextStep/steps/escalateToHuman）。',
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') { ok(id, {}); return; }
  if (method === 'tools/list') {
    const snapshot = policySnapshot(TOOLS);
    const progressStats = progressSnapshot(TOOLS, process.env, policyOfTool);
    const grades = gradeSnapshot(TOOLS, { policyOf: policyOfTool });
    ok(id, {
      tools: TOOLS.map((tool) => {
        const policy = policyFor(tool.name, tool);
        const progress = resolveProgressPolicy(tool.name, policy);
        const grade = approvalGradeFor(policy);
        // 第十一批-C：风险评分 + 升级策略（客户端可据此决定“确认 / 人工复核 / 直接放行”）。
        const risk = approvalRisk(policy, grade);
        const escalation = escalationRuleFor(policy, grade);
        return {
          name: tool.name,
          title: policy ? policy.title : tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: annotationsFor(tool.name, tool),
          _meta: {
            'browser-bridge/policy': {
              tier: policy.tier,
              timeoutMs: policy.timeoutMs,
              approval: policy.approvalRequired,
              idempotent: policy.idempotent,
              openWorld: policy.openWorld,
              featureGates: [...(tool.featureGates || [])],
              minProtocol: tool.minProtocol,
              // 第十批-B：审批分级（none / confirm / mandatory），客户端可据此决定是否弹窗。
              approvalGrade: grade.grade,
              approvalBypassable: grade.bypassable,
              approvalAction: grade.action,
              // 第十一批-C：风险分/等级与升级策略（见 mcp/approval-audit.mjs）。
              approvalRiskScore: risk ? risk.score : null,
              approvalRiskBand: risk ? risk.band : null,
              approvalEscalation: escalation.escalate,
              approvalRequiresReason: escalation.requiresReason,
            },
            'browser-bridge/progress': {
              class: progress.class,
              intervalMs: progress.intervalMs,
              firstDelayMs: progress.firstDelayMs,
              maxNotifications: progress.maxNotifications,
            },
          },
        };
      }),
      _meta: {
        'browser-bridge/policy': {
          total: snapshot.total,
          byTier: snapshot.byTier,
          approvals: snapshot.approvals,
          approvalGrades: grades.byGrade,
          mandatoryApprovals: grades.mandatory,
        },
        'browser-bridge/progress': {
          enabled: progressStats.enabled,
          classes: progressStats.classes,
          byClass: progressStats.byClass,
          maxNotifications: progressStats.maxNotifications,
        },
        'browser-bridge/approval': approvalSnapshot(TOOLS, { policyOf: policyOfTool }),
        // 第十一批-C：审批硬审计摘要（风险分布 + 升级策略分布 + 账本链状态/回执格式）。
        'browser-bridge/approval-audit': (() => {
          const audit = approvalAuditSnapshot(TOOLS, { ledger: APPROVAL_LEDGER });
          return {
            byBand: audit.byBand,
            byEscalation: audit.byEscalation,
            ledger: audit.ledger,
            receipt: audit.receipt,
            metaKey: audit.audit.metaKey,
          };
        })(),
      },
    });
    return;
  }
  // MCP completion/complete：prompt 参数 / 资源模板变量补全（纯查表，不执行工具、不访问 daemon）。
  if (method === 'completion/complete') {
    try {
      ok(id, complete(params, {
        catalog: {
          skillReferences: RESOURCES.skillReferences(),
          sessions: knownSessionIds(),
        },
      }));
    } catch (error) {
      if (error instanceof CompletionError) {
        // 与 prompts/get 的错误口径一致：参数类错误统一 -32602（未知 prompt/模板也按参数错误处理）。
        fail(id, JSONRPC_ERRORS.INVALID_PARAMS, error.code + ': ' + error.message);
      } else {
        fail(id, JSONRPC_ERRORS.INTERNAL_ERROR, String((error && error.message) || error));
      }
    }
    return;
  }
  // MCP 取消通知：没有 id、不产生响应；对未知/已完成请求按规范静默忽略。
  // 找到在途调用时：立即停止等待（不再回原请求的响应），并 best-effort 转发 daemon 取消；
  // 最终进度通知（若客户端带了 progressToken）由 CALLS.cancel 在关闭会话前发出。
  if (method === 'notifications/cancelled') {
    try {
      await CALLS.cancel(params && params.requestId, params && params.reason);
    } catch (error) {
      // 取消是通知，不能反过来让 server 崩；写 stderr 便于诊断（stdout 只放 JSON-RPC）。
      process.stderr.write('cancel notification 处理失败：' + String((error && error.message) || error) + '\n');
    }
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const tool = TOOL_MAP.get(name);
    if (!tool) {
      ok(id, { content: [{ type: 'text', text: '未知工具：' + name }], isError: true });
      return;
    }
    const policy = policyFor(tool.name, tool);
    const args = (params && params.arguments) || {};

    // 1) 入参运行时校验：与 inputSchema 同源，错误码 E_ARG_*。
    const validation = validateToolArgs(tool.inputSchema, args);
    if (!validation.ok) {
      const text = validation.errors.map((error) => error.code + ' ' + (error.path || '<arguments>') + ': ' + error.message).join('\n');
      // errorCode 让客户端不必从文本里正则抓码（additive：旧客户端忽略即可）。
      const firstCode = (validation.errors[0] && validation.errors[0].code) || 'E_ARG_UNEXPECTED';
      ok(id, {
        content: [{ type: 'text', text }],
        isError: true,
        _meta: {
          'browser-bridge/tier': policy.tier,
          'browser-bridge/validation': validation.errors,
          'browser-bridge/errorCode': firstCode,
          // 第十一批-C：参数类错误也带多步恢复剧本（先修参数再重试，不是盲目重放）。
          'browser-bridge/recovery': planRecovery({ code: firstCode, tool: tool.name }),
        },
      });
      return;
    }

    // 2) 审批闸门 + 审批硬审计：decideApproval 内部直接复用 tool-policy.approvalGate
    //    （拦截文本/结构与历史逐字节一致），并把“需要审批”的决策写进哈希链账本。
    const approvalDecision = decideApproval({
      name: tool.name,
      params,
      policy,
      ledger: APPROVAL_LEDGER,
      tool,
    });
    if (!approvalDecision.allowed) {
      const gate = approvalDecision.gate;
      ok(id, {
        ...gate,
        _meta: {
          ...gate._meta,
          'browser-bridge/approval-audit': approvalDecision.record,
        },
      });
      return;
    }
    // 通过审批的回执/决策只加在“需要审批”的调用上（read/mutate 不产生噪声字段）。
    const approvalMeta = approvalDecision.record.decision === 'not-required'
      ? {}
      : {
        'browser-bridge/approval-audit': approvalDecision.record,
        ...(approvalDecision.receipt ? { 'browser-bridge/approval-receipt': approvalDecision.receipt } : {}),
      };

    // 3) 执行：分档超时 + 客户端取消 + 分档进度心跳。
    const startedAt = Date.now();
    const progress = createProgressSession({
      tool: tool.name,
      token: progressTokenFrom(params),
      policy,
      notify: (progressParams) => send({ jsonrpc: '2.0', method: 'notifications/progress', params: progressParams }),
    });
    const call = CALLS.register(id, {
      tool: tool.name,
      methods: [...(tool.methods || [])],
      progress,
    });
    progress.start();
    try {
      const result = await raceToolCall(Promise.resolve().then(() => tool.run(args)), {
        call,
        timeoutMs: policy.timeoutMs,
        name: tool.name,
      });
      progress.finish();
      // 回填快照会同步产生 resources/updated 通知；这里同时把“哪写 URI 被推送”写进 _meta，
      // 让客户端/自测能在工具响应里核对订阅链路（订阅与实际推送是同一事件源）。
      const recorded = recordResources(tool, args, result);
      const snapshot = recorded ? recorded.snapshot : null;
      const updates = recorded && Array.isArray(recorded.updates) ? recorded.updates : [];
      ok(id, toolResult(result, policy, {
        'browser-bridge/elapsedMs': Date.now() - startedAt,
        'browser-bridge/progress': progressResultMeta(progress),
        ...approvalMeta,
        ...(snapshot ? { 'browser-bridge/snapshot': snapshot } : {}),
        ...(updates.length
          ? {
            'browser-bridge/resource-updates': {
              count: updates.length,
              uris: updates.flatMap((event) => [...(event.uris || [])]),
              action: updates[updates.length - 1].action,
            },
          }
          : {}),
      }));
    } catch (error) {
      // MCP 规范：已被取消的请求不再回响应（客户端已放弃等待）。取消的最终进度通知由
      // CALLS.cancel 负责；这里先等它发完，避免 finally 提前 dispose 掉进度会话。
      if (call.cancelled) {
        if (call.cancelSettled) {
          try { await call.cancelSettled; } catch { /* 取消报告失败不影响抑制响应 */ }
        }
        process.stderr.write('tools/call ' + String(id) + ' 已取消（' + (call.reason || '') + '）：响应按 MCP 规范抑制\n');
        return;
      }
      progress.fail(error);
      // 错误恢复映射：文本保持历史格式（`code: message` + 下一步提示），另在 _meta
      // 里给结构化分类/重试建议（见 mcp/error-map.mjs），旧客户端忽略 _meta 不受影响。
      const envelope = errorEnvelope(error, {
        tool: tool.name,
        tier: policy.tier,
        elapsedMs: Date.now() - startedAt,
      });
      // 第十一批-C：多步恢复剧本（code → 步骤序列 + 退避 + 是否需要人工），
      // 与 error-map 的单步重试建议互补；只建议，server 不自动重放工具。
      const recovery = planRecovery({ code: envelope.code, tool: tool.name });
      ok(id, {
        content: [{ type: 'text', text: envelope.text }],
        isError: true,
        _meta: {
          'browser-bridge/tier': policy.tier,
          'browser-bridge/errorCode': envelope.code,
          'browser-bridge/elapsedMs': Date.now() - startedAt,
          'browser-bridge/progress': progressResultMeta(progress),
          'browser-bridge/error': envelope.record,
          'browser-bridge/recovery': recovery,
          ...approvalMeta,
        },
      });
    } finally {
      CALLS.release(id);
      progress.dispose();
    }
    return;
  }
  if (method === 'resources/list') {
    const resourceStats = RESOURCES.stats();
    const now = Date.now();
    // 行集合可能随快照增长：支持 query/kind/mimeType 过滤 + limit/cursor 分页；
    // 默认（无参数）保持历史输出（全量、原顺序），只新增 _meta 字段。
    let resourceRows;
    let listed;
    let graphReport;
    try {
      // 一次取行集合，同时喂给：过滤/排序/分页（queryResources）、关系图（buildGraphWithDiff）。
      // 图差量基线是“上一次 resources/list”，因此 graphDiff 表示自上次 list 以来的变化。
      resourceRows = RESOURCES.list();
      graphReport = buildGraphWithDiff(LAST_RESOURCE_GRAPH, resourceRows, { templates: RESOURCES.templates() });
      LAST_RESOURCE_GRAPH = graphReport.graph;
      listed = queryResources(resourceRows, {
        cursor: params && params.cursor,
        limit: params && params.limit,
        query: params && params.query,
        kind: params && params.kind,
        mimeType: params && params.mimeType,
        sort: params && params.sort,
        label: 'resources',
      });
    } catch (error) {
      if (error instanceof CursorError) {
        fail(id, JSONRPC_ERRORS.INVALID_PARAMS, error.code + ': ' + error.message);
      } else {
        fail(id, JSONRPC_ERRORS.INTERNAL_ERROR, String((error && error.message) || error));
      }
      return;
    }
    // 订阅覆盖/健康/差量：把“资源有哪些”与“客户端订阅了哪些”对账给客户端看。
    const subscriptionEntries = SUBSCRIPTIONS.list();
    const subscriptionStats = SUBSCRIPTIONS.stats();
    ok(id, {
      resources: [...listed.page],
      ...(listed.paged.nextCursor ? { nextCursor: listed.paged.nextCursor } : {}),
      _meta: {
        'browser-bridge/resources': {
          subscribe: RESOURCES.capabilities.subscribe,
          listChanged: RESOURCES.capabilities.listChanged,
          subscription: subscriptionInfo(),
          pagination: RESOURCES.capabilities.pagination,
          templates: RESOURCES.templates().length,
          restored: RESOURCES.restored,
          updates: resourceStats.updates,
          persistence: {
            enabled: resourceStats.persistence.enabled,
            dir: resourceStats.persistence.dir,
            files: resourceStats.persistence.files,
            bytes: resourceStats.persistence.bytes,
            ttlMs: resourceStats.persistence.limits ? resourceStats.persistence.limits.ttlMs : null,
            maxTotalBytes: resourceStats.persistence.limits ? resourceStats.persistence.limits.maxTotalBytes : null,
            maxEntryBytes: resourceStats.persistence.limits ? resourceStats.persistence.limits.maxEntryBytes : null,
            lastSave: resourceStats.persistence.lastSave,
          },
          // 行级分页（与上面字符级分页参数不同：这里是“多少行一页”）。
          listPagination: listed.paged,
          // 索引分布：total/byKind/byMime/dynamic/static/unknown/duplicates。
          index: listed.summary,
          // 快照新鲜度汇总：fresh/recent/stale/expired 各多少条、哪些需要复核。
          freshness: resourceFreshnessReport({ now }),
          // 第十一批-C：关系图摘要（节点/边/会话/连通分量/指纹）与自上次 list 的图差量。
          graph: graphReport.summary,
          graphDiff: graphReport.diff,
          // 订阅覆盖（动态资源覆盖了哪些、哪些悬空、建议订阅什么）+ 健康（长期无通知）。
          subscriptionCoverage: coverageReport(subscriptionEntries, resourceRows, {
            graph: graphReport.graph,
            limits: subscriptionStats.limits,
          }),
          subscriptionHealth: subscriptionHealth(subscriptionEntries, {
            now,
            limits: subscriptionStats.limits,
          }),
          subscriptionChurn: churnReport(subscriptionStats.counters),
        },
      },
    });
    return;
  }
  if (method === 'resources/templates/list') {
    // 模板数量小，但保持与 resources/list 一致的游标语义（客户端可统一处理）。
    let listed;
    try {
      listed = paginateList(RESOURCES.templates(), {
        cursor: params && params.cursor,
        limit: params && params.limit,
        label: 'templates',
      });
    } catch (error) {
      if (error instanceof CursorError) {
        fail(id, JSONRPC_ERRORS.INVALID_PARAMS, error.code + ': ' + error.message);
      } else {
        fail(id, JSONRPC_ERRORS.INTERNAL_ERROR, String((error && error.message) || error));
      }
      return;
    }
    ok(id, {
      resourceTemplates: [...listed.page],
      ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}),
      _meta: {
        'browser-bridge/pagination': {
          total: listed.total,
          returned: listed.returned,
          offset: listed.offset,
          limit: listed.limit,
          hasMore: listed.hasMore,
          nextCursor: listed.nextCursor,
        },
      },
    });
    return;
  }
  // capabilities.resources.subscribe=true：订阅集合只记录 URI（有界、URI 级精确匹配），
  // 快照更新时由 RESOURCES 的更新 sink → SUBSCRIPTIONS.notifyUpdated 推送
  // notifications/resources/updated。URI 形状与资源目录在这里先校验：
  //   - 非法形状/分页查询参数错误 → -32602；
  //   - 未知资源（bridge://nope）→ -32002；
  //   - 分页查询串被归一掉：订阅永远针对 baseUri，重新 read 时客户端自己决定 limit/cursor。
  if (method === 'resources/subscribe' || method === 'resources/unsubscribe') {
    const uri = params && params.uri;
    if (typeof uri !== 'string' || !uri.trim()) {
      fail(id, -32602, method + ' 需要字符串 params.uri');
      return;
    }
    let baseUri;
    try {
      baseUri = RESOURCES.parseUri(uri).baseUri;
    } catch (error) {
      if (error instanceof ResourceError) fail(id, error.code === 'E_BAD_ARG' ? -32602 : -32002, error.message);
      else fail(id, -32603, String((error && error.message) || error));
      return;
    }
    try {
      const report = method === 'resources/subscribe'
        ? SUBSCRIPTIONS.subscribe(baseUri)
        : SUBSCRIPTIONS.unsubscribe(baseUri);
      // 第十一批-C：订阅差量（相对上一次 subscribe/unsubscribe 回执）+ 健康 + 图谱邻居。
      // 邻居只告诉客户端“同会话兄弟 / latest 别名 / 技能父文档”，客户端自行决定是否一并订阅。
      const currentSubscriptions = SUBSCRIPTIONS.list();
      const subscriptionDiff = diffSubscriptions(LAST_SUBSCRIPTIONS, currentSubscriptions);
      LAST_SUBSCRIPTIONS = currentSubscriptions;
      const subscriptionStats = SUBSCRIPTIONS.stats();
      let graphForRelated = LAST_RESOURCE_GRAPH;
      if (!graphForRelated) {
        try {
          graphForRelated = buildResourceGraph(RESOURCES.list(), { templates: RESOURCES.templates() });
        } catch {
          graphForRelated = null;
        }
      }
      const related = method === 'resources/subscribe' && graphForRelated
        ? relatedUris(graphForRelated, baseUri, { depth: 1 }).slice(0, 8).map((item) => item.uri)
        : [];
      // MCP 规范：成功结果为空对象；扩展信息放 _meta（客户端忽略也不影响语义）。
      ok(id, {
        _meta: {
          'browser-bridge/subscription': {
            ...report,
            uri: baseUri,
            requestedUri: uri,
            max: report.max,
            maxSubscriptions: report.max,
            active: SUBSCRIPTIONS.size(),
            notification: RESOURCE_UPDATED_NOTIFICATION,
            diff: subscriptionDiff,
            health: subscriptionHealth(currentSubscriptions, { limits: subscriptionStats.limits }),
            ...(related.length ? { related } : {}),
            ...(report.evicted ? { evictedUri: report.evicted } : {}),
          },
        },
      });
    } catch (error) {
      if (error instanceof SubscriptionError) fail(id, -32602, error.message);
      else fail(id, -32603, String((error && error.message) || error));
    }
    return;
  }
  if (method === 'resources/read') {
    const uri = params && params.uri;
    try {
      const read = RESOURCES.read(uri);
      // 新鲜度分级（additive）：在既有 stale/ageMs 之上给 state/action/hint，
      // 客户端可据此决定“直接用 / 先复核 / 重新采集”（见 mcp/resource-freshness.mjs）。
      try {
        const meta = read && read._meta && read._meta['browser-bridge/resource'];
        if (meta) {
          const classification = classifyFreshness(meta.capturedAt, { now: Date.now(), kind: meta.kind });
          meta.freshnessState = classification.state;
          meta.freshnessAction = classification.action;
          meta.freshnessHint = classification.hint;
        }
      } catch {
        // 新鲜度派生失败不影响读取结果本身
      }
      ok(id, read);
    } catch (error) {
      if (error instanceof ResourceError) {
        fail(id, jsonRpcCodeFor(error.code), error.message);
      } else {
        fail(id, JSONRPC_ERRORS.INTERNAL_ERROR, String((error && error.message) || error));
      }
    }
    return;
  }
  if (method === 'prompts/list') {
    // 第十一批-C：每条 prompt 声明附版本元数据（version/fingerprint/stability/fallback 语义），
    // 客户端可缓存并在 prompts/get 时用版本协商确认“拿到的是不是同一份模板”。
    const prompts = listPrompts().map((prompt) => ({
      ...prompt,
      _meta: {
        ...(prompt._meta || {}),
        'browser-bridge/prompt-version': promptVersionMeta(prompt.name),
      },
    }));
    let listed;
    try {
      listed = paginateList(prompts, {
        cursor: params && params.cursor,
        limit: params && params.limit,
        label: 'prompts',
      });
    } catch (error) {
      if (error instanceof CursorError) {
        fail(id, JSONRPC_ERRORS.INVALID_PARAMS, error.code + ': ' + error.message);
      } else {
        fail(id, JSONRPC_ERRORS.INTERNAL_ERROR, String((error && error.message) || error));
      }
      return;
    }
    ok(id, {
      prompts: [...listed.page],
      ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}),
      _meta: {
        'browser-bridge/prompts': {
          total: listed.total,
          returned: listed.returned,
          pagination: {
            offset: listed.offset,
            limit: listed.limit,
            hasMore: listed.hasMore,
            nextCursor: listed.nextCursor,
            cursorParam: 'cursor',
            limitParam: 'limit',
          },
          // 版本能力声明（含每个 prompt 的当前版本与指纹）。
          versioning: promptVersionsSnapshot(),
          completion: promptCompletionSnapshot(),
        },
      },
    });
    return;
  }
  if (method === 'prompts/get') {
    const name = params && params.name;
    try {
      const rendered = getPrompt(name, params && params.arguments);
      // 第十一批-C：版本协商。version 是 additive 扩展参数（params.version 或 _meta.version）；
      // 不传/不匹配时按当前版本渲染，并在 _meta 显式标 fallback + reason（不伪造旧渲染）。
      const requested = params && (params.version != null
        ? params.version
        : (params._meta && typeof params._meta === 'object' ? params._meta.version : null));
      const negotiation = resolvePromptVersion(name, requested);
      rendered._meta = {
        ...(rendered._meta || {}),
        'browser-bridge/prompt-version': {
          ...promptVersionMeta(name, { requestedVersion: requested }),
          negotiation: {
            exact: negotiation.exact,
            fallback: negotiation.fallback,
            compatible: negotiation.compatible,
            reason: negotiation.reason,
            requested: negotiation.requested,
            availableVersions: negotiation.availableVersions,
          },
        },
      };
      ok(id, rendered);
    } catch (error) {
      if (error instanceof PromptError) fail(id, -32602, error.message);
      else fail(id, -32603, String((error && error.message) || error));
    }
    return;
  }
  if (method === 'shutdown' || method === 'exit') {
    // 断开语义：订阅集合随之清空，不把订阅带进下一次 stdio 会话（也不 pretending 已推送）。
    SUBSCRIPTIONS.clear(method);
    LAST_SUBSCRIPTIONS = [];
    ok(id, {});
    process.exit(0);
  }
  fail(id, -32601, 'Method not found: ' + method);
}

// 作为脚本（node mcp/server.mjs）运行时才启动 stdio 读循环；被单测 import 时只导出 TOOLS。
const IS_MAIN = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_MAIN) {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    // 信封层：一行 → 请求/通知/响应/非法（见 mcp/wire.mjs）。
    //   - 非法/解析错误 → 回 -32602/-32700 错误帧（带能回填的 id）；
    //   - 响应 → 本 server 不发请求，按噪声忽略；
    //   - 通知 → 只有 notifications/cancelled 有语义，其余静默忽略（绝不回帧）；
    //   - 批量数组 → 解码层已按 -32600 拒绝（BridgeDeck 不声明 batch 能力）。
    const decoded = decodeWireLine(line);
    if (!decoded.ok) {
      const error = decoded.error;
      send(errorResponse(error.id === undefined ? null : error.id, error.rpcCode, error.message));
      return;
    }
    if (decoded.kind === 'response') return;
    if (decoded.kind === 'notification') {
      if (decoded.method !== 'notifications/cancelled') return;
      handle({ jsonrpc: '2.0', method: decoded.method, params: decoded.params })
        .catch((error) => process.stderr.write('cancel 通知处理失败：' + String((error && error.message) || error) + '\n'));
      return;
    }
    const request = { jsonrpc: '2.0', id: decoded.id, method: decoded.method, params: decoded.params };
    handle(request).catch((error) => fail(request.id, JSONRPC_ERRORS.INTERNAL_ERROR, String((error && error.message) || error)));
  });
  rl.on('close', () => {
    // 客户端断开：先清订阅（有界集合不跨会话），再停会话退出。
    const cleared = SUBSCRIPTIONS.clear('client-disconnect');
    if (cleared.cleared > 0) {
      process.stderr.write('resources 订阅已在断开时清理：' + cleared.cleared + ' 条\n');
    }
    if (state.sessionId) rpc('session.stop', { session: state.sessionId }).catch(() => {});
    process.exit(0);
  });
}
