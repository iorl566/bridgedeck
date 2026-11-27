// packages/protocol/src/schema-types.ts —— 方法参数 schema 的结构类型（手工维护，不含数据）。
//
// 数据单源在 lib/schemas.mjs；packages/protocol/scripts/gen.mjs 把它投影成
// src/generated-schemas.ts（METHOD_SCHEMAS / METHOD_SCHEMA_KEYS / PARAM_ALIASES /
// ENVELOPE_* / SCHEMA_COVERAGE）。本文件只声明类型，且**不 import 生成物**，因此生成物
// 可以单向 import 本文件而不产生类型环：generated-schemas.ts -> schema-types.ts。
//
// 类型面刻意与 lib/schemas.mjs 的最小 validator 一一对应：
// - 只声明 validator 真正读取的关键字（type/properties/required/items/长度/范围/枚举/pattern）；
// - 不引入 JSON Schema 全量类型（会与运行期语义脱节，也会把“没实现的关键字”伪装成支持）；
// - 额外关键字（如 additionalProperties）允许出现，但 validator 不解释它们。

/** validator 认识的基础类型。 */
export type JsonSchemaType = 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'null';

/**
 * lib/schemas.mjs 的最小 JSON Schema 投影。
 * 注意：validator 只按 `type` 分派，未列出的关键字不参与校验（与 JS 基线一致）。
 */
export interface JsonSchema {
  readonly type?: JsonSchemaType;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly pattern?: string;
  readonly enum?: readonly string[];
  /** 仅记录语义，validator 不解释（与 JS 基线一致）。 */
  readonly additionalProperties?: boolean;
}

/** 方法 schema 的 key 表行：required 与 properties 均已排序。 */
export interface SchemaKeyRow {
  readonly required: readonly string[];
  readonly properties: readonly string[];
}

/** schema 覆盖摘要（生成时快照）。 */
export interface SchemaCoverageSummary {
  /** 扩展方法总数（EXTENSION_METHODS）。 */
  readonly methods: number;
  /** 有显式 schema 的方法数。 */
  readonly schemas: number;
  /** 被覆盖的扩展方法数。 */
  readonly covered: number;
  /** 缺 schema 的扩展方法（排序）。 */
  readonly missing: readonly string[];
  /** 缺公共信封字段的扩展方法（排序）。 */
  readonly withoutEnvelope: readonly string[];
  /** 进入 key 表的方法数。 */
  readonly validatedMethods: number;
  /** key 表字段总数。 */
  readonly propertyCount: number;
  /** 有别名映射的方法数。 */
  readonly aliasedMethods: number;
  /** 公共信封键（目录派生）。 */
  readonly envelope: readonly string[];
}

/** schema 漂移报告（与 lib/schemas.mjs 的 schemaDriftReport 逐字段一致）。 */
export interface SchemaDriftReport {
  readonly ok: boolean;
  readonly methods: number;
  readonly schemas: number;
  readonly checked: number;
  readonly problems: readonly string[];
  readonly unknownSchemas: readonly string[];
  readonly derived: {
    readonly schemaKeys: number;
    readonly paramAliases: number;
    readonly envelope: readonly string[];
    readonly missing: readonly string[];
    readonly withoutEnvelope: readonly string[];
    readonly propertyCount: number;
  };
}

/** schemaDriftReport 的可选入参（测试/审计可换方法集或 schema 副本）。 */
export interface SchemaDriftOptions {
  /** 参与覆盖检查的方法集合；省略则用 EXTENSION_METHODS。 */
  readonly methods?: ReadonlySet<string> | readonly string[];
  /** schema 副本（省略则用生成本身的 METHOD_SCHEMAS）。 */
  readonly schemas?: Readonly<Record<string, JsonSchema>>;
  /** 允许存在的“非扩展方法” schema（默认 status/browsers）。 */
  readonly allowedExtraSchemas?: readonly string[];
}
