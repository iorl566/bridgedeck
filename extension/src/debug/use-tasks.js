import { useCallback, useEffect, useState } from 'react';
import { debugTasks } from './client.js';

/**
 * Result of the live debug-task subscription.
 * @typedef {object} DebugTasksState
 * @property {object[]} tasks Live task summaries, newest polling result.
 * @property {string} error Last polling failure, or an empty string.
 * @property {boolean} loaded True once the first poll settled.
 * @property {() => void} refresh Poll again immediately.
 */

/** Poll only while extension UI is visible; never wake a closed popup.
 *
 * A hidden document skips the poll entirely, and the interval stops with the
 * view. The first poll fills the state so the UI can distinguish "no tasks"
 * from "not loaded yet".
 *
 * @param {boolean} [enabled] False suspends polling and clears the state.
 * @returns {DebugTasksState} Current tasks and a manual refresh.
 */
export function useDebugTasks(enabled = true) {
  const [tasks, setTasks] = useState([]);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!enabled) {
      setTasks([]);
      setLoaded(false);
      return;
    }
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    let live = true;
    let busy = false;
    const update = async () => {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const result = await debugTasks();
        if (live) {
          setTasks(result.tasks ?? []);
          setError('');
        }
      } catch (err) {
        if (live) {
          setTasks([]);
          setError(err instanceof Error ? err.message : 'unavailable');
        }
      } finally {
        busy = false;
        if (live) setLoaded(true);
      }
    };
    void update();
    const timer = setInterval(() => void update(), 2000);
    document.addEventListener('visibilitychange', update);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', update);
    };
  }, [enabled, revision]);
  return { tasks, error, loaded, refresh };
}
