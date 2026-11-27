// extension/src/lib/encoded-writer.js —— 录制/编码分片写入（从 offscreen 拆出）。
//
// 编码路径（CanvasSource/StreamTarget）每写一块：
//   1) 优先写 OPFS 分块（writeEncodedPart），失败回退 IndexedDB 分块；
//   2) 为每块生成 manifest 分片描述 {index, atMs, bytes, codec, lastFrameAt, checksum}
//      并 appendEncodedSegment() 持久化，崩溃后按 manifest 序号/时间戳/校验和恢复；
//   3) 顺带按预算评估该段（maxSegmentBytes），把读数塞进返回值/摘要，收尾时作为证据。
// 写入失败不得中断录制：manifest 追加/摘要计算失败只记录，不影响分块落库。
import { appendEncodedSegment } from './opfs-encoded-store.js';
import { sha256Hex } from './video-meta.js';
import { evaluateBudget, summarizeBudgetEvaluation } from './video-budget.js';

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function createEncodedWriter(deps = {}) {
  const {
    openDb,
    CHUNK_STORE,
    writeEncodedPart,
    getEncodedMeta,
    appendSegment = appendEncodedSegment,
    hash = sha256Hex,
    clock = () => Date.now(),
    budget = null,
  } = deps;
  let chunkIndex = 0;
  let encodedSeq = 0;
  let encodedBytes = 0;
  const segmentLog = [];
  let lastAppend = null;

  async function storeChunk(blob, recordMeta) {
    const id = String((recordMeta && recordMeta.recordingId) || '');
    if (!id || !blob || !blob.size) return { ok: false, reason: 'bad_arg' };
    const index = chunkIndex;
    chunkIndex += 1;
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(CHUNK_STORE, 'readwrite');
        tx.objectStore(CHUNK_STORE).put({
          key: id + ':' + String(index).padStart(6, '0'),
          recordingId: id,
          index,
          at: clock(),
          meta: recordMeta,
          blob,
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('保存录制分片失败'));
      });
      return { ok: true, index, bytes: blob.size };
    } finally {
      db.close();
    }
  }

  /** 编码输出按位置落盘：Encoder 的 StreamTarget 写入，停录时按 position 组装。 */
  async function storeEncodedChunk(recordingId, position, data) {
    const id = String(recordingId || '');
    if (!id || !data || !data.byteLength) return { ok: false, reason: 'bad_arg' };
    const seq = encodedSeq;
    encodedSeq += 1;
    const meta = (typeof getEncodedMeta === 'function' ? getEncodedMeta() : null) || {};
    const startedAt = finite(meta.startedAt, 0);
    const at = finite(clock(), Date.now());
    const atMs = Math.max(0, startedAt ? at - startedAt : 0);
    const codec = String(meta.codec || 'avc');
    let checksum = '';
    try {
      checksum = String(await hash(new Blob([data], { type: 'application/octet-stream' })) || '').toLowerCase();
    } catch {
      checksum = '';
    }
    const bytes = Number(data.byteLength) || 0;
    const wrotePart = await writeEncodedPart(id, seq, position, data);
    if (!wrotePart) {
      const db = await openDb();
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(CHUNK_STORE, 'readwrite');
          tx.objectStore(CHUNK_STORE).put({
            key: 'enc:' + id + ':' + String(seq).padStart(8, '0'),
            recordingId: id,
            index: seq,
            position: finite(position),
            meta,
            at,
            blob: new Blob([data], { type: 'application/octet-stream' }),
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error || new Error('保存编码分块失败'));
        });
      } finally {
        db.close();
      }
    }
    encodedBytes += bytes;
    const segment = {
      index: seq,
      atMs,
      bytes,
      codec,
      // 编码器写入路径拿不到每帧 PTS；以分片落盘时刻作为帧时间下界（单调），
      // 真实的帧级时间戳由 mp4-integrity 从 tfdt/trun 校验。
      lastFrameAt: atMs,
      checksum,
      position: finite(position),
      storage: wrotePart ? 'opfs' : 'idb',
    };
    segmentLog.push(segment);
    const evaluation = budget
      ? evaluateBudget({ segmentBytes: bytes, totalBytes: encodedBytes, elapsedMs: atMs, bitrate: meta.bitrate }, budget)
      : null;
    let appendResult = null;
    try {
      appendResult = await appendSegment(id, segment, {
        codec,
        startedAt,
        budget,
        maxSegmentBytes: budget && budget.maxSegmentBytes,
        requireChecksum: false,
      });
    } catch {
      appendResult = null;
    }
    lastAppend = appendResult
      ? {
        ok: appendResult.ok === true,
        code: appendResult.code || null,
        index: segment.index,
        persisted: appendResult.persisted === true,
      }
      : null;
    return {
      ok: true,
      index: seq,
      bytes,
      storage: segment.storage,
      segment,
      manifest: lastAppend,
      budget: evaluation ? summarizeBudgetEvaluation(evaluation) : null,
    };
  }

  return {
    storeChunk,
    storeEncodedChunk,
    currentChunkIndex: () => chunkIndex,
    encodedBytes: () => encodedBytes,
    segments: () => segmentLog.slice(),
    lastAppend: () => lastAppend,
    summary: () => ({
      chunks: chunkIndex,
      encodedSegments: encodedSeq,
      encodedBytes,
      segments: segmentLog.length,
      lastAppend,
    }),
    reset: () => {
      chunkIndex = 0;
      encodedSeq = 0;
      encodedBytes = 0;
      segmentLog.length = 0;
      lastAppend = null;
    },
  };
}
