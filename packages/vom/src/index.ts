// packages/vom/src/index.ts —— VOM TypeScript 包的公共入口。
//
// 九个纯函数模块与 extension/src/lib/vom-*.js 逐字段等价，类型定义分模块集中：
//   affordance / layers / rows           ← vom-affordance.js / vom-layers.js / vom-rows.js
//   relations / frame-relations          ← vom-relations.js / vom-frame-relations.js
//   context / compress / query / tokens  ← vom-context.js / vom-compress.js / vom-query.js / vom-weights.js
// 包内无运行时依赖，可在扩展、daemon、测试里复用。
//
//   import { affordanceForNode, deriveLayers, normalizeRowAnchor } from '@bridge-deck/vom';
//   import { buildVomRelationGraph, queryVomRelations } from '@bridge-deck/vom';

export * from './types.ts';
export * from './relation-types.ts';
export * from './context-types.ts';
export * from './compress-types.ts';
export * from './query-types.ts';
export * from './tokens.ts';
export * from './affordance.ts';
export * from './layers.ts';
export * from './rows.ts';
export * from './graph.ts';
export * from './frame-vom.ts';
export * from './color.ts';
export * from './frame-relations.ts';
export * from './relations.ts';
export * from './context.ts';
export * from './compress.ts';
export * from './query.ts';
