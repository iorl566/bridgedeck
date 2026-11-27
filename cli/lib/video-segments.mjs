// 视频分段计划：纯函数，避免把 0 长度段交给编码器。
export function planVideoSegments(durationSec, parts) {
  const duration = Number(durationSec);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('视频时长无效');
  const count = Math.max(2, Math.min(10, Math.round(Number(parts) || 2)));
  const each = duration / count;
  const segments = [];
  for (let index = 0; index < count; index += 1) {
    const start = Math.round(index * each * 1000) / 1000;
    const end = index === count - 1 ? duration : Math.round((index + 1) * each * 1000) / 1000;
    if (end - start <= 0) continue;
    segments.push({ index: index + 1, start, end });
  }
  if (!segments.length) throw new Error('无法生成有效分段');
  return segments;
}
