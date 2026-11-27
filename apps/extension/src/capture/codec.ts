// src/capture/codec.ts —— 截图编解码：PNG 尺寸、裁剪、拼接、标注、YIQ 像素差。
//
// 全部走 **可注入** 的 CanvasCodec 接口：
// - 生产真实现用 OffscreenCanvas + createImageBitmap + FileReader（MV3 service worker 可用，
//   与 JS 扩展的 fallback 路径同一套 API）；
// - 单测注入纯内存假实现，因此裁剪/拼接/差分的几何与预算逻辑可以在 Node 里精确断言，
//   不需要真实浏览器。
//
// 刻意不引入图像库、不落盘：截图产物只以 dataUrl/base64 形式在内存中流转。

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA 字节（长度 = width*height*4）。 */
  data: Uint8ClampedArray;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface EncodedImage {
  dataUrl: string;
  width: number;
  height: number;
}

export interface StitchFrame {
  dataUrl: string;
  /** 目标画布上贴图的 y（设备像素）。 */
  drawY: number;
  /** 目标画布上贴图的 x（设备像素；横向分块截图用，缺省 0）。 */
  drawX?: number;
  width: number;
  height: number;
}

/**
 * 拼接后重绘的固定带（长截图用）：把视口顶部/底部的固定顶栏、页脚贴回整页画布的
 * 首段顶部/末段底部。滚动采集时固定元素每帧都贴在视口边上，不重绘就会在拼图中间
 * 出现贯穿整页的重复横条。
 */
export interface StitchBand {
  /** 一张视口截图（顶带取顶部若干行、底带取底部若干行）。 */
  dataUrl: string;
  edge: 'top' | 'bottom';
  /** 要贴的设备像素高度（会被源图高度裁剪）。 */
  height: number;
  /** 目标画布上的 y（设备像素）。 */
  dstY: number;
}

export interface AnnotateBox {
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
}

export interface CanvasCodec {
  decode(dataUrl: string): Promise<DecodedImage>;
  /** 裁剪；output 给定时重采样到目标尺寸（区域截图按 CSS px 输出）。 */
  crop(dataUrl: string, rect: CropRect, output?: { width: number; height: number }): Promise<EncodedImage>;
  /** 拼接；`bands` 给定时在拼图之上重绘固定顶/底带（长截图的页眉/页脚）。 */
  stitch(frames: readonly StitchFrame[], width: number, height: number, bands?: readonly StitchBand[]): Promise<EncodedImage>;
  annotate(dataUrl: string, boxes: readonly AnnotateBox[]): Promise<EncodedImage>;
}

/** 从 PNG dataUrl 的 IHDR 读宽高（不依赖 canvas；畸形输入返回 0）。 */
export function pngSize(dataUrl: unknown): { width: number; height: number } {
  const text = String(dataUrl ?? '');
  const comma = text.indexOf(',');
  const base64 = comma >= 0 ? text.slice(comma + 1) : text;
  try {
    const head = atob(base64.slice(0, 48));
    const bytes = new Uint8Array(head.length);
    for (let index = 0; index < head.length; index += 1) bytes[index] = head.charCodeAt(index);
    if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return { width: 0, height: 0 };
    const view = new DataView(bytes.buffer);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  } catch {
    return { width: 0, height: 0 };
  }
}

export interface PixelDiff {
  changed: number;
  total: number;
  ratio: number;
  threshold: number;
  bbox: { x: number; y: number; width: number; height: number } | null;
}

/**
 * YIQ 感知像素差（与 pixelmatch 同量纲的纯函数）。
 * 尺寸/长度不一致返回 null（调用方据此判 sizeMatch=false）。
 */
export function diffRgba(
  previous: Uint8ClampedArray | null | undefined,
  next: Uint8ClampedArray | null | undefined,
  width: number,
  height: number,
  options: { threshold?: number } = {},
): PixelDiff | null {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return null;
  if (!previous || !next || previous.length !== next.length || previous.length !== w * h * 4) return null;
  const threshold = Math.min(Math.max(Number(options.threshold) || 0.1, 0), 1);
  const maxDelta = 35215 * threshold * threshold;
  let changed = 0;
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const index = (y * w + x) * 4;
      const dr = (previous[index] ?? 0) - (next[index] ?? 0);
      const dg = (previous[index + 1] ?? 0) - (next[index + 1] ?? 0);
      const db = (previous[index + 2] ?? 0) - (next[index + 2] ?? 0);
      const da = (previous[index + 3] ?? 0) - (next[index + 3] ?? 0);
      const yy = 0.29889531 * dr + 0.58662247 * dg + 0.11448223 * db;
      const ii = 0.59597799 * dr - 0.2741761 * dg - 0.32180189 * db;
      const qq = 0.21147017 * dr - 0.52261711 * dg + 0.31114694 * db;
      const delta = 0.5053 * yy * yy + 0.299 * ii * ii + 0.1957 * qq * qq + da * da;
      if (delta <= maxDelta) continue;
      changed += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const total = w * h;
  return {
    changed,
    total,
    ratio: total ? Math.round((changed / total) * 10000) / 10000 : 0,
    threshold,
    bbox: changed ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
  };
}

// ---------------------------------------------------------------------------
// 生产实现（OffscreenCanvas）
// ---------------------------------------------------------------------------

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ''));
      reader.onerror = () => reject(new Error('读取截图 blob 失败'));
      reader.readAsDataURL(blob);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function decodeBitmap(dataUrl: string): Promise<{ bitmap: ImageBitmap & { width: number; height: number }; close: () => void }> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  return { bitmap: bitmap as ImageBitmap & { width: number; height: number }, close: () => bitmap.close?.() };
}

function canvasOf(width: number, height: number): OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'function') throw new Error('当前运行时没有 OffscreenCanvas，无法处理截图');
  return new OffscreenCanvas(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)));
}

function contextOf(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('OffscreenCanvas 没有 2d context');
  return context as OffscreenCanvasRenderingContext2D;
}

const DRAW_LABEL_FONT = '12px sans-serif';

/** 生产实现：真实浏览器 service worker 里的 OffscreenCanvas 版本。 */
export function createBrowserCanvasCodec(): CanvasCodec {
  return {
    async decode(dataUrl: string): Promise<DecodedImage> {
      const { bitmap, close } = await decodeBitmap(String(dataUrl));
      try {
        const canvas = canvasOf(bitmap.width, bitmap.height);
        const context = contextOf(canvas);
        context.drawImage(bitmap, 0, 0);
        const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
        return { width: bitmap.width, height: bitmap.height, data: image.data };
      } finally {
        close();
      }
    },

    async crop(dataUrl: string, rect: CropRect, output?: { width: number; height: number }): Promise<EncodedImage> {
      const { bitmap, close } = await decodeBitmap(String(dataUrl));
      try {
        const sx = Math.max(0, Math.min(Math.round(rect.x), bitmap.width));
        const sy = Math.max(0, Math.min(Math.round(rect.y), bitmap.height));
        const sw = Math.max(1, Math.min(Math.round(rect.width), bitmap.width - sx));
        const sh = Math.max(1, Math.min(Math.round(rect.height), bitmap.height - sy));
        const dw = Number.isInteger(output?.width) && Number(output?.width) > 0 ? Math.floor(Number(output?.width)) : sw;
        const dh = Number.isInteger(output?.height) && Number(output?.height) > 0 ? Math.floor(Number(output?.height)) : sh;
        const canvas = canvasOf(dw, dh);
        const context = contextOf(canvas);
        context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        return { dataUrl: await blobToDataUrl(blob), width: dw, height: dh };
      } finally {
        close();
      }
    },

    async stitch(frames: readonly StitchFrame[], width: number, height: number, bands?: readonly StitchBand[]): Promise<EncodedImage> {
      const canvas = canvasOf(width, height);
      const context = contextOf(canvas);
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      for (const frame of frames) {
        const { bitmap, close } = await decodeBitmap(String(frame.dataUrl));
        try {
          context.drawImage(bitmap, Math.max(0, Math.round(frame.drawX ?? 0)), Math.max(0, Math.round(frame.drawY)));
        } finally {
          close();
        }
      }
      // 固定带最后画：它必须盖住拼接出来的重复横条。
      for (const band of bands ?? []) {
        if (!band || !band.dataUrl) continue;
        const { bitmap, close } = await decodeBitmap(String(band.dataUrl));
        try {
          const bandHeight = Math.min(Math.max(1, Math.round(Number(band.height) || 1)), bitmap.height);
          const sourceY = band.edge === 'bottom' ? Math.max(0, bitmap.height - bandHeight) : 0;
          const targetY = Math.max(0, Math.min(Math.round(Number(band.dstY) || 0), canvas.height - bandHeight));
          context.drawImage(bitmap, 0, sourceY, bitmap.width, bandHeight, 0, targetY, canvas.width, bandHeight);
        } finally {
          close();
        }
      }
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      return { dataUrl: await blobToDataUrl(blob), width: canvas.width, height: canvas.height };
    },

    async annotate(dataUrl: string, boxes: readonly AnnotateBox[]): Promise<EncodedImage> {
      const { bitmap, close } = await decodeBitmap(String(dataUrl));
      try {
        const canvas = canvasOf(bitmap.width, bitmap.height);
        const context = contextOf(canvas);
        context.drawImage(bitmap, 0, 0);
        context.lineWidth = 2;
        context.font = DRAW_LABEL_FONT;
        for (const box of boxes) {
          const x = Math.round(box.x);
          const y = Math.round(box.y);
          const width = Math.max(1, Math.round(box.width));
          const height = Math.max(1, Math.round(box.height));
          context.strokeStyle = '#ff3b30';
          context.strokeRect(x, y, width, height);
          const label = String(box.label ?? '');
          if (!label) continue;
          const textWidth = context.measureText(label).width;
          context.fillStyle = 'rgba(255,59,48,0.85)';
          context.fillRect(x, Math.max(0, y - 16), textWidth + 6, 16);
          context.fillStyle = '#ffffff';
          context.fillText(label, x + 3, Math.max(12, y - 4));
        }
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        return { dataUrl: await blobToDataUrl(blob), width: canvas.width, height: canvas.height };
      } finally {
        close();
      }
    },
  };
}
