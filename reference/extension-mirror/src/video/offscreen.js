import { VideoError, videoError } from './errors.js';
import { VideoArtifactStore } from './store.js';
import { VIDEO_HOST_EVENT, VIDEO_HOST_PORT } from './types.js';

/**
 * Dependencies for the offscreen encoder document. `VideoArtifactStore` is
 * declared in ./store.js and the host message shapes in ./host-protocol.js.
 *
 * @typedef {object} VideoOffscreenDeps
 * @property {object} [runtime] Message runtime: `id`, `onConnect` and
 *   `sendMessage`.
 * @property {VideoArtifactStore} [store] Artifact store; one is created by default.
 * @property {() => Worker} createWorker Encoder worker factory.
 * @property {typeof URL} [urlApi] Object-URL API for download URLs.
 */

/**
 * Attach the host port and encoder worker owned by one offscreen document.
 *
 * @param {VideoOffscreenDeps} [deps]
 * @returns {() => void} Removes the runtime and worker listeners.
 */
export function attachVideoOffscreen(deps = {}) {
  const runtime = deps.runtime ?? globalThis.chrome?.runtime;
  const store = deps.store ?? new VideoArtifactStore();
  const createWorker = deps.createWorker;
  const urlApi = deps.urlApi ?? globalThis.URL;
  const pending = new Map();
  const urls = new Set();
  let activeId;
  let worker;

  /**
   * Replace a failed worker, reject its pending commands and recover the
   * recording that was being encoded.
   *
   * @param {{ code: string, message: string }} [error] Failure reported to callers.
   * @returns {void}
   */
  function resetWorker(error = { code: 'cdp_failed', message: 'Video worker stopped unexpectedly' }) {
    worker.terminate();
    for (const [id, respond] of pending) respond({ id, error });
    pending.clear();
    worker = createWorker();
    if (activeId) {
      worker.postMessage({ id: crypto.randomUUID(), command: { action: 'recover', recording_id: activeId, reason: 'encoding_failed' } });
      void runtime.sendMessage({ kind: VIDEO_HOST_EVENT, recording_id: activeId, failed: true }).catch(() => {});
      activeId = undefined;
    }
  }

  worker = createWorker();
  const onWorkerMessage = (event) => {
    if (event.data.event === 'finished') {
      activeId = undefined;
      void runtime.sendMessage({ kind: VIDEO_HOST_EVENT, recording_id: event.data.recording_id }).catch(() => {});
      return;
    }
    const callback = pending.get(event.data.id);
    pending.delete(event.data.id);
    callback?.(event.data);
  };
  const onWorkerError = () => resetWorker();
  worker.addEventListener('message', onWorkerMessage);
  worker.addEventListener('error', onWorkerError);

  const onConnect = (port) => {
    if (port.name !== VIDEO_HOST_PORT) return undefined;
    const sender = port.sender;
    if (!sender || sender.id !== runtime.id || sender.tab) return undefined;
    let connected = true;
    port.onDisconnect.addListener(() => { connected = false; });
    const onMessage = (message) => {
      const respond = (reply) => { if (connected) port.postMessage(reply); };
      const id = message.id;
      const command = message.command;
      const execute = async () => {
        if (command.action === 'download_url') {
          const value = await store.get(command.recording_id);
          if (value?.state !== 'ready') throw new Error('Video is not ready to save');
          const url = urlApi.createObjectURL(await store.file(command.recording_id));
          urls.add(url);
          return url;
        }
        if (command.action === 'revoke_url') {
          if (urls.delete(command.url)) urlApi.revokeObjectURL(command.url);
          return undefined;
        }
        if (command.action === 'idle' && urls.size > 0) return false;
        if (command.action === 'start') activeId = command.recording.recording_id;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resetWorker({ code: 'timeout', message: 'Video worker did not respond within 29s' }), 29000);
          pending.set(id, (reply) => {
            clearTimeout(timer);
            if (reply.error) reject(new VideoError(reply.error));
            else resolve(reply.result);
          });
          worker.postMessage({ id, command });
        });
      };
      void execute().then((result) => respond({ id, result }), (error) => respond({ id, error: videoError(error) }));
    };
    port.onMessage.addListener(onMessage);
    return () => port.onMessage.removeListener(onMessage);
  };
  runtime.onConnect.addListener(onConnect);

  return () => {
    runtime.onConnect.removeListener(onConnect);
    worker.removeEventListener('message', onWorkerMessage);
    worker.removeEventListener('error', onWorkerError);
  };
}
