// 该文件由 translation/build-dynamic-texts.mjs 从 translation/dynamic-texts.mjs 生成；请勿手改。
// 动态文案（拼接句子）12 语言查表：与 overlay-locales.js / error-hints.js 共用语言归一化与回退策略。
// 词条数据按分片文件存放（每个生成物都受 src 文件复杂度预算约束）。

import { DYNAMIC_TEXT_SHARD_1 } from './overlay-dynamic-locales-1.js';
import { DYNAMIC_TEXT_SHARD_2 } from './overlay-dynamic-locales-2.js';
import { DYNAMIC_TEXT_SHARD_3 } from './overlay-dynamic-locales-3.js';

export const DYNAMIC_LANGS = ["zh","en","ja","ko","de","es","fr","it","pt","zh-TW","ar","he"];
export const DYNAMIC_DEFAULT_LANG = "en";

export const DYNAMIC_KEYS = [
  "overlay.record.label",
  "overlay.record.start",
  "overlay.record.elapsed",
  "overlay.record.finished",
  "overlay.record.escHint",
  "overlay.takeover.label",
  "overlay.takeover.collapsed",
  "overlay.takeover.expanded",
  "overlay.takeover.paused",
  "overlay.takeover.resumed",
  "overlay.takeover.stopArmed",
  "overlay.takeover.stopping",
  "overlay.takeover.stopped",
  "overlay.takeover.escHint",
  "overlay.borrow.dialogLabel",
  "overlay.borrow.escHint",
  "overlay.borrow.countdown",
  "overlay.toast.label",
  "overlay.toast.escHint",
  "overlay.toast.dismissed",
  "overlay.dialog.opened",
  "overlay.dialog.closed",
  "overlay.focus.trapped",
  "overlay.focus.restored",
  "longshot.list.row",
  "longshot.restore.missing",
  "longshot.restore.done",
  "longshot.restore.failed",
  "longshot.frame.count",
  "longshot.frame.captured",
  "longshot.stitch.done",
  "longshot.saved",
  "debug.replay.done",
  "debug.capture.collecting",
  "debug.history.row",
  "debug.saved",
  "debug.history.fallbackTitle",
  "record.ui.status",
  "record.ui.openFailed",
  "record.ui.started",
  "record.ui.title",
  "ops.ui.status",
  "ops.ui.row",
  "ops.ui.saved",
  "ops.ui.fallbackTitle",
  "preview.updated",
  "preview.unavailable",
  "preview.untitled",
  "audit.summary",
  "longshot.recover.noTiles",
  "longshot.recover.manifestInvalid",
  "longshot.recover.registerRejected",
  "longshot.persist.tooLarge",
  "longshot.persist.failed",
  "longshot.persist.pruneFailed",
  "longshot.persist.saved",
  "tiled.segment.noData",
  "tiled.tile.noData",
  "tiled.segmentPlan",
  "tiled.budget",
  "tiled.indexWriteFailed",
  "tiled.indexSealFailed",
  "tiled.manifestSealFailed",
  "tiled.sealRejected",
  "tiled.beginRejected",
  "tiled.tailGrown",
  "tiled.contentChanged",
  "tiled.staleDetected",
  "tiled.staleRejected",
  "tiled.fixedBandFailed",
  "tiled.planSelfCheckFailed",
  "tiled.persistFailed",
  "tiled.tileHashMismatch",
  "tiled.tileReadbackFailed",
  "tiled.fixedBandMeasureFailed",
  "tiled.chromeRedrawFailed",
  "tiled.tileSummary",
  "longshot.budget.widthClamped",
  "longshot.budget.dprReduced",
  "longshot.budget.heightClamped",
  "longshot.budget.pixelsClamped",
  "longshot.budget.segmentsRaised",
  "longshot.budget.segmentsClamped",
  "longshot.budget.summary",
  "longshot.budget.degraded",
  "longshot.budget.truncated",
  "longshot.manifest.sealRejected",
  "longshot.manifest.versionMismatch",
  "longshot.manifest.dprRange",
  "longshot.manifest.tileCountAboveTotal",
  "longshot.manifest.duplicateIndex",
  "longshot.manifest.indexAboveTotal",
  "longshot.manifest.badHash",
  "longshot.manifest.sealedCountMismatch",
  "longshot.manifest.missingTile",
  "longshot.manifest.invalidJson",
  "longshot.manifest.segmentCount",
  "longshot.recovery.unrecoverable",
  "longshot.recovery.restored",
  "longshot.segments.overlap",
  "longshot.segments.fractionalDpr",
  "longshot.segments.gap",
  "longshot.segments.coverMismatch",
  "longshot.segments.describe",
  "longshot.state.duplicateTransition",
  "longshot.state.unknown",
  "longshot.state.pendingTiles",
  "longshot.state.staleLimit",
  "longshot.state.illegalTransition",
  "screenshot.hitCheck.unavailable",
  "screenshot.coord.empty",
  "screenshot.pointerNone",
  "screenshot.covered",
  "screenshot.candidate.mismatch",
  "screenshot.candidate.missing",
  "screenshot.failed",
  "screenshot.failed.cdpDetail",
  "screenshot.serializeFailed",
  "screenshot.stitched",
  "screenshot.stale",
  "screenshot.geometryChanged",
  "screenshot.cdpFallback",
  "screenshot.diffFailed",
  "debug.session.busy",
  "debug.events.pinNeedsId",
  "debug.noSession",
  "debug.record.missing",
  "debug.history.saveDegraded",
  "debugger.attachFailed",
  "rules.inject.failed",
  "rules.notFound",
  "rules.fetch.failed",
  "rules.fetchSync.failed",
  "rules.dnrSync.failed",
  "ops.inject.failed",
  "ops.session.missing",
  "ops.record.restricted",
  "ops.record.started",
  "ops.record.ended",
  "ops.record.resumed",
  "ops.record.reattached",
  "ops.persist.failed",
  "operations.unknown",
  "record.steps.redacted",
  "bridge.dialog.pending",
  "bridge.method.timeout",
  "bridge.command.deadline",
  "bridge.dialog.native",
  "bridge.notify.recordSaved",
  "bridge.notify.recordFailed",
  "overlay.takeover.minimize",
];

export const DYNAMIC_TEXT = {
  ...DYNAMIC_TEXT_SHARD_1,
  ...DYNAMIC_TEXT_SHARD_2,
  ...DYNAMIC_TEXT_SHARD_3,
};

const CATALOG_SCRIPT = {
  ja: /[\u3040-\u30ff\u4e00-\u9fff]/,
  ko: /[\uac00-\ud7af]/,
  'zh-TW': /[\u4e00-\u9fff]/,
  ar: /[\u0600-\u06ff]/,
  he: /[\u0590-\u05ff]/,
};
const PLACEHOLDER = /\{([a-zA-Z_$][\w$]*|\d+)\}/g;

/** 语言标签归一化：与 overlay 语言包 / 错误提示同一套写法（zh-TW、iw、zh-Hant 等）。 */
export function normalizeDynamicLang(tag) {
  const raw = String(tag || '').trim();
  if (!raw) return DYNAMIC_DEFAULT_LANG;
  const lower = raw.toLowerCase().replace(/_/g, '-');
  if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-hant' || lower.startsWith('zh-hant-')) return 'zh-TW';
  if (lower.startsWith('zh')) return 'zh';
  if (lower.startsWith('iw') || lower.startsWith('he')) return 'he';
  for (const lang of DYNAMIC_LANGS) {
    if (lang === 'zh' || lang === 'zh-TW') continue;
    if (lower === lang || lower.startsWith(lang + '-')) return lang;
  }
  return DYNAMIC_DEFAULT_LANG;
}

/** 词条是否存在。 */
export function hasDynamicText(key) {
  return Object.prototype.hasOwnProperty.call(DYNAMIC_TEXT, key);
}

/** 词条是否存在真正本地化的文案（12 语言门禁的自检入口）。 */
export function hasLocalizedDynamicText(key, lang) {
  const key2 = normalizeDynamicLang(lang);
  const row = DYNAMIC_TEXT[key];
  if (!row) return false;
  const value = row[key2];
  if (typeof value !== 'string' || !value.trim()) return false;
  const pattern = CATALOG_SCRIPT[key2];
  return pattern ? pattern.test(value) : true;
}

/** 把模板里的 {name}/{0} 换成参数；缺参数原样保留，便于发现调用点漏传。 */
export function formatDynamic(template, params) {
  const text = String(template || '');
  if (!params || typeof params !== 'object') return text;
  return text.replace(PLACEHOLDER, (whole, name) => {
    if (Object.prototype.hasOwnProperty.call(params, name)) return String(params[name]);
    const numeric = Number(name);
    if (Number.isInteger(numeric) && Object.prototype.hasOwnProperty.call(params, numeric)) return String(params[numeric]);
    return whole;
  });
}

/** 动态文案查表入口：语言归一化 → 词条 → 参数渲染；未知词条返回空串（由调用点兜底）。 */
export function dynamicText(lang, key, params) {
  const table = DYNAMIC_TEXT[key];
  if (!table) return '';
  const normalized = normalizeDynamicLang(lang);
  const template = table[normalized] !== undefined ? table[normalized] : table[DYNAMIC_DEFAULT_LANG];
  if (template === undefined) return '';
  return formatDynamic(template, params);
}

/** 返回某语言下全部缺词条 key（门禁/诊断用）。 */
export function missingDynamicKeys(keys, lang) {
  const normalized = normalizeDynamicLang(lang);
  return (Array.isArray(keys) ? keys : []).filter((key) => {
    const row = DYNAMIC_TEXT[key];
    if (!row) return true;
    const value = row[normalized];
    return typeof value !== 'string' || !value.trim();
  });
}
