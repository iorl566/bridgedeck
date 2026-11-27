import { MAX_REPLAYS, editRequest, publicRule, replayRequest, urlMatcher, validateReplay, validateRule } from './control-model.js';
import { redactText } from './redact.js';

/**
 * Local execution of pre-declared request rules: patterns are enabled per target,
 * paused requests are decided synchronously, and one request can be replayed
 * from retained evidence.
 *
 * Evidence shapes (`DebugRule`, `DebugRuleSpec`, `DebugReplay`, `DebugReplaySpec`,
 * `DebugRequest`) are declared in ./types.js; the bare names below refer to those
 * declarations.
 *
 * @typedef {object} Target
 * @property {number} tabId Tab the target belongs to.
 * @property {string} [sessionId] Absent for the top-level target.
 *
 * @typedef {object} Rule
 * @property {DebugRuleSpec} [spec] Cleared once the rule is removed.
 * @property {DebugRule} public Rule state exposed to callers.
 * @property {RegExp} matcher Anchored URL matcher.
 *
 * @typedef {object} PendingControl
 * @property {Target} target
 * @property {string} id Browser request id.
 * @property {Rule} rule
 * @property {AbortController} abort
 * @property {Promise<void>} done Settles once the decision has been applied.
 *
 * @typedef {object} ReplayRun
 * @property {DebugReplay} result Public replay state, updated in place.
 * @property {Promise<DebugReplay>} promise Settles when the replay finishes.
 */

/**
 * @param {string} text UTF-8 text to encode.
 * @returns {string} Base64 form expected by the browser command payload.
 */
function base64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}
/**
 * @param {number} ms Delay before the mocked response is released.
 * @param {AbortSignal} signal Aborted when the rule or capture stops.
 * @returns {Promise<void>} Rejects with `cancelled` on abort.
 */
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(new Error('cancelled')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}
/**
 * @param {Promise<any>} promise Browser command already in flight.
 * @param {number} [ms] Maximum wait before the command is abandoned.
 * @returns {Promise<any>} The command result, or a timeout error.
 */
async function bounded(promise, ms = 2500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('browser command timed out')), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Executes predeclared rules locally. Paused requests never wait on the
 * agent/tool queue. Each in-flight decision is tracked as a `PendingControl` and
 * each replay run as a `ReplayRun`.
 *
 * Rules are validated before they are stored, applied only to matching requests
 * on registered targets, and become inert once removed or stopped. Enabling a
 * rule can fail after the pattern was sent, so a failed rule is left disabled and
 * the error is reported instead of retried silently. Replays are keyed per
 * capture and cannot be redefined for a different source request.
 */
export class DebugNetworkControl {
  /**
   * @param {string} runId Capture id used to build rule and replay ids.
   * @param {number} tabId Tab this controller may act on.
   * @param {{ sendAttached: (target: Target, method: string, params?: object) => Promise<any>,
   *   replay?: (request: object, tabId: number, signal?: AbortSignal) => Promise<number> }} cdp
   *   Sends browser commands; `replay` runs a prepared request in the page.
   * @param {DebugNetworkStore} network Store that receives annotations.
   * @param {() => void} changed Signals that retained state changed.
   * @param {() => boolean} allowed Whether the owning capture may still control requests.
   * @param {() => number} [now] Epoch-millisecond clock.
   */
  constructor(runId, tabId, cdp, network, changed, allowed, now = Date.now) {
    this.runId = runId;
    this.tabId = tabId;
    this.cdp = cdp;
    this.network = network;
    this.changed = changed;
    this.allowed = allowed;
    this.now = now;
    this.alive = true;
    this.targets = new Map();
    this.configured = new Set();
    this.rules = new Map();
    this.pending = new Map();
    this.configuration = Promise.resolve();
    this.replayRuns = new Map();
    this.closePromise = undefined;
  }

  /**
   * @returns {void}
   * Throws when the capture is stopped or no longer owned by this task.
   */
  assertActive() {
    if (!this.alive || !this.allowed()) throw new Error('network controls require an active, task-owned capture');
  }
  /** @returns {number} Rules that are currently enabled. */
  get activeCount() { return [...this.rules.values()].filter((rule) => rule.public.state === 'enabled').length; }
  /** @returns {boolean} True while any rule or replay still needs cleanup. */
  get hasWork() { return this.rules.size > 0 || this.replayRuns.size > 0; }
  /** @returns {DebugRule[]} Copies of the exposed rule state, in creation order. */
  list() { return [...this.rules.values()].map((rule) => ({ ...rule.public })); }
  /** @returns {DebugReplay[]} Copies of every replay run, in creation order. */
  replays() { return [...this.replayRuns.values()].map(({ result }) => ({ ...result })); }
  /**
   * @param {string} id Rule id.
   * @returns {boolean} True while the rule is still known.
   */
  has(id) { return this.rules.has(id); }

  /**
   * Register one target and re-apply the active rule patterns to it.
   *
   * @param {Target} target
   * @returns {Promise<void>}
   */
  async target(target) {
    if (!this.alive) return;
    this.targets.set(target.sessionId ?? 'root', target);
    if (this.rules.size) await this.refresh();
  }
  /**
   * Forget one target and cancel any decision that was pending on it.
   *
   * @param {string} sessionId
   * @returns {void}
   */
  detach(sessionId) {
    this.targets.delete(sessionId);
    this.configured.delete(sessionId);
    for (const item of this.pending.values()) if (item.target.sessionId === sessionId) item.abort.abort();
  }

  /**
   * Validate, store and enable one rule; a rule that fails to enable is left
   * disabled and reported through the thrown error.
   *
   * @param {DebugRuleSpec} input Untrusted rule description.
   * @param {AbortSignal} [signal] Cancels enabling and disables the rule.
   * @returns {Promise<void>}
   * Throws on invalid input, the rule limit, cancellation or a failed enable.
   */
  async add(input, signal) {
    this.assertActive();
    if (signal?.aborted) throw new Error('debug action cancelled');
    const spec = validateRule(input);
    if (this.rules.size >= 32) throw new Error('capture rule limit reached (32); start a new capture');
    const id = `${this.runId}:r${this.rules.size + 1}`;
    const rule = {
      spec,
      matcher: urlMatcher(spec.match.url),
      public: {
        ...publicRule(spec),
        id,
        times: spec.times ?? 1,
        state: 'enabled',
        hits: 0,
        failures: 0,
        created_at: this.now(),
      },
    };
    this.rules.set(id, rule);
    this.changed();
    const cancel = () => {
      rule.public.state = 'disabled';
      for (const item of this.pending.values()) if (item.rule === rule) item.abort.abort();
      this.changed();
      void this.refresh().catch(() => {});
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      await this.refresh();
      this.assertActive();
      if (signal?.aborted) throw new Error('debug action cancelled');
    } catch (error) {
      rule.public.state = this.alive ? 'disabled' : 'stopped';
      rule.public.last_error = 'could not enable request interception';
      this.changed();
      await this.refresh().catch(() => {});
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  /**
   * Enable, disable or remove one rule. Disabling and removal wait for that
   * rule's in-flight decisions to settle.
   *
   * @param {string} id Rule id.
   * @param {'rule_enable' | 'rule_disable' | 'rule_remove'} action
   * @param {AbortSignal} [signal] Cancels a state change that is still running.
   * @returns {Promise<void>}
   * Throws when the rule is missing, removed, exhausted or cancelled.
   */
  async update(id, action, signal) {
    this.assertActive();
    if (signal?.aborted) throw new Error('debug action cancelled');
    const rule = this.rules.get(id);
    if (!rule?.spec || rule.public.state === 'removed') throw new Error('rule not found or removed');
    if (action === 'rule_enable') {
      if (rule.public.times && rule.public.hits >= rule.public.times) throw new Error('rule is exhausted; create a new rule to apply it again');
      rule.public.state = 'enabled';
    } else {
      rule.public.state = action === 'rule_remove' ? 'removed' : 'disabled';
      if (action === 'rule_remove') rule.spec = undefined;
      for (const pending of this.pending.values()) if (pending.rule === rule) pending.abort.abort();
      await Promise.allSettled([...this.pending.values()].filter((item) => item.rule === rule).map((item) => item.done));
    }
    this.changed();
    const cancel = () => {
      if (action !== 'rule_enable') return;
      if (rule.public.state === 'enabled') rule.public.state = 'disabled';
      for (const item of this.pending.values()) if (item.rule === rule) item.abort.abort();
      this.changed();
      void this.refresh().catch(() => {});
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      await this.refresh();
      if (action === 'rule_enable') {
        this.assertActive();
        if (signal?.aborted) throw new Error('debug action cancelled');
      }
    } catch (error) {
      if (rule.public.state === 'enabled') rule.public.state = 'disabled';
      this.changed();
      await this.refresh().catch(() => {});
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }

  /**
   * Re-apply the active patterns on every target, serialized so two refreshes
   * never interleave. Disabling waits for pending decisions first.
   *
   * @returns {Promise<void>} Rejects when any target could not be reconfigured.
   */
  refresh() {
    const work = this.configuration.catch(() => {}).then(async () => {
      const active = this.alive ? [...this.rules.values()].filter((rule) => rule.public.state === 'enabled' && rule.spec) : [];
      const patterns = active.flatMap(({ spec }) => (spec.match.resource_type ? [spec.match.resource_type] : ['Fetch', 'XHR']).map((resourceType) => ({
        urlPattern: spec.match.url.replace(/\?/g, '\\?'),
        resourceType,
        requestStage: 'Request',
      })));
      const errors = [];
      await Promise.all([...this.targets].map(async ([key, target]) => {
        try {
          if (patterns.length && this.alive && this.allowed()) {
            this.configured.add(key);
            await bounded(this.cdp.sendAttached(target, 'Fetch.enable', { patterns, handleAuthRequests: false }));
          } else if (this.configured.has(key)) {
            await Promise.allSettled([...this.pending.values()].filter((item) => (item.target.sessionId ?? 'root') === key).map((item) => item.done));
            await bounded(this.cdp.sendAttached(target, 'Fetch.disable'));
            this.configured.delete(key);
          }
        } catch (error) {
          errors.push(error);
        }
      }));
      if (errors.length) throw new Error('request control configuration failed; inspect the rule state');
    });
    this.configuration = work;
    return work;
  }

  /**
   * Consume one protocol event for this tab: link replay-created requests and
   * decide a paused request from the rules declared up front.
   *
   * @param {Target} source Target that reported the event.
   * @param {string} method Protocol event name.
   * @param {unknown} raw Untrusted event payload.
   * @returns {void}
   */
  onEvent(source, method, raw) {
    if (source.tabId !== this.tabId || !this.targets.has(source.sessionId ?? 'root')) return;
    if (method === 'Network.requestWillBeSent') {
      const frames = [...(raw?.initiator?.stack?.callFrames ?? []), ...(raw?.initiator?.stack?.parent?.callFrames ?? [])];
      for (const { result } of this.replayRuns.values()) {
        if (raw?.requestId && frames.some((frame) => frame.url === `bb-replay://${result.id}`)) {
          this.network.annotate(source, raw.requestId, { replay_from: result.source_request_id, replay_id: result.id });
          result.request_id = this.network.list().find((item) => item.replay_id === result.id)?.id;
          this.changed();
        }
      }
    }
    if (method !== 'Fetch.requestPaused') return;
    const event = raw;
    if (!event?.requestId || !event.request) return;
    const key = `${source.sessionId ?? 'root'}:${event.requestId}`;
    if (this.pending.has(key)) return;
    if (!this.alive || !this.allowed()) {
      void bounded(this.cdp.sendAttached(source, 'Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' })).catch(() => {});
      return;
    }
    const rule = [...this.rules.values()].find(({ spec, public: meta, matcher }) => spec && meta.state === 'enabled' && matcher.test(event.request.url) && (!spec.match.method || spec.match.method === event.request.method) && (spec.match.resource_type ? spec.match.resource_type === event.resourceType : ['Fetch', 'XHR'].includes(event.resourceType)));
    if (!rule?.spec) {
      void bounded(this.cdp.sendAttached(source, 'Fetch.continueRequest', { requestId: event.requestId })).catch(() => bounded(this.cdp.sendAttached(source, 'Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' })).catch(() => {}));
      return;
    }
    rule.public.hits += 1;
    if (rule.public.times && rule.public.hits >= rule.public.times) rule.public.state = 'exhausted';
    this.changed();
    const abort = new AbortController();
    const done = this.apply(source, event, rule, rule.spec, abort.signal).finally(() => {
      this.pending.delete(key);
      if (!this.pending.size && ![...this.rules.values()].some((item) => item.public.state === 'enabled')) void this.refresh().catch(() => {});
    });
    this.pending.set(key, { target: source, id: event.requestId, rule, abort, done });
    if (this.pending.size > 32) abort.abort();
  }

  /**
   * Apply one matched rule to a paused request: block, modify or mock. The
   * decision is annotated on the retained request in every case, including
   * cancellation and failure.
   *
   * @param {Target} target
   * @param {{ requestId: string, networkId?: string, resourceType?: string,
   *   request: { url: string, method: string, headers: Record<string, string>, postData?: string } }} event
   *   Paused-request payload.
   * @param {Rule} rule
   * @param {DebugRuleSpec} spec Rule spec that matched.
   * @param {AbortSignal} signal Aborted when the rule or capture stops.
   * @returns {Promise<void>}
   */
  async apply(target, event, rule, spec, signal) {
    const mark = { rule_id: rule.public.id, type: spec.effect.type, state: 'pending' };
    const annotate = (extra = {}) => { if (event.networkId) this.network.annotate(target, event.networkId, { intervention: mark, ...extra }); };
    annotate();
    await Promise.resolve();
    try {
      if (signal.aborted) throw new Error('cancelled');
      const effect = spec.effect;
      if (effect.type === 'block') {
        annotate();
        await bounded(this.cdp.sendAttached(target, 'Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }));
      } else if (effect.type === 'modify') {
        const effective = editRequest(event.request, effect);
        mark.changes = [
          effect.url !== undefined ? 'url' : '',
          effect.method !== undefined ? 'method' : '',
          ...Object.keys(effect.headers ?? {}).map((key) => `header:${key}`),
          effect.body !== undefined ? 'body' : '',
          ...Object.keys(effect.json?.set ?? {}).map((key) => `json:${key}`),
          ...(effect.json?.remove ?? []).map((key) => `remove:${key}`),
          ...Object.entries(effect.json?.rename ?? {}).map(([from, to]) => `${from} -> ${to}`),
        ].filter(Boolean).map((value) => redactText(value, 160));
        annotate({ effective });
        await bounded(this.cdp.sendAttached(target, 'Fetch.continueRequest', {
          requestId: event.requestId,
          ...(effect.url === undefined ? {} : { url: effective.url }),
          ...(effect.method === undefined ? {} : { method: effective.method }),
          ...(effect.headers === undefined ? {} : { headers: Object.entries(effective.headers).filter(([key]) => !/^(content-length|host)$/i.test(key)).map(([name, value]) => ({ name, value })) }),
          ...(effect.body === undefined && effect.json === undefined ? {} : { postData: base64(effective.postData ?? '') }),
        }));
      } else {
        if (effect.delay_ms) await wait(effect.delay_ms, signal);
        if (signal.aborted || !this.alive || !this.allowed()) throw new Error('cancelled');
        const headers = Object.fromEntries(Object.entries(effect.headers ?? { 'content-type': 'application/json' }).map(([key, value]) => [key.toLowerCase(), value]));
        const responseBody = event.request.method === 'HEAD' ? '' : effect.body;
        annotate({ mock: { status: effect.status, headers, body: responseBody } });
        await bounded(this.cdp.sendAttached(target, 'Fetch.fulfillRequest', {
          requestId: event.requestId,
          responseCode: effect.status,
          responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
          body: base64(responseBody),
        }));
      }
      mark.state = 'applied';
    } catch {
      mark.state = signal.aborted || !this.alive ? 'cancelled' : 'failed';
      mark.error = mark.state === 'cancelled' ? 'rule disabled or capture stopped' : 'request control failed; request aborted';
      rule.public.failures += 1;
      rule.public.last_error = mark.error;
      annotate();
      await bounded(this.cdp.sendAttached(target, 'Fetch.failRequest', { requestId: event.requestId, errorReason: 'Aborted' })).catch(() => {});
    } finally {
      annotate();
      this.changed();
    }
  }

  /**
   * Send one retained request again from the page context. A reused key returns
   * the existing run instead of sending a second request.
   *
   * @param {DebugRequest} source Retained request to reuse.
   * @param {DebugReplaySpec} input Untrusted replay options.
   * @param {string} pageUrl Current page URL; replay must stay same-origin.
   * @param {AbortSignal} [signal] Marks a running replay as interrupted.
   * @returns {Promise<DebugReplay>} Final replay state; the request may already
   *   have been sent when this rejects.
   */
  async replay(source, input, pageUrl, signal) {
    this.assertActive();
    if (signal?.aborted) throw new Error('debug action cancelled');
    const spec = validateReplay(input);
    const existing = this.replayRuns.get(spec.key);
    if (existing) {
      if (existing.result.source_request_id !== source.id) throw new Error('replay key already belongs to another request');
      return { ...(await existing.promise) };
    }
    if (this.replayRuns.size >= MAX_REPLAYS) throw new Error('capture replay limit reached (20)');
    const request = replayRequest(source, spec, pageUrl);
    if (!this.cdp || typeof this.cdp.replay !== 'function') throw new Error('replay runner is unavailable');
    const result = { id: `${this.runId}-replay-${this.replayRuns.size + 1}`, key: spec.key, source_request_id: source.id, state: 'running' };
    const record = { result, promise: undefined };
    this.replayRuns.set(spec.key, record);
    this.changed();
    signal?.addEventListener('abort', () => { if (result.state === 'running') { result.state = 'interrupted'; result.error = 'replay cancelled; the request may have been sent'; this.changed(); } }, { once: true });
    const promise = Promise.resolve(this.cdp.replay(request, this.tabId, signal)).then((status) => {
      result.state = 'complete';
      result.status = status;
      this.changed();
      return { ...result };
    }).catch((error) => {
      result.state = 'failed';
      result.error = redactText(String((error && error.message) || error), 200);
      this.changed();
      throw error;
    });
    record.promise = promise;
    return promise;
  }

  /**
   * Stop controlling this tab: cancel pending decisions, disable patterns, and
   * mark unfinished rules and replays as stopped or interrupted.
   *
   * @param {string} [reason] Reason recorded on interrupted replays.
   * @returns {Promise<void>} Resolves once the tab is released.
   */
  async close(reason = 'capture stopped') {
    if (this.closePromise) return this.closePromise;
    this.alive = false;
    for (const item of this.pending.values()) item.abort.abort();
    this.closePromise = (async () => {
      for (const [key, target] of this.targets) {
        if (!this.configured.has(key)) continue;
        try { await bounded(this.cdp.sendAttached(target, 'Fetch.disable')); } catch { /* 忽略 */ }
        this.configured.delete(key);
      }
      for (const rule of this.rules.values()) if (rule.public.state !== 'removed') rule.public.state = 'stopped';
      for (const { result } of this.replayRuns.values()) if (result.state === 'running') { result.state = 'interrupted'; result.error = reason; }
      this.changed();
    })();
    return this.closePromise;
  }

  /** @returns {Promise<void>} Same contract as `close`. */
  async stop() {
    return this.close('stopped');
  }
}
