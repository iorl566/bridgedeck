// video-capture-check.js —— 录制启动后的“确实有画面”校验。
//
// 背景：tabCapture 在后台/最小化标签页上可能拿不到任何帧，MediaRecorder 会静默产出 0 字节；
// 这时 video start 仍会成功，但随后 list/status/save 都找不到录制，用户只能看到 E_NOT_FOUND。
// 这里在 startVideo 返回前确认 offscreen 确实收到了帧（编码器）或分片（MediaRecorder）。
export async function verifyCaptureOrThrow(recordingId, readRecord, clearState) {
  let produced = 0;
  for (let attempt = 0; attempt < 2 && produced === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 1200 : 900));
    const status = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'bb.rec.status' }).catch(() => null);
    produced = Number(status && status.frames) || Number(status && status.chunks) || 0;
    if ((!status || status.active === false) && produced === 0) {
      const early = await readRecord(recordingId).catch(() => null);
      if (early && Number(early.bytes) > 0) produced = 1;
    }
  }
  if (produced > 0) return;
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'bb.rec.stop' }).catch(() => {});
  clearState();
  await chrome.storage.local.remove('bb.video.active').catch(() => {});
  throw new Error('录制启动失败：标签页没有产生任何画面（可能处于后台/最小化）；请把标签页切到前台可见后重试');
}
