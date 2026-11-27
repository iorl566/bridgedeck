// src/video/offscreen.ts —— 离屏文档：tabCapture / 调试器截帧 → WebCodecs(mediabunny) 编码或 MediaRecorder。
//
// 为什么必须离屏：chrome.tabCapture 的 streamId 要在离屏文档里 getUserMedia 消费；
// WebCodecs 编码 + canvas 绘制也需要 DOM（service worker 里没有）。
//
// 采集与编码策略（失败一律如实降级，不伪造 faststart/mp4）：
// 1) tabCapture 流：优先 MediaStreamTrackProcessor → canvas → mediabunny CanvasSource（MP4, fastStart:'in-memory'）；
//    MediaStreamTrackProcessor/编码器不可用 → MediaRecorder（优先 MP4，其次 WebM）→ 能重封装才置 faststart；
// 2) 逐帧：Page.screencastFrame 的 JPEG → canvas → 同一个编码器（fps 由固定节拍泵帧，保证时长/帧数）；
// 3) 结束后统一做容器/分片日记分析，byte 级结论回传 service（SW）落库。
//
// 注意：本文件只在离屏文档里执行，不参与 Node 单测；mediabunny 来自仓库根 node_modules
// （不新增依赖，不改 package.json）。

import {
  BufferTarget,
  CanvasSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  BlobSource,
  MP4,
  Mp4OutputFormat,
  Output,
  canEncodeVideo,
} from 'mediabunny';
import { sha256Hex, sha256OfBlob, toArrayBuffer } from './hash.ts';
import {
  analyzeContainer,
  completeFragmentPackage,
  evenDimension,
  fragmentJournal,
  journalSummary,
  pickVideoMime,
} from './mp4.ts';
import { OFFSCREEN_MESSAGES, OFFSCREEN_SOURCE, OFFSCREEN_TARGET, encodeOffscreenResult, type OffscreenRecordingResult } from './offscreen-protocol.ts';
import type { FragmentEntry } from './types.ts';

/** WebCodecs 可编码的候选 codec：AVC 优先（MP4 兼容面最广），headless 下退 VP9/AV1/HEVC。 */
type EncoderCodec = 'avc' | 'vp9' | 'av1' | 'hevc';
const ENCODER_CODECS: readonly EncoderCodec[] = Object.freeze(['avc', 'vp9', 'av1', 'hevc']);

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String((error as { message?: unknown } | null)?.message ?? error);
}


// ---------------------------------------------------------------------------
// 运行时最小接口（不直接依赖 @types/chrome；WXT 注入的 browser 命名空间即可）
// ---------------------------------------------------------------------------

interface OffscreenRuntime {
  getURL(path: string): string;
  sendMessage(message: unknown): Promise<unknown>;
  onMessage?: {
    addListener(listener: (message: unknown, sender: unknown, sendResponse: (reply?: unknown) => void) => boolean | void): void;
  };
}

interface OffscreenWindow {
  setTimeout(handler: () => void, timeout?: number): number;
  clearTimeout(handle: number | null): void;
  setInterval(handler: () => void, timeout?: number): number;
  clearInterval(handle: number | null): void;
  fetch(input: string): Promise<Response>;
  createImageBitmap(blob: Blob): Promise<ImageBitmap>;
}

function offscreenWindow(): OffscreenWindow {
  return globalThis as unknown as OffscreenWindow;
}

function resolveRuntime(): OffscreenRuntime | null {
  const scope = globalThis as unknown as { browser?: { runtime?: OffscreenRuntime }; chrome?: { runtime?: OffscreenRuntime } };
  return scope.browser?.runtime ?? scope.chrome?.runtime ?? null;
}

function sendToService(message: Record<string, unknown>): void {
  const runtime = resolveRuntime();
  if (!runtime) return;
  try {
    void runtime.sendMessage({ ...message, from: OFFSCREEN_SOURCE }).catch(() => {});
  } catch {
    // 服务工作线程可能已退出：结果仍保存在 lastResult，可经 bb.rec.last 回读
  }
}

// ---------------------------------------------------------------------------
// 会话状态
// ---------------------------------------------------------------------------

interface RecordingMeta {
  recordingId: string;
  tabId: number | null;
  url: string;
  title: string;
  startedAt: number;
  mime: string;
  mode: 'stream' | 'frames';
}

interface EncoderSession {
  output: Output;
  source: CanvasSource;
  target: BufferTarget;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  /** 实际使用的 codec（WebCodecs AVC 不可用时退 VP9/AV1/HEVC，mime 仍是 MP4）。 */
  codec: EncoderCodec;
  frames: number;
  fps: number;
  queue: Promise<void>;
  timer: number | null;
  reader: ReadableStreamDefaultReader<VideoFrame> | null;
  closed: boolean;
}

interface RecorderSession {
  recorder: MediaRecorder;
  chunks: Blob[];
  fragments: FragmentEntry[];
  hashes: Array<Promise<void>>;
  mime: string;
}

let encoder: EncoderSession | null = null;
let recorderSession: RecorderSession | null = null;
let mediaStream: MediaStream | null = null;
let meta: RecordingMeta | null = null;
let stopTimer: number | null = null;
let stopReason: 'user' | 'duration' = 'user';
let lastResult: OffscreenRecordingResult | null = null;
let frameCanvas: HTMLCanvasElement | null = null;
let frameContext: CanvasRenderingContext2D | null = null;

const MAX_REMUX_BYTES = 128 * 1024 * 1024;
const MAX_DURATION_MS = 10 * 60 * 1000;

function clearStopTimer(): void {
  if (stopTimer !== null) {
    offscreenWindow().clearTimeout(stopTimer);
    stopTimer = null;
  }
}

function scheduleAutoStop(durationMs: number): void {
  const limit = Number(durationMs) > 0 ? Math.min(Number(durationMs), MAX_DURATION_MS) : 0;
  if (!limit) return;
  stopTimer = offscreenWindow().setTimeout(() => {
    stopTimer = null;
    stopReason = 'duration';
    void stopRecording().catch(() => { /* 结果经 lastResult 回读 */ });
  }, limit);
}

function isBusy(): boolean {
  return Boolean(encoder || recorderSession);
}

function stopMediaStream(): void {
  const stream = mediaStream;
  mediaStream = null;
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch { /* 忽略 */ }
  }
}

// ---------------------------------------------------------------------------
// 编码器（WebCodecs via mediabunny）
// ---------------------------------------------------------------------------

/**
 * 启动 mediabunny 编码器（MP4 容器，fastStart:'in-memory' 保证 moov 前置）。
 * codec 按 AVC → VP9 → AV1 → HEVC 探测：headless 环境常没有 AVC 硬编，
 * 但 VP9/AV1 软件编码通常可用；容器仍是 MP4，mime 如实写 video/mp4。
 * 全部不可用时抛错（调用方据此回退 MediaRecorder 或报失败，绝不伪造字节）。
 */
async function startEncoder(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  bitrate: number,
  fps: number,
): Promise<EncoderSession> {
  const failures: string[] = [];
  for (const codec of ENCODER_CODECS) {
    let output: Output | null = null;
    try {
      const supported = await canEncodeVideo(codec, { width, height }).catch(() => false);
      if (!supported) {
        failures.push(codec + '：WebCodecs 不支持该 codec');
        continue;
      }
      const target = new BufferTarget();
      output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
      const source = new CanvasSource(canvas, { codec, bitrate });
      output.addVideoTrack(source);
      await output.start();
      const session: EncoderSession = {
        output,
        source,
        target,
        canvas,
        context,
        codec,
        frames: 0,
        fps: Math.max(2, Number(fps) || 10),
        queue: Promise.resolve(),
        timer: null,
        reader: null,
        closed: false,
      };
      // 先编一帧探针：编码器配置错误（headless 没有硬编等）在这里就暴露，
      // 可以换下一个 codec，而不是等到 stop 时才发现一个空文件。
      await source.add(0, 1 / session.fps);
      session.frames = 1;
      // 固定节拍泵帧：即使采集端一帧没来也能产出黑帧，保证时长/帧数/字节数可信。
      session.timer = offscreenWindow().setInterval(() => {
        if (session.closed) return;
        const timestamp = session.frames / session.fps;
        session.frames += 1;
        session.queue = session.queue
          .then(() => session.source.add(timestamp, 1 / session.fps))
          .then(() => undefined)
          .catch(() => undefined);
      }, Math.max(50, Math.round(1000 / session.fps)));
      encoder = session;
      return session;
    } catch (error) {
      failures.push(codec + '：' + errorMessage(error));
      try { await output?.cancel(); } catch { /* 忽略 */ }
    }
  }
  throw new Error('WebCodecs/mediabunny 编码器不可用（' + failures.join('；') + '）');
}

async function finalizeEncoder(session: EncoderSession): Promise<Uint8Array> {
  session.closed = true;
  if (session.timer !== null) {
    offscreenWindow().clearInterval(session.timer);
    session.timer = null;
  }
  try { await session.reader?.cancel(); } catch { /* 忽略 */ }
  await session.queue.catch(() => undefined);
  if (session.frames === 0) {
    try { await session.source.add(0, 1 / session.fps); } catch { /* 忽略 */ }
  }
  await session.output.finalize();
  const buffer = session.target.buffer;
  if (!buffer) throw new Error('编码器没有输出字节');
  return new Uint8Array(buffer);
}

// ---------------------------------------------------------------------------
// tabCapture 流录制（编码器优先，MediaRecorder 兜底）
// ---------------------------------------------------------------------------

interface StartMessage extends Record<string, unknown> {
  recordingId?: unknown;
  tabId?: unknown;
  url?: unknown;
  title?: unknown;
  bitrate?: unknown;
  durationMs?: unknown;
  streamId?: unknown;
  width?: unknown;
  height?: unknown;
  fps?: unknown;
}

function readMeta(message: StartMessage, mode: 'stream' | 'frames'): RecordingMeta {
  return {
    recordingId: typeof message.recordingId === 'string' ? message.recordingId : '',
    tabId: Number.isInteger(Number(message.tabId)) ? Number(message.tabId) : null,
    url: typeof message.url === 'string' ? message.url : '',
    title: typeof message.title === 'string' ? message.title : '',
    startedAt: Date.now(),
    mime: '',
    mode,
  };
}

function startRecorder(stream: MediaStream, message: StartMessage): { mime: string } {
  const preferred = typeof message.encoder === 'string' && message.encoder === 'avc' ? 'video/mp4;codecs=avc1.42E01E' : '';
  const mime = pickVideoMime((candidate) => MediaRecorder.isTypeSupported(candidate), preferred);
  if (!mime) throw new Error('浏览器不支持可用的录制格式（mp4/webm 都不可用）');
  const bitrate = Number(message.bitrate) > 0 ? Number(message.bitrate) : 4_000_000;
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
  const session: RecorderSession = { recorder, chunks: [], fragments: [], hashes: [], mime };
  recorder.ondataavailable = (event: BlobEvent) => {
    const blob = event.data;
    if (!blob || !blob.size) return;
    const entry: FragmentEntry = { index: session.fragments.length, at: Date.now(), bytes: blob.size, sha256: '' };
    session.fragments.push(entry);
    session.chunks.push(blob);
    session.hashes.push(sha256OfBlob(blob).then((hash) => { entry.sha256 = hash; }));
  };
  recorder.start(500);
  recorderSession = session;
  return { mime };
}

/** 把 MediaRecorder 的 MP4（通常是 fMP4）重封装成 moov 前置的单 mdat 文件（不重编码）。 */
async function remuxFaststart(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (bytes.length <= 0 || bytes.length > MAX_REMUX_BYTES) return null;
  const input = new Input({ source: new BlobSource(new Blob([toArrayBuffer(bytes)], { type: 'video/mp4' })), formats: [MP4] });
  try {
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
      await source.add(packet, packets === 0 && config ? { decoderConfig: config } : undefined);
      packets += 1;
    }
    if (!packets) {
      try { await output.cancel(); } catch { /* 忽略 */ }
      return null;
    }
    await output.finalize();
    const buffer = target.buffer;
    return buffer ? new Uint8Array(buffer) : null;
  } catch {
    return null;
  } finally {
    try { await input.dispose?.(); } catch { /* 忽略 */ }
  }
}

async function startStream(message: StartMessage): Promise<{ ok: true; mime: string; startedAt: number; mode: string; encoder?: string }> {
  if (isBusy()) throw new Error('已经在录制中');
  const streamId = typeof message.streamId === 'string' ? message.streamId : '';
  if (!streamId) throw new Error('缺少 tabCapture streamId');
  const nav = (globalThis as unknown as { navigator?: { mediaDevices?: { getUserMedia(constraints: unknown): Promise<MediaStream> } } }).navigator;
  if (!nav?.mediaDevices?.getUserMedia) throw new Error('离屏文档没有 navigator.mediaDevices.getUserMedia');
  const stream = await nav.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
  } as unknown as MediaStreamConstraints);
  mediaStream = stream;
  meta = readMeta(message, 'stream');
  // 新录制开始：清掉上一条录制的 lastResult/stop_reason，避免 STOP 竞态回读到旧结果。
  lastResult = null;
  stopReason = 'user';
  const bitrate = Number(message.bitrate) > 0 ? Number(message.bitrate) : 4_000_000;

  // 1) 优先 WebCodecs 编码器（输出 MP4，faststart 由 muxer 保证；codec 按可用性回退）。
  try {
    const track = stream.getVideoTracks()[0];
    const settings = track && typeof track.getSettings === 'function' ? track.getSettings() : {};
    const rawWidth = Number((settings as { width?: number }).width) || Number(message.width) || 1280;
    const rawHeight = Number((settings as { height?: number }).height) || Number(message.height) || 800;
    const width = evenDimension(Math.min(rawWidth, 1280), 1280);
    const height = evenDimension(Math.min(rawHeight, 800), 800);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('离屏 canvas 拿不到 2d 上下文');
    context.fillStyle = '#000000';
    context.fillRect(0, 0, width, height);
    const session = await startEncoder(canvas, context, width, height, bitrate, 10);
    attachTrackReader(stream, width, height);
    meta.mime = 'video/mp4';
    scheduleAutoStop(Number(message.durationMs));
    return { ok: true, mime: 'video/mp4', startedAt: meta.startedAt, mode: 'stream', encoder: session.codec };
  } catch {
    // 编码器不可用：回退 MediaRecorder（mime 如实写实际格式）。
    if (encoder) {
      const failed = encoder;
      encoder = null;
      try {
        failed.closed = true;
        if (failed.timer !== null) offscreenWindow().clearInterval(failed.timer);
      } catch {
        // 忽略
      }
    }
  }

  let recorder: { mime: string };
  try {
    recorder = startRecorder(stream, message);
  } catch (error) {
    // MediaRecorder 也不可用：清掉流/元数据，避免离屏停在半启动状态挡住重试。
    stopMediaStream();
    meta = null;
    throw error;
  }
  if (meta) meta.mime = recorder.mime;
  scheduleAutoStop(Number(message.durationMs));
  return { ok: true, mime: recorder.mime, startedAt: meta?.startedAt ?? Date.now(), mode: 'stream' };
}

interface TrackProcessorLike {
  readable: ReadableStream<VideoFrame>;
}

function attachTrackReader(stream: MediaStream, width: number, height: number): void {
  const session = encoder;
  if (!session) return;
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  const Ctor = (globalThis as unknown as { MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => TrackProcessorLike }).MediaStreamTrackProcessor;
  if (!Ctor) return;
  try {
    const processor = new Ctor({ track });
    const reader = processor.readable.getReader();
    session.reader = reader;
    void (async () => {
      while (!session.closed) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        try {
          session.context.drawImage(value as unknown as CanvasImageSource, 0, 0, width, height);
        } catch {
          // 坏帧丢弃
        } finally {
          try { value.close(); } catch { /* 忽略 */ }
        }
      }
    })().catch(() => { /* 帧流结束时静默 */ });
  } catch {
    // TrackProcessor 不可用：固定节拍泵帧仍然会产出黑帧，录制不会空
  }
}

// ---------------------------------------------------------------------------
// 逐帧录制（调试器截帧 → canvas → 编码器）
// ---------------------------------------------------------------------------

async function startFrames(message: StartMessage): Promise<{ ok: true; mime: string; startedAt: number; mode: string; encoder?: string }> {
  if (isBusy()) throw new Error('已经在录制中');
  const width = evenDimension(Number(message.width) || 1280, 1280);
  const height = evenDimension(Number(message.height) || 800, 800);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('逐帧录制拿不到 canvas 2d 上下文');
  context.fillStyle = '#000000';
  context.fillRect(0, 0, width, height);
  meta = readMeta(message, 'frames');
  // 新录制开始：清掉上一条录制的 lastResult/stop_reason，避免 STOP 竞态回读到旧结果。
  lastResult = null;
  stopReason = 'user';
  const bitrate = Number(message.bitrate) > 0 ? Number(message.bitrate) : 4_000_000;
  const fps = Math.max(2, Number(message.fps) || 10);
  let session: EncoderSession;
  try {
    session = await startEncoder(canvas, context, width, height, bitrate, fps);
  } catch (error) {
    // 编码器起不来：清空元数据，返回结构化错误让 SW 决定回退（tabCapture）还是报失败。
    meta = null;
    throw error;
  }
  frameCanvas = canvas;
  frameContext = context;
  meta.mime = 'video/mp4';
  scheduleAutoStop(Number(message.durationMs));
  return { ok: true, mime: 'video/mp4', startedAt: meta.startedAt, mode: 'frames', encoder: session.codec };
}

async function drawFrame(dataUrl: string): Promise<void> {
  const canvas = frameCanvas;
  const context = frameContext;
  if (!canvas || !context) return;
  try {
    const response = await offscreenWindow().fetch(dataUrl);
    const blob = await response.blob();
    const bitmap = await offscreenWindow().createImageBitmap(blob);
    try {
      context.drawImage(bitmap as unknown as CanvasImageSource, 0, 0, canvas.width, canvas.height);
    } finally {
      bitmap.close();
    }
  } catch {
    // 坏帧直接丢弃（固定节拍仍会泵出上一帧）
  }
}

// ---------------------------------------------------------------------------
// 收尾：字节 → 结果（容器/分片日记/faststart 全部按实测）
// ---------------------------------------------------------------------------

interface AssembleInput {
  data: Uint8Array;
  mime: string;
  fragments: FragmentEntry[];
  finishVia: 'encoder' | 'worker' | 'main';
  faststart: boolean;
  completeFrames: boolean;
  trimmedBytes?: number;
  rawBytes?: number;
  mode: 'stream' | 'frames';
}

async function assembleResult(input: AssembleInput): Promise<OffscreenRecordingResult> {
  const current = meta ?? { recordingId: '', tabId: null, url: '', title: '', startedAt: Date.now(), mime: input.mime, mode: input.mode };
  const data = input.data;
  const container = analyzeContainer(data, input.mime);
  const journal = container.format === 'mp4' ? fragmentJournal(data) : null;
  const mime = input.mime || (container.format === 'mp4' ? 'video/mp4' : 'video/webm');
  const fragments = input.fragments.length
    ? input.fragments
    : [{ index: 0, at: current.startedAt, bytes: data.length, sha256: await sha256Hex(data) }];
  const faststart = input.faststart === true && container.faststart === true && container.hasMoof === false;
  return {
    ok: true,
    id: current.recordingId,
    tabId: current.tabId,
    url: current.url,
    title: current.title,
    startedAt: current.startedAt,
    endedAt: Date.now(),
    mime,
    data,
    completeness: input.completeFrames && data.length > 0 && container.format === 'mp4' ? 'complete' : 'partial',
    stop_reason: stopReason,
    chunk_count: fragments.length,
    fragments,
    finish_via: input.finishVia,
    complete_frames: input.completeFrames,
    faststart,
    journal: journalSummary(journal),
    mode: input.mode,
    ...(input.trimmedBytes && input.trimmedBytes > 0 ? { trimmed_bytes: input.trimmedBytes } : {}),
    ...(input.rawBytes && input.rawBytes > 0 ? { raw_bytes: input.rawBytes } : {}),
  };
}

async function buildEncoderResult(data: Uint8Array): Promise<OffscreenRecordingResult> {
  const journal = fragmentJournal(data);
  const container = analyzeContainer(data, 'video/mp4');
  const completeFrames = container.format === 'mp4' && container.hasMoov && journal.completeFrames === true;
  const fragments: FragmentEntry[] = [{
    index: 0,
    at: meta?.startedAt ?? Date.now(),
    bytes: data.length,
    sha256: await sha256Hex(data),
  }];
  return assembleResult({
    data,
    mime: 'video/mp4',
    fragments,
    finishVia: 'encoder',
    // faststart 由 muxer 的 fastStart:'in-memory' 保证，但这里仍以实测为准（moov 在 mdat 前且无 moof）。
    faststart: container.faststart === true && container.hasMoof === false,
    completeFrames,
    mode: meta?.mode === 'frames' ? 'frames' : 'stream',
  });
}

async function buildRecorderResult(session: RecorderSession): Promise<OffscreenRecordingResult> {
  await Promise.allSettled(session.hashes);
  const raw = new Uint8Array(await new Blob(session.chunks, { type: session.mime }).arrayBuffer());
  if (raw.length === 0) throw new Error('MediaRecorder 没有产出任何分片');
  const journal = fragmentJournal(raw);
  const packaged = completeFragmentPackage(raw, journal, session.fragments);
  let data = packaged.bytes;
  let fragments = packaged.fragments;
  let trimmedBytes = packaged.trimmedBytes;
  let faststart = false;
  let finishVia: 'worker' | 'main' = 'main';
  const initial = analyzeContainer(data, session.mime);
  if (initial.format === 'mp4' && initial.faststart === false && data.length <= MAX_REMUX_BYTES) {
    const remuxed = await remuxFaststart(data);
    if (remuxed && remuxed.length > 0) {
      const remuxedContainer = analyzeContainer(remuxed, 'video/mp4');
      if (remuxedContainer.faststart === true && remuxedContainer.hasMoof === false) {
        data = remuxed;
        fragments = [{ index: 0, at: meta?.startedAt ?? Date.now(), bytes: data.length, sha256: await sha256Hex(data) }];
        trimmedBytes = 0;
        faststart = true;
        finishVia = 'worker';
      }
    }
  }
  const container = analyzeContainer(data, session.mime);
  const finalJournal = container.format === 'mp4' ? fragmentJournal(data) : null;
  return assembleResult({
    data,
    mime: session.mime,
    fragments,
    finishVia,
    faststart,
    completeFrames: finalJournal ? finalJournal.completeFrames === true : false,
    trimmedBytes,
    rawBytes: trimmedBytes > 0 ? raw.length : 0,
    mode: 'stream',
  });
}

/**
 * 发布结果：内存里保留带 Uint8Array 的 lastResult（同上下文 STOP/LAST 回读），
 * 但发往 SW 的消息用 base64 线格式——Chromium 的 runtime.sendMessage 走 JSON，
 * 直接塞 Uint8Array 会变成数字键对象，SW 侧 `instanceof Uint8Array` 必然失败。
 */
function publishResult(result: OffscreenRecordingResult): OffscreenRecordingResult {
  lastResult = result;
  sendToService({ type: OFFSCREEN_MESSAGES.DONE, result: encodeOffscreenResult(result) });
  return result;
}

/** STOP/LAST 回包也走线格式（同一个 JSON 序列化约束）。 */
function wireResult(result: OffscreenRecordingResult | null): Record<string, unknown> | null {
  return result ? encodeOffscreenResult(result) : null;
}

let stopPromise: Promise<OffscreenRecordingResult> | null = null;

async function doStopRecording(): Promise<OffscreenRecordingResult> {
  clearStopTimer();
  const activeEncoder = encoder;
  const activeRecorder = recorderSession;
  if (!activeEncoder && !activeRecorder) {
    if (lastResult) return lastResult;
    throw new Error('当前没有录制');
  }
  encoder = null;
  recorderSession = null;
  try {
    let result: OffscreenRecordingResult;
    if (activeEncoder) {
      const data = await finalizeEncoder(activeEncoder);
      result = await buildEncoderResult(data);
    } else if (activeRecorder) {
      const stopped = new Promise<void>((resolve) => {
        activeRecorder.recorder.onstop = () => resolve();
      });
      if (activeRecorder.recorder.state !== 'inactive') activeRecorder.recorder.stop();
      await stopped;
      result = await buildRecorderResult(activeRecorder);
    } else {
      throw new Error('当前没有录制');
    }
    stopMediaStream();
    frameCanvas = null;
    frameContext = null;
    meta = null;
    return publishResult(result);
  } finally {
    clearStopTimer();
  }
}

/**
 * 停止录制（幂等）：离屏定时器与 SW 的 video.stop 可能同时到达，
 * 并发 STOP 共享同一个收尾 Promise，避免第二次返回旧结果/抛「当前没有录制」。
 */
function stopRecording(): Promise<OffscreenRecordingResult> {
  if (stopPromise) return stopPromise;
  stopPromise = doStopRecording().finally(() => { stopPromise = null; });
  return stopPromise;
}

async function abortRecording(): Promise<void> {
  clearStopTimer();
  if (stopPromise) {
    // 已在收尾：等它结束（结果由 stop/LAST 路径决定），然后清空活动态。
    try { await stopPromise; } catch { /* 忽略 */ }
  }
  const activeEncoder = encoder;
  const activeRecorder = recorderSession;
  encoder = null;
  recorderSession = null;
  lastResult = null;
  try {
    if (activeEncoder) {
      activeEncoder.closed = true;
      if (activeEncoder.timer !== null) offscreenWindow().clearInterval(activeEncoder.timer);
      try { await activeEncoder.reader?.cancel(); } catch { /* 忽略 */ }
      try { await activeEncoder.output.cancel(); } catch { /* 忽略 */ }
    }
    if (activeRecorder) {
      try { if (activeRecorder.recorder.state !== 'inactive') activeRecorder.recorder.stop(); } catch { /* 忽略 */ }
    }
  } finally {
    stopMediaStream();
    frameCanvas = null;
    frameContext = null;
    meta = null;
    stopReason = 'user';
  }
}

// ---------------------------------------------------------------------------
// 消息入口
// ---------------------------------------------------------------------------

function statusReply(): Record<string, unknown> {
  return {
    ok: true,
    active: isBusy(),
    state: encoder ? 'recording' : (recorderSession ? recorderSession.recorder.state : 'idle'),
    recordingId: meta?.recordingId ?? null,
    startedAt: meta?.startedAt ?? null,
    mime: meta?.mime ?? '',
    mode: meta?.mode ?? null,
  };
}

function installListener(): void {
  const runtime = resolveRuntime();
  const onMessage = runtime?.onMessage;
  if (!runtime || !onMessage) return;
  onMessage.addListener((message, _sender, sendResponse) => {
    const bag = message && typeof message === 'object' ? message as Record<string, unknown> : null;
    if (!bag || bag.target !== OFFSCREEN_TARGET) return false;
    const type = String(bag.type ?? '');
    if (type === OFFSCREEN_MESSAGES.PING) {
      sendResponse({ ok: true, ready: true });
      return false;
    }
    if (type === OFFSCREEN_MESSAGES.START) {
      startStream(bag as StartMessage)
        .then((reply) => sendResponse(reply))
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    if (type === OFFSCREEN_MESSAGES.START_FRAMES) {
      startFrames(bag as StartMessage)
        .then((reply) => sendResponse(reply))
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    if (type === OFFSCREEN_MESSAGES.FRAME) {
      drawFrame(typeof bag.data === 'string' ? bag.data : '')
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (type === OFFSCREEN_MESSAGES.STOP) {
      stopRecording()
        .then((result) => sendResponse({ ok: true, result: wireResult(result) }))
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    if (type === OFFSCREEN_MESSAGES.ABORT) {
      abortRecording()
        .then(() => sendResponse({ ok: true }))
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }
    if (type === OFFSCREEN_MESSAGES.STATUS) {
      sendResponse(statusReply());
      return false;
    }
    if (type === OFFSCREEN_MESSAGES.LAST) {
      sendResponse({ ok: true, result: wireResult(lastResult) });
      return false;
    }
    return false;
  });
}

installListener();
