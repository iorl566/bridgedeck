// extension/src/screenshot-visual.js —— 截图标注/网格/剖面与 dataUrl 工具。

export async function blobToDataUrl(blob) {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode.apply(null, buffer.subarray(i, i + chunk));
  }
  return `data:image/png;base64,${btoa(binary)}`;
}

async function annotateShot(dataUrl, refs, scale) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  ctx.lineWidth = 2;
  ctx.font = 'bold ' + Math.max(12, Math.round(12 * scale)) + 'px Segoe UI, sans-serif';
  for (const item of refs) {
    const x = Math.round(item.x * scale);
    const y = Math.round(item.y * scale);
    const width = Math.round(item.width * scale);
    const height = Math.round(item.height * scale);
    ctx.strokeStyle = 'rgba(47,111,237,0.95)';
    ctx.fillStyle = 'rgba(47,111,237,0.12)';
    ctx.fillRect(x, y, width, height);
    ctx.strokeRect(x, y, width, height);
    const label = item.ref;
    const metrics = ctx.measureText(label);
    const padX = Math.round(4 * scale);
    const padY = Math.round(2 * scale);
    const labelHeight = Math.round(14 * scale);
    const labelWidth = Math.round(metrics.width + padX * 2);
    const labelY = y - labelHeight < 0 ? y : y - labelHeight;
    ctx.fillStyle = 'rgba(47,111,237,0.95)';
    ctx.fillRect(x, labelY, labelWidth, labelHeight);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x + padX, labelY + labelHeight - padY * 2);
  }
  const output = await canvas.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(output);
}

async function gridShot(dataUrl, scale, step) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const gap = Math.max(10, Math.round(Number(step) || 50));
  ctx.font = 'bold 11px Segoe UI, sans-serif';
  ctx.textBaseline = 'top';
  for (let x = 0; x < canvas.width; x += gap) {
    const major = x % (gap * 2) === 0;
    ctx.strokeStyle = major ? 'rgba(220,38,38,0.55)' : 'rgba(220,38,38,0.22)';
    ctx.lineWidth = major ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, canvas.height);
    ctx.stroke();
    if (major) {
      ctx.fillStyle = 'rgba(220,38,38,0.9)';
      ctx.fillText(String(x), x + 2, 2);
    }
  }
  for (let y = 0; y < canvas.height; y += gap) {
    const major = y % (gap * 2) === 0;
    ctx.strokeStyle = major ? 'rgba(37,99,235,0.55)' : 'rgba(37,99,235,0.22)';
    ctx.lineWidth = major ? 1.5 : 1;
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(canvas.width, y + 0.5);
    ctx.stroke();
    if (major) {
      ctx.fillStyle = 'rgba(37,99,235,0.95)';
      ctx.fillText(String(y), 2, y + 1);
    }
  }
  const output = await canvas.convertToBlob({ type: 'image/png' });
  return blobToDataUrl(output);
}

async function profileShot(dataUrl, axis) {
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  const gray = (x, y) => {
    const i = (y * width + x) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  const along = axis === 'y' ? height : width;
  const across = axis === 'y' ? width : height;
  const scores = new Float64Array(along);
  for (let a = 1; a < along; a += 1) {
    let sum = 0;
    for (let b = 0; b < across; b += 1) {
      const prev = axis === 'y' ? gray(b, a - 1) : gray(a - 1, b);
      const cur = axis === 'y' ? gray(b, a) : gray(a, b);
      sum += Math.abs(cur - prev);
    }
    scores[a] = sum / across;
  }
  const peaks = [];
  for (let a = 0; a < along; a += 1) {
    const prev = a > 0 ? scores[a - 1] : 0;
    const next = a < along - 1 ? scores[a + 1] : 0;
    if (scores[a] > prev && scores[a] >= next) peaks.push({ pos: a, score: Math.round(scores[a] * 100) / 100 });
  }
  peaks.sort((a, b) => b.score - a.score);
  return { axis, width, height, peaks: peaks.slice(0, 12) };
}

export { annotateShot, gridShot, profileShot };
