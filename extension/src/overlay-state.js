// src/overlay-state.js —— 浮层注册表与截图捕获抑制状态。
//
// 具体状态机在 overlay-controller.js；本模块保留原有导出，供各浮层模块和
// overlay-suppress 共用。
import { createOverlayController } from './overlay-controller.js';

const controller = createOverlayController();

export function openOverlay(tabId, kind, options = {}) {
  return controller.open(tabId, kind, options);
}

export function closeOverlay(tabId, kind, token) {
  return controller.close(tabId, kind, token);
}

export function getOverlayState(tabId) {
  return controller.snapshot(tabId);
}

export function beginCapture(tabId) {
  controller.beginCapture(tabId);
}

export function endCapture(tabId) {
  controller.endCapture(tabId);
}

export function isCapturing(tabId) {
  return controller.isCapturing(tabId);
}
