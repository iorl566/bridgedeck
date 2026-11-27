// mcp/tools-input.mjs —— M6-P0①：兼容目标 MCP 输入/导航/观测动作的直接工具入口。
//
// 背景（docs/兼容目标-DIFF-MATRIX.md ③b）：兼容目标 0.5.0 的 MCP 是 7 个粗粒度工具 + action 枚举；
// press/hover/select/drag/scroll_to/wheel/focus/blur、page 的 back/forward/reload、inspect 的
// console 在我方 MCP 面上只能经 browser_plan(steps=[...]) 间接触达，矩阵把它们记为 missing。
// 本文件给这些动作各注册一个直接入口，参数沿用我方协议方法的规范 schema
// （lib/schemas.mjs，经 lib/mcp-schemas.mjs 生成 snake_case 入参），审批分级由
// mcp/tool-policy.mjs 从协议 effect 派生，因此与既有 click/fill 等工具同一口径。
//
// 兼容目标 对齐（证据：兼容目标 MCP 工具表）：
//   - interact action 枚举 press/hover/select/drag/scroll_to/wheel/focus/blur（tools.rs:1303-1315）；
//   - page action 枚举 back/forward/reload（tools.rs:990-997）；
//   - inspect action 枚举 console（tools.rs:1123-1132）；
//   - 兼容目标 把整个 interact / page 标 destructive（tools.rs:150-153/178-181）；我方按动作
//     effect 分级更细（输入/导航 = mutate，evaluate 才是 destructive），见报告 D 节的差异说明。
//
// 参数映射：MCP snake_case → 协议 camelCase 用 lib/mcp-schemas.mjs 的 snakeName 反解，
// 与 mcp/schema-audit.mjs 的审计口径同源；协议 schema 没声明、但扩展页面处理器真实读取的
// 字段（wheel 的 ref/selector、drag 的 source/target/delta/mode/hold_ms）在此显式换算成
// 协议参数（from/to/dx/dy/mode/holdMs），并在 mcp/tool-contracts.mjs 里按“本地扩展参数”
// 登记理由（不静默丢参，也不假装协议 schema 支持）。

import { METHOD_SCHEMAS } from '../lib/schemas.mjs';
import { mcpInputSchema, snakeName } from '../lib/mcp-schemas.mjs';

/** 工具统一注入/透传的信封参数，不进入协议参数体。 */
const ENVELOPE_ARGS = new Set(['session', 'session_id', 'tab_id']);

/** 协议方法的 snake_case 入参 → 协议 camelCase 参数名（由规范 schema 反推，不手抄）。 */
function protocolNameTable(method) {
  const table = {};
  const schema = METHOD_SCHEMAS[method];
  for (const camel of Object.keys((schema && schema.properties) || {})) table[snakeName(camel)] = camel;
  return table;
}

/**
 * 把 MCP 入参转成协议参数体：只转发 schema 声明过的字段（信封字段由 withSession 注入）。
 * @param {string} method 协议方法名
 * @param {object} args MCP 入参
 * @param {{aliases?: Record<string,string>, skip?: string[]}} [options]
 */
export function forwardProtocolArgs(method, args, { aliases = {}, skip = [] } = {}) {
  const table = protocolNameTable(method);
  const skipped = new Set(skip);
  const params = {};
  for (const [name, value] of Object.entries(args || {})) {
    if (value === undefined) continue;
    if (ENVELOPE_ARGS.has(name) || skipped.has(name)) continue;
    const target = aliases[name] || table[name];
    if (target) params[target] = value;
  }
  return params;
}

/** 目标定位参数（ref / @eN / selector 字符串），MCP 侧统一用字符串表达。 */
const TARGET_PROPERTY = Object.freeze({ type: 'string', minLength: 1, description: '目标：@eN ref 或主文档 CSS selector' });

/** drag 的 delta 参数（兼容目标 interact params.delta = {x, y}）。 */
const DELTA_PROPERTY = Object.freeze({
  type: 'object',
  description: '位移 { x, y }（相对起点，单位 CSS px）',
  properties: { x: { type: 'number' }, y: { type: 'number' } },
  required: ['x', 'y'],
  additionalProperties: false,
});

export function createInputTools({ rpc, ensureSession, withSession }) {
  /** 单方法工具：入参完全由规范 schema 生成，run 只做一次协议转发。 */
  function single(method, tool) {
    return {
      ...tool,
      inputSchema: mcpInputSchema(method, { omit: ['sessionId', 'tabId'] }),
      async run(args) {
        const sessionId = await ensureSession(args);
        return rpc(method, withSession(sessionId, forwardProtocolArgs(method, args)));
      },
    };
  }

  const TOOLS = [
    single('press', {
      name: 'browser_press',
      description: '按键（键盘）：key 必填（Enter/a/Ctrl+A 这类组合键），可先用 ref/selector 聚焦目标。对应 兼容目标 interact action=press。',
    }),
    single('hover', {
      name: 'browser_hover',
      description: '悬停到元素（ref 或 CSS selector），用于展开 hover-only 菜单。对应 兼容目标 interact action=hover。',
    }),
    single('select', {
      name: 'browser_select',
      description: '在 select 元素上选择选项（ref 或 CSS selector + value）。对应 兼容目标 interact action=select（兼容目标 用 values 数组，我方协议是单值 value）。',
    }),
    {
      name: 'browser_drag',
      description: '拖拽：source 起点 + target 终点，或 source + delta {x,y} 相对位移；可带 mode(hold|click-move-click)/hold_ms。对应 兼容目标 interact action=drag。',
      inputSchema: mcpInputSchema('drag', {
        omit: ['sessionId', 'tabId'],
        extra: {
          source: TARGET_PROPERTY,
          target: TARGET_PROPERTY,
          delta: DELTA_PROPERTY,
          mode: { type: 'string', enum: ['hold', 'click-move-click'], description: '拖拽模式（默认 hold）' },
          hold_ms: { type: 'integer', minimum: 0, maximum: 5000, description: '按住后保持多久再移动（毫秒）' },
        },
      }),
      async run(args) {
        const sessionId = await ensureSession(args);
        const params = forwardProtocolArgs('drag', args, {
          skip: ['source', 'target', 'delta', 'mode', 'hold_ms'],
        });
        if (args.source !== undefined) params.from = String(args.source);
        if (args.target !== undefined) params.to = String(args.target);
        if (args.delta && typeof args.delta === 'object') {
          if (args.delta.x !== undefined) params.dx = Number(args.delta.x);
          if (args.delta.y !== undefined) params.dy = Number(args.delta.y);
        }
        if (args.mode !== undefined) params.mode = String(args.mode);
        if (args.hold_ms !== undefined) params.holdMs = Number(args.hold_ms);
        return rpc('drag', withSession(sessionId, params));
      },
    },
    single('scroll-to', {
      name: 'browser_scroll_to',
      description: '把元素滚动到视口内（ref 或 CSS selector）。对应 兼容目标 interact action=scroll_to。',
    }),
    {
      name: 'browser_wheel',
      description: '滚轮滚动（delta_x/delta_y，可先用 ref/selector 指定滚动落点）。对应 兼容目标 interact action=wheel。',
      inputSchema: mcpInputSchema('wheel', {
        extra: { ref: TARGET_PROPERTY, selector: TARGET_PROPERTY },
      }),
      async run(args) {
        const sessionId = await ensureSession(args);
        return rpc('wheel', withSession(sessionId, forwardProtocolArgs('wheel', args, {
          aliases: { ref: 'ref', selector: 'selector' },
        })));
      },
    },
    single('focus', {
      name: 'browser_focus',
      description: '聚焦元素（ref 或 CSS selector）。对应 兼容目标 interact action=focus。',
    }),
    single('blur', {
      name: 'browser_blur',
      description: '让当前焦点元素失焦（可指定 ref/selector）。对应 兼容目标 interact action=blur。',
    }),
    single('reload', {
      name: 'browser_reload',
      description: '刷新当前任务标签页。对应 兼容目标 page action=reload；兼容目标 的 hard 参数我方协议未实现，不暴露。',
    }),
    single('navigate-back', {
      name: 'browser_back',
      description: '历史后退。对应 兼容目标 page action=back。',
    }),
    single('navigate-forward', {
      name: 'browser_forward',
      description: '历史前进。对应 兼容目标 page action=forward。',
    }),
    single('console', {
      name: 'browser_console',
      description: '读取捕获的控制台条目（since 游标续读、limit 上限）。对应 兼容目标 inspect action=console。',
    }),
  ];
  return TOOLS;
}
