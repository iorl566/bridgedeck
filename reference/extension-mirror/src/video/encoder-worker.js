import { completeStop } from './types.js';

/**
 * Dependencies for the testable encoder-worker core. `StoredVideo` and
 * `VideoStopReason` are declared in ./types.js, `VideoHostCommand` in
 * ./host-protocol.js and `VideoEncoderPipeline` in ./encoder.js.
 *
 * @typedef {object} VideoWorkerHandlerDeps
 * @property {object} store Artifact store with `get` and `put`.
 * @property {(recording: StoredVideo,
 *   finished: (recording: StoredVideo) => void) => VideoEncoderPipeline} createPipeline
 * @property {(recording: StoredVideo) => Promise<StoredVideo>} finishVideo
 * @property {(message: { event: 'finished', recording_id: string }) => void} [post]
 *   Publishes worker events; defaults to a no-op in tests.
 *
 * @typedef {object} VideoWorkerHandler
 * @property {(command: VideoHostCommand) => Promise<unknown>} execute
 *   Run one host command and resolve with its result.
 * @property {Map<string, Promise<StoredVideo>>} recovering
 *   In-flight recoveries keyed by recording id.
 */

/**
 * Build the command handler shared by the encoder worker and its tests.
 *
 * @param {VideoWorkerHandlerDeps} deps
 * @returns {VideoWorkerHandler}
 */
export function createVideoWorkerHandler({ store, createPipeline, finishVideo, post = () => {} }) {
  let active;
  const recovering = new Map();

  const recover = async (id, reason) => {
    if (active?.id === id) return active.pipeline.stop(reason);
    const value = await store.get(id);
    if (!value) throw new Error('Recording not found');
    if (value.state === 'ready' || value.state === 'failed') return value;
    const interrupted = { ...value, stop_reason: reason, completeness: 'partial' };
    try {
      return await finishVideo(interrupted);
    } catch (error) {
      const failed = { ...interrupted, state: 'failed', error: error instanceof Error ? error.message : String(error) };
      await store.put(failed);
      return failed;
    }
  };
  const recoverOnce = (id, reason = 'browser_restarted') => {
    let pending = recovering.get(id);
    if (!pending) {
      pending = recover(id, reason)
        .then((value) => { post({ event: 'finished', recording_id: id }); return value; })
        .finally(() => recovering.delete(id));
      recovering.set(id, pending);
    }
    return pending;
  };

  return {
    async execute(command) {
      if (command.action === 'idle') return !active && recovering.size === 0;
      if (command.action === 'recover') return recoverOnce(command.recording_id, command.reason);
      if (command.action === 'start') {
        if (active || recovering.size) throw new Error('A video is already being encoded or recovered');
        const pipeline = createPipeline(command.recording, (recording) => {
          if (active?.id === recording.recording_id) active = undefined;
          post({ event: 'finished', recording_id: recording.recording_id });
        });
        active = { id: command.recording.recording_id, pipeline };
        try {
          return await pipeline.start(command.image);
        } catch (error) {
          active = undefined;
          throw error;
        }
      }
      if (command.action === 'download_url' || command.action === 'revoke_url') throw new Error('Blob URLs belong to the offscreen document');
      if (!active || active.id !== command.recording_id) {
        if (command.action === 'stop') return recoverOnce(command.recording_id, completeStop(command.reason) ? 'encoding_failed' : command.reason);
        return undefined;
      }
      if (command.action === 'stop') return active.pipeline.stop(command.reason);
      if (command.action === 'frame') return active.pipeline.frame(command.image, command.elapsed_ms);
      return active.pipeline.suspend(command.mode, command.label);
    },
    get recovering() { return recovering; },
  };
}
