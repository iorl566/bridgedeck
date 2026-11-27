// AUTO-GENERATED FILE — DO NOT EDIT.
//
// 源：lib/schemas.mjs（方法参数 schema 单源：137 方法 / 公共请求信封键 / camelCase 参数别名）
// 生成器：packages/protocol/scripts/gen.mjs
// 重生成：node packages/protocol/scripts/gen.mjs
// 漂移校验：node packages/protocol/scripts/gen.mjs --check
//
// 本文件是 TS 栈的 schema 数据单源投影；schema 语义只允许改 lib/schemas.mjs 后重新生成。
//
// schema 目录签名：sha256:9c2611b8ac4ca91c42ce3beedc7d62e1e79b8cb41c8068a1259138f818a039b6
// 统计：137 方法 schema / 3 信封键 / 137 方法含别名 / 687 参数键

import type { JsonSchema, SchemaCoverageSummary, SchemaKeyRow } from './schema-types.ts';

/** schema 目录签名：sha256(canonical snapshot)，用于与 JS 单源做漂移比对。 */
export const SCHEMA_SIGNATURE = 'sha256:9c2611b8ac4ca91c42ce3beedc7d62e1e79b8cb41c8068a1259138f818a039b6';

export const SCHEMA_METHOD_COUNT = 137;

/** 请求公共信封键（来自 lib/method-catalog.mjs 的 REQUEST_ENVELOPE_KEYS）。 */
export const ENVELOPE_SCHEMA_KEYS: readonly string[] = ['session', 'sessionId', 'tabId'];

/** 信封键 → 参数 schema（未单列方法的通用校验用；所有出现处定义必须一致）。 */
export const ENVELOPE_PROPERTY_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  'session': { 'type': 'string', 'minLength': 1 },
  'sessionId': { 'type': 'string', 'minLength': 1 },
  'tabId': { 'type': 'integer', 'minimum': 0 },
};

/** 有显式 schema 的方法名（索引签名与调用方补全用）。 */
export type SchemaMethodName =
  | 'observe'
  | 'console'
  | 'navigate'
  | 'wait-ms'
  | 'wait-for-element'
  | 'wait-for-navigation'
  | 'click'
  | 'click-backend'
  | 'hover'
  | 'fill'
  | 'press'
  | 'select'
  | 'read'
  | 'evaluate'
  | 'wheel'
  | 'webmcp.list'
  | 'webmcp.call'
  | 'drag'
  | 'transfer.begin'
  | 'transfer.chunk'
  | 'transfer.finish'
  | 'transfer.read'
  | 'transfer.release'
  | 'session.control_status'
  | 'session.claim_control'
  | 'session.release_control'
  | 'session.handoff'
  | 'session.control_mode'
  | 'plan'
  | 'extract'
  | 'extract.discover'
  | 'extract.table'
  | 'extract.list'
  | 'longshot.recover'
  | 'refs.negotiate'
  | 'upload'
  | 'pdf'
  | 'screenshot'
  | 'screenshot.read'
  | 'screenshot.release'
  | 'record.start'
  | 'record.stop'
  | 'record.list'
  | 'trace.start'
  | 'trace.stop'
  | 'trace.status'
  | 'video.start'
  | 'video.stop'
  | 'network.rule_add'
  | 'reload'
  | 'navigate-back'
  | 'navigate-forward'
  | 'snapshot'
  | 'observe-frames'
  | 'actionable'
  | 'blur'
  | 'focus'
  | 'get-html'
  | 'scroll-to'
  | 'shadow.read'
  | 'shadow.click'
  | 'download'
  | 'click-point'
  | 'screenshot.manual.start'
  | 'screenshot.manual.frame'
  | 'screenshot.manual.save'
  | 'tab.list'
  | 'tab.new'
  | 'tab.policy'
  | 'tab.alias'
  | 'tab.cleanup'
  | 'tab.close'
  | 'tab.select'
  | 'tab.borrow'
  | 'tab.return'
  | 'tab.move'
  | 'window.list'
  | 'window.close'
  | 'window.focus'
  | 'window.resize'
  | 'window.ensureAgent'
  | 'window.newAgent'
  | 'dialog.list'
  | 'dialog.status'
  | 'dialog.arm'
  | 'dialog.disarm'
  | 'dialog.accept'
  | 'dialog.dismiss'
  | 'dialog.handle'
  | 'network.start'
  | 'network.stop'
  | 'network.list'
  | 'network.detail'
  | 'network.waterfall'
  | 'network.replay'
  | 'debug.start'
  | 'debug.stop'
  | 'debug.current'
  | 'debug.request'
  | 'debug.performance'
  | 'debug.coverage'
  | 'debug.history'
  | 'debug.delete'
  | 'debug.fetch_probe'
  | 'debug.pin'
  | 'debug.pinned'
  | 'debug.capabilities'
  | 'debug.rule_add'
  | 'debug.rule_list'
  | 'debug.rule_clear'
  | 'debug.rule_enable'
  | 'debug.rule_disable'
  | 'debug.rule_remove'
  | 'debug.rule_export'
  | 'debug.rule_import'
  | 'video.status'
  | 'video.list'
  | 'video.fetch'
  | 'video.discard'
  | 'video.prune'
  | 'video.recover'
  | 'video.verify'
  | 'record.status'
  | 'cooperate.sync'
  | 'cooperate.hold'
  | 'cooperate.wait'
  | 'cooperate.handback'
  | 'operation.await'
  | 'operation.cancel'
  | 'request-help'
  | 'emulate'
  | 'step'
  | 'ui.open'
  | 'diagnostics.ui'
  | 'control-hint'
  | 'debugger.detach'
  | 'debugger.simulate-detach';

/** 方法 → {required, properties} 的 key 表（两个数组均已排序，决定论输出）。 */
export const METHOD_SCHEMA_KEYS: Readonly<Record<SchemaMethodName, SchemaKeyRow>> = {
  'observe': { required: [], properties: [
    'ax',
    'baseline',
    'closedShadow',
    'compareAx',
    'cursor',
    'debugSurfaces',
    'deepMaxTokens',
    'delta',
    'facts',
    'fallbackAx',
    'force',
    'maxDepth',
    'maxTokens',
    'pipeline',
    'probeHover',
    'session',
    'sessionId',
    'tabId',
    'vom',
    'vomBillingModel',
    'vomDeep',
    'vomExcludeHidden',
    'vomExplain',
    'vomGroupContext',
    'vomGroupTokens',
    'vomMaxNodes',
    'vomMaxTokens',
    'vomMinScore',
    'vomPerGroup',
    'vomProfile',
    'vomRank',
    'vomSemanticMaxGroups',
    'vomSemanticMaxTokens',
    'vomSemanticMinScore',
    'vomTop',
    'vomTree',
    'vomWeights',
  ] },
  'console': { required: [], properties: ['limit', 'session', 'sessionId', 'since', 'tabId'] },
  'navigate': { required: ['url'], properties: ['session', 'sessionId', 'tabId', 'url'] },
  'wait-ms': { required: ['ms'], properties: ['ms', 'session', 'sessionId', 'tabId'] },
  'wait-for-element': { required: [], properties: ['operationId', 'ref', 'selector', 'session', 'sessionId', 'stableRef', 'state', 'tabId', 'timeoutMs'] },
  'wait-for-navigation': { required: [], properties: ['session', 'sessionId', 'tabId', 'timeoutMs', 'waitUntil'] },
  'click': { required: [], properties: ['force', 'ref', 'selector', 'stableRef', 'text', 'trusted', 'waitTimeoutMs'] },
  'click-backend': { required: [], properties: ['backendId', 'session', 'sessionId', 'tabId'] },
  'hover': { required: [], properties: ['force', 'ref', 'selector', 'stableRef', 'trusted', 'waitTimeoutMs'] },
  'fill': { required: ['value'], properties: ['force', 'noClear', 'ref', 'selector', 'stableRef', 'trusted', 'value', 'waitTimeoutMs'] },
  'press': { required: ['key'], properties: ['force', 'key', 'ref', 'selector', 'stableRef', 'trusted', 'waitTimeoutMs'] },
  'select': { required: ['value'], properties: ['ref', 'selector', 'stableRef', 'value', 'waitTimeoutMs'] },
  'read': { required: [], properties: ['all', 'fieldsJson', 'ref', 'selector', 'session', 'sessionId', 'stableRef', 'tabId'] },
  'evaluate': { required: ['expression'], properties: ['expression', 'session', 'sessionId', 'tabId', 'unverified'] },
  'wheel': { required: [], properties: ['deltaX', 'deltaY'] },
  'webmcp.list': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'webmcp.call': { required: ['name'], properties: ['input', 'name', 'session', 'sessionId', 'tabId'] },
  'drag': { required: [], properties: ['capture', 'imageDx', 'imageDy', 'imageX', 'imageY', 'modifiers', 'steps', 'waitTimeoutMs'] },
  'transfer.begin': { required: ['byteSize', 'name'], properties: ['byteSize', 'name', 'session', 'sessionId'] },
  'transfer.chunk': { required: ['dataBase64', 'offset', 'transferId'], properties: ['dataBase64', 'offset', 'transferId'] },
  'transfer.finish': { required: ['transferId'], properties: ['transferId'] },
  'transfer.read': { required: ['offset', 'transferId'], properties: ['maxBytes', 'offset', 'transferId'] },
  'transfer.release': { required: ['transferId'], properties: ['transferId'] },
  'session.control_status': { required: [], properties: ['session', 'sessionId'] },
  'session.claim_control': { required: [], properties: ['expectEpoch', 'leaseMs', 'session', 'sessionId'] },
  'session.release_control': { required: [], properties: ['expectEpoch', 'session', 'sessionId'] },
  'session.handoff': { required: ['to'], properties: ['expectEpoch', 'leaseMs', 'session', 'sessionId', 'to'] },
  'session.control_mode': { required: ['mode'], properties: ['mode', 'session', 'sessionId'] },
  'plan': { required: ['steps'], properties: ['session', 'sessionId', 'steps', 'tabId'] },
  'extract': { required: [], properties: ['cursor', 'maxBytes', 'maxCells', 'maxRows', 'ref', 'selector', 'session', 'sessionId', 'tabId'] },
  'extract.discover': { required: [], properties: ['maxTargets', 'previewColumns', 'session', 'sessionId', 'tabId'] },
  'extract.table': { required: [], properties: [
    'cursor',
    'frameId',
    'maxBytes',
    'maxCells',
    'maxRows',
    'ref',
    'selector',
    'session',
    'sessionId',
    'tabId',
    'target',
  ] },
  'extract.list': { required: [], properties: [
    'cursor',
    'frameId',
    'itemSelector',
    'maxBytes',
    'maxCells',
    'maxRows',
    'ref',
    'selector',
    'session',
    'sessionId',
    'tabId',
  ] },
  'longshot.recover': { required: [], properties: ['captureId', 'longshotId', 'session', 'sessionId', 'tabId'] },
  'refs.negotiate': { required: [], properties: ['session', 'sessionId', 'stableRef', 'stableRefs', 'tabId'] },
  'upload': { required: [], properties: ['expectRevision', 'files', 'paths', 'ref', 'selector', 'session', 'sessionId', 'stableRef', 'tabId'] },
  'pdf': { required: [], properties: [
    'landscape',
    'margins',
    'pages',
    'paperHeight',
    'paperWidth',
    'preferCssPageSize',
    'printBackground',
    'scale',
    'session',
    'sessionId',
    'tabId',
  ] },
  'screenshot': { required: [], properties: [
    'annotate',
    'format',
    'fullPage',
    'grid',
    'gridStep',
    'profile',
    'ref',
    'region',
    'scale',
    'scope',
    'segmented',
    'selector',
    'session',
    'sessionId',
    'staleAttempts',
    'stream',
    'tabId',
    'tileSize',
    'visualIndex',
  ] },
  'screenshot.read': { required: ['captureId'], properties: ['captureId', 'length', 'offset', 'session', 'sessionId', 'tabId'] },
  'screenshot.release': { required: ['captureId'], properties: ['captureId', 'session', 'sessionId', 'tabId'] },
  'record.start': { required: [], properties: ['includeAgent', 'maxPageTokens', 'purpose', 'screenshots', 'session', 'sessionId', 'tabId'] },
  'record.stop': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'record.list': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'trace.start': { required: [], properties: ['categories', 'session', 'sessionId', 'tabId'] },
  'trace.stop': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'trace.status': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'video.start': { required: [], properties: ['durationMs', 'quality', 'session', 'sessionId', 'tabId'] },
  'video.stop': { required: [], properties: ['recording', 'session', 'sessionId', 'tabId'] },
  'network.rule_add': { required: [], properties: ['rule', 'session', 'sessionId', 'tabId'] },
  'reload': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'navigate-back': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'navigate-forward': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'snapshot': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'observe-frames': { required: [], properties: ['cursor', 'maxDepth', 'maxTokens', 'session', 'sessionId', 'tabId', 'vom'] },
  'actionable': { required: [], properties: ['expectRevision', 'ref', 'selector', 'session', 'sessionId', 'stableRef', 'tabId'] },
  'blur': { required: [], properties: ['expectRevision', 'ref', 'selector', 'session', 'sessionId', 'stableRef', 'tabId'] },
  'focus': { required: [], properties: ['expectRevision', 'ref', 'selector', 'session', 'sessionId', 'stableRef', 'tabId'] },
  'get-html': { required: [], properties: ['expectRevision', 'ref', 'selector', 'session', 'sessionId', 'stableRef', 'tabId'] },
  'scroll-to': { required: [], properties: ['expectRevision', 'ref', 'selector', 'session', 'sessionId', 'stableRef', 'tabId'] },
  'shadow.read': { required: [], properties: ['expectRevision', 'ref', 'selector', 'session', 'sessionId', 'stableRef', 'tabId'] },
  'shadow.click': { required: [], properties: ['expectRevision', 'ref', 'selector', 'session', 'sessionId', 'stableRef', 'tabId', 'text'] },
  'download': { required: [], properties: ['expectRevision', 'out', 'ref', 'selector', 'session', 'sessionId', 'stableRef', 'tabId', 'url'] },
  'click-point': { required: [], properties: ['capture', 'imageX', 'imageY', 'session', 'sessionId', 'tabId'] },
  'screenshot.manual.start': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'screenshot.manual.frame': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'screenshot.manual.save': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'tab.list': { required: [], properties: ['scope', 'session', 'sessionId', 'tabId'] },
  'tab.new': { required: [], properties: [
    'allowedOrigins',
    'focus',
    'incognito',
    'newWindow',
    'noFocus',
    'readOnly',
    'session',
    'sessionId',
    'tabId',
    'url',
    'windowId',
  ] },
  'tab.policy': { required: [], properties: ['allowedOrigins', 'clear', 'readOnly', 'session', 'sessionId', 'tabId'] },
  'tab.alias': { required: [], properties: ['action', 'alias', 'session', 'sessionId', 'tabId'] },
  'tab.cleanup': { required: [], properties: ['dryRun', 'idleMs', 'session', 'sessionId', 'tabId'] },
  'tab.close': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'tab.select': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'tab.borrow': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'tab.return': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'tab.move': { required: [], properties: ['index', 'session', 'sessionId', 'tabId', 'windowId'] },
  'window.list': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'window.close': { required: [], properties: ['session', 'sessionId', 'tabId', 'windowId'] },
  'window.focus': { required: [], properties: ['session', 'sessionId', 'tabId', 'windowId'] },
  'window.resize': { required: [], properties: ['height', 'session', 'sessionId', 'tabId', 'width'] },
  'window.ensureAgent': { required: [], properties: ['focus', 'incognito', 'noFocus', 'session', 'sessionId', 'tabId'] },
  'window.newAgent': { required: [], properties: ['focus', 'incognito', 'noFocus', 'session', 'sessionId', 'tabId'] },
  'dialog.list': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'dialog.status': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'dialog.arm': { required: [], properties: ['alert', 'beforeUnload', 'confirm', 'prompt', 'promptText', 'queue', 'session', 'sessionId', 'tabId'] },
  'dialog.disarm': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'dialog.accept': { required: [], properties: ['session', 'sessionId', 'tabId', 'text'] },
  'dialog.dismiss': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'dialog.handle': { required: [], properties: ['accept', 'dismiss', 'promptText', 'session', 'sessionId', 'tabId'] },
  'network.start': { required: [], properties: ['bodies', 'session', 'sessionId', 'tabId'] },
  'network.stop': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'network.list': { required: [], properties: ['filter', 'limit', 'session', 'sessionId', 'since', 'tabId'] },
  'network.detail': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'network.waterfall': { required: [], properties: ['limit', 'session', 'sessionId', 'tabId'] },
  'network.replay': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'debug.start': { required: [], properties: ['bodies', 'name', 'session', 'sessionId', 'tabId'] },
  'debug.stop': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'debug.current': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'debug.request': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'debug.performance': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'debug.coverage': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'debug.history': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'debug.delete': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'debug.fetch_probe': { required: [], properties: ['ms', 'session', 'sessionId', 'tabId'] },
  'debug.pin': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'debug.pinned': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'debug.capabilities': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'debug.rule_add': { required: [], properties: ['rule', 'session', 'sessionId', 'tabId'] },
  'debug.rule_list': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'debug.rule_clear': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'debug.rule_enable': { required: [], properties: ['id', 'session', 'sessionId', 'tabId'] },
  'debug.rule_disable': { required: [], properties: ['id', 'session', 'sessionId', 'tabId'] },
  'debug.rule_remove': { required: [], properties: ['id', 'session', 'sessionId', 'tabId'] },
  'debug.rule_export': { required: [], properties: ['output', 'session', 'sessionId', 'tabId'] },
  'debug.rule_import': { required: [], properties: ['rules', 'session', 'sessionId', 'tabId'] },
  'video.status': { required: [], properties: ['recording', 'session', 'sessionId', 'tabId'] },
  'video.list': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'video.fetch': { required: [], properties: ['recording', 'session', 'sessionId', 'tabId'] },
  'video.discard': { required: [], properties: ['recording', 'session', 'sessionId', 'tabId'] },
  'video.prune': { required: [], properties: ['session', 'sessionId', 'tabId', 'ttlMs'] },
  'video.recover': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'video.verify': { required: [], properties: ['recording', 'session', 'sessionId', 'tabId'] },
  'record.status': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'cooperate.sync': { required: [], properties: ['contextLines', 'matchText', 'policy', 'probeHover', 'session', 'sessionId', 'tabId'] },
  'cooperate.hold': { required: [], properties: ['held', 'session', 'sessionId', 'tabId'] },
  'cooperate.wait': { required: [], properties: ['session', 'sessionId', 'tabId', 'timeoutMs'] },
  'cooperate.handback': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'operation.await': { required: [], properties: ['session', 'sessionId', 'tabId', 'timeoutMs'] },
  'operation.cancel': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'request-help': { required: [], properties: ['reason', 'session', 'sessionId', 'tabId', 'timeoutMs'] },
  'emulate': { required: [], properties: [
    'device',
    'dpr',
    'geolocation',
    'height',
    'locale',
    'mobile',
    'reset',
    'session',
    'sessionId',
    'tabId',
    'timezone',
    'touch',
    'ua',
    'width',
  ] },
  'step': { required: [], properties: ['action', 'saveFull', 'session', 'sessionId', 'tabId', 'untilVisible', 'waitTimeoutMs'] },
  'ui.open': { required: [], properties: ['page', 'query', 'session', 'sessionId', 'tabId'] },
  'diagnostics.ui': { required: [], properties: ['page', 'session', 'sessionId', 'tabId'] },
  'control-hint': { required: [], properties: ['enabled', 'session', 'sessionId', 'tabId'] },
  'debugger.detach': { required: [], properties: ['session', 'sessionId', 'tabId'] },
  'debugger.simulate-detach': { required: [], properties: ['session', 'sessionId', 'tabId'] },
};

/** camelCase → snake_case 参数别名（只列有驼峰字段的方法）。 */
export const PARAM_ALIASES: Readonly<Partial<Record<SchemaMethodName, Readonly<Record<string, string>>>>> = {
  'observe': {
    'closed_shadow': 'closedShadow',
    'compare_ax': 'compareAx',
    'debug_surfaces': 'debugSurfaces',
    'deep_max_tokens': 'deepMaxTokens',
    'fallback_ax': 'fallbackAx',
    'max_depth': 'maxDepth',
    'max_tokens': 'maxTokens',
    'probe_hover': 'probeHover',
    'session_id': 'sessionId',
    'tab_id': 'tabId',
    'vom_billing_model': 'vomBillingModel',
    'vom_deep': 'vomDeep',
    'vom_exclude_hidden': 'vomExcludeHidden',
    'vom_explain': 'vomExplain',
    'vom_group_context': 'vomGroupContext',
    'vom_group_tokens': 'vomGroupTokens',
    'vom_max_nodes': 'vomMaxNodes',
    'vom_max_tokens': 'vomMaxTokens',
    'vom_min_score': 'vomMinScore',
    'vom_per_group': 'vomPerGroup',
    'vom_profile': 'vomProfile',
    'vom_rank': 'vomRank',
    'vom_semantic_max_groups': 'vomSemanticMaxGroups',
    'vom_semantic_max_tokens': 'vomSemanticMaxTokens',
    'vom_semantic_min_score': 'vomSemanticMinScore',
    'vom_top': 'vomTop',
    'vom_tree': 'vomTree',
    'vom_weights': 'vomWeights',
  },
  'console': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'navigate': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'wait-ms': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'wait-for-element': {
    'operation_id': 'operationId',
    'session_id': 'sessionId',
    'stable_ref': 'stableRef',
    'tab_id': 'tabId',
    'timeout_ms': 'timeoutMs',
  },
  'wait-for-navigation': {
    'session_id': 'sessionId',
    'tab_id': 'tabId',
    'timeout_ms': 'timeoutMs',
    'wait_until': 'waitUntil',
  },
  'click': { 'stable_ref': 'stableRef', 'wait_timeout_ms': 'waitTimeoutMs' },
  'click-backend': { 'backend_id': 'backendId', 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'hover': { 'stable_ref': 'stableRef', 'wait_timeout_ms': 'waitTimeoutMs' },
  'fill': { 'no_clear': 'noClear', 'stable_ref': 'stableRef', 'wait_timeout_ms': 'waitTimeoutMs' },
  'press': { 'stable_ref': 'stableRef', 'wait_timeout_ms': 'waitTimeoutMs' },
  'select': { 'stable_ref': 'stableRef', 'wait_timeout_ms': 'waitTimeoutMs' },
  'read': { 'fields_json': 'fieldsJson', 'session_id': 'sessionId', 'stable_ref': 'stableRef', 'tab_id': 'tabId' },
  'evaluate': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'wheel': { 'delta_x': 'deltaX', 'delta_y': 'deltaY' },
  'webmcp.list': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'webmcp.call': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'drag': {
    'image_dx': 'imageDx',
    'image_dy': 'imageDy',
    'image_x': 'imageX',
    'image_y': 'imageY',
    'wait_timeout_ms': 'waitTimeoutMs',
  },
  'transfer.begin': { 'byte_size': 'byteSize', 'session_id': 'sessionId' },
  'transfer.chunk': { 'data_base64': 'dataBase64', 'transfer_id': 'transferId' },
  'transfer.finish': { 'transfer_id': 'transferId' },
  'transfer.read': { 'max_bytes': 'maxBytes', 'transfer_id': 'transferId' },
  'transfer.release': { 'transfer_id': 'transferId' },
  'session.control_status': { 'session_id': 'sessionId' },
  'session.claim_control': { 'expect_epoch': 'expectEpoch', 'lease_ms': 'leaseMs', 'session_id': 'sessionId' },
  'session.release_control': { 'expect_epoch': 'expectEpoch', 'session_id': 'sessionId' },
  'session.handoff': { 'expect_epoch': 'expectEpoch', 'lease_ms': 'leaseMs', 'session_id': 'sessionId' },
  'session.control_mode': { 'session_id': 'sessionId' },
  'plan': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'extract': {
    'max_bytes': 'maxBytes',
    'max_cells': 'maxCells',
    'max_rows': 'maxRows',
    'session_id': 'sessionId',
    'tab_id': 'tabId',
  },
  'extract.discover': {
    'max_targets': 'maxTargets',
    'preview_columns': 'previewColumns',
    'session_id': 'sessionId',
    'tab_id': 'tabId',
  },
  'extract.table': {
    'frame_id': 'frameId',
    'max_bytes': 'maxBytes',
    'max_cells': 'maxCells',
    'max_rows': 'maxRows',
    'session_id': 'sessionId',
    'tab_id': 'tabId',
  },
  'extract.list': {
    'frame_id': 'frameId',
    'item_selector': 'itemSelector',
    'max_bytes': 'maxBytes',
    'max_cells': 'maxCells',
    'max_rows': 'maxRows',
    'session_id': 'sessionId',
    'tab_id': 'tabId',
  },
  'longshot.recover': {
    'capture_id': 'captureId',
    'longshot_id': 'longshotId',
    'session_id': 'sessionId',
    'tab_id': 'tabId',
  },
  'refs.negotiate': {
    'session_id': 'sessionId',
    'stable_ref': 'stableRef',
    'stable_refs': 'stableRefs',
    'tab_id': 'tabId',
  },
  'upload': {
    'expect_revision': 'expectRevision',
    'session_id': 'sessionId',
    'stable_ref': 'stableRef',
    'tab_id': 'tabId',
  },
  'pdf': {
    'paper_height': 'paperHeight',
    'paper_width': 'paperWidth',
    'prefer_css_page_size': 'preferCssPageSize',
    'print_background': 'printBackground',
    'session_id': 'sessionId',
    'tab_id': 'tabId',
  },
  'screenshot': {
    'full_page': 'fullPage',
    'grid_step': 'gridStep',
    'session_id': 'sessionId',
    'stale_attempts': 'staleAttempts',
    'tab_id': 'tabId',
    'tile_size': 'tileSize',
    'visual_index': 'visualIndex',
  },
  'screenshot.read': { 'capture_id': 'captureId', 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'screenshot.release': { 'capture_id': 'captureId', 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'record.start': {
    'include_agent': 'includeAgent',
    'max_page_tokens': 'maxPageTokens',
    'session_id': 'sessionId',
    'tab_id': 'tabId',
  },
  'record.stop': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'record.list': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'trace.start': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'trace.stop': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'trace.status': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'video.start': { 'duration_ms': 'durationMs', 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'video.stop': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'network.rule_add': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'reload': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'navigate-back': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'navigate-forward': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'snapshot': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'observe-frames': {
    'max_depth': 'maxDepth',
    'max_tokens': 'maxTokens',
    'session_id': 'sessionId',
    'tab_id': 'tabId',
  },
  'actionable': {
    'expect_revision': 'expectRevision',
    'session_id': 'sessionId',
    'stable_ref': 'stableRef',
    'tab_id': 'tabId',
  },
  'blur': {
    'expect_revision': 'expectRevision',
    'session_id': 'sessionId',
    'stable_ref': 'stableRef',
    'tab_id': 'tabId',
  },
  'focus': {
    'expect_revision': 'expectRevision',
    'session_id': 'sessionId',
    'stable_ref': 'stableRef',
    'tab_id': 'tabId',
  },
  'get-html': {
    'expect_revision': 'expectRevision',
    'session_id': 'sessionId',
    'stable_ref': 'stableRef',
    'tab_id': 'tabId',
  },
  'scroll-to': {
    'expect_revision': 'expectRevision',
    'session_id': 'sessionId',
    'stable_ref': 'stableRef',
    'tab_id': 'tabId',
  },
  'shadow.read': {
    'expect_revision': 'expectRevision',
    'session_id': 'sessionId',
    'stable_ref': 'stableRef',
    'tab_id': 'tabId',
  },
  'shadow.click': {
    'expect_revision': 'expectRevision',
    'session_id': 'sessionId',
    'stable_ref': 'stableRef',
    'tab_id': 'tabId',
  },
  'download': {
    'expect_revision': 'expectRevision',
    'session_id': 'sessionId',
    'stable_ref': 'stableRef',
    'tab_id': 'tabId',
  },
  'click-point': { 'image_x': 'imageX', 'image_y': 'imageY', 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'screenshot.manual.start': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'screenshot.manual.frame': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'screenshot.manual.save': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'tab.list': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'tab.new': {
    'allowed_origins': 'allowedOrigins',
    'new_window': 'newWindow',
    'no_focus': 'noFocus',
    'read_only': 'readOnly',
    'session_id': 'sessionId',
    'tab_id': 'tabId',
    'window_id': 'windowId',
  },
  'tab.policy': {
    'allowed_origins': 'allowedOrigins',
    'read_only': 'readOnly',
    'session_id': 'sessionId',
    'tab_id': 'tabId',
  },
  'tab.alias': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'tab.cleanup': { 'dry_run': 'dryRun', 'idle_ms': 'idleMs', 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'tab.close': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'tab.select': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'tab.borrow': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'tab.return': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'tab.move': { 'session_id': 'sessionId', 'tab_id': 'tabId', 'window_id': 'windowId' },
  'window.list': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'window.close': { 'session_id': 'sessionId', 'tab_id': 'tabId', 'window_id': 'windowId' },
  'window.focus': { 'session_id': 'sessionId', 'tab_id': 'tabId', 'window_id': 'windowId' },
  'window.resize': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'window.ensureAgent': { 'no_focus': 'noFocus', 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'window.newAgent': { 'no_focus': 'noFocus', 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'dialog.list': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'dialog.status': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'dialog.arm': {
    'before_unload': 'beforeUnload',
    'prompt_text': 'promptText',
    'session_id': 'sessionId',
    'tab_id': 'tabId',
  },
  'dialog.disarm': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'dialog.accept': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'dialog.dismiss': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'dialog.handle': { 'prompt_text': 'promptText', 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'network.start': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'network.stop': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'network.list': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'network.detail': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'network.waterfall': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'network.replay': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'debug.start': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'debug.stop': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'debug.current': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'debug.request': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'debug.performance': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'debug.coverage': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'debug.history': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'debug.delete': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'debug.fetch_probe': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'debug.pin': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'debug.pinned': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'debug.capabilities': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'debug.rule_add': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'debug.rule_list': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'debug.rule_clear': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'debug.rule_enable': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'debug.rule_disable': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'debug.rule_remove': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'debug.rule_export': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'debug.rule_import': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'video.status': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'video.list': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'video.fetch': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'video.discard': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'video.prune': { 'session_id': 'sessionId', 'tab_id': 'tabId', 'ttl_ms': 'ttlMs' },
  'video.recover': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'video.verify': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'record.status': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'cooperate.sync': {
    'context_lines': 'contextLines',
    'match_text': 'matchText',
    'probe_hover': 'probeHover',
    'session_id': 'sessionId',
    'tab_id': 'tabId',
  },
  'cooperate.hold': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'cooperate.wait': { 'session_id': 'sessionId', 'tab_id': 'tabId', 'timeout_ms': 'timeoutMs' },
  'cooperate.handback': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'operation.await': { 'session_id': 'sessionId', 'tab_id': 'tabId', 'timeout_ms': 'timeoutMs' },
  'operation.cancel': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'request-help': { 'session_id': 'sessionId', 'tab_id': 'tabId', 'timeout_ms': 'timeoutMs' },
  'emulate': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'step': {
    'save_full': 'saveFull',
    'session_id': 'sessionId',
    'tab_id': 'tabId',
    'until_visible': 'untilVisible',
    'wait_timeout_ms': 'waitTimeoutMs',
  },
  'ui.open': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'diagnostics.ui': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'control-hint': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'debugger.detach': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
  'debugger.simulate-detach': { 'session_id': 'sessionId', 'tab_id': 'tabId' },
};

/** 全量方法 schema（验证器与漂移审计共用同一份数据，不在 TS 侧重写语义）。 */
export const METHOD_SCHEMAS: Readonly<Record<SchemaMethodName, JsonSchema>> = {
  'observe': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'probeHover': { 'type': 'boolean' },
      'debugSurfaces': { 'type': 'boolean' },
      'closedShadow': { 'type': 'boolean' },
      'vom': { 'type': 'boolean' },
      'vomDeep': { 'type': 'boolean' },
      'vomTree': { 'type': 'boolean' },
      'vomRank': { 'type': 'boolean' },
      'vomExplain': { 'type': 'boolean' },
      'vomExcludeHidden': { 'type': 'boolean' },
      'vomProfile': { 'type': 'string', 'enum': ['balanced', 'compact', 'all'] },
      'vomPerGroup': { 'type': 'integer', 'minimum': 1 },
      'vomGroupTokens': { 'type': 'integer', 'minimum': 1 },
      'vomBillingModel': { 'type': 'string', 'enum': ['cjk-heuristic-v2', 'chars-per-4', 'o200k'] },
      'vomSemanticMaxGroups': { 'type': 'integer', 'minimum': 1 },
      'vomSemanticMinScore': { 'type': 'number', 'minimum': -1000, 'maximum': 1000 },
      'vomSemanticMaxTokens': { 'type': 'integer', 'minimum': 1 },
      'vomGroupContext': { 'type': 'boolean' },
      'vomWeights': { 'type': 'object' },
      'vomTop': { 'type': 'integer', 'minimum': 1, 'maximum': 500 },
      'vomMinScore': { 'type': 'number', 'minimum': -1000, 'maximum': 1000 },
      'vomMaxNodes': { 'type': 'integer', 'minimum': 1, 'maximum': 5000 },
      'vomMaxTokens': { 'type': 'integer', 'minimum': 1, 'maximum': 200000 },
      'deepMaxTokens': { 'type': 'integer', 'minimum': 1, 'maximum': 20000 },
      'ax': { 'type': 'boolean' },
      'facts': { 'type': 'boolean' },
      'fallbackAx': { 'type': 'boolean' },
      'compareAx': { 'type': 'boolean' },
      'pipeline': { 'type': 'string', 'enum': ['page-lib', 'ax'] },
      'maxTokens': { 'type': 'integer', 'minimum': 1, 'maximum': 20000 },
      'maxDepth': { 'type': 'integer', 'minimum': 1, 'maximum': 100 },
      'cursor': { 'type': 'string', 'minLength': 1, 'maxLength': 4096 },
      'force': { 'type': 'boolean' },
      'delta': { 'type': 'boolean' },
      'baseline': { 'type': 'string' },
    },
  },
  'console': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'since': { 'type': 'integer', 'minimum': 0 },
      'limit': { 'type': 'integer', 'minimum': 1, 'maximum': 2000 },
    },
  },
  'navigate': {
    'type': 'object',
    'required': ['url'],
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'url': { 'type': 'string', 'minLength': 1, 'maxLength': 8192 },
    },
  },
  'wait-ms': {
    'type': 'object',
    'required': ['ms'],
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'ms': { 'type': 'integer', 'minimum': 0, 'maximum': 120000 },
    },
  },
  'wait-for-element': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'ref': { 'type': 'string', 'minLength': 1 },
      'selector': { 'type': 'string', 'minLength': 1 },
      'stableRef': { 'type': 'string', 'minLength': 1 },
      'state': { 'type': 'string' },
      'timeoutMs': { 'type': 'integer', 'minimum': 1, 'maximum': 120000 },
      'operationId': { 'type': 'string', 'minLength': 1 },
    },
  },
  'wait-for-navigation': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'waitUntil': { 'type': 'string' },
      'timeoutMs': { 'type': 'integer', 'minimum': 1, 'maximum': 120000 },
    },
  },
  'click': {
    'type': 'object',
    'properties': {
      'ref': { 'type': 'string', 'minLength': 1 },
      'selector': { 'type': 'string', 'minLength': 1 },
      'text': { 'type': 'string', 'minLength': 1 },
      'stableRef': { 'type': 'string', 'minLength': 1 },
      'trusted': { 'type': 'boolean' },
      'force': { 'type': 'boolean' },
      'waitTimeoutMs': { 'type': 'integer', 'minimum': 0, 'maximum': 120000 },
    },
  },
  'click-backend': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'backendId': { 'type': 'integer', 'minimum': 1 },
    },
  },
  'hover': {
    'type': 'object',
    'properties': {
      'ref': { 'type': 'string', 'minLength': 1 },
      'selector': { 'type': 'string', 'minLength': 1 },
      'stableRef': { 'type': 'string', 'minLength': 1 },
      'trusted': { 'type': 'boolean' },
      'force': { 'type': 'boolean' },
      'waitTimeoutMs': { 'type': 'integer', 'minimum': 0, 'maximum': 120000 },
    },
  },
  'fill': {
    'type': 'object',
    'required': ['value'],
    'properties': {
      'ref': { 'type': 'string', 'minLength': 1 },
      'selector': { 'type': 'string', 'minLength': 1 },
      'stableRef': { 'type': 'string', 'minLength': 1 },
      'value': { 'type': 'string' },
      'noClear': { 'type': 'boolean' },
      'trusted': { 'type': 'boolean' },
      'force': { 'type': 'boolean' },
      'waitTimeoutMs': { 'type': 'integer', 'minimum': 0, 'maximum': 120000 },
    },
  },
  'press': {
    'type': 'object',
    'required': ['key'],
    'properties': {
      'ref': { 'type': 'string', 'minLength': 1 },
      'selector': { 'type': 'string', 'minLength': 1 },
      'stableRef': { 'type': 'string', 'minLength': 1 },
      'key': { 'type': 'string', 'minLength': 1 },
      'trusted': { 'type': 'boolean' },
      'force': { 'type': 'boolean' },
      'waitTimeoutMs': { 'type': 'integer', 'minimum': 0, 'maximum': 120000 },
    },
  },
  'select': {
    'type': 'object',
    'required': ['value'],
    'properties': {
      'ref': { 'type': 'string', 'minLength': 1 },
      'selector': { 'type': 'string', 'minLength': 1 },
      'stableRef': { 'type': 'string', 'minLength': 1 },
      'value': { 'type': 'string' },
      'waitTimeoutMs': { 'type': 'integer', 'minimum': 0, 'maximum': 120000 },
    },
  },
  'read': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'ref': { 'type': 'string', 'minLength': 1 },
      'selector': { 'type': 'string', 'minLength': 1 },
      'stableRef': { 'type': 'string', 'minLength': 1 },
      'all': { 'type': 'boolean' },
      'fieldsJson': { 'type': 'string' },
    },
  },
  'evaluate': {
    'type': 'object',
    'required': ['expression'],
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'expression': { 'type': 'string', 'minLength': 1, 'maxLength': 200000 },
      'unverified': { 'type': 'boolean' },
    },
  },
  'wheel': { 'type': 'object', 'properties': { 'deltaY': { 'type': 'number' }, 'deltaX': { 'type': 'number' } } },
  'webmcp.list': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'webmcp.call': {
    'type': 'object',
    'required': ['name'],
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'name': { 'type': 'string', 'minLength': 1 },
      'input': { 'type': 'object' },
    },
  },
  'drag': {
    'type': 'object',
    'properties': {
      'modifiers': { 'type': 'integer', 'minimum': 0, 'maximum': 15 },
      'steps': { 'type': 'integer', 'minimum': 2, 'maximum': 60 },
      'waitTimeoutMs': { 'type': 'integer', 'minimum': 0, 'maximum': 120000 },
      'capture': { 'type': 'string' },
      'imageX': { 'type': 'integer' },
      'imageY': { 'type': 'integer' },
      'imageDx': { 'type': 'integer' },
      'imageDy': { 'type': 'integer' },
    },
  },
  'transfer.begin': {
    'type': 'object',
    'required': ['name', 'byteSize'],
    'properties': {
      'name': { 'type': 'string', 'minLength': 1, 'maxLength': 200 },
      'byteSize': { 'type': 'integer', 'minimum': 1, 'maximum': 67108864 },
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
    },
  },
  'transfer.chunk': {
    'type': 'object',
    'required': ['transferId', 'offset', 'dataBase64'],
    'properties': {
      'transferId': { 'type': 'string', 'pattern': '^tr_[0-9a-f]{16}$' },
      'offset': { 'type': 'integer', 'minimum': 0 },
      'dataBase64': { 'type': 'string', 'minLength': 1 },
    },
  },
  'transfer.finish': {
    'type': 'object',
    'required': ['transferId'],
    'properties': { 'transferId': { 'type': 'string', 'pattern': '^tr_[0-9a-f]{16}$' } },
  },
  'transfer.read': {
    'type': 'object',
    'required': ['transferId', 'offset'],
    'properties': {
      'transferId': { 'type': 'string', 'pattern': '^tr_[0-9a-f]{16}$' },
      'offset': { 'type': 'integer', 'minimum': 0 },
      'maxBytes': { 'type': 'integer', 'minimum': 1, 'maximum': 1048576 },
    },
  },
  'transfer.release': {
    'type': 'object',
    'required': ['transferId'],
    'properties': { 'transferId': { 'type': 'string', 'pattern': '^tr_[0-9a-f]{16}$' } },
  },
  'session.control_status': {
    'type': 'object',
    'properties': { 'session': { 'type': 'string', 'minLength': 1 }, 'sessionId': { 'type': 'string', 'minLength': 1 } },
  },
  'session.claim_control': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'leaseMs': { 'type': 'integer', 'minimum': 1000, 'maximum': 600000 },
      'expectEpoch': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'session.release_control': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'expectEpoch': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'session.handoff': {
    'type': 'object',
    'required': ['to'],
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'to': { 'type': 'string', 'minLength': 1 },
      'leaseMs': { 'type': 'integer', 'minimum': 1000, 'maximum': 600000 },
      'expectEpoch': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'session.control_mode': {
    'type': 'object',
    'required': ['mode'],
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'mode': { 'type': 'string', 'enum': ['open', 'exclusive'] },
    },
  },
  'plan': {
    'type': 'object',
    'required': ['steps'],
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'steps': {
        'type': 'array',
        'minItems': 1,
        'maxItems': 50,
        'items': {
          'type': 'object',
          'required': ['method'],
          'properties': { 'method': { 'type': 'string', 'minLength': 1 }, 'params': { 'type': 'object' } },
        },
      },
    },
  },
  'extract': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'ref': { 'type': 'string', 'minLength': 1 },
      'selector': { 'type': 'string', 'minLength': 1 },
      'maxRows': { 'type': 'integer', 'minimum': 1 },
      'maxBytes': { 'type': 'integer', 'minimum': 1 },
      'maxCells': { 'type': 'integer', 'minimum': 1 },
      'cursor': { 'type': 'string', 'minLength': 1 },
    },
  },
  'extract.discover': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'maxTargets': { 'type': 'integer', 'minimum': 1 },
      'previewColumns': { 'type': 'integer', 'minimum': 1 },
    },
  },
  'extract.table': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'frameId': { 'type': 'integer', 'minimum': 0 },
      'target': { 'type': 'integer', 'minimum': 0 },
      'ref': { 'type': 'string', 'minLength': 1 },
      'selector': { 'type': 'string', 'minLength': 1 },
      'maxRows': { 'type': 'integer', 'minimum': 1 },
      'maxBytes': { 'type': 'integer', 'minimum': 1 },
      'maxCells': { 'type': 'integer', 'minimum': 1 },
      'cursor': { 'type': 'string', 'minLength': 1 },
    },
  },
  'extract.list': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'frameId': { 'type': 'integer', 'minimum': 0 },
      'ref': { 'type': 'string', 'minLength': 1 },
      'selector': { 'type': 'string', 'minLength': 1 },
      'itemSelector': { 'type': 'string', 'minLength': 1 },
      'maxRows': { 'type': 'integer', 'minimum': 1 },
      'maxBytes': { 'type': 'integer', 'minimum': 1 },
      'maxCells': { 'type': 'integer', 'minimum': 1 },
      'cursor': { 'type': 'string', 'minLength': 1 },
    },
  },
  'longshot.recover': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'longshotId': { 'type': 'string', 'minLength': 1, 'maxLength': 128 },
      'captureId': { 'type': 'string', 'minLength': 1, 'maxLength': 128 },
    },
  },
  'refs.negotiate': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'stableRef': { 'type': 'string', 'minLength': 1, 'maxLength': 128 },
      'stableRefs': { 'type': 'array', 'items': { 'type': 'string', 'minLength': 1, 'maxLength': 128 }, 'maxItems': 50 },
    },
  },
  'upload': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'ref': { 'type': 'string', 'minLength': 1 },
      'selector': { 'type': 'string', 'minLength': 1 },
      'stableRef': { 'type': 'string', 'minLength': 1 },
      'expectRevision': { 'type': 'integer', 'minimum': 0 },
      'files': { 'type': 'array' },
      'paths': { 'type': 'array' },
    },
  },
  'pdf': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'printBackground': { 'type': 'boolean' },
      'landscape': { 'type': 'boolean' },
      'preferCssPageSize': { 'type': 'boolean' },
      'paperWidth': { 'type': 'number', 'minimum': 0.1, 'maximum': 100 },
      'paperHeight': { 'type': 'number', 'minimum': 0.1, 'maximum': 100 },
      'pages': { 'type': 'string', 'maxLength': 64 },
      'scale': { 'type': 'number', 'minimum': 0.1, 'maximum': 2 },
      'margins': {
        'type': 'object',
        'properties': {
          'top': { 'type': 'number', 'minimum': 0 },
          'right': { 'type': 'number', 'minimum': 0 },
          'bottom': { 'type': 'number', 'minimum': 0 },
          'left': { 'type': 'number', 'minimum': 0 },
        },
        'additionalProperties': false,
      },
    },
  },
  'screenshot': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'ref': { 'type': 'string', 'minLength': 1 },
      'selector': { 'type': 'string', 'minLength': 1 },
      'scope': { 'type': 'string', 'enum': ['viewport', 'full', 'follow', 'current'] },
      'fullPage': { 'type': 'boolean' },
      'annotate': { 'type': 'boolean' },
      'grid': { 'type': 'boolean' },
      'gridStep': { 'type': 'integer', 'minimum': 10, 'maximum': 200 },
      'scale': { 'type': 'number', 'minimum': 1, 'maximum': 8 },
      'visualIndex': { 'type': 'integer', 'minimum': 1 },
      'profile': { 'type': 'string', 'enum': ['x', 'y'] },
      'format': { 'type': 'string', 'minLength': 1 },
      'region': { 'type': 'object', 'required': ['x', 'y', 'width', 'height'] },
      'stream': { 'type': 'boolean' },
      'segmented': { 'type': 'boolean' },
      'tileSize': { 'type': 'integer', 'minimum': 256, 'maximum': 8192 },
      'staleAttempts': { 'type': 'integer', 'minimum': 1, 'maximum': 3 },
    },
  },
  'screenshot.read': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'captureId': { 'type': 'string', 'minLength': 1 },
      'offset': { 'type': 'integer', 'minimum': 0 },
      'length': { 'type': 'integer', 'minimum': 1, 'maximum': 4194304 },
    },
    'required': ['captureId'],
  },
  'screenshot.release': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'captureId': { 'type': 'string', 'minLength': 1 },
    },
    'required': ['captureId'],
  },
  'record.start': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'purpose': { 'type': 'string' },
      'maxPageTokens': { 'type': 'integer', 'minimum': 1 },
      'screenshots': { 'type': 'boolean' },
      'includeAgent': { 'type': 'boolean' },
    },
  },
  'record.stop': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'record.list': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'trace.start': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'categories': { 'type': 'string', 'minLength': 1, 'maxLength': 512 },
    },
  },
  'trace.stop': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'trace.status': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'video.start': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'durationMs': { 'type': 'integer', 'minimum': 0 },
      'quality': { 'type': 'string' },
    },
  },
  'video.stop': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'recording': { 'type': 'string' },
    },
  },
  'network.rule_add': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'rule': { 'type': 'object' },
    },
  },
  'reload': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'navigate-back': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'navigate-forward': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'snapshot': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'observe-frames': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'maxTokens': { 'type': 'integer', 'minimum': 1, 'maximum': 20000 },
      'maxDepth': { 'type': 'integer', 'minimum': 1, 'maximum': 100 },
      'cursor': { 'type': 'string', 'minLength': 1, 'maxLength': 4096 },
      'vom': { 'type': 'boolean' },
    },
  },
  'actionable': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'ref': { 'type': 'string', 'minLength': 1 },
      'selector': { 'type': 'string', 'minLength': 1 },
      'stableRef': { 'type': 'string', 'minLength': 1 },
      'expectRevision': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'blur': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'ref': { 'type': 'string', 'minLength': 1 },
      'selector': { 'type': 'string', 'minLength': 1 },
      'stableRef': { 'type': 'string', 'minLength': 1 },
      'expectRevision': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'focus': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'ref': { 'type': 'string', 'minLength': 1 },
      'selector': { 'type': 'string', 'minLength': 1 },
      'stableRef': { 'type': 'string', 'minLength': 1 },
      'expectRevision': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'get-html': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'ref': { 'type': 'string', 'minLength': 1 },
      'selector': { 'type': 'string', 'minLength': 1 },
      'stableRef': { 'type': 'string', 'minLength': 1 },
      'expectRevision': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'scroll-to': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'ref': { 'type': 'string', 'minLength': 1 },
      'selector': { 'type': 'string', 'minLength': 1 },
      'stableRef': { 'type': 'string', 'minLength': 1 },
      'expectRevision': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'shadow.read': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'ref': { 'type': 'string', 'minLength': 1 },
      'selector': { 'type': 'string', 'minLength': 1 },
      'stableRef': { 'type': 'string', 'minLength': 1 },
      'expectRevision': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'shadow.click': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'ref': { 'type': 'string', 'minLength': 1 },
      'selector': { 'type': 'string', 'minLength': 1 },
      'stableRef': { 'type': 'string', 'minLength': 1 },
      'expectRevision': { 'type': 'integer', 'minimum': 0 },
      'text': { 'type': 'string' },
    },
  },
  'download': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'ref': { 'type': 'string', 'minLength': 1 },
      'selector': { 'type': 'string', 'minLength': 1 },
      'stableRef': { 'type': 'string', 'minLength': 1 },
      'expectRevision': { 'type': 'integer', 'minimum': 0 },
      'url': { 'type': 'string' },
      'out': { 'type': 'string' },
    },
  },
  'click-point': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'capture': { 'type': 'string' },
      'imageX': { 'type': 'integer' },
      'imageY': { 'type': 'integer' },
    },
  },
  'screenshot.manual.start': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'screenshot.manual.frame': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'screenshot.manual.save': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'tab.list': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'scope': { 'type': 'string' },
    },
  },
  'tab.new': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'url': { 'type': 'string' },
      'windowId': { 'type': 'integer', 'minimum': 0 },
      'newWindow': { 'type': 'boolean' },
      'focus': { 'type': 'boolean' },
      'noFocus': { 'type': 'boolean' },
      'incognito': { 'type': 'boolean' },
      'readOnly': { 'type': 'boolean' },
      'allowedOrigins': { 'type': 'string' },
    },
  },
  'tab.policy': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'readOnly': { 'type': 'boolean' },
      'allowedOrigins': { 'type': 'string' },
      'clear': { 'type': 'boolean' },
    },
  },
  'tab.alias': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'action': { 'type': 'string' },
      'alias': { 'type': 'string' },
    },
  },
  'tab.cleanup': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'idleMs': { 'type': 'integer', 'minimum': 0 },
      'dryRun': { 'type': 'boolean' },
    },
  },
  'tab.close': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'tab.select': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'tab.borrow': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'tab.return': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'tab.move': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'windowId': { 'type': 'integer', 'minimum': 0 },
      'index': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'window.list': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'window.close': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'windowId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'window.focus': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'windowId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'window.resize': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'width': { 'type': 'integer', 'minimum': 1 },
      'height': { 'type': 'integer', 'minimum': 1 },
    },
  },
  'window.ensureAgent': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'noFocus': { 'type': 'boolean' },
      'incognito': { 'type': 'boolean' },
      'focus': { 'type': 'boolean' },
    },
  },
  'window.newAgent': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'noFocus': { 'type': 'boolean' },
      'incognito': { 'type': 'boolean' },
      'focus': { 'type': 'boolean' },
    },
  },
  'dialog.list': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'dialog.status': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'dialog.arm': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'alert': { 'type': 'string' },
      'confirm': { 'type': 'string' },
      'prompt': { 'type': 'string' },
      'beforeUnload': { 'type': 'string' },
      'promptText': { 'type': 'string' },
      'queue': { 'type': 'boolean' },
    },
  },
  'dialog.disarm': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'dialog.accept': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'text': { 'type': 'string' },
    },
  },
  'dialog.dismiss': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'dialog.handle': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'accept': { 'type': 'boolean' },
      'dismiss': { 'type': 'boolean' },
      'promptText': { 'type': 'string' },
    },
  },
  'network.start': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'bodies': { 'type': 'boolean' },
    },
  },
  'network.stop': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'network.list': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'filter': { 'type': 'object' },
      'since': { 'type': 'integer', 'minimum': 0 },
      'limit': { 'type': 'integer', 'minimum': 1 },
    },
  },
  'network.detail': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'network.waterfall': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'limit': { 'type': 'integer', 'minimum': 1, 'maximum': 2000 },
    },
  },
  'network.replay': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'debug.start': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'name': { 'type': 'string' },
      'bodies': { 'type': 'boolean' },
    },
  },
  'debug.stop': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'debug.current': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'debug.request': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'debug.performance': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'debug.coverage': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'debug.history': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'debug.delete': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'debug.fetch_probe': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'ms': { 'type': 'integer', 'minimum': 1 },
    },
  },
  'debug.pin': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'debug.pinned': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'debug.capabilities': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'debug.rule_add': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'rule': { 'type': 'object' },
    },
  },
  'debug.rule_list': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'debug.rule_clear': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'debug.rule_enable': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'id': { 'type': 'integer' },
    },
  },
  'debug.rule_disable': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'id': { 'type': 'integer' },
    },
  },
  'debug.rule_remove': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'id': { 'type': 'integer' },
    },
  },
  'debug.rule_export': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'output': { 'type': 'string' },
    },
  },
  'debug.rule_import': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'rules': { 'type': 'array' },
    },
  },
  'video.status': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'recording': { 'type': 'string' },
    },
  },
  'video.list': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'video.fetch': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'recording': { 'type': 'string' },
    },
  },
  'video.discard': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'recording': { 'type': 'string' },
    },
  },
  'video.prune': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'ttlMs': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'video.recover': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'video.verify': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'recording': { 'type': 'string' },
    },
  },
  'record.status': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'cooperate.sync': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'policy': { 'type': 'string' },
      'probeHover': { 'type': 'boolean' },
      'matchText': { 'type': 'string' },
      'contextLines': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'cooperate.hold': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'held': { 'type': 'boolean' },
    },
  },
  'cooperate.wait': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'timeoutMs': { 'type': 'integer', 'minimum': 1 },
    },
  },
  'cooperate.handback': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'operation.await': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'timeoutMs': { 'type': 'integer', 'minimum': 1 },
    },
  },
  'operation.cancel': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'request-help': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'reason': { 'type': 'string' },
      'timeoutMs': { 'type': 'integer', 'minimum': 1 },
    },
  },
  'emulate': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'device': { 'type': 'string' },
      'width': { 'type': 'integer', 'minimum': 1 },
      'height': { 'type': 'integer', 'minimum': 1 },
      'dpr': { 'type': 'number', 'minimum': 0 },
      'mobile': { 'type': 'boolean' },
      'ua': { 'type': 'string' },
      'timezone': { 'type': 'string' },
      'locale': { 'type': 'string' },
      'geolocation': { 'type': 'object' },
      'touch': { 'type': 'boolean' },
      'reset': { 'type': 'boolean' },
    },
  },
  'step': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'action': { 'type': 'object' },
      'untilVisible': { 'type': 'string' },
      'waitTimeoutMs': { 'type': 'integer', 'minimum': 0 },
      'saveFull': { 'type': 'string' },
    },
  },
  'ui.open': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'page': { 'type': 'string' },
      'query': { 'type': 'string' },
    },
  },
  'diagnostics.ui': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'page': { 'type': 'string' },
    },
  },
  'control-hint': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
      'enabled': { 'type': 'boolean' },
    },
  },
  'debugger.detach': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
  'debugger.simulate-detach': {
    'type': 'object',
    'properties': {
      'session': { 'type': 'string', 'minLength': 1 },
      'sessionId': { 'type': 'string', 'minLength': 1 },
      'tabId': { 'type': 'integer', 'minimum': 0 },
    },
  },
};

/** schema 覆盖摘要（生成时快照；运行时可直接读，不需要重算派生表）。 */
export const SCHEMA_COVERAGE: Readonly<SchemaCoverageSummary> = {
  methods: 126,
  schemas: 137,
  covered: 126,
  missing: [],
  withoutEnvelope: ['click', 'drag', 'fill', 'hover', 'press', 'select', 'wheel'],
  validatedMethods: 137,
  propertyCount: 687,
  aliasedMethods: 137,
  envelope: ['session', 'sessionId', 'tabId'],
};
