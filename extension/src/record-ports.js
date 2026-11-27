// src/record-ports.js —— per-document record Port 注册表。
// 每个 Port 记录它使用的录制 step 模型版本，导出快照时能区分“旧录制器 / v2 录制器”。
import { RECORD_STEP_VERSION } from './record-steps.js';

const ports = new Map(); // `${tabId}:${frameId}:${documentId}` -> entry
let installed = false;

export function installRecordPorts() {
  if (installed) return;
  installed = true;
  chrome.runtime.onConnect.addListener((port) => {
    if (!port || port.name !== 'bb-record') return;
    const tabId = port.sender && port.sender.tab && Number.isInteger(port.sender.tab.id) ? port.sender.tab.id : null;
    if (tabId == null) return;
    const frameId = port.sender && Number.isInteger(port.sender.frameId) ? port.sender.frameId : 0;
    const documentId = port.sender && port.sender.documentId ? String(port.sender.documentId) : null;
    const key = tabId + ':' + frameId + ':' + (documentId || '');
    const entry = { port, tabId, frameId, documentId, url: '', at: Date.now(), stepModel: RECORD_STEP_VERSION };
    ports.set(key, entry);
    port.onMessage.addListener((message) => {
      if (!message || message.type !== 'bb.record.ready') return;
      entry.documentId = message.documentId || entry.documentId;
      entry.url = message.frameUrl || '';
      entry.at = Date.now();
      if (Number.isInteger(message.stepModel) && message.stepModel > 0) entry.stepModel = message.stepModel;
    });
    port.onDisconnect.addListener(() => { ports.delete(key); });
  });
}

export function recordPortSnapshot(tabId) {
  const id = Number(tabId);
  return [...ports.values()].filter((entry) => entry.tabId === id).map((entry) => ({
    frameId: entry.frameId,
    documentId: entry.documentId,
    url: entry.url,
    at: entry.at,
    stepModel: entry.stepModel,
  }));
}
