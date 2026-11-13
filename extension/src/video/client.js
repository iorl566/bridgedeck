import React from 'react';
import { VIDEO_MESSAGE } from './types.js';

export async function videoRequest(action, params = {}, send = (message) => globalThis.chrome.runtime.sendMessage(message)) {
  const response = await send({ kind: VIDEO_MESSAGE, action, ...params });
  if (!response?.ok) throw new Error(response?.error ?? 'Video service is unavailable');
  return response.data;
}

export function useVideos() {
  const [snapshot, setSnapshot] = React.useState({ tasks: [], recordings: [] });
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [interrupting, setInterrupting] = React.useState(false);
  React.useEffect(() => {
    let disposed = false;
    let timer;
    const refresh = async () => {
      try {
        const next = await videoRequest('snapshot');
        if (!disposed) setSnapshot(next);
      } catch (reason) {
        if (!disposed) setError(String(reason));
      } finally {
        if (!disposed) timer = setTimeout(refresh, 1000);
      }
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, []);
  const run = async (action, params = {}) => {
    const setPending = action === 'interrupt' ? setInterrupting : setBusy;
    setPending(true);
    setError('');
    try {
      await videoRequest(action, params);
      setSnapshot(await videoRequest('snapshot'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };
  return { ...snapshot, error, busy, interrupting, run };
}

export function videoTime(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function openVideo(id) {
  return chrome.tabs.create({ url: chrome.runtime.getURL(`video.html${id ? `?id=${encodeURIComponent(id)}` : ''}`) });
}
