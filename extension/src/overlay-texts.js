// src/overlay-texts.js —— 把语义语言包组装成各浮层函数需要的 T 对象。
import { OVERLAY_PACKS } from './overlay-locales.js';

function shape(p) {
  return {
    borrow: { title: p.borrowTitle, body: p.borrowBody, target: p.borrowTarget, deny: p.borrowDeny, allow: p.borrowAllow, autoDeny: p.borrowAutoDeny },
    toast: { title: p.toastTitle, target: p.toastTarget, allow: p.toastAllow, deny: p.toastDeny, close: p.toastClose },
    help: { defaultTitle: p.helpTitle, defaultReason: p.helpReason, collapse: p.helpCollapse, placeholder: p.helpPlaceholder, cancel: p.helpCancel, done: p.helpDone, expand: p.helpExpand },
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

export function overlayTexts(lang) {
  return shape(OVERLAY_PACKS[lang] || OVERLAY_PACKS.en);
}
