import { installPerformance } from './performance-observer.js';
import { redactText } from './redact.js';

export const OBSERVATION_TIMEOUT_MS = 600;

/**
 * Commands exposed by the installed in-page observer slot.
 *
 * @typedef {object} ObserverSlot
 * @property {() => object} snapshot Current bounded text and field snapshot.
 * @property {() => void} flush Emit any pending input transition.
 * @property {(value: boolean, revision: number, expiresAt: number) => void} agent
 *   Toggle agent-owned input suppression with a monotonic revision.
 * @property {() => object | undefined} performance Latest performance payload.
 * @property {() => object | undefined} finishPerformance Settle performance capture.
 * @property {() => void} dispose Remove listeners and delete the slot.
 */

/**
 * Runs only in a named isolated world of the captured main frame. Keep it
 * self-contained: its source text is also installed on future documents.
 *
 * @param {string} binding
 * @param {string} slot
 * @param {(emit: (data: object) => void, early: boolean) => object} observePerformance
 * @param {boolean} early
 * @returns {void}
 */
function installObserver(binding, slot, observePerformance, early) {
  if (window !== window.top) return;
  const host = globalThis;
  host[slot]?.dispose?.();
  const abort = new AbortController();
  let agent = false;
  let agentRevision = 0;
  let pending;
  let timer;
  let changedTimer;
  let original;
  const secret = /password|passwd|pwd|secret|token|credential|api.?key|session|credit|card.?number|cc-|one-time-code/i;
  const controls = 'input:not([type=hidden]):not([type=submit]):not([type=button]),textarea,select';
  function snapshot() {
    const fields = [];
    const nodes = document.querySelectorAll(controls);
    let partial = nodes.length > 80;
    for (const node of Array.from(nodes).slice(0, 80)) {
      if (!node.id && !node.name) {
        partial = true;
        continue;
      }
      if (fields.length >= 16) {
        partial = true;
        break;
      }
      const name = node.name || node.id;
      const label = (node.labels?.[0]?.textContent || node.getAttribute('aria-label') || name)
        .trim()
        .slice(0, 120);
      const key = `${location.origin}${location.pathname}|${node.form?.id || node.form?.name || ''}|${node.name ? 'name' : 'id'}:${name}`;
      if (key.length > 256 || name.length > 120) {
        partial = true;
        continue;
      }
      const sensitive =
        secret.test(`${node.type} ${node.name} ${node.id} ${node.autocomplete} ${label}`) ||
        node.type === 'file';
      const value = sensitive
        ? undefined
        : node instanceof HTMLInputElement && ['checkbox', 'radio'].includes(node.type)
          ? String(node.checked)
          : node.value;
      fields.push({
        key,
        name: name.slice(0, 120),
        label,
        state: sensitive ? 'redacted' : (value?.length ?? 0) > 256 ? 'truncated' : 'available',
        ...(value !== undefined ? { value: value.slice(0, 256) } : {}),
      });
    }
    // Bound traversal instead of reading the whole document text inside an input
    // handler. Only visible text is retained; form values stay separate.
    const lines = [];
    let chars = 0;
    let visited = 0;
    let textPartial = false;
    if (document.body) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        if (++visited > 600 || lines.length === 100 || chars >= 6000) {
          textPartial = true;
          break;
        }
        const parent = node.parentElement;
        const line = node.textContent?.trim();
        if (
          line &&
          parent &&
          !parent.closest(
            'script,style,noscript,template,textarea,select,[hidden],[aria-hidden=true]',
          ) &&
          parent.getClientRects().length
        ) {
          const retained = line.slice(0, Math.min(500, 6000 - chars));
          textPartial ||= retained.length < line.length;
          lines.push(retained);
          chars += retained.length;
        }
        node = walker.nextNode();
      }
    }
    const text = lines.join('\n');
    return {
      text: text.slice(0, 6000),
      truncated: textPartial,
      fields,
      fields_partial: partial,
      navigation: performance.getEntriesByType('navigation')[0]?.type,
    };
  }
  const emit = (data) => {
    try {
      host[binding](JSON.stringify(data));
    } catch {
      /* detached */
    }
  };
  const label = (node) =>
    (
      node.getAttribute('aria-label') ||
      node.labels?.[0]?.textContent ||
      node.textContent?.trim() ||
      node.getAttribute('name') ||
      node.id ||
      node.tagName
    )
      .trim()
      .slice(0, 120);
  function flush() {
    clearTimeout(timer);
    if (!pending) return;
    const value = pending;
    pending = undefined;
    emit({
      kind: 'input',
      at: value.at,
      target: label(value.target),
      before: value.before,
      after: snapshot(),
    });
    original = { target: value.target, snapshot: snapshot() };
  }
  const on = (type, fn) =>
    document.addEventListener(type, fn, { capture: true, signal: abort.signal });
  on('focusin', (event) => {
    if (event.target instanceof Element && event.target.matches(controls))
      original = { target: event.target, snapshot: snapshot() };
  });
  on('beforeinput', (event) => {
    if (!agent && event.target instanceof Element && event.target.matches(controls) && !pending)
      original = { target: event.target, snapshot: snapshot() };
  });
  on('input', (event) => {
    if (
      !event.isTrusted ||
      agent ||
      !(event.target instanceof Element) ||
      !event.target.matches(controls)
    )
      return;
    if (pending?.target !== event.target) flush();
    const starting = !pending;
    pending ??= {
      target: event.target,
      at: Date.now(),
      before: original?.target === event.target ? original.snapshot : snapshot(),
    };
    clearTimeout(timer);
    if (starting)
      emit({
        kind: 'input_start',
        at: pending.at,
        target: label(event.target),
        before: pending.before,
      });
    timer = setTimeout(flush, 350);
  });
  on('focusout', () => {
    if (!agent) flush();
  });
  on('click', (event) => {
    if (!event.isTrusted || agent || !(event.target instanceof Element)) return;
    const target = event.target.closest(
      'button,a,[role=button],input[type=submit],input[type=checkbox],input[type=radio]',
    );
    if (!target) return;
    flush();
    emit({ kind: 'click', at: Date.now(), target: label(target), before: snapshot() });
  });
  on('submit', (event) => {
    if (!event.isTrusted || agent || !(event.target instanceof Element)) return;
    flush();
    emit({ kind: 'submit', at: Date.now(), target: label(event.target), before: snapshot() });
  });
  window.addEventListener(
    'pagehide',
    () => {
      if (agent) return;
      flush();
      emit({ kind: 'navigate', at: Date.now(), target: '', before: snapshot() });
    },
    { signal: abort.signal },
  );
  const mutations = new MutationObserver(() => {
    if (changedTimer) return;
    changedTimer = setTimeout(() => {
      changedTimer = undefined;
      emit({ kind: 'changed' });
    }, 700);
  });
  mutations.observe(document, { subtree: true, childList: true, characterData: true });
  let performanceCapture;
  try {
    performanceCapture = observePerformance((data) => emit({ kind: 'performance', data }), early);
  } catch {
    emit({ kind: 'performance_error' });
  }
  host[slot] = {
    performance: () => performanceCapture?.snapshot(),
    finishPerformance: () => performanceCapture?.finish(),
    snapshot,
    flush,
    agent(value, revision, expiresAt) {
      // A queued pre-read may execute after its command finished or was cancelled.
      if (revision <= agentRevision) return;
      agentRevision = revision;
      if (value && Date.now() >= expiresAt) return;
      if (value) flush();
      agent = value;
    },
    dispose() {
      abort.abort();
      mutations.disconnect();
      performanceCapture?.dispose();
      clearTimeout(timer);
      clearTimeout(changedTimer);
      delete host[slot];
    },
  };
  emit({ kind: 'ready' });
}

/**
 * @typedef {object} DebugFieldSnapshot
 * @property {string} key
 * @property {string} [name]
 * @property {string} label
 * @property {string} [value]
 * @property {'available' | 'redacted' | 'truncated'} state
 *
 * @typedef {object} FieldSnapshot
 * @property {DebugFieldSnapshot[]} fields
 * @property {boolean} fields_partial
 * @property {string} [navigation]
 * @property {string} [text]
 * @property {boolean} [truncated]
 */

/**
 * Validate, redact and bound an untrusted field snapshot before retention.
 *
 * @param {unknown} value
 * @returns {FieldSnapshot}
 */
export function sanitizeFields(value) {
  const data = value;
  const fields = Array.isArray(data?.fields)
    ? data.fields.slice(0, 16).flatMap((field) => {
      if (!field || typeof field.key !== 'string' || typeof field.label !== 'string') return [];
      const sensitive = /password|passwd|pwd|secret|token|credential|api.?key|session|credit|card.?number|cc-|one-time-code/i.test(`${field.key} ${field.name} ${field.label}`);
      const state = sensitive || field.state === 'redacted'
        ? 'redacted'
        : field.state === 'truncated' || (typeof field.value === 'string' && field.value.length > 256)
          ? 'truncated'
          : 'available';
      return [{
        key: redactText(field.key, 256),
        label: redactText(field.label, 120),
        ...(typeof field.name === 'string' ? { name: redactText(field.name, 120) } : {}),
        state,
        ...(state !== 'redacted' && typeof field.value === 'string' ? { value: redactText(field.value, 256) } : {}),
      }];
    })
    : [];
  return {
    fields,
    fields_partial: !Array.isArray(data?.fields) || !!data?.fields_partial,
    ...(typeof data?.text === 'string' ? { text: redactText(data.text, 6000), truncated: !!data.truncated || data.text.length > 6000 } : {}),
    ...(typeof data?.navigation === 'string' ? { navigation: data.navigation.slice(0, 30) } : {}),
  };
}

/**
 * @typedef {object} ObserverSendTarget
 * @property {number} tabId
 * @property {string} [sessionId]
 */

/**
 * Installs and debugs one bounded in-page observer for a captured main frame.
 *
 * The observer owns an isolated-world slot, a binding used for page events and
 * the performance collector. Commands are dispatched by name through the slot;
 * revisions make a late pre-read a no-op instead of stealing the next action.
 */
export class DebugObserver {
  /**
   * @param {{ sendAttached: (target: ObserverSendTarget, method: string, params?: object) => Promise<any> }} cdp
   * @param {number} tabId
   * @param {string} id
   */
  constructor(cdp, tabId, id) {
    this.cdp = cdp;
    this.tabId = tabId;
    this.world = `bb-debug-${id}`;
    this.binding = `__bb_debug_${id}`;
    this.context = undefined;
    this.rootFrame = undefined;
    this.script = undefined;
    this.stopped = false;
    this.agentRevision = 0;
    this.contexts = new Set();
  }

  /**
   * Track isolated-world lifecycles and forget contexts that no longer exist.
   *
   * @param {string} method
   * @param {unknown} params
   */
  contextEvent(method, params) {
    const event = params;
    if (method === 'Runtime.executionContextsCleared') {
      this.contexts.clear();
      this.context = undefined;
    }
    if (method === 'Runtime.executionContextDestroyed' && event.executionContextId !== undefined) {
      this.contexts.delete(event.executionContextId);
      if (this.context === event.executionContextId) this.context = undefined;
    }
    if (
      method === 'Runtime.executionContextCreated' &&
      event.context?.name === this.world &&
      event.context.auxData?.frameId === this.rootFrame
    ) {
      this.contexts.add(event.context.id);
    }
  }

  /**
   * Accept a page binding call only from the world that installed the observer.
   *
   * @param {{ name?: string, executionContextId?: number }} params
   * @returns {boolean}
   */
  accepts(params) {
    const accepted =
      !this.stopped &&
      params.name === this.binding &&
      this.contexts.has(params.executionContextId ?? -1);
    // The browser can create more than one context with the same world name.
    // Select the context that actually installed the observer, not the last one.
    if (accepted) this.context = params.executionContextId;
    return accepted;
  }

  /**
   * @param {string} [frameId]
   * @returns {boolean}
   */
  isRoot(frameId) {
    return !!frameId && frameId === this.rootFrame;
  }

  /**
   * @template T
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<T>}
   */
  send(method, params) {
    return this.cdp.sendAttached({ tabId: this.tabId }, method, params);
  }

  /**
   * Bind the world, preload the observer and evaluate it in the current document.
   *
   * @returns {Promise<void>}
   */
  async start() {
    const tree = await this.send('Page.getFrameTree');
    if (this.stopped) return;
    this.rootFrame = tree.frameTree.frame.id;
    const source = (early) =>
      `(${installObserver.toString()})(${JSON.stringify(this.binding)},${JSON.stringify(this.world)},(${installPerformance.toString()}),${early})`;
    await this.send('Runtime.addBinding', { name: this.binding, executionContextName: this.world });
    if (this.stopped) {
      await this.dispose();
      return;
    }
    const script = await this.send('Page.addScriptToEvaluateOnNewDocument', {
      source: source(true),
      worldName: this.world,
    });
    this.script = script.identifier;
    if (this.stopped) {
      await this.dispose();
      return;
    }
    const created = await this.send('Page.createIsolatedWorld', {
      frameId: tree.frameTree.frame.id,
      worldName: this.world,
    });
    this.context = created.executionContextId;
    this.contexts.add(created.executionContextId);
    if (!this.stopped) await this.send('Runtime.evaluate', { expression: source(false), contextId: this.context });
    else await this.dispose();
  }

  /**
   * @template T
   * @param {'snapshot' | 'agent' | 'flush' | 'performance' | 'finishPerformance'} method
   * @param {boolean} [value]
   * @returns {Promise<T | undefined>}
   */
  async call(method, value) {
    if (this.context === undefined || this.stopped) return undefined;
    const args =
      method === 'agent'
        ? `${value},${++this.agentRevision},${Date.now() + OBSERVATION_TIMEOUT_MS}`
        : value === undefined
          ? ''
          : String(value);
    const result = await this.send('Runtime.evaluate', {
      expression: `globalThis[${JSON.stringify(this.world)}]?.${method}(${args})`,
      contextId: this.context,
      returnByValue: true,
    });
    return result.result?.value;
  }

  /**
   * Remove the preload script, dispose every world instance and the binding.
   *
   * @returns {Promise<void>}
   */
  async dispose() {
    this.stopped = true;
    const work = [];
    if (this.script) {
      work.push(this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.script }));
      this.script = undefined;
    }
    for (const contextId of this.contexts)
      work.push(
        this.send('Runtime.evaluate', {
          expression: `globalThis[${JSON.stringify(this.world)}]?.dispose()`,
          contextId,
        }),
      );
    work.push(this.send('Runtime.removeBinding', { name: this.binding }));
    await Promise.allSettled(work);
    this.contexts.clear();
  }
}
