/**
 * @typedef {number} BackendNodeId
 *
 * @typedef {object} DomRefEntry
 * @property {'dom'} kind
 * @property {string} [name]
 * @property {BackendNodeId} backendNodeId
 * @property {number | null} tabId
 * @property {string} [frameId]
 * @property {string} [cdpSessionId]
 * @property {number} generation
 *
 * @typedef {object} VisualRefInput
 * @property {'visual-region'} kind
 * @property {object} candidate
 *
 * @typedef {DomRefEntry | (VisualRefInput & { generation: number })} RefEntry
 *
 * @typedef {object} DomRefInput
 * @property {string} [name]
 * @property {BackendNodeId} backendNodeId
 * @property {number} tabId
 * @property {string} [frameId]
 * @property {string} [cdpSessionId]
 *
 * @typedef {VisualRefInput | BackendNodeId | DomRefInput} RefInput
 */

/**
 * Published references for one session, keyed by stable names.
 *
 * An observation publishes a fresh generation: DOM refs may survive a
 * supplementary read once stable naming is negotiated, while visual regions
 * stay scoped to the page that produced them. A name is reserved while a
 * result is rendered and only becomes actionable after publication, so a stale
 * rendering can never resolve to a node the agent has not seen.
 */
export class RefStore {
  constructor() {
    this.map = new Map();
    this.generation = 0;
    this.observationToken = crypto.randomUUID();
    this.stable = false;
    this.nextRef = 1;
    this.identities = new Map();
    this.documents = new Map();
  }

  get stableRefsEnabled() { return this.stable; }

  /** Observation identity for the most recently published generation.
   * @returns {string} Opaque token that changes on every publication.
   */
  get observationId() { return this.observationToken; }

  /** Monotonic publication counter.
   * @returns {number} Generation of the last publication or invalidation.
   */
  get revision() { return this.generation; }

  /** Negotiate once, before publishing the first observation under the new policy.
   * @returns {void}
   */
  enableStableRefs() {
    if (this.stable) return;
    this.stable = true;
    this.clear();
  }

  /** Prepare a fresh publication without mutating this store or recycling issued names.
   * @returns {RefStore} Unpublished store that continues this one's naming.
   */
  createObservationStore() {
    const store = new RefStore();
    store.nextRef = this.nextRef;
    store.generation = this.generation;
    for (const [tabId, revision] of this.documents) store.documents.set(tabId, revision);
    return store;
  }

  /** Reserve a name while rendering; only published rows become actionable.
   * @param {RefInput} input DOM identity or visual region to name.
   * @returns {string} Reference such as `e3`.
   */
  allocateRef(input) {
    if (input && typeof input === 'object' && input.kind === 'visual-region') return this.allocateVisualRef();
    let tab = this.identities.get(input.tabId);
    if (!tab) {
      tab = new Map();
      this.identities.set(input.tabId, tab);
    }
    const key = JSON.stringify([this.documentRevision(input.tabId), input.frameId, input.cdpSessionId, input.backendNodeId]);
    let ref = tab.get(key);
    if (!ref) {
      ref = `e${this.nextRef++}`;
      tab.set(key, ref);
    }
    return ref;
  }

  /** Visual regions remain observation-scoped even when DOM refs are stable.
   * @returns {string} Fresh reference such as `e7`.
   */
  allocateVisualRef() { return `e${this.nextRef++}`; }

  /** @returns {number} Published entry count. */
  size() { return this.map.size; }
  /** @returns {boolean} True when nothing is published. */
  isEmpty() { return this.map.size === 0; }

  /**
   * @param {string} ref Reference name, with or without the `@` prefix.
   * @param {{ tabId?: number }} [opts] Restrict the lookup to one tab.
   * @returns {BackendNodeId | null} Published DOM node, or null when absent or foreign.
   */
  resolve(ref, opts = {}) {
    const entry = this.map.get(normaliseRef(ref));
    if (!entry || entry.kind !== 'dom') return null;
    if (opts.tabId !== undefined && entry.tabId !== opts.tabId) return null;
    return entry.backendNodeId;
  }

  /**
   * @param {string} ref Reference name, with or without the `@` prefix.
   * @returns {RefEntry | null} Full published entry, or null when unknown.
   */
  resolveEntry(ref) { return this.map.get(normaliseRef(ref)) ?? null; }

  /** Publish a new observation. Stable DOM refs survive supplementary reads;
   * screenshot regions always belong to the most recently published page.
   * @param {Map<string, RefInput>} entries Rendered refs and their inputs.
   */
  replace(entries) {
    const generation = this.generation + 1;
    const next = this.stable ? new Map([...this.map].filter(([, entry]) => entry.kind === 'dom')) : new Map();
    for (const [ref, input] of entries) {
      this.reserveRef(ref);
      next.set(normaliseRef(ref), this.entry(input, generation));
    }
    this.map = next;
    this.generation = generation;
    this.observationToken = crypto.randomUUID();
  }

  /**
   * @param {string} ref Reference name.
   * @param {BackendNodeId} id Published DOM node.
   * @param {{ tabId?: number, frameId?: string, cdpSessionId?: string }} [opts] Document identity.
   */
  set(ref, id, opts = {}) {
    this.reserveRef(ref);
    this.map.set(normaliseRef(ref), {
      kind: 'dom',
      backendNodeId: id,
      tabId: opts.tabId ?? null,
      ...(opts.frameId ? { frameId: opts.frameId } : {}),
      ...(opts.cdpSessionId ? { cdpSessionId: opts.cdpSessionId } : {}),
      generation: this.generation,
    });
  }

  /**
   * @param {number} tabId
   * @returns {number} Document revision for the tab.
   */
  documentRevision(tabId) { return this.documents.get(tabId) ?? 0; }

  /** A CDP node id may be reused by a new document in the same tab.
   * @param {number} tabId Invalidated tab.
   */
  invalidateTab(tabId) {
    this.documents.set(tabId, this.documentRevision(tabId) + 1);
    this.identities.delete(tabId);
    let changed = false;
    for (const [ref, entry] of this.map) {
      const owner = entry.kind === 'dom' ? entry.tabId : entry.candidate.document.target.tabId;
      if (owner === tabId) {
        this.map.delete(ref);
        changed = true;
      }
    }
    if (changed) {
      this.generation++;
      this.observationToken = crypto.randomUUID();
    }
  }

  /** Drop every published ref and start a new observation generation. */
  clear() {
    this.generation++;
    this.map.clear();
    this.identities.clear();
    this.observationToken = crypto.randomUUID();
  }

  /** @returns {IterableIterator<[string, RefEntry]>} Published refs in insertion order. */
  entries() { return this.map.entries(); }

  /** Keep `nextRef` ahead of every issued name, including rendered-only refs.
   * @param {string} ref Reference name that may appear in a published row.
   */
  reserveRef(ref) {
    const match = /^@?e(\d+)$/.exec(ref);
    if (match) this.nextRef = Math.max(this.nextRef, Number(match[1]) + 1);
  }

  /** Build the published row for one rendered input.
   *
   * A visual region is admitted only with a complete, verified DOM identity and
   * anchor, so a screenshot coordinate never becomes actionable without a node
   * to resolve it against.
   *
   * @param {RefInput} input DOM identity or visual region.
   * @param {number} generation Publication generation for the new row.
   * @returns {RefEntry} Immutable entry to publish.
   * @throws {TypeError} When a visual region lacks a verified identity or anchor.
   */
  entry(input, generation) {
    if (typeof input !== 'number' && input && typeof input === 'object' && input.kind === 'visual-region') {
      const { document } = input.candidate;
      if (
        !document?.attachmentId || !document.frameId ||
        !Number.isSafeInteger(document.target?.tabId) ||
        !Number.isSafeInteger(document.documentElementBackendNodeId) ||
        document.documentElementBackendNodeId <= 0 ||
        !Number.isSafeInteger(input.candidate.backendNodeId) ||
        input.candidate.backendNodeId <= 0
      ) throw new TypeError('visual ref requires a verified DOM identity and anchor');
      return { kind: 'visual-region', candidate: input.candidate, generation };
    }
    if (typeof input === 'number') return { kind: 'dom', backendNodeId: input, tabId: null, generation };
    return {
      kind: 'dom',
      ...(input.name ? { name: input.name } : {}),
      backendNodeId: input.backendNodeId,
      tabId: input.tabId,
      ...(input.frameId ? { frameId: input.frameId } : {}),
      ...(input.cdpSessionId ? { cdpSessionId: input.cdpSessionId } : {}),
      generation,
    };
  }
}

/** Canonical RefStore key: `@e3` and `e3` both become `e3`.
 * @param {string} ref Raw reference.
 * @returns {string} Key without the `@` prefix.
 */
export function normaliseRef(ref) {
  return ref.startsWith('@') ? ref.slice(1) : ref;
}
