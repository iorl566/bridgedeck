// mcp/tools-m6b.mjs —— M6-P0②：MCP 剩余动作的直接入口（inspect html / assist / session 查询）。
//
// 背景（docs/兼容目标-DIFF-MATRIX.md ③b）：兼容目标 0.5.0 的 MCP 是 7 个粗粒度工具 + action 枚举，
// 这些动作在我方 MCP 面上只能经 browser_plan 或 CLI 间接调用，矩阵把它们记为 missing：
//   - inspect action=html          → 协议方法 get-html（inspect:html）
//   - assist action=emulate        → 协议方法 emulate（assist:emulate）
//   - assist action=request_help   → 协议方法 request-help（assist:request_help）
//   - assist action=operation_await→ 协议方法 operation.await（assist:operation_await）
//   - assist action=operation_cancel→协议方法 operation.cancel（assist:operation_cancel）
//   - session action=browsers      → daemon 本地方法 browsers（session:browsers）
//   - session action=list          → daemon 本地方法 session.list（session:list）
// 本文件只做“直连既有 RPC”的薄封装，不新增/不伪造任何 RPC 名称；既有 85 个工具的名字、
// 顺序、参数、输出都不变（这些工具追加在聚合表末尾，见 mcp/tools.mjs）。
//
// 兼容目标证据（ref/兼容目标-0.5.0-src/.../crates/兼容目标-cli/src/cli/mcp/tools.rs）：
//   - session action 枚举 Browsers/List（tools.rs:710-722）与分发（tools.rs:786-880）：
//     browsers → Method::BrowserList；list → Method::SessionList，两者都 only(arguments, …, &[])；
//   - inspect action=html（tools.rs:1123-1132）→ Method::ToolGetHtml（tools.rs:1225-1229），
//     参数 GetHtmlParams（ref/selector）/max_bytes；
//   - assist action 枚举（tools.rs:1853-1862）与分发（tools.rs:1915-2048）：
//     emulate → Method::ToolEmulate（width/height/device/mobile/off，tools.rs:1937-1986）、
//     request_help → Method::ToolRequestHelp（prompt/title/targets/completion_criteria/
//     timeout_ms，tools.rs:1987-1996）、operation_await/cancel → Method::ToolOperationAwait/
//     ToolOperationCancel（operation_id [+wait_ms]，tools.rs:2017-2042）；
//   - CLI 帮助（ref/兼容目标-0.5.0-bin/兼容目标.exe get-html|emulate|request-help|operation await|
//     operation cancel|browsers|session list --help）用作参数命名对照。
//
// 参数映射说明（逐条对齐兼容目标 help + 源码，差异都写在这里，不静默丢参）：
//   1) get-html：直接由规范 schema（lib/schemas.mjs）生成入参，ref/selector/stable_ref/
//      expect_revision 全部原样转发（ref 子树上限、max_bytes 截断由页面侧实现）。
//   2) emulate：兼容目标 MCP 动作只接受 width/height/device/mobile/off（tools.rs:1938-1951）；
//      我方规范 schema 暴露的是扁平字段（device/width/height/dpr/mobile/ua/timezone/locale/
//      geolocation/touch/reset）。运行时把扁平字段按 CLI `bridge emulate` 的同一套换算
//      （cli/commands/emulate.mjs:23-52）翻译成扩展真正读取的线上参数：
//        width/height/dpr/mobile → viewport{width,height,deviceScaleFactor,mobile}
//        ua → userAgent；device 预设 → viewport 默认值 + ua 默认值（DEVICE_PRESETS 单一来源）
//        touch/timezone/locale/geolocation/reset 原样转发（extension/src/emulate.js:28-156）。
//      兼容目标的 `off` 在我方协议里叫 `reset`（旧字段名沿用，语义相同：清除全部仿真）。
//   3) request-help：extend 实现读取 reason/tabId/timeoutMs/criteria
//      （extension/src/tabs-help.js:17-74），规范 schema 暴露 reason/timeout_ms；兼容目标的 prompt
//      ↔ reason（都把提示文案作为必填语义）、timeout_ms ↔ timeout_ms。criteria 是扩展已实现、
//      但规范 schema 尚未登记的扩展字段（完成条件，对应兼容目标 completion_criteria 的简化形态），
//      这里按“协议 schema 未声明的扩展字段”登记并原样转发（不假装支持兼容目标的 any/all/regex）。
//      title/targets 在我方 request-help 里没有实现，故不暴露（见 mcp/tool-contracts.mjs 的
//      unexposed 说明）。
//   4) operation.await/cancel：兼容目标字段名是 operation_id（+operation_await 的 wait_ms），而我方
//      实现（CLI/扩展）真实读取的是协议参数 id（cli/commands/cooperate.mjs:70-89、
//      extension/src/dispatch.js:133-137）。因此 MCP 统一暴露 operation_id，工具内部换算成 id
//      发送；timeout_ms 对应扩展的 await 等待预算（默认 10000，上限 300000，
//      extension/src/operations.js:34-54）。规范 schema 的 operation.await/cancel 正在由
//      task-53 补 id 字段（string, optional）；本工具兼容“schema 有 id 时透传 id”的形式，
//      无论补没补都不丢参。
//   5) browsers/session.list：daemon 本地方法（daemon/local-dispatch.js:14-15/34-35），两者都不
//      接受业务参数（兼容目标同样 only(arguments, …, &[])；实现分别返回 {browsers}/{sessions}）。
//      工具入参 schema 自适应：lib/schemas.mjs 若已登记该方法 schema 就按 schema 生成（新字段
//      必须是 optional，见 task-53 约定），否则给最小空对象 schema；这样 lib 侧补 schema 后
//      不会因“未覆盖协议参数”让 MCP 契约审计失败，也不需要改本文件。
//
// 审批分级：全部由 mcp/tool-policy.mjs 从协议方法 effect 派生（get-html/operation.await 是
// passive_read → read；emulate/request-help/operation.cancel 是 browser_mutation/control_plane
// → mutate；browsers/session.list 是 control_plane 只读查询，用 TIER_OVERRIDES 降为 read 并
// 写理由）。兼容目标把这 7 个动作所在的 assist/session 整工具标 destructive=true
// （tools.rs:105-108/192-195），我方按动作 effect 分级更细，与既有 browser_status 口径一致。

import { METHOD_SCHEMAS } from '../lib/schemas.mjs';
import { mcpInputSchema } from '../lib/mcp-schemas.mjs';
import { forwardProtocolArgs } from './tools-input.mjs';
import { ARG_ERROR_CODES, ToolArgumentError } from './tool-args.mjs';
import { DEVICE_PRESETS } from '../cli/commands/emulate.mjs';

/** 操作 id（被原生对话框/下载挂起的原始 operation）：兼容目标 assist 的 operation_id。 */
const OPERATION_ID_PROPERTY = Object.freeze({
  type: 'string',
  minLength: 1,
  description: '被原生对话框/下载挂起的原始 operation id（兼容目标 assist 的 operation_id；工具内部换算成协议参数 id）',
});

/** request-help 的完成条件（扩展已实现；兼容目标 completion_criteria 的简化形态）。 */
const HELP_CRITERIA_PROPERTY = Object.freeze({
  type: 'array',
  maxItems: 10,
  description: '可选完成条件数组：[{kind,selector,text}]；满足后自动视为人工完成并交还控制权（扩展原生 criteria 形态，不等于兼容目标 completion_criteria 的 any/all/regex）',
  items: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['selector_exists', 'selector_visible', 'text_exists', 'url_contains'] },
      selector: { type: 'string' },
      text: { type: 'string' },
    },
    required: ['kind'],
    additionalProperties: false,
  },
});

/** 统一构造 MCP 入参错误（E_ARG_* 分类，与 server 运行时校验同源）。 */
function argError(code, path, message) {
  return new ToolArgumentError([{ code, path, message }]);
}

/** 空对象 schema：daemon 本地全局查询（无业务参数，也不需要会话）。 */
const EMPTY_OBJECT_SCHEMA = Object.freeze({ type: 'object', properties: {}, additionalProperties: false });

/**
 * 规范化 emulate 入参 → 扩展真实读取的线上参数（与 cli/commands/emulate.mjs 同一换算）。
 * 只翻译扁平字段，不臆造协议字段；未知 device 预设直接拒绝（不静默忽略）。
 */
export function buildEmulateParams(args = {}) {
  const presetName = args.device !== undefined ? String(args.device) : '';
  const preset = presetName ? DEVICE_PRESETS[presetName] : null;
  if (presetName && !preset) {
    throw argError(
      ARG_ERROR_CODES.ENUM,
      'device',
      '未知 device 预设 "' + presetName + '"；可用：' + Object.keys(DEVICE_PRESETS).join('|'),
    );
  }
  const has = (name) => args[name] !== undefined;
  const params = {};
  const width = has('width') ? Number(args.width) : (preset ? preset.width : undefined);
  const height = has('height') ? Number(args.height) : (preset ? preset.height : undefined);
  if (width !== undefined || height !== undefined) {
    if (width === undefined || height === undefined) {
      throw argError(ARG_ERROR_CODES.MISSING, width === undefined ? 'width' : 'height', 'width 与 height 需要同时给（或改用 device 预设）');
    }
    const viewport = { width, height };
    const dpr = has('dpr') ? Number(args.dpr) : (preset ? preset.dpr : undefined);
    if (dpr !== undefined) {
      if (!Number.isFinite(dpr) || dpr < 0) throw argError(ARG_ERROR_CODES.RANGE, 'dpr', 'dpr 必须是非负数字');
      viewport.deviceScaleFactor = dpr;
    }
    viewport.mobile = has('mobile') ? args.mobile === true : Boolean(preset && preset.mobile);
    params.viewport = viewport;
  }
  const ua = has('ua') ? String(args.ua) : (preset ? preset.ua : '');
  if (ua) params.userAgent = ua;
  if (has('touch')) params.touch = args.touch === true;
  if (has('timezone')) params.timezone = String(args.timezone);
  if (has('locale')) params.locale = String(args.locale);
  if (has('geolocation')) {
    const location = args.geolocation;
    if (!location || typeof location !== 'object') throw argError(ARG_ERROR_CODES.TYPE, 'geolocation', 'geolocation 必须是 {latitude,longitude} 对象');
    const latitude = Number(location.latitude);
    const longitude = Number(location.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      throw argError(ARG_ERROR_CODES.TYPE, 'geolocation', 'geolocation 需要数字 latitude/longitude');
    }
    const applied = { latitude, longitude };
    if (location.accuracy !== undefined) applied.accuracy = Number(location.accuracy);
    params.geolocation = applied;
  }
  if (args.reset === true) {
    if (Object.keys(params).length) {
      throw argError(ARG_ERROR_CODES.UNEXPECTED, 'reset', 'reset 与其它仿真参数互斥（先 reset 再单独设置）');
    }
    params.reset = true;
  }
  if (!Object.keys(params).length) {
    throw argError(ARG_ERROR_CODES.MISSING, 'arguments', 'emulate 至少给一个参数：device/width+height/dpr/mobile/ua/touch/timezone/locale/geolocation/reset');
  }
  return params;
}

export function createM6bTools({ rpc, ensureSession, withSession }) {
  /** 会话级单方法工具：入参完全由规范 schema 生成，run 只做一次协议转发。 */
  function sessionTool(method, tool) {
    return {
      ...tool,
      inputSchema: mcpInputSchema(method, { omit: ['sessionId', 'tabId'] }),
      async run(args) {
        const sessionId = await ensureSession(args);
        return rpc(method, withSession(sessionId, forwardProtocolArgs(method, args)));
      },
    };
  }

  /**
   * daemon 本地全局查询工具（browsers / session.list）：不需要会话，也没有业务参数。
   * 入参 schema 自适应 lib/schemas.mjs：已登记 schema 时按 schema 生成（覆盖未来新增的
   * optional 字段），未登记时用最小空对象 schema。run 只转发 schema 声明过的参数。
   */
  function globalQueryTool(method, tool) {
    const schemaBacked = Boolean(METHOD_SCHEMAS[method]);
    return {
      ...tool,
      inputSchema: schemaBacked
        ? mcpInputSchema(method, { omit: ['sessionId', 'tabId'] })
        : { ...EMPTY_OBJECT_SCHEMA },
      async run(args) {
        return rpc(method, forwardProtocolArgs(method, args));
      },
    };
  }

  /** operation.await/cancel 的共用实现：operation_id 换算成协议参数 id。 */
  function operationTool(method, tool, { waiting = false } = {}) {
    return {
      ...tool,
      inputSchema: mcpInputSchema(method, {
        omit: ['sessionId', 'tabId'],
        extra: { operation_id: OPERATION_ID_PROPERTY },
      }),
      async run(args) {
        const sessionId = await ensureSession(args);
        const params = forwardProtocolArgs(method, args);
        // operation_id 是兼容目标字段名；协议线上字段是 id（cli/commands/cooperate.mjs 同款）。
        const operationId = args.operation_id !== undefined ? String(args.operation_id) : (params.id !== undefined ? String(params.id) : '');
        if (!operationId) {
          throw argError(ARG_ERROR_CODES.MISSING, 'operation_id', '需要 operation_id（被原生对话框/下载挂起的原始 operation id）');
        }
        params.id = operationId;
        if (!waiting) {
          return rpc(method, withSession(sessionId, params), 90_000);
        }
        // 等待预算：扩展默认 10000ms、上限 300000ms（extension/src/operations.js:34-54）。
        const budget = Number(params.timeoutMs);
        const waitMs = Number.isFinite(budget) && budget > 0 ? Math.min(Math.max(Math.round(budget), 1_000), 300_000) : 10_000;
        params.timeoutMs = waitMs;
        return rpc(method, withSession(sessionId, params), waitMs + 10_000);
      },
    };
  }

  const TOOLS = [
    sessionTool('get-html', {
      name: 'browser_inspect_html',
      description: '取原始 HTML（可限 ref 子树；ref/selector 二选一）。对应 兼容目标 inspect action=html（GetHtmlParams）。',
    }),
    {
      name: 'browser_assist_emulate',
      description: '设备/环境仿真：device 预设（iphone-14/pixel-7/ipad-mini 等）或 width+height(+dpr/mobile) 视口覆盖，可叠加 ua/touch/timezone/locale/geolocation；reset 清除全部仿真。对应 兼容目标 assist action=emulate。',
      // 线上字段 viewport/userAgent/acceptLanguage/platform 由 buildEmulateParams 从扁平参数
      // 生成（与 CLI 同一换算），不作为 MCP 入参；契约里登记为 unexposed（见 tool-contracts.mjs）。
      inputSchema: mcpInputSchema('emulate', {
        omit: ['sessionId', 'tabId', 'viewport', 'userAgent', 'acceptLanguage', 'platform'],
      }),
      async run(args) {
        const sessionId = await ensureSession(args);
        return rpc('emulate', withSession(sessionId, buildEmulateParams(args)), 120_000);
      },
    },
    {
      name: 'browser_assist_request_help',
      description: '请求人工协助（登录/验证码/确认）：在任务标签页显示提示并等待用户完成；reason 必填，可带 timeout_ms 与 criteria 完成条件。对应 兼容目标 assist action=request_help（prompt→reason）。',
      inputSchema: mcpInputSchema('request-help', {
        omit: ['sessionId', 'tabId'],
        extra: { criteria: HELP_CRITERIA_PROPERTY },
        required: ['reason'],
      }),
      async run(args) {
        const sessionId = await ensureSession(args);
        const params = forwardProtocolArgs('request-help', args);
        if (Array.isArray(args.criteria)) params.criteria = args.criteria;
        // 扩展的等待窗口：默认 180s、夹在 [5s, 600s]（extension/src/tabs-help.js:25-26）。
        const raw = Number(params.timeoutMs);
        const timeoutMs = Number.isFinite(raw) && raw > 0 ? Math.min(Math.max(Math.round(raw), 5_000), 600_000) : 180_000;
        params.timeoutMs = timeoutMs;
        return rpc('request-help', withSession(sessionId, params), timeoutMs + 10_000);
      },
    },
    operationTool('operation.await', {
      name: 'browser_assist_operation_await',
      description: '取回被原生对话框/下载挂起的原始操作结果（绝不重复执行原动作）。operation_id 必填，可带 timeout_ms 等待预算（默认 10000，≤300000）。对应 兼容目标 assist action=operation_await。',
    }, { waiting: true }),
    operationTool('operation.cancel', {
      name: 'browser_assist_operation_cancel',
      description: '取消挂起的原始操作并拒绝其待处理弹窗（不重复执行原动作）。operation_id 必填。对应 兼容目标 assist action=operation_cancel。',
    }),
    globalQueryTool('browsers', {
      name: 'browser_session_browsers',
      description: '列出已连接的浏览器实例（instanceId/label/浏览器/版本/localAuth）。对应 兼容目标 session action=browsers（Method::BrowserList）。',
    }),
    globalQueryTool('session.list', {
      name: 'browser_session_list',
      description: '列出当前活跃会话（sessionId/tabId/状态/归属）。对应 兼容目标 session action=list（Method::SessionList）。',
    }),
  ];
  return TOOLS;
}
