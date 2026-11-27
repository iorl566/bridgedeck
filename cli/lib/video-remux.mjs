// cli/lib/video-remux.mjs —— 把 MediaRecorder 的 fragmented MP4 重封装为 moov 前置（faststart）的 MP4。
//
// 通过 vendored mediabunny（cli/vendor/mediabunny，Apache-2.0）做 packet 级 remux：
// 不解码、不重编码，只是重排/重建索引，便于播放器立即 seek。失败时调用方回退原始字节。
const MAX_REMUX_BYTES = 128 * 1024 * 1024;

export async function remuxFaststartBase64(base64, options = {}) {
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : MAX_REMUX_BYTES;
  const inputBytes = Buffer.from(String(base64 || ''), 'base64');
  if (!inputBytes.length || inputBytes.length > maxBytes) return null;
  const mod = await import('../vendor/mediabunny/mediabunny.min.mjs');
  const {
    Input, BlobSource, MP4, Output, Mp4OutputFormat, BufferTarget,
    EncodedVideoPacketSource, EncodedPacketSink,
  } = mod;
  const input = new Input({ source: new BlobSource(new Blob([inputBytes])), formats: [MP4] });
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
  const out = Buffer.from(target.buffer);
  if (!out.length) return null;
  return { base64: out.toString('base64'), bytes: out.length, packets, codec, inputBytes: inputBytes.length };
}
