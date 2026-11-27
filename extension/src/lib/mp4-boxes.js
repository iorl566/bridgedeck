/** 顶层 ISO BMFF box 扫描：判断 MediaRecorder MP4 是否 fragmented。 */
export function analyzeMp4(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const boxes = [];
  let offset = 0;
  while (offset + 8 <= data.length && boxes.length < 200) {
    let size = new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0);
    const type = String.fromCharCode(data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7]);
    let header = 8;
    if (size === 1 && offset + 16 <= data.length) {
      const hi = new DataView(data.buffer, data.byteOffset + offset + 8, 4).getUint32(0);
      const lo = new DataView(data.buffer, data.byteOffset + offset + 12, 4).getUint32(0);
      size = hi * 4294967296 + lo;
      header = 16;
    } else if (size === 0) {
      size = data.length - offset;
    }
    if (size < header || offset + size > data.length) break;
    boxes.push({ type, size, offset });
    offset += size;
  }
  const types = boxes.map((box) => box.type);
  const fragmented = types.includes('moof');
  const moov = boxes.find((box) => box.type === 'moov') || null;
  const mdat = boxes.find((box) => box.type === 'mdat') || null;
  const moof = boxes.find((box) => box.type === 'moof') || null;
  return {
    format: 'mp4',
    fragmented,
    boxes: types.slice(0, 40),
    // 偏移/大小明细：moov 是否前置（faststart）、首个 moof 位置、扫描是否被截断都从这一层派生。
    boxDetails: boxes.slice(0, 40),
    hasFtyp: types.includes('ftyp'),
    hasMoov: types.includes('moov'),
    hasMoof: fragmented,
    hasSidx: types.includes('sidx'),
    moovOffset: moov ? moov.offset : null,
    mdatOffset: mdat ? mdat.offset : null,
    firstMoofOffset: moof ? moof.offset : null,
    faststart: Boolean(moov && (mdat == null || moov.offset < mdat.offset)),
    parsedBytes: offset,
    truncated: offset < data.length,
  };
}
