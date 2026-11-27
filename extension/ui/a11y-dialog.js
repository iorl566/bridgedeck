// ui/a11y-dialog.js —— 扩展页面的可访问确认对话框（无框架、无构建步骤）。
//
// 目标（对标实现 W4-B）：
// - role="dialog" + aria-modal="true" + aria-labelledby/aria-describedby；
// - 焦点陷阱：Tab/Shift+Tab 在对话框内循环，焦点被脚本/鼠标移出时自动拉回；
// - Escape 关闭、点击遮罩取消、关闭后焦点回到打开它的按钮；
// - aria-live 播报打开/关闭与结果，键盘 Enter/Space 原生激活按钮；
// - 背景容器设置 aria-hidden + inert，避免读屏进入被遮挡内容。
//
// 本模块不依赖 chrome.*，可在普通页面/测试夹具中直接使用；样式在首次打开时
// 以 <style> 注入（MV3 扩展页默认 CSP 允许内联样式）。
import { normalizeHintLang } from './error-hints.js';

/** 对话框默认文案（12 语言）。{title} 会被替换为调用方标题。 */
export const DIALOG_TEXT = {
  zh: {
    confirm: '确认', cancel: '取消', close: '关闭', opened: '已打开对话框：{title}', dismissed: '对话框已关闭',
    revokeTitle: '撤销全部配对设备？', revokeBody: '撤销后，其它设备需要重新配对才能连接；此操作无法撤销。', revokeConfirm: '全部撤销',
    clearAuditTitle: '清空任务审计记录？', clearAuditBody: '只清空本机记录，无法恢复。', clearAuditConfirm: '清空记录',
  },
  en: {
    confirm: 'Confirm', cancel: 'Cancel', close: 'Close', opened: 'Dialog opened: {title}', dismissed: 'Dialog closed',
    revokeTitle: 'Revoke all paired devices?', revokeBody: 'Other devices must pair again to connect; this cannot be undone.', revokeConfirm: 'Revoke all',
    clearAuditTitle: 'Clear task audit records?', clearAuditBody: 'Only local records are cleared; this cannot be undone.', clearAuditConfirm: 'Clear records',
  },
  ja: {
    confirm: '確認', cancel: 'キャンセル', close: '閉じる', opened: 'ダイアログを開きました：{title}', dismissed: 'ダイアログを閉じました',
    revokeTitle: 'ペアリング済みの端末をすべて取り消しますか？', revokeBody: '他の端末は再接続時に再度ペアリングが必要です。この操作は取り消せません。', revokeConfirm: 'すべて取り消す',
    clearAuditTitle: 'タスク監査記録を消去しますか？', clearAuditBody: '本機の記録のみ消去され、元に戻せません。', clearAuditConfirm: '記録を消去',
  },
  ko: {
    confirm: '확인', cancel: '취소', close: '닫기', opened: '대화 상자를 열었습니다: {title}', dismissed: '대화 상자를 닫았습니다',
    revokeTitle: '모든 페어링 기기를 취소할까요?', revokeBody: '다른 기기는 다시 페어링해야 연결할 수 있습니다. 이 작업은 되돌릴 수 없습니다.', revokeConfirm: '모두 취소',
    clearAuditTitle: '작업 감사 기록을 지울까요?', clearAuditBody: '이 기기의 기록만 지워지며 되돌릴 수 없습니다.', clearAuditConfirm: '기록 지우기',
  },
  de: {
    confirm: 'Bestätigen', cancel: 'Abbrechen', close: 'Schließen', opened: 'Dialog geöffnet: {title}', dismissed: 'Dialog geschlossen',
    revokeTitle: 'Alle gekoppelten Geräte widerrufen?', revokeBody: 'Andere Geräte müssen sich erneut koppeln. Dies kann nicht rückgängig gemacht werden.', revokeConfirm: 'Alle widerrufen',
    clearAuditTitle: 'Aufgaben-Auditprotokoll löschen?', clearAuditBody: 'Nur lokale Datensätze werden gelöscht; dies kann nicht rückgängig gemacht werden.', clearAuditConfirm: 'Protokoll löschen',
  },
  es: {
    confirm: 'Confirmar', cancel: 'Cancelar', close: 'Cerrar', opened: 'Diálogo abierto: {title}', dismissed: 'Diálogo cerrado',
    revokeTitle: '¿Revocar todos los dispositivos emparejados?', revokeBody: 'Los demás dispositivos deberán emparejarse de nuevo; esta acción no se puede deshacer.', revokeConfirm: 'Revocar todo',
    clearAuditTitle: '¿Borrar los registros de auditoría?', clearAuditBody: 'Solo se borran los registros locales; no se puede deshacer.', clearAuditConfirm: 'Borrar registros',
  },
  fr: {
    confirm: 'Confirmer', cancel: 'Annuler', close: 'Fermer', opened: 'Boîte de dialogue ouverte : {title}', dismissed: 'Boîte de dialogue fermée',
    revokeTitle: 'Révoquer tous les appareils appairés ?', revokeBody: "Les autres appareils devront s'appairer à nouveau ; cette action est irréversible.", revokeConfirm: 'Tout révoquer',
    clearAuditTitle: "Effacer le journal d'audit ?", clearAuditBody: 'Seuls les enregistrements locaux sont effacés ; action irréversible.', clearAuditConfirm: 'Effacer les enregistrements',
  },
  it: {
    confirm: 'Conferma', cancel: 'Annulla', close: 'Chiudi', opened: 'Finestra di dialogo aperta: {title}', dismissed: 'Finestra di dialogo chiusa',
    revokeTitle: 'Revocare tutti i dispositivi associati?', revokeBody: 'Gli altri dispositivi dovranno riassociarsi; questa azione non è reversibile.', revokeConfirm: 'Revoca tutto',
    clearAuditTitle: 'Cancellare i registri di audit?', clearAuditBody: 'Vengono cancellati solo i registri locali; azione irreversibile.', clearAuditConfirm: 'Cancella registri',
  },
  pt: {
    confirm: 'Confirmar', cancel: 'Cancelar', close: 'Fechar', opened: 'Caixa de diálogo aberta: {title}', dismissed: 'Caixa de diálogo fechada',
    revokeTitle: 'Revogar todos os dispositivos emparelhados?', revokeBody: 'Os outros dispositivos precisarão emparelhar novamente; isto não pode ser desfeito.', revokeConfirm: 'Revogar tudo',
    clearAuditTitle: 'Limpar os registros de auditoria?', clearAuditBody: 'Apenas os registros locais são apagados; não pode ser desfeito.', clearAuditConfirm: 'Limpar registros',
  },
  'zh-TW': {
    confirm: '確認', cancel: '取消', close: '關閉', opened: '已開啟對話框：{title}', dismissed: '對話框已關閉',
    revokeTitle: '撤銷全部配對裝置？', revokeBody: '撤銷後，其它裝置需要重新配對才能連線；此操作無法復原。', revokeConfirm: '全部撤銷',
    clearAuditTitle: '清除任務稽核記錄？', clearAuditBody: '只會清除本機記錄，無法復原。', clearAuditConfirm: '清除記錄',
  },
  ar: {
    confirm: 'تأكيد', cancel: 'إلغاء', close: 'إغلاق', opened: 'تم فتح مربع الحوار: {title}', dismissed: 'تم إغلاق مربع الحوار',
    revokeTitle: 'إلغاء جميع الأجهزة المقترنة؟', revokeBody: 'ستحتاج الأجهزة الأخرى إلى الاقتران مجددًا؛ لا يمكن التراجع عن هذا الإجراء.', revokeConfirm: 'إلغاء الكل',
    clearAuditTitle: 'مسح سجلات تدقيق المهام؟', clearAuditBody: 'تُمسح السجلات المحلية فقط؛ لا يمكن التراجع.', clearAuditConfirm: 'مسح السجلات',
  },
  he: {
    confirm: 'אישור', cancel: 'ביטול', close: 'סגירה', opened: 'נפתח תיבת דו-שיח: {title}', dismissed: 'תיבת הדו-שיח נסגרה',
    revokeTitle: 'לבטל את כל ההתקנים המצומדים?', revokeBody: 'התקנים אחרים יצטרכו להצטמד מחדש; לא ניתן לבטל פעולה זו.', revokeConfirm: 'בטל הכול',
    clearAuditTitle: 'לנקות את יומן הביקורת?', clearAuditBody: 'רק רשומות מקומיות נמחקות; לא ניתן לשחזר.', clearAuditConfirm: 'נקה רשומות',
  },
};

export const DIALOG_TEXT_KEYS = [
  'confirm', 'cancel', 'close', 'opened', 'dismissed',
  'revokeTitle', 'revokeBody', 'revokeConfirm',
  'clearAuditTitle', 'clearAuditBody', 'clearAuditConfirm',
];

/** 返回某语言的对话框文案；未知语言回退英文，缺字段回退英文同类字段。 */
export function dialogText(lang, overrides) {
  const key = normalizeHintLang(lang);
  const base = DIALOG_TEXT[key] || DIALOG_TEXT.en;
  const merged = { ...DIALOG_TEXT.en, ...base, ...(overrides || {}) };
  return merged;
}

/** 可聚焦元素选择器：只覆盖对话框里实际会出现的控件。 */
export const TABBABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const STYLE_ID = 'bb-a11y-dialog-style';
const DIALOG_STYLE = [
  '.bb-dialog-layer{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;',
  'background:var(--bb-backdrop,rgba(15,23,42,.42));-webkit-backdrop-filter:blur(1px);backdrop-filter:blur(1px);}',
  '.bb-dialog{position:relative;box-sizing:border-box;width:min(360px,calc(100vw - 32px));border-radius:14px;padding:18px 18px 14px;',
  'background:var(--bb-surface-raised,#fff);color:var(--bb-fg,#1c2230);border:1px solid var(--bb-line,#dbe4f5);',
  'box-shadow:0 18px 48px var(--bb-shadow-strong,rgba(28,34,48,.28));font:13px/1.5 system-ui,"Segoe UI",sans-serif;',
  'text-align:start;direction:inherit;}',
  '.bb-dialog:focus{outline:none;}',
  '.bb-dialog-title{margin:0 24px 6px 0;font-size:15px;font-weight:650;line-height:1.35;}',
  '[dir="rtl"] .bb-dialog-title{margin:0 0 6px 24px;}',
  '.bb-dialog-body{margin:0;color:var(--bb-body,#475569);font-size:12.5px;line-height:1.55;white-space:pre-wrap;}',
  '.bb-dialog-actions{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:14px;}',
  '.bb-dialog-btn{font:inherit;font-size:12.5px;min-height:32px;padding:6px 12px;border-radius:8px;cursor:pointer;',
  'border:1px solid var(--bb-line,#dbe4f5);background:var(--bb-surface,#f7f9fc);color:var(--bb-fg,#1c2230);}',
  '.bb-dialog-btn:hover{border-color:var(--bb-accent,#2f6fed);}',
  '.bb-dialog-btn[data-confirm]{background:var(--bb-accent,#2f6fed);border-color:var(--bb-accent,#2f6fed);color:var(--bb-accent-fg,#fff);}',
  '.bb-dialog-btn[data-tone="danger"]{background:var(--bb-danger,#d92d20);border-color:var(--bb-danger,#d92d20);color:var(--bb-accent-fg,#fff);}',
  '.bb-dialog-close{position:absolute;inset-block-start:8px;inset-inline-end:8px;width:26px;height:26px;line-height:1;',
  'border:0;border-radius:8px;background:transparent;color:var(--bb-muted,#667085);font-size:16px;cursor:pointer;}',
  '.bb-dialog-close:hover{background:var(--bb-surface,#f7f9fc);color:var(--bb-fg,#1c2230);}',
  '.bb-dialog :focus-visible{outline:2px solid var(--bb-accent,#2f6fed);outline-offset:2px;}',
  '.bb-a11y-live{position:absolute!important;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;',
  'clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0;}',
].join('');

/** 元素是否渲染可见（对话框内的 Tab 顺序只看可见控件）。 */
export function isVisible(element) {
  if (!element || typeof element.getBoundingClientRect !== 'function') return false;
  const style = element.ownerDocument && element.ownerDocument.defaultView
    ? element.ownerDocument.defaultView.getComputedStyle(element)
    : null;
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 || element === element.ownerDocument?.activeElement;
}

/** 元素是否可按 Tab 聚焦（可见、未禁用、非 tabindex=-1、未 aria-hidden）。 */
export function isTabbable(element) {
  if (!element || element.disabled) return false;
  const tabindex = element.getAttribute && element.getAttribute('tabindex');
  if (tabindex === '-1') return false;
  if (element.closest && element.closest('[aria-hidden="true"],[inert]')) return false;
  return isVisible(element);
}

/** 容器内按 DOM 顺序的全部可 Tab 聚焦元素。 */
export function tabbable(container) {
  if (!container || typeof container.querySelectorAll !== 'function') return [];
  return [...container.querySelectorAll(TABBABLE_SELECTOR)].filter(isTabbable);
}

/** 把背景兄弟节点设为 aria-hidden+inert；返回恢复函数。 */
export function isolateBackground(keepNode, root) {
  const doc = (keepNode && keepNode.ownerDocument) || document;
  const top = root || doc.body;
  if (!top || !keepNode || !top.contains(keepNode)) return () => {};
  const changed = [];
  let node = keepNode;
  while (node && node !== top) {
    const parent = node.parentElement;
    if (!parent) break;
    for (const sibling of parent.children) {
      if (sibling === node) continue;
      if (sibling.hasAttribute && sibling.hasAttribute('data-bb-announcer')) continue;
      if (sibling.hasAttribute && sibling.hasAttribute('data-bb-dialog-layer')) continue;
      changed.push({
        element: sibling,
        ariaHidden: sibling.getAttribute('aria-hidden'),
        inert: sibling.hasAttribute('inert'),
      });
      sibling.setAttribute('aria-hidden', 'true');
      try { sibling.inert = true; } catch { /* 老浏览器只有 aria-hidden */ }
    }
    node = parent;
  }
  return () => {
    for (const item of changed) {
      if (item.ariaHidden === null) item.element.removeAttribute('aria-hidden');
      else item.element.setAttribute('aria-hidden', item.ariaHidden);
      if (!item.inert) {
        try { item.element.inert = false; } catch { /* 忽略 */ }
      }
    }
  };
}

let liveRegion = null;

/** 获取（或创建）共享 aria-live 播报区；位于 body 顶层且不被背景隔离。 */
export function liveRegionNode() {
  if (liveRegion && liveRegion.isConnected) return liveRegion;
  liveRegion = document.querySelector('[data-bb-announcer]');
  if (liveRegion) return liveRegion;
  liveRegion = document.createElement('div');
  liveRegion.className = 'bb-a11y-live';
  liveRegion.setAttribute('data-bb-announcer', '');
  liveRegion.setAttribute('role', 'status');
  liveRegion.setAttribute('aria-live', 'polite');
  liveRegion.setAttribute('aria-atomic', 'true');
  document.body.appendChild(liveRegion);
  return liveRegion;
}

/** 向共享 live region 播报；先清空再写入，保证同一句话重复播报也会触发。 */
export function announce(message, options = {}) {
  const text = String(message || '').trim();
  if (!text) return false;
  const region = options.region || liveRegionNode();
  region.setAttribute('aria-live', options.politeness === 'assertive' ? 'assertive' : 'polite');
  region.textContent = '';
  const win = region.ownerDocument.defaultView;
  const write = () => { region.textContent = text; };
  // 先清空再用一个宏任务写入：同一句话重复播报也会被读屏再次读出。
  // 用 setTimeout 而非 rAF，避免页面后台/无渲染帧时播报丢失（也便于真实 DOM 测试确定断言）。
  if (win && typeof win.setTimeout === 'function') win.setTimeout(write, 0);
  else write();
  return true;
}

/** 清空播报区（对话框关闭/测试清理用）。 */
export function clearAnnouncements() {
  if (liveRegion && liveRegion.isConnected) liveRegion.textContent = '';
}

/** 注入对话框样式（幂等）。 */
export function ensureDialogStyles(doc = document) {
  if (!doc || !doc.head) return null;
  const existing = doc.getElementById(STYLE_ID);
  if (existing) return existing;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = DIALOG_STYLE;
  doc.head.appendChild(style);
  return style;
}

/**
 * 创建焦点陷阱。
 * @param {Element} container 对话框根节点
 * @param {{ initialFocus?: Element, returnFocus?: boolean, onEscape?: (event: KeyboardEvent) => void }} [options]
 */
export function createFocusTrap(container, options = {}) {
  const doc = container.ownerDocument;
  const previous = doc.activeElement;
  const returnFocus = options.returnFocus !== false;
  let active = false;
  let guard = false;

  function focusFirst() {
    const items = tabbable(container);
    const target = options.initialFocus && items.includes(options.initialFocus) ? options.initialFocus : items[0] || container;
    if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
  }

  function onKeydown(event) {
    if (!active) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (typeof options.onEscape === 'function') options.onEscape(event);
      return;
    }
    if (event.key !== 'Tab') return;
    const items = tabbable(container);
    if (!items.length) {
      event.preventDefault();
      container.focus({ preventScroll: true });
      return;
    }
    // 显式移动焦点（而不是依赖浏览器默认 Tab 行为）：焦点被程序移出、或在卡片容器上
    // 按 Tab 时也能进入正确位置；真实浏览器里效果与原生 Tab 顺序一致。
    event.preventDefault();
    const current = items.indexOf(doc.activeElement);
    const next = event.shiftKey
      ? (current <= 0 ? items.length - 1 : current - 1)
      : (current === -1 || current === items.length - 1 ? 0 : current + 1);
    items[next].focus({ preventScroll: true });
  }

  function onFocusIn(event) {
    if (!active || guard) return;
    if (event.target && container.contains(event.target)) return;
    guard = true;
    try { focusFirst(); } finally { guard = false; }
  }

  return {
    get active() { return active; },
    activate() {
      if (active) return;
      active = true;
      doc.addEventListener('keydown', onKeydown, true);
      doc.addEventListener('focusin', onFocusIn, true);
      focusFirst();
    },
    deactivate() {
      if (!active) return;
      active = false;
      doc.removeEventListener('keydown', onKeydown, true);
      doc.removeEventListener('focusin', onFocusIn, true);
      if (returnFocus && previous && previous.isConnected && typeof previous.focus === 'function') {
        previous.focus({ preventScroll: true });
      }
    },
    handleKeydown: onKeydown,
    items: () => tabbable(container),
    focusFirst,
  };
}

const activeDialogs = new Set();

/** 是否有打开的对话框（面板/快捷键可用它避免重复打开）。 */
export function isDialogOpen() {
  return activeDialogs.size > 0;
}

/** 关闭全部对话框（页面卸载/测试清理用）。 */
export function closeAllDialogs() {
  for (const dialog of [...activeDialogs]) dialog.close({ confirmed: false, via: 'close-all' });
}

function buildDialog(options, text) {
  const doc = options.document || document;
  ensureDialogStyles(doc);
  const layer = doc.createElement('div');
  layer.className = 'bb-dialog-layer';
  layer.setAttribute('data-bb-dialog-layer', '');
  const card = doc.createElement('div');
  card.className = 'bb-dialog';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('tabindex', '-1');
  if (options.tone === 'danger') card.setAttribute('data-tone', 'danger');
  const titleId = 'bb-dialog-title-' + Math.random().toString(36).slice(2, 9);
  const bodyId = 'bb-dialog-body-' + Math.random().toString(36).slice(2, 9);
  card.setAttribute('aria-labelledby', titleId);
  if (options.body) card.setAttribute('aria-describedby', bodyId);
  const title = doc.createElement('h2');
  title.className = 'bb-dialog-title';
  title.id = titleId;
  title.textContent = String(options.title || '');
  const body = doc.createElement('p');
  body.className = 'bb-dialog-body';
  body.id = bodyId;
  body.textContent = String(options.body || '');
  const actions = doc.createElement('div');
  actions.className = 'bb-dialog-actions';
  const cancel = doc.createElement('button');
  cancel.type = 'button';
  cancel.className = 'bb-dialog-btn';
  cancel.setAttribute('data-cancel', '');
  cancel.textContent = options.cancelLabel || text.cancel;
  const confirm = doc.createElement('button');
  confirm.type = 'button';
  confirm.className = 'bb-dialog-btn';
  confirm.setAttribute('data-confirm', '');
  if (options.tone === 'danger') confirm.setAttribute('data-tone', 'danger');
  confirm.textContent = options.confirmLabel || text.confirm;
  actions.append(cancel, confirm);
  if (options.closable !== false) {
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'bb-dialog-close';
    close.setAttribute('data-close', '');
    close.setAttribute('aria-label', options.closeLabel || text.close);
    close.textContent = '×';
    card.append(close);
  }
  card.append(title, body, actions);
  layer.append(card);
  return { layer, card, title, body, cancel, confirm };
}

/**
 * 打开一个可访问确认对话框。
 * @returns {{ element: HTMLElement, result: Promise<{confirmed: boolean, via: string, elapsedMs: number}>, close: Function }}
 */
export function openDialog(options = {}) {
  const doc = options.document || document;
  const lang = normalizeHintLang(options.lang);
  const text = dialogText(lang);
  const built = buildDialog(options, text);
  const { layer, card, cancel, confirm } = built;
  const started = Date.now();
  let settled = false;
  let resolveResult;
  const result = new Promise((resolve) => { resolveResult = resolve; });
  const trap = createFocusTrap(card, {
    initialFocus: options.initialFocus === 'confirm' ? confirm : options.initialFocus === 'card' ? card : cancel,
    returnFocus: options.returnFocus !== false,
    onEscape: () => finish({ confirmed: false, via: 'escape' }),
  });
  let restoreBackground = () => {};

  function finish(outcome) {
    if (settled) return;
    settled = true;
    // 先恢复背景再还焦点：背景此刻可能还带 inert/aria-hidden，直接在 inert 容器里
    // focus() 会被浏览器忽略，导致焦点停在 body。
    restoreBackground();
    trap.deactivate();
    layer.remove();
    activeDialogs.delete(api);
    announce(text.dismissed, { politeness: 'polite' });
    if (typeof options.onClose === 'function') {
      try { options.onClose(outcome); } catch (error) { console.error('dialog onClose failed', error); }
    }
    resolveResult({ ...outcome, elapsedMs: Date.now() - started });
  }

  const api = {
    element: layer,
    card,
    result,
    close: finish,
    get settled() { return settled; },
  };
  activeDialogs.add(api);

  cancel.addEventListener('click', () => finish({ confirmed: false, via: 'cancel' }));
  confirm.addEventListener('click', () => finish({ confirmed: true, via: 'confirm' }));
  layer.addEventListener('click', (event) => {
    if (event.target === layer) finish({ confirmed: false, via: 'backdrop' });
  });
  built.layer.addEventListener('keydown', (event) => {
    // 键盘 Enter/Space 交给按钮原生行为；这里只处理“焦点在卡片上时按 Enter = 取消”
    // 与数字快捷键，避免误触发破坏性确认。
    if (event.key === 'Enter' && event.target === card) {
      event.preventDefault();
      finish({ confirmed: false, via: 'keyboard' });
    }
  });
  // 关闭按钮：closable === false 时不存在，用可选链注册。
  layer.querySelector('[data-close]')?.addEventListener('click', () => finish({ confirmed: false, via: 'close' }));

  doc.body.appendChild(layer);
  restoreBackground = isolateBackground(layer, doc.body);
  announce(text.opened.replace('{title}', String(options.title || '')), { politeness: 'polite' });
  trap.activate();
  if (typeof options.onOpen === 'function') options.onOpen(api);
  return api;
}
