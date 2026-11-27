/**
 * Main-frame performance scope installed into the isolated debug world.
 *
 * The scope reports a snapshot on a short debounce and after lifecycle events,
 * and it ends the visit on page hide. Every metric carries a state rather than a
 * bare number: `provisional` while a value may still change, `partial` when the
 * scope started late or entries were dropped, `unsupported` when the runtime or
 * the visit type cannot produce it, and `unavailable` when nothing was observed.
 *
 * @typedef {object} PerformanceScope
 * @property {(final?: boolean) => object} snapshot Current sanitized record.
 * @property {() => object} finish Final record; provisional metrics become partial.
 * @property {() => void} dispose Detach observers and ignore later entries.
 *
 * @typedef {object} PagePerformanceState
 * @property {'main_frame'} scope Fixed scope marker.
 * @property {string} document_key Time origin and visit counter.
 * @property {number} time_origin Epoch milliseconds of the time origin.
 * @property {number} started_at Epoch milliseconds when this visit started.
 * @property {number} observed_at Epoch milliseconds of this snapshot.
 * @property {string} url Document URL at snapshot time.
 * @property {string} navigation Navigation type, or the restore marker.
 * @property {'capturing' | 'completed'} state Visit lifecycle state.
 * @property {boolean} early Whether observation began before page scripts.
 * @property {{ at: number, state: string }[]} visibility Bounded visibility history.
 * @property {boolean} visibility_truncated True when older visibility entries were dropped.
 * @property {Record<string, { value?: number, state: string, reasons: string[] }>} metrics Per-metric state.
 * @property {{ at: number, duration_ms: number }[]} long_tasks Longest tasks, bounded.
 * @property {boolean} long_tasks_truncated True when shorter tasks were dropped.
 * @property {string[]} coverage Scope and validity tokens.
 */

/**
 * Install the main-frame performance scope in an isolated world.
 *
 * Observation is registered with buffered delivery so entries that predate the
 * install are still considered. A page restored from the back/forward cache
 * starts a new visit: counters reset, and metrics that cannot be reconstructed
 * for that visit are reported as unsupported instead of inheriting stale values.
 *
 * @param {(record: PagePerformanceState) => void} emit Receives every snapshot.
 * @param {boolean} early True when installed before page scripts ran.
 * @returns {PerformanceScope} Snapshot, finish and dispose handles.
 */
export function installPerformance(emit, early) {
  const origin = performance.timeOrigin;
  const abort = new AbortController();
  const observers = [];
  const supported = new Set(typeof PerformanceObserver === 'function' ? (PerformanceObserver.supportedEntryTypes ?? []) : []);
  let timer;
  let disposed = false;
  let visit = 0;
  let since = early ? 0 : performance.now();
  let restored = false;
  let ended = false;
  let stopped = false;
  let lcpClosed = false;
  let initiallyHidden = document.visibilityState !== 'visible';
  let firstHidden = initiallyHidden ? 0 : Infinity;
  let visibility = [{ at: origin + since, state: document.visibilityState }];
  let fcp;
  let lcp;
  let cls = 0;
  let burst = 0;
  let burstStart = 0;
  let lastShift = -Infinity;
  let taskCount = 0;
  let taskTotal = 0;
  let taskMax = 0;
  let tasks = [];
  const gaps = new Set();
  const valid = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  /** Debounce one snapshot after related entries arrive. */
  const schedule = () => {
    if (!disposed && !timer) timer = setTimeout(() => { timer = undefined; emit(snapshot()); }, 500);
  };

  /** Subscribe to one entry type, tolerating an unsupported or throwing observer.
   * @param {string} type Entry type name.
   * @param {(entries: object[]) => void} consume Bounded entry handler.
   */
  function observe(type, consume) {
    if (!supported.has(type)) return;
    try {
      const observer = new PerformanceObserver((list, _observer, options) => {
        if (disposed || ended) return;
        if (options?.droppedEntriesCount) gaps.add('browser_entry_buffer_full');
        const entries = list.getEntries();
        if (entries.length > 1000) gaps.add('performance_entry_limit');
        consume(entries.slice(0, 1000));
        schedule();
      });
      observer.observe({ type, buffered: true });
      observers.push({ observer, consume });
    } catch {
      supported.delete(type);
    }
  }

  const inVisit = (entry) => valid(entry.startTime) && (!restored || entry.startTime >= since);
  observe('paint', (entries) => {
    for (const entry of entries) if (inVisit(entry) && entry.name === 'first-contentful-paint' && entry.startTime < firstHidden) fcp = entry.startTime;
  });
  observe('largest-contentful-paint', (entries) => {
    for (const entry of entries) if (inVisit(entry) && entry.startTime < firstHidden) lcp = entry.startTime;
  });
  observe('layout-shift', (entries) => {
    for (const entry of entries) {
      if (!inVisit(entry) || entry.hadRecentInput || !valid(entry.value)) continue;
      if (entry.startTime - lastShift < 1000 && entry.startTime - burstStart < 5000) burst += entry.value;
      else { burst = entry.value; burstStart = entry.startTime; }
      lastShift = entry.startTime;
      cls = Math.max(cls, burst);
    }
  });
  observe('longtask', (entries) => {
    for (const entry of entries) {
      if (!inVisit(entry) || !valid(entry.duration)) continue;
      taskCount += 1;
      taskTotal += entry.duration;
      taskMax = Math.max(taskMax, entry.duration);
      tasks.push({ at: origin + entry.startTime, duration_ms: entry.duration });
    }
    tasks.sort((a, b) => b.duration_ms - a.duration_ms || a.at - b.at);
    tasks = tasks.slice(0, 50);
  });

  /** Take every buffered entry so a pending snapshot is not delayed by delivery. */
  function drain() {
    for (const item of observers) {
      const entries = item.observer.takeRecords();
      if (entries.length > 1000) gaps.add('performance_entry_limit');
      item.consume(entries.slice(0, 1000));
    }
  }

  /** Build the sanitized record from counters and buffered entries.
   *
   * The record is always well formed: unusable numbers become an explicit
   * state with a reason instead of a missing or misleading value.
   *
   * @param {boolean} [final] Treat dynamic metrics as settled for this visit.
   * @returns {PagePerformanceState} Current record.
   */
  function snapshot(final = false) {
    drain();
    const nav = performance.getEntriesByType('navigation')[0];
    const prerendered = (nav?.activationStart ?? 0) > 0 || !!document.prerendering;
    const metric = (value, type, dynamic = false, paint = false) => {
      const reasons = [];
      let state = dynamic && !ended && !final ? 'provisional' : 'available';
      if (!supported.has(type)) { state = 'unsupported'; value = undefined; reasons.push('api_unsupported'); }
      else if (restored && type !== 'longtask' && type !== 'layout-shift') { state = 'unsupported'; reasons.push('back_forward_cache'); value = undefined; }
      else if (prerendered && type !== 'longtask') { state = 'unsupported'; reasons.push('prerendered_page'); value = undefined; }
      else if (paint && initiallyHidden) { state = 'unavailable'; reasons.push('initially_hidden'); value = undefined; }
      else if (value === undefined) { state = 'unavailable'; reasons.push(ended || final ? 'not_observed' : 'not_observed_yet'); }
      else if ((!early && type !== 'navigation') || gaps.size) {
        state = 'partial';
        if (!early) reasons.push('started_late');
        reasons.push(...gaps);
      }
      if (stopped && dynamic && state === 'available') { state = 'partial'; reasons.push('capture_stopped_before_final'); }
      return { ...(valid(value) ? { value } : {}), state, reasons };
    };
    const navigation = (value) => metric(value && value > 0 ? value : undefined, 'navigation');
    return {
      document_key: `${origin}:${visit}`,
      time_origin: origin,
      started_at: origin + since,
      observed_at: Date.now(),
      url: location.href,
      navigation: restored ? 'back_forward_cache' : (nav?.type ?? 'unknown'),
      state: ended || final ? 'completed' : 'capturing',
      early,
      scope: 'main_frame',
      visibility,
      visibility_truncated: gaps.has('visibility_history_limit'),
      metrics: {
        ttfb_ms: navigation(nav?.responseStart),
        dom_content_loaded_ms: navigation(nav?.domContentLoadedEventEnd),
        load_ms: navigation(nav?.loadEventEnd),
        fcp_ms: metric(fcp, 'paint', false, true),
        lcp_ms: metric(lcp, 'largest-contentful-paint', !lcpClosed, true),
        cls: metric(cls, 'layout-shift', true),
        long_task_count: metric(taskCount, 'longtask'),
        long_task_total_ms: metric(taskTotal, 'longtask'),
        long_task_max_ms: metric(taskMax, 'longtask'),
      },
      long_tasks: tasks,
      long_tasks_truncated: taskCount > tasks.length,
      coverage: [...new Set(['main_frame_only', ...(!early ? ['started_late', 'visibility_before_capture_unknown'] : []), ...gaps])],
    };
  }

  /** Emit immediately, cancelling a scheduled snapshot. */
  function send(final = false) {
    if (disposed) return;
    clearTimeout(timer);
    timer = undefined;
    emit(snapshot(final));
  }

  document.addEventListener('visibilitychange', () => {
    if (visibility.length < 64) visibility.push({ at: Date.now(), state: document.visibilityState });
    else gaps.add('visibility_history_limit');
    if (document.visibilityState === 'hidden') { firstHidden = Math.min(firstHidden, performance.now()); lcpClosed = true; }
    send();
  }, { signal: abort.signal });
  for (const type of ['pointerdown', 'keydown', 'scroll']) {
    document.addEventListener(type, () => { if (!lcpClosed) { lcpClosed = true; send(); } }, { capture: true, passive: true, signal: abort.signal });
  }
  window.addEventListener('load', schedule, { signal: abort.signal });
  document.addEventListener('DOMContentLoaded', schedule, { signal: abort.signal });
  window.addEventListener('pagehide', () => { send(true); ended = true; }, { signal: abort.signal });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    visit += 1;
    since = performance.now();
    restored = true;
    early = true;
    ended = false;
    stopped = false;
    fcp = undefined;
    lcp = undefined;
    cls = burst = burstStart = taskCount = taskTotal = taskMax = 0;
    lastShift = -Infinity;
    tasks = [];
    gaps.clear();
    lcpClosed = false;
    initiallyHidden = document.visibilityState !== 'visible';
    firstHidden = initiallyHidden ? 0 : Infinity;
    visibility = [{ at: origin + since, state: document.visibilityState }];
    send();
  }, { signal: abort.signal });
  send();
  return {
    snapshot,
    finish: () => {
      clearTimeout(timer);
      timer = undefined;
      stopped = true;
      const value = snapshot();
      value.state = 'completed';
      ended = true;
      for (const item of Object.values(value.metrics)) if (item.state === 'provisional') { item.state = 'partial'; item.reasons.push('capture_stopped_before_final'); }
      return value;
    },
    dispose: () => {
      disposed = true;
      abort.abort();
      clearTimeout(timer);
      for (const item of observers) item.observer.disconnect();
    },
  };
}
