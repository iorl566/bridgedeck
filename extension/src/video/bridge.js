import { VideoDownloads } from './downloads.js';
import { publicVideo, VIDEO_HOST_EVENT, VIDEO_MESSAGE } from './types.js';
import { VIDEO_OVERLAY } from './overlay.js';

/**
 * Bridge between UI messages, the recording manager and the offscreen host.
 *
 * `VideoManager` is declared in ./manager.js and `VideoHost` in
 * ./host-protocol.js.
 *
 * @typedef {object} VideoBridgeDeps
 * @property {object} [runtime] Message runtime: `id`, `onMessage`, `getURL`.
 * @property {object} [webNavigation] Frame lookup API with `getFrame`.
 * @property {VideoDownloads} [downloads] Prebuilt save helper.
 * @property {object} [downloadDeps] Dependencies for the default save helper.
 */

/**
 * Whether a message sender is one of the extension's own video pages.
 *
 * @param {{ id?: string, url?: string }} sender
 * @param {{ id: string, getURL: (path: string) => string }} runtime
 * @returns {boolean}
 */
export function isVideoPage(sender, runtime) {
  if (sender.id !== runtime.id || !sender.url) return false;
  return ['popup.html', 'video.html'].some((page) => sender.url.split('?')[0] === runtime.getURL(page));
}

/**
 * Wire popup/UI messages to the recording manager and offscreen host.
 *
 * @param {VideoManager} video
 * @param {VideoHost} host
 * @param {(sessionId: string) => Promise<unknown>} interrupt
 * @param {VideoBridgeDeps} [deps]
 * @returns {() => void} Removes the message listener.
 */
export function attachVideoBridge(video, host, interrupt, deps = {}) {
  const runtime = deps.runtime ?? globalThis.chrome?.runtime;
  const webNavigation = deps.webNavigation ?? globalThis.chrome?.webNavigation;
  const downloads = deps.downloads ?? new VideoDownloads(video, host, deps.downloadDeps);
  downloads.attach?.();
  const onMessage = runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.kind === VIDEO_HOST_EVENT) {
      if (sender.id === runtime.id && sender.url === runtime.getURL('video-offscreen.html')) {
        void (message.failed ? video.stop(message.recording_id, 'encoding_failed') : video.finished(message.recording_id)).catch(() => {});
      }
      return false;
    }
    if (message?.type === VIDEO_OVERLAY) {
      if (sender.id !== runtime.id || sender.tab?.id === undefined) return false;
      const tab = sender.tab.id;
      const execute = async () => {
        const frame = sender.documentId ? { tabId: tab, documentId: sender.documentId } : { tabId: tab, frameId: sender.frameId };
        const current = await webNavigation.getFrame(frame);
        if (current?.frameType !== 'outermost_frame' || current.documentLifecycle !== 'active' || (sender.documentId && current.documentId !== sender.documentId)) throw new Error('Video overlay document changed');
        if (message.action === 'query') return { recording_id: await video.queryOverlay(tab, sender.documentId) };
        if (!['interactive', 'clean'].includes(message.action)) throw new Error('Invalid overlay action');
        return { recording_id: await video.suspend(tab, message.action === 'interactive' ? 'interactive' : 'clean', sender.documentId) };
      };
      void execute().then(respond, () => respond({ error: 'Video overlay handshake failed' }));
      return true;
    }
    if (message?.kind !== VIDEO_MESSAGE) return false;
    if (!isVideoPage(sender, runtime)) {
      respond({ ok: false, error: 'forbidden' });
      return false;
    }
    const execute = async () => {
      switch (message.action) {
        case 'snapshot': return { tasks: await video.tasks(), recordings: (await video.list()).map(publicVideo) };
        case 'start': return { recording: (await video.start(message.options)).recording };
        case 'stop': return { recording: publicVideo(await video.stop(message.recording_id)) };
        case 'discard': await video.discard(message.recording_id); return {};
        case 'interrupt': return interrupt(message.session_id);
        case 'save': return downloads.save(message.recording_id);
        default: throw new Error('Unsupported video UI action');
      }
    };
    void execute().then((data) => respond({ ok: true, data }), (error) => respond({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  });
  return () => runtime.onMessage.removeListener(onMessage);
}
