// tests/support/fake-canvas.ts —— 截图单测用的假 CanvasCodec 与假 PNG dataUrl。
//
// 只实现 ScreenshotService 真正用到的契约：
// - decode → 返回可配置的 RGBA 像素（用于差分断言）；
// - crop / stitch / annotate → 记录几何参数并回一个占位 dataUrl；
// 断言的是“截图服务传给 codec 的几何与预算”，而不是真实像素编解码。
import type { AnnotateBox, CanvasCodec, CropRect, DecodedImage, EncodedImage, StitchFrame } from '../../src/capture/codec.ts';
import { pngSize } from '../../src/capture/codec.ts';

export interface FakeCropCall {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FakeCanvasCodec extends CanvasCodec {
  crops: FakeCropCall[];
  cropOutputs: Array<{ width: number; height: number } | undefined>;
  stitches: Array<{ drawYs: number[]; width: number; height: number }>;
  annotations: Array<{ boxes: readonly AnnotateBox[] }>;
  setPixels(dataUrl: string, pixels: { width: number; height: number; color: [number, number, number, number] }): void;
  decodedCount(): number;
}

/**
 * 构造一个“足够让 pngSize 读出宽高”的 PNG dataUrl（8 字节签名 + IHDR 头）。
 * 不是完整 PNG：截图服务只用 IHDR 读尺寸，真实像素由 codec 注入。
 */
export function fakePngDataUrl(width: number, height: number): string {
  const bytes = Buffer.alloc(24);
  bytes[0] = 0x89;
  bytes[1] = 0x50;
  bytes[2] = 0x4e;
  bytes[3] = 0x47;
  bytes[4] = 0x0d;
  bytes[5] = 0x0a;
  bytes[6] = 0x1a;
  bytes[7] = 0x0a;
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return 'data:image/png;base64,' + bytes.toString('base64');
}

export function createFakeCanvasCodec(): FakeCanvasCodec {
  const crops: FakeCropCall[] = [];
  const cropOutputs: Array<{ width: number; height: number } | undefined> = [];
  const stitches: Array<{ drawYs: number[]; width: number; height: number }> = [];
  const annotations: Array<{ boxes: readonly AnnotateBox[] }> = [];
  const pixels = new Map<string, { width: number; height: number; color: [number, number, number, number] }>();
  let decodeCalls = 0;

  return {
    crops,
    cropOutputs,
    stitches,
    annotations,
    setPixels(dataUrl, value) {
      pixels.set(dataUrl, value);
    },
    decodedCount() {
      return decodeCalls;
    },
    async decode(dataUrl: string): Promise<DecodedImage> {
      decodeCalls += 1;
      const configured = pixels.get(dataUrl);
      const size = configured ?? { width: pngSize(dataUrl).width, height: pngSize(dataUrl).height, color: [0, 0, 0, 255] as [number, number, number, number] };
      const width = Math.max(1, size.width);
      const height = Math.max(1, size.height);
      const data = new Uint8ClampedArray(width * height * 4);
      for (let index = 0; index < width * height; index += 1) {
        data[index * 4] = size.color[0];
        data[index * 4 + 1] = size.color[1];
        data[index * 4 + 2] = size.color[2];
        data[index * 4 + 3] = size.color[3];
      }
      return { width, height, data };
    },
    async crop(_dataUrl: string, rect: CropRect, output?: { width: number; height: number }): Promise<EncodedImage> {
      crops.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      cropOutputs.push(output);
      return {
        dataUrl: 'data:image/png;base64,' + Buffer.from('cropped-' + String(crops.length)).toString('base64'),
        width: output?.width ?? Math.round(rect.width),
        height: output?.height ?? Math.round(rect.height),
      };
    },
    async stitch(frames: readonly StitchFrame[], width: number, height: number): Promise<EncodedImage> {
      stitches.push({ drawYs: frames.map((frame) => frame.drawY), width, height });
      return { dataUrl: 'data:image/png;base64,' + Buffer.from('stitched-' + String(stitches.length)).toString('base64'), width, height };
    },
    async annotate(dataUrl: string, boxes: readonly AnnotateBox[]): Promise<EncodedImage> {
      annotations.push({ boxes });
      const size = pngSize(dataUrl);
      return { dataUrl: 'data:image/png;base64,' + Buffer.from('annotated').toString('base64'), width: size.width, height: size.height };
    },
  };
}
