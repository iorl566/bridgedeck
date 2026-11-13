export const VIDEO_VERSION = 1;
export const VIDEO_CHUNK_BYTES = 256 * 1024;
export const VIDEO_MAX_BYTES = 256 * 1024 * 1024;
export const VIDEO_BUDGET_BYTES = 1024 * 1024 * 1024;
export const VIDEO_RETENTION_MS = 24 * 60 * 60_000;
export const VIDEO_MAX_DURATION_MS = 10 * 60_000;
export const VIDEO_MESSAGE = 'bb/video';
export const VIDEO_HOST_PORT = 'bb/video-host';
export const VIDEO_HOST_EVENT = 'bb/video-host-event';

export const VIDEO_PRESETS = {
  standard: { maxDimension: 1280, fps: 15, bitrate: 2_000_000 },
  clear: { maxDimension: 1920, fps: 30, bitrate: 4_000_000 },
};

/**
 * @typedef {'standard' | 'clear'} VideoQuality
 * @typedef {'starting' | 'recording' | 'finalizing' | 'ready' | 'failed'} VideoState
 * @typedef {'user_stopped' | 'duration_limit' | 'size_limit' | 'tab_closed'
 *   | 'session_ended' | 'disconnected' | 'debugger_detached' | 'capture_failed'
 *   | 'encoding_failed' | 'storage_failed' | 'browser_restarted'} VideoStopReason
 *
 * @typedef {object} VideoRecording
 * @property {string} recording_id
 * @property {string} session_id
 * @property {number} tab_id
 * @property {string} title
 * @property {VideoState} state
 * @property {VideoQuality} quality
 * @property {number} created_at
 * @property {number} [started_at]
 * @property {number} expires_at
 * @property {number} max_duration_ms
 * @property {number} duration_ms
 * @property {number} byte_size
 * @property {number} width
 * @property {number} height
 * @property {number} frames
 * @property {number} dropped_frames
 * @property {VideoStopReason} [stop_reason]
 * @property {'complete' | 'partial'} [completeness]
 * @property {string} [error]
 * @property {boolean} exported
 *
 * @typedef {VideoRecording & {
 *   owner: string,
 *   capability: string,
 *   request_id: string,
 * }} StoredVideo
 *
 * @typedef {object} VideoStartOptions
 * @property {string} session_id
 * @property {number} [tab_id]
 * @property {number} [max_duration_ms]
 * @property {VideoQuality} [quality]
 * @property {string} request_id
 *
 * @typedef {object} VideoGrant
 * @property {VideoRecording} recording
 * @property {string} capability
 *
 * @typedef {object} VideoTask
 * @property {string} session_id
 * @property {{ id: number, title: string, url: string, active: boolean }[]} tabs
 *
 * @typedef {({ action: 'start' } & VideoStartOptions)
 *   | { action: 'capabilities' | 'list', browser?: string }
 *   | { action: 'status' | 'stop' | 'read' | 'discard' | 'exported',
 *       browser?: string, recording_id: string, capability: string, offset?: number }} VideoParams
 */

export function publicVideo(value) {
  const { owner: _owner, capability: _capability, request_id: _request, ...recording } = value;
  return recording;
}

export function isVideoId(id) {
  return typeof id === 'string' && /^vid_[a-f0-9]{32}$/.test(id);
}

export function completeStop(reason) {
  return ['user_stopped', 'duration_limit', 'size_limit'].includes(reason);
}

export function videoFilename(recording) {
  const title = recording.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').trim().slice(0, 80);
  const date = new Date(recording.created_at).toISOString().replace(/[:.]/g, '-');
  return `${title || 'Video'}-${date}.mp4`;
}

export function validateVideoStart(value) {
  if (!value || typeof value.session_id !== 'string' || !value.session_id) return 'session_id is required';
  if (typeof value.request_id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(value.request_id)) return 'A stable request_id is required';
  if (value.tab_id !== undefined && (!Number.isSafeInteger(value.tab_id) || value.tab_id < 0)) return 'Invalid tab_id';
  const duration = value.max_duration_ms ?? 60_000;
  if (!Number.isSafeInteger(duration) || duration < 1000 || duration > VIDEO_MAX_DURATION_MS) return 'max_duration_ms must be between 1000 and 600000';
  if (value.quality !== undefined && !Object.hasOwn(VIDEO_PRESETS, value.quality)) return 'quality must be standard or clear';
  return undefined;
}
