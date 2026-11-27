// extension/src/lib/video-analysis.js —— 分片日记/完整包分析（从 offscreen 拆出）。
import { fragmentJournalFromBlob, completeFragmentPackage } from './mp4-fragments.js';
import { segmentIndexForBlob } from './fmp4-sidx.js';

export async function analyzeRecording(blob, fragments, wantPackage = false) {
  try {
    if (typeof Worker === 'function' && blob && blob.size > 0) {
      const worker = new Worker(chrome.runtime.getURL('video-worker.js'), { type: 'module' });
      try {
        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('分片日记 worker 超时')), 5000);
          worker.addEventListener('message', (event) => {
            clearTimeout(timer);
            const data = event.data || {};
            if (data.ok) resolve(data);
            else reject(new Error(data.error || '分片日记 worker 失败'));
          });
          worker.addEventListener('error', (event) => {
            clearTimeout(timer);
            reject(new Error((event && event.message) || '分片日记 worker 错误'));
          });
          worker.postMessage({ id: 'journal', blob, fragments: fragments || [], wantPackage });
        });
        return {
          journal: result.journal,
          packaged: result.package || null,
          sidx: result.sidx ? { sidx: result.sidx, insertAt: result.insertAt } : null,
          faststart: result.faststart ? { blob: result.faststart, bytes: result.faststartBytes, packets: result.faststartPackets, codec: result.codec } : null,
          via: 'worker',
        };
      } finally {
        worker.terminate();
      }
    }
  } catch {
    // worker 不可用（CSP/环境）时走主线程
  }
  const journal = await fragmentJournalFromBlob(blob);
  const packaged = wantPackage ? completeFragmentPackage(blob, journal, fragments || []) : null;
  const sidx = wantPackage && journal.fragmented
    ? await segmentIndexForBlob(packaged ? packaged.blob : blob).catch(() => null)
    : null;
  return { journal, packaged, sidx, faststart: null, via: 'main' };
}
