// extension/src/lib/offscreen-recovery.js —— 录制恢复（从 offscreen 拆出）。

export function createOffscreenRecovery(ctx) {
  const { readChunks, saveVideo, clearChunks, analyzeRecording, sha256Hex, journalSummary, assembleEncodedParts, assembleEncodedBlob, listEncodedManifests, clearEncodedParts, getStorageState } = ctx;

async function recoverEncodedIdb() {
    const items = await readChunks().catch(() => []);
    if (!items.length || !chunksHavePosition(items)) return [];
    const groups = new Map();
    for (const item of items) {
      if (!item || !Number.isFinite(Number(item.position))) continue;
      const id = String(item.recordingId || '');
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(item);
    }
    const manifest = null;
    const recovered = [];
    for (const [id, list] of groups) {
      const parts = list
        .map((item) => ({ position: Number(item.position), blob: item.blob }))
        .filter((item) => item.blob && item.blob.size)
        .sort((a, b) => a.position - b.position);
      if (!parts.length) continue;
      const blob = await assembleEncodedParts(parts);
      if (!blob || !blob.size) continue;
      const meta = (list[0] && list[0].meta) || (manifest && manifest.recordingId === id ? manifest : null) || {};
      const record = {
        id,
        tabId: meta.tabId,
        url: meta.url || '',
        title: meta.title || '',
        startedAt: meta.startedAt || Date.now(),
        endedAt: Date.now(),
        mime: 'video/mp4',
        bytes: blob.size,
        blob,
        recovered: true,
        completeness: 'partial',
        stop_reason: 'recovered',
        chunk_count: parts.length,
        fragments: [{ index: 0, at: Date.now(), bytes: blob.size, sha256: await sha256Hex(blob) }],
        finish_via: 'encoder-idb-recovered',
        durability: 'unverified',
        durability_parts: parts.length,
        durability_policy: 'browser-readback',
        fsync_supported: false,
      };
      await saveVideo(record);
      recovered.push({ id, bytes: blob.size, summary: { id, startedAt: record.startedAt, endedAt: record.endedAt, mime: record.mime, bytes: record.bytes, completeness: record.completeness, stop_reason: record.stop_reason, chunk_count: record.chunk_count, fragments: record.fragments, finish_via: record.finish_via } });
    }
    if (recovered.length) {
      await clearChunks();
    }
    return recovered;
  }
  
  async function recoverChunks() {
    const idbEncoded = await recoverEncodedIdb().catch(() => []);
    if (idbEncoded.length) return { ok: true, record: idbEncoded[0].summary, records: idbEncoded.map((item) => item.summary) };
  
    const encoded = await recoverEncodedRecordings().catch(() => []);
    if (encoded.length) {
      return { ok: true, record: encoded[0].summary, records: encoded.map((item) => item.summary) };
    }
    const items = await readChunks();
    if (!items.length) return { ok: false, error: '没有可恢复的录制分片' };
    const groups = new Map();
    for (const item of items) {
      const id = String(item.recordingId || '');
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(item);
    }
    const [id, list] = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    list.sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
    const first = list[0];
    const recordMeta = first.meta || { recordingId: id, tabId: 0, url: '', title: '', startedAt: first.at || Date.now(), mime: 'video/mp4' };
    const mime = recordMeta.mime || 'video/mp4';
    const blob = new Blob(list.map((item) => item.blob), { type: mime });
    const { journal } = await analyzeRecording(blob, null, false).catch(() => ({ journal: null }));
    const fragments = [];
    for (const item of list) {
      fragments.push({
        index: Number(item.index) || 0,
        at: Number(item.at) || 0,
        bytes: item.blob ? item.blob.size : 0,
        sha256: item.blob ? await sha256Hex(item.blob) : '',
      });
    }
    const record = {
      id,
      tabId: recordMeta.tabId,
      url: recordMeta.url || '',
      title: recordMeta.title || '',
      startedAt: recordMeta.startedAt || Date.now(),
      endedAt: Date.now(),
      mime,
      bytes: blob.size,
      blob,
      recovered: true,
      completeness: 'partial',
      stop_reason: 'recovered',
      chunk_count: list.length,
      fragments,
      ...(journal ? { complete_frames: journal.completeFrames === true, journal: journalSummary(journal) } : {}),
    };
    await saveVideo(record);
    await clearChunks();
    return { ok: true, record: { id, tabId: record.tabId, startedAt: record.startedAt, endedAt: record.endedAt, mime, bytes: blob.size, completeness: record.completeness, stop_reason: record.stop_reason, chunk_count: record.chunk_count, fragments: record.fragments, ...(record.complete_frames !== undefined ? { complete_frames: record.complete_frames } : {}), ...(record.journal ? { journal: record.journal } : {}) } };
  }
  
  async function recoverEncodedRecordings() {
    const manifests = await listEncodedManifests().catch(() => []);
    const recovered = [];
    for (const manifest of manifests) {
      if (manifest.sealed === true) {
        await clearEncodedParts(manifest.recordingId).catch(() => {});
        continue;
      }
      const blob = await assembleEncodedBlob(manifest.recordingId).catch(() => null);
      if (!blob || !blob.size) continue;
      const sha256 = await sha256Hex(blob);
      const record = {
        id: manifest.recordingId,
        tabId: manifest.tabId,
        url: manifest.url || '',
        title: manifest.title || '',
        startedAt: manifest.startedAt || manifest.createdAt || Date.now(),
        endedAt: Date.now(),
        mime: 'video/mp4',
        bytes: blob.size,
        blob,
        recovered: true,
        completeness: 'partial',
        stop_reason: 'recovered',
        chunk_count: 1,
        fragments: [{ index: 0, at: Date.now(), bytes: blob.size, sha256 }],
        finish_via: 'encoder-recovered',
        storage_persisted: getStorageState() ? getStorageState().persisted : false,
        storage_quota: getStorageState() ? getStorageState().quota : null,
        complete_frames: true,
        faststart: true,
      };
      await saveVideo(record);
      await clearEncodedParts(manifest.recordingId);
      recovered.push({
        manifest,
        summary: {
          id: record.id,
          tabId: record.tabId,
          startedAt: record.startedAt,
          endedAt: record.endedAt,
          mime: record.mime,
          bytes: record.bytes,
          completeness: record.completeness,
          stop_reason: record.stop_reason,
          chunk_count: record.chunk_count,
          fragments: record.fragments,
          finish_via: record.finish_via,
        },
      });
    }
    return recovered;
  }
  return { recoverEncodedIdb, recoverChunks, recoverEncodedRecordings };
}
