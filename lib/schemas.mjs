// lib/schemas.mjs —— 轻量协议参数校验（零依赖，先覆盖 transfer.*）。
//
// 用 JSON Schema 约束方法参数；这里实现一个最小 validator，
// 让 daemon 在进入业务逻辑前给出稳定的 E_BAD_ARG 与字段路径。
//
// 单源约定：请求公共信封字段由 lib/method-catalog.mjs 的 REQUEST_ENVELOPE_KEYS 派生，
// 方法 schema 只有这一处权威定义；生成物里的 METHOD_SCHEMA_KEYS / PARAM_ALIASES 由
// buildSchemaKeyTable() / buildParamAliases() 派生（tools/gen-protocol.mjs 只调用，不重写逻辑），
// tools/protocol-single-source.mjs 再逐项审计生成物 == 这里的派生结果。
import { EXTENSION_METHODS, METHOD_NAMES, REQUEST_ENVELOPE_KEYS } from './method-catalog.mjs';

const TRANSFER_ID = { type: 'string', pattern: '^tr_[0-9a-f]{16}$' };
const SESSION_FIELD = { type: 'string', minLength: 1 };
const MI_B = 1024 * 1024;
/**
 * 可选命令超时提示：daemon/server.mjs:1329 的 sendCommand 读取 params.timeoutMs，
 * 用它抬高 daemon→扩展 的等待上限（所有转发命令通用，缺省行为不变）。
 * 对兼容目标 0.5.0 有 timeout_ms 参数的方法，这是唯一可机械对齐的公共字段。
 */
const TIMEOUT_HINT = { type: 'integer', minimum: 1 };

/** 公共信封字段的类型声明；键集合来自目录（REQUEST_ENVELOPE_KEYS）。 */
const ENVELOPE_PROPERTY_SCHEMAS = Object.freeze({
  session: SESSION_FIELD,
  sessionId: SESSION_FIELD,
  tabId: { type: 'integer', minimum: 0 },
});

/** 由目录信封键生成 properties（未知键跳过并暴露在 schemaDriftReport 里）。 */
function envelopeProperties() {
  const properties = {};
  for (const key of REQUEST_ENVELOPE_KEYS) {
    const schema = ENVELOPE_PROPERTY_SCHEMAS[key];
    if (schema) properties[key] = schema;
  }
  return properties;
}

// 未单列的方法仍校验通用信封，避免 session/tabId 类型错误穿透到业务层。
const GENERIC_SCHEMA = {
  type: 'object',
  properties: envelopeProperties(),
};

export const METHOD_SCHEMAS = {
  observe: {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      probeHover: { type: 'boolean' },
      debugSurfaces: { type: 'boolean' },
      closedShadow: { type: 'boolean' },
      vom: { type: 'boolean' },
      vomDeep: { type: 'boolean' },
      vomTree: { type: 'boolean' },
      vomRank: { type: 'boolean' },
      vomExplain: { type: 'boolean' },
      vomExcludeHidden: { type: 'boolean' },
      vomProfile: { type: 'string', enum: ['balanced', 'compact', 'all'] },
      vomPerGroup: { type: 'integer', minimum: 1 },
      vomGroupTokens: { type: 'integer', minimum: 1 },
      vomBillingModel: { type: 'string', enum: ['cjk-heuristic-v2', 'chars-per-4', 'o200k'] },
      vomSemanticMaxGroups: { type: 'integer', minimum: 1 },
      vomSemanticMinScore: { type: 'number', minimum: -1000, maximum: 1000 },
      vomSemanticMaxTokens: { type: 'integer', minimum: 1 },
      vomGroupContext: { type: 'boolean' },
      vomWeights: { type: 'object' },
      vomTop: { type: 'integer', minimum: 1, maximum: 500 },
      vomMinScore: { type: 'number', minimum: -1000, maximum: 1000 },
      vomMaxNodes: { type: 'integer', minimum: 1, maximum: 5000 },
      vomMaxTokens: { type: 'integer', minimum: 1, maximum: 200000 },
      deepMaxTokens: { type: 'integer', minimum: 1, maximum: 20000 },
      ax: { type: 'boolean' },
      facts: { type: 'boolean' },
      fallbackAx: { type: 'boolean' },
      compareAx: { type: 'boolean' },
      pipeline: { type: 'string', enum: ['page-lib', 'ax'] },
      maxTokens: { type: 'integer', minimum: 1, maximum: 20000 },
      maxDepth: { type: 'integer', minimum: 1, maximum: 100 },
      cursor: { type: 'string', minLength: 1, maxLength: 4096 },
      force: { type: 'boolean' },
      delta: { type: 'boolean' },
      baseline: { type: 'string' },
    },
  },
  console: {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      since: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 2000 },
      maxTextChars: { type: 'integer', minimum: 1 },
      includeStack: { type: 'boolean' },
    },
  },
  navigate: {
    type: 'object',
    required: ['url'],
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      url: { type: 'string', minLength: 1, maxLength: 8192 },
    },
  },
  'wait-ms': {
    type: 'object',
    required: ['ms'],
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      ms: { type: 'integer', minimum: 0, maximum: 120000 },
      // extension/src/tools/waits.js:32 读取 commandId（等待期间可按命令 id 归因/取消）。
      commandId: { type: 'string', minLength: 1 },
    },
  },
  'wait-for-element': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      stableRef: { type: 'string', minLength: 1 },
      state: { type: 'string' },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 },
      operationId: { type: 'string', minLength: 1 },
    },
  },
  'wait-for-navigation': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      waitUntil: { type: 'string' },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 },
    },
  },
  click: {
    type: 'object',
    properties: {
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      text: { type: 'string', minLength: 1 },
      stableRef: { type: 'string', minLength: 1 },
      trusted: { type: 'boolean' },
      force: { type: 'boolean' },
      waitTimeoutMs: { type: 'integer', minimum: 0, maximum: 120000 },
      // 兼容目标 0.5.0 对齐：鼠标键与连续点击次数（扩展按 button 选择可信输入路径）。
      button: { type: 'string', enum: ['left', 'middle', 'right'] },
      clickCount: { type: 'integer', minimum: 1, maximum: 10 },
    },
  },
  'click-backend': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      backendId: { type: 'integer', minimum: 1 },
    },
  },
  hover: {
    type: 'object',
    properties: {
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      stableRef: { type: 'string', minLength: 1 },
      trusted: { type: 'boolean' },
      force: { type: 'boolean' },
      waitTimeoutMs: { type: 'integer', minimum: 0, maximum: 120000 },
    },
  },
  fill: {
    type: 'object',
    required: ['value'],
    properties: {
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      stableRef: { type: 'string', minLength: 1 },
      value: { type: 'string' },
      noClear: { type: 'boolean' },
      trusted: { type: 'boolean' },
      force: { type: 'boolean' },
      waitTimeoutMs: { type: 'integer', minimum: 0, maximum: 120000 },
    },
  },
  press: {
    type: 'object',
    required: ['key'],
    properties: {
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      stableRef: { type: 'string', minLength: 1 },
      key: { type: 'string', minLength: 1 },
      trusted: { type: 'boolean' },
      force: { type: 'boolean' },
      waitTimeoutMs: { type: 'integer', minimum: 0, maximum: 120000 },
    },
  },
  select: {
    type: 'object',
    required: ['value'],
    properties: {
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      stableRef: { type: 'string', minLength: 1 },
      value: { type: 'string' },
      waitTimeoutMs: { type: 'integer', minimum: 0, maximum: 120000 },
    },
  },
  read: {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      stableRef: { type: 'string', minLength: 1 },
      all: { type: 'boolean' },
      fieldsJson: { type: 'string' },
    // 兼容 tool.read 的声明式字段列表；扩展 read 已消费 fields。
    fields: { type: 'array', items: { type: 'object' }, maxItems: 32 },
    timeoutMs: TIMEOUT_HINT,
      // 兼容目标 0.5.0 对齐：读取节点上限/字节上限（daemon 在返回前按上限裁剪并给 truncated 证据）。
      maxNodes: { type: 'integer', minimum: 1, maximum: 10000 },
      maxBytes: { type: 'integer', minimum: 1, maximum: 64 * MI_B },
    },
  },
  evaluate: {
    type: 'object',
    required: ['expression'],
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      expression: { type: 'string', minLength: 1, maxLength: 200000 },
      unverified: { type: 'boolean' },
      // 兼容目标 0.5.0 对齐：CDP Runtime.evaluate 的两个开关（默认 true）。
      awaitPromise: { type: 'boolean' },
      returnByValue: { type: 'boolean' },
    },
  },
  wheel: {
    type: 'object',
    properties: {
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      deltaY: { type: 'number' },
      deltaX: { type: 'number' },
      modifiers: { type: 'array', items: { type: 'string' }, maxItems: 8 },
      timeoutMs: TIMEOUT_HINT,
    },
  },
  'webmcp.list': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
    },
  },
  'webmcp.call': {
    type: 'object',
    required: ['name'],
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      name: { type: 'string', minLength: 1 },
      input: { type: 'object' },
    },
  },
  drag: {
    type: 'object',
    properties: {
      modifiers: { type: 'integer', minimum: 0, maximum: 15 },
      steps: { type: 'integer', minimum: 2, maximum: 60 },
      waitTimeoutMs: { type: 'integer', minimum: 0, maximum: 120000 },
      // 视觉定位：用截图里的像素坐标当起点，位移也用图片像素表达。
      // 交给 CLI 换算成页面坐标，模型只需要"看图 → 报坐标"。
      capture: { type: 'string' },
      imageX: { type: 'integer' },
      imageY: { type: 'integer' },
      imageDx: { type: 'integer' },
      imageDy: { type: 'integer' },
      // 兼容目标 0.5.0 对齐：显式观察基线 + 鼠标键（strict/target 策略会消费 observation）。
      observationId: { type: 'string', minLength: 1 },
      button: { type: 'string', enum: ['left', 'middle', 'right'] },
      source: {},
      mode: { type: 'string', enum: ['press-move-release', 'click-move-click', 'hold'] },
      target: {},
      delta: {},
      holdMs: { type: 'integer', minimum: 0, maximum: 5000 },
      durationMs: { type: 'integer', minimum: 0, maximum: 5000 },
      timeoutMs: TIMEOUT_HINT,
    },
  },
  'transfer.begin': {
    type: 'object',
    required: ['name', 'byteSize'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 200 },
      byteSize: { type: 'integer', minimum: 1, maximum: 64 * MI_B },
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
    },
  },
  'transfer.chunk': {
    type: 'object',
    required: ['transferId', 'offset', 'dataBase64'],
    properties: {
      transferId: TRANSFER_ID,
      offset: { type: 'integer', minimum: 0 },
      dataBase64: { type: 'string', minLength: 1 },
    },
  },
  'transfer.finish': {
    type: 'object',
    required: ['transferId'],
    properties: { transferId: TRANSFER_ID },
  },
  'transfer.read': {
    type: 'object',
    required: ['transferId', 'offset'],
    properties: {
      transferId: TRANSFER_ID,
      offset: { type: 'integer', minimum: 0 },
      maxBytes: { type: 'integer', minimum: 1, maximum: MI_B },
    },
  },
  'transfer.release': {
    type: 'object',
    required: ['transferId'],
    properties: { transferId: TRANSFER_ID },
  },
  'session.control_status': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
    },
  },
  'session.claim_control': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      leaseMs: { type: 'integer', minimum: 1000, maximum: 600000 },
      expectEpoch: { type: 'integer', minimum: 0 },
    },
  },
  'session.release_control': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      expectEpoch: { type: 'integer', minimum: 0 },
    },
  },
  'session.handoff': {
    type: 'object',
    required: ['to'],
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      to: { type: 'string', minLength: 1 },
      leaseMs: { type: 'integer', minimum: 1000, maximum: 600000 },
      expectEpoch: { type: 'integer', minimum: 0 },
    },
  },
  'session.control_mode': {
    type: 'object',
    required: ['mode'],
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      mode: { type: 'string', enum: ['open', 'exclusive'] },
    },
  },
  plan: {
    type: 'object',
    required: ['steps'],
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      steps: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: {
          type: 'object',
          required: ['method'],
          properties: {
            method: { type: 'string', minLength: 1 },
            params: { type: 'object' },
          },
        },
      },
    },
  },
  extract: {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      maxRows: { type: 'integer', minimum: 1 },
      maxBytes: { type: 'integer', minimum: 1 },
      maxCells: { type: 'integer', minimum: 1 },
      maxColumns: { type: 'integer', minimum: 1 },
      cursor: { type: 'string', minLength: 1 },
    action: { type: 'string', enum: ['table', 'list', 'discover'] },
    targetId: { type: 'string', minLength: 1 },
    itemSelector: { type: 'string', minLength: 1 },
    fields: { type: 'array', items: { type: 'object' }, maxItems: 64 },
    timeoutMs: TIMEOUT_HINT,
    },
  },
  'extract.discover': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      maxTargets: { type: 'integer', minimum: 1 },
      previewColumns: { type: 'integer', minimum: 1 },
    },
  },
  'extract.table': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      frameId: { type: 'integer', minimum: 0 },
      target: { type: 'integer', minimum: 0 },
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      maxRows: { type: 'integer', minimum: 1 },
      maxBytes: { type: 'integer', minimum: 1 },
      maxCells: { type: 'integer', minimum: 1 },
      maxColumns: { type: 'integer', minimum: 1 },
      cursor: { type: 'string', minLength: 1 },
    },
  },
  'extract.list': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      frameId: { type: 'integer', minimum: 0 },
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      itemSelector: { type: 'string', minLength: 1 },
      maxRows: { type: 'integer', minimum: 1 },
      maxBytes: { type: 'integer', minimum: 1 },
      maxCells: { type: 'integer', minimum: 1 },
      maxColumns: { type: 'integer', minimum: 1 },
      cursor: { type: 'string', minLength: 1 },
    },
  },
  'longshot.recover': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      longshotId: { type: 'string', minLength: 1, maxLength: 128 },
      captureId: { type: 'string', minLength: 1, maxLength: 128 },
      // 兼容目标 tool.screenshot_full_page 的 timeout_ms 对应项（本方法经 daemon sendCommand 转发）。
      timeoutMs: TIMEOUT_HINT,
      scope: { type: 'string', enum: ['follow', 'current'] },
    },
  },
  'refs.negotiate': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      stableRef: { type: 'string', minLength: 1, maxLength: 128 },
      stableRefs: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 128 }, maxItems: 50 },
    },
  },
  upload: {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      target: { type: 'string', minLength: 1, maxLength: 512 },
      files: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 4096 }, minItems: 1, maxItems: 20 },
    },
    required: ['target', 'files'],
  },
  pdf: {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      printBackground: { type: 'boolean' },
      landscape: { type: 'boolean' },
      preferCssPageSize: { type: 'boolean' },
      paperWidth: { type: 'number', minimum: 0.1, maximum: 100 },
      paperHeight: { type: 'number', minimum: 0.1, maximum: 100 },
      pages: { type: 'string', maxLength: 64 },
      scale: { type: 'number', minimum: 0.1, maximum: 2 },
      margins: {
        type: 'object',
        properties: { top: { type: 'number', minimum: 0 }, right: { type: 'number', minimum: 0 }, bottom: { type: 'number', minimum: 0 }, left: { type: 'number', minimum: 0 } },
        additionalProperties: false,
      },
    },
  },
  screenshot: {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      ref: { type: 'string', minLength: 1 },
      selector: { type: 'string', minLength: 1 },
      scope: { type: 'string', enum: ['viewport', 'full', 'follow', 'current'] },
      fullPage: { type: 'boolean' },
      annotate: { type: 'boolean' },
      grid: { type: 'boolean' },
      gridStep: { type: 'integer', minimum: 10, maximum: 200 },
      scale: { type: 'number', minimum: 1, maximum: 8 },
      visualIndex: { type: 'integer', minimum: 1 },
      profile: { type: 'string', enum: ['x', 'y'] },
      format: { type: 'string', minLength: 1 },
      region: { type: 'object', required: ['x', 'y', 'width', 'height'] },
      stream: { type: 'boolean' },
      segmented: { type: 'boolean' },
      tileSize: { type: 'integer', minimum: 256, maximum: 8192 },
      staleAttempts: { type: 'integer', minimum: 1, maximum: 3 },
    },
  },
  'screenshot.read': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      captureId: { type: 'string', minLength: 1 },
      offset: { type: 'integer', minimum: 0 },
      length: { type: 'integer', minimum: 1, maximum: 4194304 },
    },
    required: ['captureId'],
  },
  'screenshot.release': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      captureId: { type: 'string', minLength: 1 },
    },
    required: ['captureId'],
  },
  'record.start': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      purpose: { type: 'string' },
      maxPageTokens: { type: 'integer', minimum: 1 },
      screenshots: { type: 'boolean' },
      includeAgent: { type: 'boolean' },
      url: { type: 'string' },
      redactValues: { type: 'boolean' },
      traceVersion: { type: 'integer', enum: [2, 3] },
      supportsTabSwitchSteps: { type: 'boolean' },
    },
  },
  'record.stop': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      // daemon sendCommand 的命令超时提示（兼容目标 tool.record_stop 无业务参数）。
      timeoutMs: TIMEOUT_HINT,
    },
  },
  'record.list': {
    type: 'object',
    properties: { session: SESSION_FIELD, sessionId: SESSION_FIELD, tabId: { type: 'integer', minimum: 0 } },
  },
  'trace.start': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      categories: { type: 'string', minLength: 1, maxLength: 512 },
    },
  },
  'trace.stop': {
    type: 'object',
    properties: { session: SESSION_FIELD, sessionId: SESSION_FIELD, tabId: { type: 'integer', minimum: 0 } },
  },
  'trace.status': {
    type: 'object',
    properties: { session: SESSION_FIELD, sessionId: SESSION_FIELD, tabId: { type: 'integer', minimum: 0 } },
  },
  'video.start': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      quality: { type: 'string' },
      encoder: { type: 'string', enum: ['avc'] },
      forceFrames: { type: 'boolean' },
      durationMs: { type: 'integer', minimum: 0 },
    },
  },
  'video.stop': {
    type: 'object',
    properties: { session: SESSION_FIELD, sessionId: SESSION_FIELD, tabId: { type: 'integer', minimum: 0 }, recording: { type: 'string' } },
  },
  'network.rule_add': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      rule: { type: 'object' },
    },
  },
};

// 其余扩展方法的显式 schema（覆盖门禁要求每个 EXT 方法都有条目）。
// 只声明确定存在的字段；未列出的字段会被 validator 忽略，避免误伤扩展侧参数。
const ENVELOPE_PROPS = envelopeProperties();
const TARGET_PROPS = {
  ref: { type: 'string', minLength: 1 },
  selector: { type: 'string', minLength: 1 },
  stableRef: { type: 'string', minLength: 1 },
  // 观测代数：给了就要求"动作发生在同一个 DOM 代数里"，页面在此期间变过则 E_OBSERVATION_CHANGED。
  expectRevision: { type: 'integer', minimum: 0 },
};
const withProps = (extra = {}, required = []) => ({
  type: 'object',
  properties: { ...ENVELOPE_PROPS, ...extra },
  ...(required.length ? { required } : {}),
});
const withTarget = (extra = {}, required = []) => withProps({ ...TARGET_PROPS, ...extra }, required);

Object.assign(METHOD_SCHEMAS, {
  // 导航族：扩展实现只消费 tabId，但 daemon sendCommand 会读 params.timeoutMs 抬高命令等待上限；
  // 兼容目标 NavigateBack/Forward/ReloadParams 的 timeout_ms 靠这个字段做机械对齐。
  reload: withProps({ timeoutMs: TIMEOUT_HINT }),
  'navigate-back': withProps({ timeoutMs: TIMEOUT_HINT }),
  'navigate-forward': withProps({ timeoutMs: TIMEOUT_HINT }),
  snapshot: withProps(),
  'observe-frames': withProps({
    maxTokens: { type: 'integer', minimum: 1, maximum: 20000 },
    maxDepth: { type: 'integer', minimum: 1, maximum: 100 },
    cursor: { type: 'string', minLength: 1, maxLength: 4096 },
    vom: { type: 'boolean' },
  }),
  actionable: withTarget(),
  blur: withTarget(),
  focus: withTarget(),
  'get-html': withTarget(),
  'scroll-to': withTarget(),
  'shadow.read': withTarget(),
  'shadow.click': withTarget({ text: { type: 'string' } }),
  upload: withTarget({ files: { type: 'array' }, paths: { type: 'array' }, mode: { type: 'string', enum: ['input', 'drop'] }, timeoutMs: TIMEOUT_HINT }),
  download: withTarget({ url: { type: 'string' }, out: { type: 'string' } }),
  'click-point': withProps({
    capture: { type: 'string' },
    imageX: { type: 'integer' },
    imageY: { type: 'integer' },
  }),
  'screenshot.manual.start': withProps(),
  'screenshot.manual.frame': withProps(),
  'screenshot.manual.save': withProps(),
  'tab.list': withProps({ scope: { type: 'string' } }),
  'tab.new': withProps({
    url: { type: 'string' },
    windowId: { type: 'integer', minimum: 0 },
    newWindow: { type: 'boolean' },
    focus: { type: 'boolean' },
    noFocus: { type: 'boolean' },
    incognito: { type: 'boolean' },
    readOnly: { type: 'boolean' },
    allowedOrigins: { type: 'string' },
  }),
  'tab.policy': withProps({
    readOnly: { type: 'boolean' },
    allowedOrigins: { type: 'string' },
    clear: { type: 'boolean' },
  }),
  'tab.alias': withProps({
    action: { type: 'string' },
    alias: { type: 'string' },
  }),
  'tab.cleanup': withProps({
    idleMs: { type: 'integer', minimum: 0 },
    dryRun: { type: 'boolean' },
  }),
  // tab.* 的关闭/激活/归还：扩展只消费 tabId；兼容目标 TabClose/TabSelect/TabReturnParams 也无业务字段，
  // 唯一可声明的公共参数是 daemon 消费的命令超时提示。
  'tab.close': withProps({ timeoutMs: TIMEOUT_HINT }),
  'tab.select': withProps({ timeoutMs: TIMEOUT_HINT }),
  'tab.borrow': withProps({
    // 兼容目标 BorrowConfirmationTimeout：显式借用确认超时（feature 门 borrow_confirmation_timeout）。
    confirmationTimeoutMs: { type: 'integer', minimum: 1, maximum: 600000 },
  }),
  'tab.return': withProps({ timeoutMs: TIMEOUT_HINT }),
  'tab.move': withProps({
    windowId: { type: 'integer', minimum: 0 },
    index: { type: 'integer', minimum: 0 },
  }),
  'window.list': withProps(),
  'window.close': withProps({ windowId: { type: 'integer', minimum: 0 } }),
  'window.focus': withProps({ windowId: { type: 'integer', minimum: 0 } }),
  'window.resize': withProps({
    width: { type: 'integer', minimum: 1 },
    height: { type: 'integer', minimum: 1 },
  }),
  'window.ensureAgent': withProps({ noFocus: { type: 'boolean' }, incognito: { type: 'boolean' }, focus: { type: 'boolean' } }),
  'window.newAgent': withProps({ noFocus: { type: 'boolean' }, incognito: { type: 'boolean' }, focus: { type: 'boolean' } }),
  'dialog.list': withProps(),
  // extension/src/dialogs.js:217 dialogStatus 直接复用 dialogList，因此也接受 clear（清空历史视图）。
  'dialog.status': withProps({ clear: { type: 'boolean' } }),
  'dialog.arm': withProps({
    alert: { type: 'string' },
    confirm: { type: 'string' },
    prompt: { type: 'string' },
    beforeUnload: { type: 'string' },
    promptText: { type: 'string' },
    queue: { type: 'boolean' },
  }),
  'dialog.disarm': withProps({}),
  'dialog.accept': withProps({ text: { type: 'string' } }),
  // extension/src/dialogs.js:227 dialogDismiss → dialogHandle：只认 id（accept 固定为 false）。
  'dialog.dismiss': withProps({ id: { type: 'integer', minimum: 1 } }),
  'dialog.handle': withProps({
    accept: { type: 'boolean' },
    dismiss: { type: 'boolean' },
    promptText: { type: 'string' },
  }),
  // extension/src/network.js:311 networkStart：bodies 采集正文、wsPayloadLimit 限制单帧负载。
  'network.start': withProps({
    bodies: { type: 'boolean' },
    wsPayloadLimit: { type: 'integer', minimum: 1 },
  }),
  'network.stop': withProps(),
  'network.list': withProps({
    filter: { type: 'object' },
    since: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1 },
  }),
  // extension/src/network.js:479 networkDetail 按 id 取单条记录。
  'network.detail': withProps({ id: { type: 'integer', minimum: 0 } }),
  'network.waterfall': {
    type: 'object',
    properties: {
      session: SESSION_FIELD,
      sessionId: SESSION_FIELD,
      tabId: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 2000 },
    },
  },
  // extension/src/network.js:554 networkReplay：request 直给请求描述，否则用 id 取已采集记录，overrides 覆盖字段。
  'network.replay': withProps({
    id: { type: 'integer', minimum: 0 },
    request: { type: 'object' },
    overrides: { type: 'object' },
  }),
  'debug.start': withProps({ name: { type: 'string' }, id: { type: 'string' }, bodies: { type: 'boolean' }, action: { type: 'string' }, runId: { type: 'string' }, since: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, part: { type: 'string' }, offset: { type: 'integer', minimum: 0, maximum: 65536 }, maxChars: { type: 'integer', minimum: 1, maximum: 16384 }, pointer: { type: 'string' }, rule: { type: 'object' }, replay: { type: 'object' }, budget: { type: 'integer', minimum: 4096, maximum: 262144 }, slowMs: { type: 'integer', minimum: 0, maximum: 60000 }, windowMs: { type: 'integer', minimum: 100, maximum: 10000 }, includeControlled: { type: 'boolean' }, url: { type: 'string' }, method: { type: 'string' }, resourceType: { type: 'string' }, status: { type: 'integer', minimum: 100, maximum: 599 }, state: { type: 'string' }, kind: { type: 'string' }, fields: { type: 'array', items: { type: 'string' } }, waitMs: { type: 'integer', minimum: 0, maximum: 60000 }, commandId: { type: 'string' } }),
  // extension/src/debug.js:419 debugStop 读取 trace / traceOrigin（CLI 之外的内嵌调用会用）。
  'debug.stop': withProps({ trace: { }, traceOrigin: { type: 'integer', minimum: 0 } }),
  // extension/src/debug.js:378 debugCurrent 读取 trace（对象或 JSON 字符串，故不限定单类型）。
  'debug.current': withProps({ trace: { } }),
  // extension/src/debug.js:583 debugRequest 只认 id（与兼容目标 DebugParams.id 同名可对齐）。
  'debug.request': withProps({ id: {}, name: { type: 'string' }, action: { type: 'string' }, runId: { type: 'string' }, since: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, part: { type: 'string' }, offset: { type: 'integer', minimum: 0, maximum: 65536 }, maxChars: { type: 'integer', minimum: 1, maximum: 16384 }, pointer: { type: 'string' }, rule: { type: 'object' }, replay: { type: 'object' }, budget: { type: 'integer', minimum: 4096, maximum: 262144 }, slowMs: { type: 'integer', minimum: 0, maximum: 60000 }, windowMs: { type: 'integer', minimum: 100, maximum: 10000 }, includeControlled: { type: 'boolean' }, url: { type: 'string' }, method: { type: 'string' }, resourceType: { type: 'string' }, status: { type: 'integer', minimum: 100, maximum: 599 }, state: { type: 'string' }, kind: { type: 'string' }, fields: { type: 'array', items: { type: 'string' } }, waitMs: { type: 'integer', minimum: 0, maximum: 60000 }, commandId: { type: 'string' } }),
  'debug.performance': withProps(),
  'debug.coverage': withProps(),
  'debug.history': withProps(),
  'debug.delete': withProps(),
  'debug.fetch_probe': withProps({ ms: { type: 'integer', minimum: 1 } }),
  'debug.pin': withProps(),
  'debug.pinned': withProps(),
  'debug.capabilities': withProps(),
  'debug.rule_add': withProps({ rule: { type: 'object' } }),
  'debug.rule_list': withProps(),
  'debug.rule_clear': withProps(),
  'debug.rule_enable': withProps({ id: { type: 'integer' } }),
  'debug.rule_disable': withProps({ id: { type: 'integer' } }),
  'debug.rule_remove': withProps({ id: { type: 'integer' } }),
  'debug.rule_export': withProps({ output: { type: 'string' } }),
  'debug.rule_import': withProps({ rules: { type: 'array' } }),
  // extension/src/video.js:109-115 budgetInputOf 读取 maxDurationMs/maxSegmentBytes/maxTotalBytes/
  // maxConcurrent；:323 durationMs；:298/:328 quality/encoder/forceFrames。
  // 兼容目标 tool.video 的 VideoParams::Start 只有 max_duration_ms/quality/request_id（行为级不同，参数面对齐 quality）。
  'video.start': withProps({
    durationMs: { type: 'integer', minimum: 0 },
    quality: { type: 'string' },
    encoder: { type: 'string', enum: ['avc'] },
    forceFrames: { type: 'boolean' },
    maxDurationMs: { type: 'integer', minimum: 1 },
    maxSegmentBytes: { type: 'integer', minimum: 1 },
    maxTotalBytes: { type: 'integer', minimum: 1 },
    maxConcurrent: { type: 'integer', minimum: 1 },
  }),
  'video.stop': withProps({ recording: { type: 'string' } }),
  'video.status': withProps({ recording: { type: 'string' } }),
  'video.list': withProps(),
  'video.fetch': withProps({ recording: { type: 'string' } }),
  'video.discard': withProps({ recording: { type: 'string' } }),
  'video.prune': withProps({ ttlMs: { type: 'integer', minimum: 0 } }),
  'video.recover': withProps(),
  'video.verify': withProps({ recording: { type: 'string' } }),
  // 兼容目标 tool.record_await 只带 timeout_ms（等待录制收敛）；本方法不阻塞，但同样接受
  // daemon sendCommand 的命令超时提示，参数面与兼容目标一致。
  'record.status': withProps({ timeoutMs: TIMEOUT_HINT }),
  'cooperate.sync': withProps({
    policy: { type: 'string' },
    probeHover: { type: 'boolean' },
    matchText: { type: 'string' },
    contextLines: { type: 'integer', minimum: 0 },
    // 兼容目标 CooperateParams.timeout_ms 的对应项（daemon sendCommand 消费）。
    timeoutMs: TIMEOUT_HINT,
  }),
  'cooperate.hold': withProps({ held: { type: 'boolean' } }),
  'cooperate.wait': withProps({ timeoutMs: { type: 'integer', minimum: 1 } }),
  'cooperate.handback': withProps(),
  'operation.await': withProps({
    // extension/src/dispatch.js:133 awaitOperation(params.id, params.timeoutMs)。
    id: { type: 'string', minLength: 1 },
    timeoutMs: { type: 'integer', minimum: 1 },
  }),
  // extension/src/dispatch.js:134-137 cancelWait(params.id) / cancelOperation(params.id)。
  'operation.cancel': withProps({ id: { type: 'string', minLength: 1 } }),
  'request-help': withProps({ reason: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1 } }),
  // extension/src/emulate.js 实际消费：reset / viewport{width,height,deviceScaleFactor,mobile} /
  // userAgent / acceptLanguage / platform / touch / timezone / locale / geolocation；
  // device/width/height/dpr/mobile/ua 是 0.3.0 已有的扁平写法（保持兼容，不删）。
  emulate: withProps({
    device: { type: 'string' },
    width: { type: 'integer', minimum: 1 },
    height: { type: 'integer', minimum: 1 },
    dpr: { type: 'number', minimum: 0 },
    mobile: { type: 'boolean' },
    ua: { type: 'string' },
    timezone: { type: 'string' },
    locale: { type: 'string' },
    geolocation: { type: 'object' },
    touch: { type: 'boolean' },
    reset: { type: 'boolean' },
    viewport: { type: 'object' },
    userAgent: { type: 'string' },
    acceptLanguage: { type: 'string' },
    platform: { type: 'string' },
  }),
  step: withProps({
    action: { type: 'object' },
    untilVisible: { type: 'string' },
    waitTimeoutMs: { type: 'integer', minimum: 0 },
    saveFull: { type: 'string' },
  }),
  'ui.open': withProps({ page: { type: 'string' }, query: { type: 'string' } }),
  'diagnostics.ui': withProps({ page: { type: 'string' } }),
  'control-hint': withProps({
    tabId: { type: 'integer', minimum: 0 },
    enabled: { type: 'boolean' },
  }),
  'debugger.detach': withProps({
    tabId: { type: 'integer', minimum: 0 },
  }),
  'debugger.simulate-detach': withProps({
    tabId: { type: 'integer', minimum: 0 },
  }),
});

// ---------------------------------------------------------------------------
// daemon 本地/控制面方法：0.3.0 里这些方法只走通用信封校验。这里按**现有实现**补最小参数契约
// （证据一律是 daemon/*.js 的 params.X 读取点），全部字段可选，默认调用参数面不变。
// owner=local 不要求 schema 覆盖，但补齐后 `bridge schema <method>` 与 daemon 入参校验对它们同样生效。
// ---------------------------------------------------------------------------
const REQUEST_TOKEN = { type: 'string', minLength: 1 };
const SESSION_START_EXTRAS = {
  controller: { type: 'object' },
  scope: { type: 'string' },
  requestId: REQUEST_TOKEN,
  browser: { type: 'string' },
  focus: { type: 'boolean' },
  noFocus: { type: 'boolean' },
  incognito: { type: 'boolean' },
  share: { type: 'boolean' },
  tab: { type: 'integer', minimum: 1 },
  allowDomains: { type: 'string' },
  denyDomains: { type: 'string' },
  minIntervalMs: { type: 'number', minimum: 0 },
  controlMode: { type: 'string' },
};

Object.assign(METHOD_SCHEMAS, {
  // 无业务参数的方法也显式登记最小契约（只含通用信封），避免“没有 schema”被误读成“还没取证”。
  // daemon/local-dispatch.js:14-15 browserList() 无参数；daemon/pairing.mjs:54 list() 无参数；
  // daemon/session-views.js:5 sessionList() 无参数。
  browsers: withProps(),
  'pair.list': withProps(),
  'session.list': withProps(),
  // daemon/status-views.js:29-68 parseStatusViews：views/view/doctor/limit/limitSessions/strategy。
  status: withProps({
    views: { },
    view: { type: 'string' },
    doctor: { type: 'boolean' },
    limit: { type: 'integer', minimum: 1 },
    limitSessions: { type: 'integer', minimum: 1 },
    strategy: { type: 'string' },
  }),
  // daemon/read-views.js:36-39 listAudit：limit/since。
  'audit.list': withProps({
    limit: { type: 'integer', minimum: 1, maximum: 500 },
    since: { type: 'number', minimum: 0 },
  }),
  // daemon/pairing.mjs:104-124 renew→deviceId；revoke→deviceId|code。
  'pair.renew': withProps({ deviceId: REQUEST_TOKEN }),
  'pair.revoke': withProps({ deviceId: REQUEST_TOKEN, code: { type: 'string', minLength: 1 } }),
  // daemon/local-trust.js:4-29 localPairCreate→replace；localTrustSet→strict。
  // daemon/local-trust.js:10 只做 `if (params.replace)` 的真值判断；CLI 历史路径会传字符串
  // （配对码/设备标记），因此这里只登记字段、不锁类型（锁 boolean 会误杀真实调用）。
  'local.pair': withProps({ replace: {} }),
  'local.trust': withProps({ strict: { type: 'boolean' } }),
  // daemon/session-start.js:9-137 startSession 消费的字段（controller/incognito 与兼容目标
  // tool.session_start 的 SessionStartParams 同名，可机械对齐）。
  'session.start': withProps(SESSION_START_EXTRAS),
  // daemon/local-dispatch.js:18-19 start_tracked = startSession({...params, requestId})。
  'session.start_tracked': withProps(SESSION_START_EXTRAS),
  // daemon/start-requests.js:17-38 prepare 额外记录启动偏好。
  'session.request_prepare': withProps({
    requestId: REQUEST_TOKEN,
    browser: { type: 'string' },
    focus: { type: 'boolean' },
    noFocus: { type: 'boolean' },
    incognito: { type: 'boolean' },
    tab: { type: 'integer', minimum: 1 },
  }),
  // daemon/start-requests.js:41-72 claim/cancel/status 只认 requestId。
  'session.request_claim': withProps({ requestId: REQUEST_TOKEN }),
  'session.request_cancel': withProps({ requestId: REQUEST_TOKEN }),
  'session.request_status': withProps({ requestId: REQUEST_TOKEN }),
  // daemon/session-stop.js:53/58/70 keep；daemon/session-admin.js:43 stop_all→sessionStop({keep})。
  'session.stop': withProps({ keep: { type: 'boolean' } }),
  'session.stop_all': withProps({ keep: { type: 'boolean' } }),
  // daemon/session-views.js:38-42 runLogView → session.runLog.snapshot({limit})。
  'session.run_log': withProps({ limit: { type: 'integer', minimum: 1 } }),
});

function valueType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function typeMatches(value, type) {
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return valueType(value) === type;
}

function checkValue(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(path + ' 应为 ' + schema.type);
    return;
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(path + ' 至少 ' + schema.minItems + ' 项');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(path + ' 最多 ' + schema.maxItems + ' 项');
    if (schema.items) value.forEach((item, index) => checkValue(item, schema.items, path + '[' + index + ']', errors));
  }
  if (schema.type === 'object' && valueType(value) === 'object') {
    for (const key of schema.required || []) {
      if (value[key] === undefined) errors.push(path + '.' + key + ' 缺失');
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (value[key] !== undefined) checkValue(value[key], child, path + '.' + key, errors);
    }
  }
  if (schema.minLength !== undefined && typeof value === 'string' && value.length < schema.minLength) {
    errors.push(path + ' 长度至少 ' + schema.minLength);
  }
  if (schema.maxLength !== undefined && typeof value === 'string' && value.length > schema.maxLength) {
    errors.push(path + ' 长度最多 ' + schema.maxLength);
  }
  if (schema.minimum !== undefined && typeof value === 'number' && value < schema.minimum) {
    errors.push(path + ' 不能小于 ' + schema.minimum);
  }
  if (schema.maximum !== undefined && typeof value === 'number' && value > schema.maximum) {
    errors.push(path + ' 不能大于 ' + schema.maximum);
  }
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errors.push(path + ' 格式不匹配 ' + schema.pattern);
  }
}

/** 返回 [] 表示通过，否则返回字段错误列表。 */
export function validateSchema(schema, value, path = 'params') {
  const errors = [];
  if (!schema) return errors;
  if (schema.type === 'object') {
    if (valueType(value) !== 'object') {
      errors.push(path + ' 应为 object');
      return errors;
    }
    for (const key of schema.required || []) {
      if (value[key] === undefined) errors.push(path + '.' + key + ' 缺失');
    }
    const props = schema.properties || {};
    for (const [key, child] of Object.entries(props)) {
      if (value[key] !== undefined) checkValue(value[key], child, path + '.' + key, errors);
    }
  } else {
    checkValue(value, schema, path, errors);
  }
  return errors;
}

export function validateMethodParams(method, params) {
  const schema = METHOD_SCHEMAS[method] || GENERIC_SCHEMA;
  if (!schema) return [];
  return validateSchema(schema, params && typeof params === 'object' ? params : {}, 'params');
}

// ---------------------------------------------------------------------------
// schema 单源派生（生成器与审计共用；不要在各处再手写一份 key/别名表）。
// ---------------------------------------------------------------------------

/** 请求公共信封键（来自目录）。 */
export const ENVELOPE_SCHEMA_KEYS = REQUEST_ENVELOPE_KEYS;

/** 生成物 METHOD_SCHEMA_KEYS 的唯一渲染源：方法 → {required, properties}。 */
export function buildSchemaKeyTable(schemas = METHOD_SCHEMAS) {
  const table = {};
  for (const [method, schema] of Object.entries(schemas)) {
    const properties = schema && schema.properties ? Object.keys(schema.properties).sort() : [];
    table[method] = {
      required: Array.isArray(schema && schema.required) ? [...schema.required].sort() : [],
      properties,
    };
  }
  return table;
}

/** camelCase → snake_case 参数别名（生成物 PARAM_ALIASES 的唯一渲染源）。 */
export function buildParamAliases(schemas = METHOD_SCHEMAS) {
  const aliases = {};
  for (const [method, schema] of Object.entries(schemas)) {
    const map = {};
    const properties = schema && schema.properties ? Object.keys(schema.properties).sort() : [];
    for (const key of properties) {
      const snake = key.replace(/[A-Z]/g, (char) => '_' + char.toLowerCase());
      if (snake !== key) map[snake] = key;
    }
    if (Object.keys(map).length) aliases[method] = map;
  }
  return aliases;
}

/** 方法 schema 覆盖与信封派生摘要（CLI/门禁/测试共用）。 */
export function schemaCoverageSummary(methods = EXTENSION_METHODS, schemas = METHOD_SCHEMAS) {
  const names = methods instanceof Set ? [...methods] : [...(methods || [])];
  const missing = names.filter((method) => !schemas[method]).sort();
  const present = names.filter((method) => schemas[method]);
  const withoutEnvelope = present.filter((method) => {
    const properties = (schemas[method] && schemas[method].properties) || {};
    return !REQUEST_ENVELOPE_KEYS.every((key) => key in properties);
  }).sort();
  const keyTable = buildSchemaKeyTable(schemas);
  const propertyCount = Object.values(keyTable).reduce((sum, row) => sum + row.properties.length, 0);
  return {
    methods: names.length,
    schemas: Object.keys(schemas).length,
    covered: present.length,
    missing,
    withoutEnvelope,
    validatedMethods: Object.keys(keyTable).length,
    propertyCount,
    aliasedMethods: Object.keys(buildParamAliases(schemas)).length,
    envelope: [...REQUEST_ENVELOPE_KEYS],
  };
}

/**
 * schema 漂移报告：覆盖、信封派生、字段类型、required 引用。
 * tools/schema-audit.mjs --check 与 tests/unit/protocol-* 共用同一份判定。
 */
export function schemaDriftReport(options = {}) {
  const methods = options.methods instanceof Set
    ? options.methods
    : new Set(options.methods || EXTENSION_METHODS);
  const schemas = options.schemas && typeof options.schemas === 'object' ? options.schemas : METHOD_SCHEMAS;
  const problems = [];
  let checked = 0;
  // schema 键必须对应协议目录里的方法（扩展方法必须全覆盖；owner=local 的方法允许可选覆盖）。
  // 目录外只允许调用方显式给 allowedExtraSchemas；默认口径下网络规则历史别名会被判漂移。
  const allowedExtra = new Set(options.allowedExtraSchemas || METHOD_NAMES);
  for (const method of [...methods].sort()) {
    const schema = schemas[method];
    if (!schema) { problems.push(method + ' 缺少 METHOD_SCHEMAS 条目'); continue; }
    if (schema.type !== 'object') problems.push(method + ' schema.type 不是 object');
    const properties = schema.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
      problems.push(method + ' schema.properties 缺失或类型错误');
      continue;
    }
    checked += 1;
    for (const [key, value] of Object.entries(properties)) {
      if (!key || typeof key !== 'string') problems.push(method + ' schema 存在空字段名');
      if (!value || typeof value !== 'object') problems.push(method + '.' + key + ' 属性不是对象');
    }
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!(key in properties)) problems.push(method + ' required 引用了未声明字段：' + key);
    }
  }
  const unknownSchemas = Object.keys(schemas)
    .filter((method) => !methods.has(method) && !allowedExtra.has(method))
    .sort();
  const summary = schemaCoverageSummary(methods, schemas);
  return {
    ok: problems.length === 0,
    methods: methods.size,
    schemas: Object.keys(schemas).length,
    checked,
    problems,
    unknownSchemas,
    derived: {
      schemaKeys: Object.keys(buildSchemaKeyTable(schemas)).length,
      paramAliases: Object.keys(buildParamAliases(schemas)).length,
      envelope: [...REQUEST_ENVELOPE_KEYS],
      missing: summary.missing,
      withoutEnvelope: summary.withoutEnvelope,
      propertyCount: summary.propertyCount,
    },
  };
}
