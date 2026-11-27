// src/overlay-texts.js —— 把语义语言包组装成各浮层函数需要的 T 对象。
//
// 同时是内容侧三类文案的**统一查表入口**：
//   1. 浮层语言包（overlay-locales.js 的 54 个语义串，12 语言）；
//   2. 动态文案（overlay-dynamic-locales.js 的拼接句子模板，12 语言）；
//   3. 错误码提示（ui/error-hints.js 的 12 语言提示）。
// 三者共用同一套语言归一化与“缺语言回退英文”策略，调用点不需要各自处理
// zh-Hant / iw / 无 lang 等写法。
import { OVERLAY_PACKS } from './overlay-locales.js';
import { dynamicText, normalizeDynamicLang } from './overlay-dynamic-locales.js';
import { hintForCode, normalizeHintLang, unknownHint } from '../ui/error-hints.js';

function shape(p) {
  return {
    borrow: { title: p.borrowTitle, inactiveTitle: p.borrowInactiveTitle, body: p.borrowBody, target: p.borrowTarget, deny: p.borrowDeny, allow: p.borrowAllow, autoDeny: p.borrowAutoDeny },
    toast: { title: p.toastTitle, target: p.toastTarget, allow: p.toastAllow, deny: p.toastDeny, close: p.toastClose },
    help: { defaultTitle: p.helpTitle, defaultReason: p.helpReason, compactStatus: p.helpCompactStatus, collapse: p.helpCollapse, placeholder: p.helpPlaceholder, cancel: p.helpCancel, done: p.helpDone, expand: p.helpExpand },
    takeover: {
      ready: [p.takeoverReadyTitle, p.takeoverReadySub],
      acting: [p.takeoverActingTitle, p.takeoverActingSub],
      syncing: [p.takeoverSyncingTitle, p.takeoverSyncingSub],
      held: [p.takeoverHeldTitle, p.takeoverHeldSub],
      human: [p.takeoverHumanTitle, p.takeoverHumanSub],
      editing: [p.takeoverEditingTitle, p.takeoverEditingSub],
      yielding: [p.takeoverYieldingTitle, p.takeoverYieldingSub],
      unavailable: [p.takeoverUnavailableTitle, p.takeoverUnavailableSub],
      borrowed: p.takeoverBorrowed, pause: p.takeoverPause, resume: p.takeoverResume, stop: p.takeoverStop,
      confirmStop: p.takeoverConfirmStop, stopConfirmSub: p.takeoverStopConfirmSub, stopping: p.takeoverStopping,
      mini: p.takeoverMini, project: p.takeoverProject, session: p.takeoverSession, badge: p.takeoverBadge,
      controlling: p.takeoverControlling, reading: p.takeoverReading,
    },
    record: { label: p.recordLabel, finish: p.recordFinish },
    manual: { label: p.manualLabel, frame: p.manualFrame, done: p.manualDone, cancel: p.manualCancel, frames: p.manualFrames },
  };
}

/** 浮层语言归一化：与动态文案/错误提示同一套写法（zh-TW、zh-Hant、iw、无 lang 兜底 en）。 */
export function overlayLang(lang) {
  const dynamic = normalizeDynamicLang(lang);
  if (OVERLAY_PACKS[dynamic]) return dynamic;
  const hint = normalizeHintLang(lang);
  return OVERLAY_PACKS[hint] ? hint : 'en';
}

export function overlayTexts(lang) {
  return shape(OVERLAY_PACKS[overlayLang(lang)] || OVERLAY_PACKS.en);
}

/**
 * 每类浮层的可访问性/播报文案 → 动态文案 catalog 的 key。
 * 注入函数拿到的 `dynamic` 参数就是这里按语言展开后的扁平对象。
 */
export const A11Y_TEXT_KEYS = Object.freeze({
  record: {
    label: 'overlay.record.label',
    start: 'overlay.record.start',
    elapsed: 'overlay.record.elapsed',
    finished: 'overlay.record.finished',
    escHint: 'overlay.record.escHint',
  },
  takeover: {
    label: 'overlay.takeover.label',
    minimize: 'overlay.takeover.minimize',
    collapsed: 'overlay.takeover.collapsed',
    expanded: 'overlay.takeover.expanded',
    paused: 'overlay.takeover.paused',
    resumed: 'overlay.takeover.resumed',
    stopArmed: 'overlay.takeover.stopArmed',
    stopping: 'overlay.takeover.stopping',
    stopped: 'overlay.takeover.stopped',
    escHint: 'overlay.takeover.escHint',
  },
  borrow: {
    label: 'overlay.borrow.dialogLabel',
    escHint: 'overlay.borrow.escHint',
    countdown: 'overlay.borrow.countdown',
  },
  toast: {
    label: 'overlay.toast.label',
    escHint: 'overlay.toast.escHint',
    dismissed: 'overlay.toast.dismissed',
  },
  dialog: {
    opened: 'overlay.dialog.opened',
    closed: 'overlay.dialog.closed',
    focusTrapped: 'overlay.focus.trapped',
    focusRestored: 'overlay.focus.restored',
  },
});

/** 单条动态文案（按浮层语言归一化后查表）。 */
export function overlayDynamicText(lang, key, params) {
  return dynamicText(overlayLang(lang), key, params);
}

/** 一组浮层播报文案：{ record: {...}, takeover: {...}, borrow: {...}, toast: {...}, dialog: {...} }。 */
export function overlayA11yTexts(lang) {
  const code = overlayLang(lang);
  const out = {};
  for (const [surface, fields] of Object.entries(A11Y_TEXT_KEYS)) {
    const group = {};
    for (const [field, key] of Object.entries(fields)) group[field] = dynamicText(code, key);
    out[surface] = group;
  }
  return out;
}

/** 错误码 → 该语言提示（与 error-hints 同一个查表入口；未知码走该语言未知提示）。 */
export function overlayErrorText(code, lang) {
  return hintForCode(code, overlayLang(lang));
}

/** 某语言的未知错误兜底提示（浮层里没有错误码时用）。 */
export function overlayUnknownErrorText(lang) {
  return unknownHint(overlayLang(lang));
}
