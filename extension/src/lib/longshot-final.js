/** 长截图末尾「final exposure」：确保文档底部（含固定页脚/懒加载追加）至少有一帧完整覆盖。 */
export function planFinalExposure({ scrollHeight, innerHeight, scale = 1, lastBottom = 0, viewportHeight = 0 } = {}) {
  const docHeight = Number(scrollHeight);
  const view = Number(innerHeight);
  const s = Number(scale) > 0 ? Number(scale) : 1;
  if (!(docHeight > 0) || !(view > 0)) return null;
  const docPx = Math.round(docHeight * s);
  const framePx = Number(viewportHeight) > 0 ? Math.round(Number(viewportHeight)) : Math.round(view * s);
  if (lastBottom >= docPx - 1) return null;
  return {
    scrollY: Math.max(0, docHeight - view),
    drawY: Math.max(0, docPx - framePx),
  };
}
