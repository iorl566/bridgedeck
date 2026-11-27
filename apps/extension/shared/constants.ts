/** 协议与扩展共享常量（架构路线 TS 栈）。数值必须与 0.3.0 JS 栈一致。 */
export const PROTOCOL_VERSION = '1.9' as const;
export const EXTENSION_NAME = 'BridgeDeck' as const;
export const DEFAULT_DAEMON_PORT = 52900 as const;
/** 已实现的 canonical 方法数（0.3.0 口径）；M-B 起由 packages/protocol 单源生成。 */
export const CANONICAL_METHOD_COUNT = 165 as const;
export const MCP_TOOL_COUNT = 67 as const;
