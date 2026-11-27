// mcp/tools.mjs —— MCP 工具表聚合。
import { createCoreATools } from './tools-core-a.mjs';
import { createCoreBTools } from './tools-core-b.mjs';
import { createDebugATools } from './tools-debug-a.mjs';
import { createDebugBTools } from './tools-debug-b.mjs';
// M6-P0①：MCP 直接动作入口（press/hover/select/drag/scroll_to/wheel/focus/blur、
// back/forward/reload/console、session.request_*、tab borrow/return）。追加在既有 67 个
// 工具之后，保证既有工具名/顺序/参数/输出不变。
import { createInputTools } from './tools-input.mjs';
import { createSessionTabTools } from './tools-session-tab.mjs';
// M6-P0②：MCP 剩余动作入口（inspect html / assist emulate+request_help+operation.* /
// session browsers+list）。同样追加在既有工具之后，保证既有工具名/顺序/参数/输出不变。
import { createM6bTools } from './tools-m6b.mjs';

export function createBrowserTools(ctx) {
  return [
    ...createCoreATools(ctx),
    ...createCoreBTools(ctx),
    ...createDebugATools(ctx),
    ...createDebugBTools(ctx),
    ...createInputTools(ctx),
    ...createSessionTabTools(ctx),
    ...createM6bTools(ctx),
  ];
}
