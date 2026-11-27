import { finishVideo, VideoEncoderPipeline } from './encoder.js';
import { videoError } from './errors.js';
import { VideoArtifactStore } from './store.js';
import { completeStop } from './types.js';

let active;
const store = new VideoArtifactStore();
const recovering = new Map();

function recoverOnce(id, reason = 'browser_restarted') {
  let pending = recovering.get(id);
  if (!pending) {
    pending = recover(id, reason)
      .then((value) => { self.postMessage({ event: 'finished', recording_id: id }); return value; })
      .finally(() => recovering.delete(id));
    recovering.set(id, pending);
  }
  return pending;
}

async function recover(id, reason) {
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
}

async function execute(command) {
  if (command.action === 'idle') return !active && recovering.size === 0;
  if (command.action === 'recover') return recoverOnce(command.recording_id, command.reason);
  if (command.action === 'start') {
    if (active || recovering.size) throw new Error('A video is already being encoded or recovered');
    const pipeline = new VideoEncoderPipeline(command.recording, (recording) => {
      if (active?.id === recording.recording_id) active = undefined;
      self.postMessage({ event: 'finished', recording_id: recording.recording_id });
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
}

self.addEventListener('message', (event) => {
  const { id, command } = event.data;
  void execute(command).then(
    (result) => self.postMessage({ id, result }),
    (error) => self.postMessage({ id, error: videoError(error) }),
  );
});
