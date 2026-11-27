// 本地视频编辑：按时间裁剪/重封装（不重编码），供 `bridge video trim` 使用。
import fs from 'node:fs';
import path from 'node:path';
import { planVideoSegments } from './video-segments.mjs';
import {
  Input, BufferSource, MP4, Output, Mp4OutputFormat, BufferTarget, EncodedVideoPacketSource, EncodedPacketSink, EncodedPacket,
} from '../vendor/mediabunny/mediabunny.min.mjs';

export async function probeVideoFile(inputPath) {
  const bytes = fs.readFileSync(inputPath);
  const input = new Input({ source: new BufferSource(bytes), formats: [MP4] });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('输入不是可识别的 MP4 视频');
  const codec = await track.getCodec();
  const config = await track.getDecoderConfig();
  const duration = await input.computeDuration().catch(() => 0);
  let packets = 0;
  let keyframes = 0;
  let firstTimestamp = null;
  let lastTimestamp = null;
  for await (const packet of new EncodedPacketSink(track).packets()) {
    packets += 1;
    if (packet.type === 'key') keyframes += 1;
    if (firstTimestamp == null) firstTimestamp = packet.timestamp;
    lastTimestamp = packet.timestamp + packet.duration;
  }
  return {
    bytes: bytes.byteLength,
    codec,
    width: Number(config && config.codedWidth) || null,
    height: Number(config && config.codedHeight) || null,
    duration: Math.round(Number(duration) * 1000) / 1000,
    packets,
    keyframes,
    firstTimestamp,
    lastTimestamp,
  };
}

export async function mergeVideoFiles(inputPaths, outputPath) {
  const files = (Array.isArray(inputPaths) ? inputPaths : []).filter(Boolean);
  if (files.length < 2) throw new Error('合并至少需要两个 MP4 文件');
  const first = new Input({ source: new BufferSource(fs.readFileSync(files[0])), formats: [MP4] });
  const firstTrack = await first.getPrimaryVideoTrack();
  if (!firstTrack) throw new Error('输入不是可识别的 MP4 视频：' + files[0]);
  const codec = await firstTrack.getCodec();
  const config = await firstTrack.getDecoderConfig();
  const width = Number(firstTrack.displayWidth) || null;
  const height = Number(firstTrack.displayHeight) || null;
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const sink = new EncodedVideoPacketSource(codec);
  output.addVideoTrack(sink);
  await output.start();
  let offset = 0;
  let packets = 0;
  for (const file of files) {
    const input = file === files[0] ? first : new Input({ source: new BufferSource(fs.readFileSync(file)), formats: [MP4] });
    const track = file === files[0] ? firstTrack : await input.getPrimaryVideoTrack();
    if (!track) throw new Error('输入不是可识别的 MP4 视频：' + file);
    const currentCodec = await track.getCodec();
    if (currentCodec !== codec) throw new Error('合并文件的编码不一致：' + codec + ' != ' + currentCodec);
    const currentWidth = Number(track.displayWidth) || width;
    const currentHeight = Number(track.displayHeight) || height;
    if (width && height && (currentWidth !== width || currentHeight !== height)) {
      throw new Error('合并文件的分辨率不一致：' + width + 'x' + height + ' != ' + currentWidth + 'x' + currentHeight);
    }
    for await (const packet of new EncodedPacketSink(track).packets()) {
      const shifted = new EncodedPacket(packet.data, packet.type, packet.timestamp + offset, packet.duration);
      await sink.add(shifted, packets === 0 ? { decoderConfig: config } : undefined);
      packets += 1;
      offset = Math.max(offset, shifted.timestamp + shifted.duration);
    }
  }
  if (!packets) {
    try { await output.cancel(); } catch { /* 忽略 */ }
    throw new Error('输入没有视频帧');
  }
  await output.finalize();
  const buffer = Buffer.from(target.buffer);
  fs.writeFileSync(outputPath, buffer);
  return { bytes: buffer.byteLength, packets, codec, width, height, duration: offset, inputs: files.length };
}

export async function splitVideoFile(inputPath, outputDir, parts = 2) {
  const source = fs.readFileSync(inputPath);
  const input = new Input({ source: new BufferSource(source), formats: [MP4] });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('输入不是可识别的 MP4 视频');
  const codec = await track.getCodec();
  const config = await track.getDecoderConfig();
  const packets = [];
  for await (const packet of new EncodedPacketSink(track).packets()) packets.push(packet);
  if (!packets.length) throw new Error('输入没有视频帧');
  // 分段必须从关键帧开始；只有一个 keyframe 时只能输出一段。
  const keyIndices = [];
  for (let index = 0; index < packets.length; index += 1) {
    if (packets[index].type === 'key') keyIndices.push(index);
  }
  const wanted = Math.max(2, Math.min(Number(parts) || 2, 10));
  const groups = [];
  if (keyIndices.length <= 1) {
    groups.push(packets);
  } else {
    const count = Math.min(wanted, keyIndices.length);
    for (let index = 0; index < count; index += 1) {
      const start = keyIndices[Math.floor(index * keyIndices.length / count)];
      const end = index === count - 1 ? packets.length : keyIndices[Math.floor((index + 1) * keyIndices.length / count)];
      const chunk = packets.slice(start, end);
      if (chunk.length) groups.push(chunk);
    }
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const base = path.basename(inputPath, path.extname(inputPath));
  const outputs = [];
  for (let index = 0; index < groups.length; index += 1) {
    const chunk = groups[index];
    const target = new BufferTarget();
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
    const sink = new EncodedVideoPacketSource(codec);
    output.addVideoTrack(sink);
    await output.start();
    for (let packetIndex = 0; packetIndex < chunk.length; packetIndex += 1) {
      await sink.add(chunk[packetIndex], packetIndex === 0 ? { decoderConfig: config } : undefined);
    }
    await output.finalize();
    const buffer = Buffer.from(target.buffer);
    const file = path.join(outputDir, base + '-part' + (index + 1) + '.mp4');
    fs.writeFileSync(file, buffer);
    outputs.push({
      path: file,
      bytes: buffer.byteLength,
      packets: chunk.length,
      start: chunk[0].timestamp,
      end: chunk[chunk.length - 1].timestamp + chunk[chunk.length - 1].duration,
      codec,
    });
  }
  // 时长只用于校验/元数据；分段以 GOP/包数切分，避免 0 长度段。
  const duration = await input.computeDuration().catch(() => 0);
  const plan = duration > 0 ? planVideoSegments(duration, groups.length).length : outputs.length;
  return { outputs, count: outputs.length, plan, duration };
}

export async function trimVideoFile(inputPath, outputPath, { startSec = 0, endSec = null } = {}) {
  const source = fs.readFileSync(inputPath);
  const input = new Input({ source: new BufferSource(source), formats: [MP4] });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('输入不是可识别的 MP4 视频');
  const codec = await track.getCodec();
  if (!codec) throw new Error('无法读取视频编码');
  const config = await track.getDecoderConfig();
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const sink = new EncodedVideoPacketSource(codec);
  output.addVideoTrack(sink);
  await output.start();
  let packets = 0;
  for await (const packet of new EncodedPacketSink(track).packets()) {
    if (packet.timestamp + packet.duration <= startSec) continue;
    if (endSec != null && packet.timestamp >= endSec) break;
    await sink.add(packet, packets === 0 ? { decoderConfig: config } : undefined);
    packets += 1;
  }
  if (!packets) {
    try { await output.cancel(); } catch { /* 忽略 */ }
    throw new Error('指定时间范围内没有视频帧');
  }
  await output.finalize();
  const buffer = Buffer.from(target.buffer);
  fs.writeFileSync(outputPath, buffer);
  return { bytes: buffer.byteLength, packets, codec };
}
