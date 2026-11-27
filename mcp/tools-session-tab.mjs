// mcp/tools-session-tab.mjs —— M6-P0①：tracked session 启动请求 + tab 借用/归还的直接工具入口。
//
// 背景（docs/兼容目标-DIFF-MATRIX.md ③b）：兼容目标 0.5.0 的 session 有
// request_prepare/request_status/request_claim/request_cancel 四个动作，tabs 有
// borrow/return 两个动作；我方协议方法都有（session.request_* / tab.borrow / tab.return），
// 但 MCP 面没有入口，矩阵记为 missing/P0。本文件只做“直连既有 RPC”的薄封装：
//   - session.request_* 是 daemon 本地方法（daemon/local-dispatch.js:20-27），没有
//     METHOD_SCHEMAS 规范 schema，因此入参在 mcp/tool-contracts.mjs 里按 schemaless 登记；
//   - prepare 缺 request_id 时按 兼容目标 的行为生成 `<expiry-unix-ms>:<id>`（tools.rs:887-897），
//     生成器复用 lib/start-journal.mjs 的 createStartToken（TTL 5 分钟，同 daemon 上限 10 分钟）；
//   - tab.borrow / tab.return 由扩展侧校验 tabId（extension/src/tabs-borrow.js:36/164），
//     借用确认沿用既有 borrowGate（不绕过确认闸门）。
//
// 兼容目标 证据：
//   - session action 枚举（tools.rs:710-722）与 request_* 分发（tools.rs:882-913）；
//   - tabs 工具描述里的 borrow/return（tools.rs:172-182）+ tabs.rs 的 TabBorrowParams；
//   - 审批分级：tab 借用/归还在 兼容目标 属于 tabs（destructive:true，tools.rs:178-181）；我方按
//     协议 effect（browser_mutation）落 mutate —— 借用是“用户确认后接管、可归还”的可恢复变更，
//     与 browser_tab_close（destructive）区分，见报告 D 节。

import { mcpInputSchema } from '../lib/mcp-schemas.mjs';
import { createStartToken } from '../lib/start-journal.mjs';

/** 可恢复启动请求 token 的说明（与 lib/start-journal.mjs 的 normalizeStartToken 对齐）。 */
const REQUEST_ID_DESCRIPTION = '可恢复启动请求 token：<expiry-unix-ms>:<8-80 位 id>（过期时间不超过 10 分钟）';

/** 四个 request_* 动作里 status/claim/cancel 的共用 schema（只有 request_id 必填）。 */
const REQUEST_ONLY_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    request_id: { type: 'string', description: REQUEST_ID_DESCRIPTION },
    session: { type: 'string' },
  },
  required: ['request_id'],
  additionalProperties: false,
});

export function createSessionTabTools({ rpc, state = {} }) {
  const TOOLS = [
    {
      name: 'browser_session_request_prepare',
      description: '预登记可恢复的 session 启动请求（不创建窗口）。request_id 省略时自动生成并随结果返回；拿到 ready 后再 start/claim。对应 兼容目标 session action=request_prepare。',
      inputSchema: {
        type: 'object',
        properties: {
          request_id: { type: 'string', description: REQUEST_ID_DESCRIPTION },
          browser: { type: 'string', description: '目标浏览器实例 id 或唯一标签' },
          no_focus: { type: 'boolean', description: 'prepare：不要在启动时置前窗口' },
          incognito: { type: 'boolean', description: 'prepare：使用无痕 Agent 窗口' },
          session: { type: 'string' },
        },
        additionalProperties: false,
      },
      async run(args) {
        const generated = !args.request_id;
        const params = { requestId: args.request_id ? String(args.request_id) : createStartToken() };
        if (args.browser) params.browser = String(args.browser);
        if (args.no_focus === true) params.noFocus = true;
        if (args.incognito === true) params.incognito = true;
        const result = await rpc('session.request_prepare', params, 40000);
        // 自动生成的 token 回填到进程状态，方便同一 MCP 进程里接着调用 claim/cancel。
        if (generated && result && result.requestId && state) state.startRequestId = result.requestId;
        return result;
      },
    },
    {
      name: 'browser_session_request_status',
      description: '查询 tracked session 启动请求的状态（prepared/starting/ready/claimed/cancelled/failed）。对应 兼容目标 session action=request_status。',
      inputSchema: REQUEST_ONLY_SCHEMA,
      async run(args) {
        return rpc('session.request_status', { requestId: String(args.request_id) }, 40000);
      },
    },
    {
      name: 'browser_session_request_claim',
      description: '认领已就绪的启动请求（ready/claimed → claimed）。对应 兼容目标 session action=request_claim。',
      inputSchema: REQUEST_ONLY_SCHEMA,
      async run(args) {
        return rpc('session.request_claim', { requestId: String(args.request_id) }, 40000);
      },
    },
    {
      name: 'browser_session_request_cancel',
      description: '取消启动请求并留下墓碑（starting 进行中会拒绝，稍后用 status 查询）。对应 兼容目标 session action=request_cancel。',
      inputSchema: REQUEST_ONLY_SCHEMA,
      async run(args) {
        return rpc('session.request_cancel', { requestId: String(args.request_id) }, 40000);
      },
    },
    {
      name: 'browser_tab_borrow',
      description: '借用用户标签页到 Agent 窗口：需要用户确认（borrow-confirm 闸门，未确认前对该 tab 的动作会被拒绝）。对应 兼容目标 tabs action=borrow。',
      inputSchema: mcpInputSchema('tab.borrow', {
        omit: ['sessionId', 'tabId'],
        required: ['tab_id'],
        extra: { tab_id: { type: 'integer', minimum: 1, description: '要借用的标签页 id（browser_tabs 返回的 tabId）' } },
      }),
      async run(args) {
        return rpc('tab.borrow', { tabId: Number(args.tab_id) }, 90000);
      },
    },
    {
      name: 'browser_tab_return',
      description: '归还借用的标签页（只清标记与控制权，不移动也不关闭标签页）。对应 兼容目标 tabs action=return。',
      inputSchema: mcpInputSchema('tab.return', {
        omit: ['sessionId', 'tabId'],
        required: ['tab_id'],
        extra: { tab_id: { type: 'integer', minimum: 1, description: '要归还的标签页 id（browser_tabs 返回的 tabId）' } },
      }),
      async run(args) {
        return rpc('tab.return', { tabId: Number(args.tab_id) }, 90000);
      },
    },
  ];
  return TOOLS;
}
