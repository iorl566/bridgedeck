// video-worker.js —— 离屏文档的视频完帧重封装 + 可 seek/faststart worker：
// 扫描 MP4 顶层 box、截到完整分片（不重编码），为 fMP4 生成 sidx，并重封装为 moov 前置。
import { fragmentJournalFromBlob, completeFragmentPackage } from './src/lib/mp4-fragments.js';
import { segmentIndexForBlob } from './src/lib/fmp4-sidx.js';
import {
  Input, BlobSource, MP4, Output, Mp4OutputFormat, BufferTarget, EncodedVideoPacketSource, EncodedPacketSink,
} from './vendor/mediabunny/mediabunny.min.mjs';

const MAX_REMUX_BYTES = 128 * 1024 * 1024;

async function remuxFaststart(blob) {
  if (!blob || blob.size <= 0 || blob.size > MAX_REMUX_BYTES) return null;
  const input = new Input({ source: new BlobSource(blob), formats: [MP4] });
  const track = await input.getPrimaryVideoTrack();
  if (!track) return null;
  const codec = await track.getCodec();
  if (!codec) return null;
  const config = await track.getDecoderConfig();
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const source = new EncodedVideoPacketSource(codec);
  output.addVideoTrack(source);
  await output.start();
  let packets = 0;
  for await (const packet of new EncodedPacketSink(track).packets()) {
    await source.add(packet, packets === 0 ? { decoderConfig: config } : undefined);
    packets += 1;
  }
  if (!packets) {
    try { await output.cancel(); } catch { /* 忽略 */ }
    return null;
  }
  await output.finalize();
  const out = new Blob([target.buffer], { type: 'video/mp4' });
  return { blob: out, bytes: out.size, packets, codec };
}

self.addEventListener('message', (event) => {
  const { id, blob, fragments, wantPackage } = event.data || {};
  fragmentJournalFromBlob(blob)
    .then(async (journal) => {
      const packaged = wantPackage === true ? completeFragmentPackage(blob, journal, fragments || []) : null;
      const finalBlob = packaged ? packaged.blob : blob;
      let sidx = null;
      let faststart = null;
      if (wantPackage === true && journal.fragmented) {
        sidx = await segmentIndexForBlob(finalBlob).catch(() => null);
        faststart = await remuxFaststart(finalBlob).catch(() => null);
      }
      self.postMessage({
        id,
        ok: true,
        journal,
        ...(packaged ? { package: packaged } : {}),
        ...(sidx ? { sidx: sidx.sidx, insertAt: sidx.insertAt, sidxFragments: sidx.fragments, timescale: sidx.timescale } : {}),
        ...(faststart ? { faststart: faststart.blob, faststartBytes: faststart.bytes, faststartPackets: faststart.packets, codec: faststart.codec } : {}),
      });
    })
    .catch((error) => self.postMessage({ id, ok: false, error: String((error && error.message) || error) }));
});
