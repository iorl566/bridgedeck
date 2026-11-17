// src/action-notifications.js — 借用/协助请求的系统通知与待决动作登记。
// 关键点：service worker 内发出的 chrome.runtime.sendMessage 不会回到自己，
// 因此借用流程必须直接调用这里，而不是再绕一条 runtime 消息。

import { overlayTexts } from './overlay-texts.js';

const ACTION_NOTIFICATIONS = new Map(); // notificationId -> { kind, requestId, tabId }
const NOTIFICATION_ICON = 'icons/icon128.png';

export function systemNotification(id, options) {
  if (!chrome.notifications || typeof chrome.notifications.create !== 'function') return;
  try {
    const result = chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: NOTIFICATION_ICON,
      title: 'BridgeDeck',
      priority: 2,
      ...options,
    });
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch {
    // 通知失败不影响主流程。
  }
}

export async function notifyActionRequest(kind, message) {
  const tabId = Number(message && message.tabId);
  const requestId = String((message && message.requestId) || '');
  if (!Number.isInteger(tabId) || !requestId) return { ok: false };
  const id = 'bb-' + kind + '-' + requestId;
  const lang = (message && message.lang) || 'zh';
  const texts = overlayTexts(lang);
  let tabTitle = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    tabTitle = tab.title || tab.url || '';
  } catch {
    // 标签页可能已关闭。
  }
  const safeTitle = String(tabTitle).slice(0, 80);
  const title = kind === 'borrow'
    ? 'BridgeDeck · ' + texts.borrow.title
    : 'BridgeDeck · ' + texts.help.defaultTitle;
  const text = kind === 'borrow'
    ? texts.borrow.body + ' ' + safeTitle
    : texts.help.defaultReason + ' ' + safeTitle;
  const buttons = kind === 'borrow'
    ? [{ title: texts.borrow.allow }, { title: texts.borrow.deny }]
    : [{ title: texts.help.cancel }, { title: texts.help.done }];
  ACTION_NOTIFICATIONS.set(id, { kind, requestId, tabId });
  systemNotification(id, {
    title,
    message: text,
    buttons,
    requireInteraction: true,
  });
  return { ok: true, notificationId: id };
}

export function getActionNotification(notificationId) {
  return ACTION_NOTIFICATIONS.get(notificationId) || null;
}

export function clearActionNotificationById(notificationId) {
  if (!notificationId) return;
  ACTION_NOTIFICATIONS.delete(notificationId);
  try {
    if (chrome.notifications && typeof chrome.notifications.clear === 'function') {
      chrome.notifications.clear(notificationId).catch(() => {});
    }
  } catch {
    // 忽略。
  }
}

export function clearActionNotification(kind, requestId) {
  const id = 'bb-' + kind + '-' + String(requestId || '');
  if (requestId) clearActionNotificationById(id);
}
