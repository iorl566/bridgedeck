// src/video-status-chip.js —— 视频录制期间的执行期状态 chip（注入/移除）。
// 从 video.js 拆出以控制 video.js 的复杂度预算；复用 status-chip 的统一视觉。
import { log } from './log.js';
import { installStatusChip } from './status-chip.js';
import { OVERLAY_THEME } from './overlay-theme.js';

const STATUS_CHIP_HOST_ID = '__bb_status_chip_host';

/** 在录制标签页右下角显示视频录制状态（失败不影响录制）。 */
export async function injectVideoStatusChip(tabId, startedAt) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: Number(tabId) },
      world: 'ISOLATED',
      func: installStatusChip,
      args: [{
        kind: 'video',
        label: '正在录制视频',
        detail: '无声音 · 可在视频面板预览',
        lang: 'zh',
        theme: OVERLAY_THEME,
        startedAt: Number(startedAt) || Date.now(),
      }],
    });
  } catch (error) {
    log('视频状态 chip 注入失败（不影响录制）：' + ((error && error.message) || error));
  }
}

export async function removeVideoStatusChip(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: Number(tabId) },
      world: 'ISOLATED',
      func: () => {
        const host = document.getElementById('__bb_status_chip_host');
        if (host) host.remove();
      },
    });
  } catch { /* 标签页可能已关闭 */ }
}

/** 整页/长截图进行中的状态 chip（与视频共用 status-chip）。 */
export async function injectCaptureStatusChip(tabId, startedAt) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: Number(tabId) },
      world: 'ISOLATED',
      func: installStatusChip,
      args: [{
        kind: 'capture',
        label: '正在截取整页',
        detail: '分片拼接中',
        lang: 'zh',
        theme: OVERLAY_THEME,
        startedAt: Number(startedAt) || Date.now(),
      }],
    });
  } catch (error) {
    log('截图状态 chip 注入失败（不影响截图）：' + ((error && error.message) || error));
  }
}

export async function removeCaptureStatusChip(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: Number(tabId) },
      world: 'ISOLATED',
      func: () => {
        const host = document.getElementById('__bb_status_chip_host');
        if (host) host.remove();
      },
    });
  } catch { /* 标签页可能已关闭 */ }
}
