// video-record-fields.js —— 从录制记录里挑选对外返回的 journal/封装字段。
// 单独成文件是为了让 video.js 控制在架构门禁的 1100 行预算内。
export function journalFields(record) {
  if (!record) return {};
  return {
    ...(record.complete_frames !== undefined ? { complete_frames: record.complete_frames } : {}),
    ...(record.finish_via ? { finish_via: record.finish_via } : {}),
    ...(record.journal ? { journal: record.journal } : {}),
    ...(record.raw_bytes !== undefined ? { raw_bytes: record.raw_bytes } : {}),
    ...(record.trimmed_bytes !== undefined ? { trimmed_bytes: record.trimmed_bytes } : {}),
    ...(record.indexed ? { indexed: true } : {}),
    ...(record.sidx_bytes ? { sidx_bytes: record.sidx_bytes } : {}),
    ...(record.faststart ? { faststart: true, faststart_bytes: record.faststart_bytes, faststart_packets: record.faststart_packets } : {}),
  };
}
