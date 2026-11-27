// packages/protocol/src/index.ts —— TypeScript 协议单源包的公共入口。
//
// 使用方式：
//   import { METHOD_COUNT, MethodName, FEATURE_FLOORS, methodState,
//            assertProtocolCompatible, protocolGate } from '@bridge-deck/protocol';
// 本包不含任何运行时依赖：生成物是纯数据，其余模块是纯函数，可在 daemon / CLI /
// 扩展 / 测试里同样使用。
//
// 导出面按语义分组（生成物、错误、版本、特性门、状态、闸门），生成物永远来自
// `node packages/protocol/scripts/gen.mjs`，手写模块不重复声明数据。

export * from './types.ts';
export * from './schema-types.ts';
export * from './generated.ts';
export * from './generated-schemas.ts';
export * from './errors.ts';
export * from './version.ts';
export * from './features.ts';
export * from './state.ts';
export * from './gate.ts';
export * from './schema.ts';
