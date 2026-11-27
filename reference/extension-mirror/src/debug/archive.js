import { jsonBytes } from './journal.js';

/**
 * Browser-local debug history: bounded retention of already-redacted checkpoints.
 *
 * Evidence shapes referenced below (`DebugRun`, `DebugRecording`, `DebugRequest`,
 * `DebugParams`, `DebugResult`, `DebugPerformance`) are declared in ./types.js;
 * the bare names in these contracts refer to those declarations.
 *
 * @typedef {object} StoredRun
 * @property {DebugRun} run Run summary indexed for listing and eviction.
 * @property {number} bytes Serialized size counted against the history byte budget.
 *
 * @typedef {object} DebugArchive
 * @property {() => Promise<DebugRun[]>} list Stored run summaries, newest first.
 * @property {(id: string, bodies?: boolean) => Promise<DebugRecording | undefined>} get
 *   One recording; metadata-only when bodies is false.
 * @property {(recording: DebugRecording) => Promise<void>} put Store or replace a checkpoint.
 * @property {(id: string) => Promise<void>} delete Remove a run and its request evidence.
 * @property {(runId: string, params: DebugParams) => Promise<DebugResult | undefined>} [query]
 *   Read retained data for one run without attaching to a page.
 * @property {(run: DebugRun, entries: DebugRequest[]) => Promise<void>} [retain]
 *   Merge incrementally retained request evidence.
 * @property {(runId: string, id: string, pinned: boolean, sequence?: number) => Promise<void>} [pin]
 *   Pin or unpin one retained request, optionally reordering it.
 */

/** Maximum number of finished runs kept; capturing runs do not consume a slot. */
export const HISTORY_LIMIT = 50;
/**
 * Maximum serialized bytes across finished runs. The newest run is always kept;
 * eviction removes the oldest finished runs first until the budget fits.
 */
export const HISTORY_BYTES = 50 * 1024 * 1024;
/** Age after which a finished run is deleted on the next read or listing. */
export const HISTORY_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Mark an in-progress performance record as interrupted so no provisional
 * metric can later be reported as final.
 *
 * @param {DebugPerformance} entry
 * @param {string} reason Coverage token recorded on the entry and its metrics.
 * @returns {void}
 */
function interruptPerformance(entry, reason) {
  if (entry.state !== 'capturing') return;
  entry.state = 'interrupted';
  entry.coverage = [...new Set([...entry.coverage, reason])];
  for (const metric of Object.values(entry.metrics ?? {})) {
    if (metric.state === 'provisional') {
      metric.state = 'partial';
      metric.reasons = [...new Set([...(metric.reasons ?? []), reason])];
    }
  }
}

/**
 * Select finished runs that exceed the count, byte or age budget; the newest
 * runs and every capturing run are kept.
 *
 * @param {StoredRun[]} values
 * @param {number} now Epoch milliseconds used for the age budget.
 * @returns {string[]} Run ids to delete, oldest first.
 */
export function expiredHistory(values, now) {
  const active = values.filter(({ run }) => run.state === 'capturing');
  let count = active.length;
  let bytes = active.reduce((sum, item) => sum + item.bytes, 0);
  return values
    .filter(({ run }) => run.state !== 'capturing')
    .sort((a, b) => b.run.started_at - a.run.started_at)
    .filter((value) => {
      const expired = (value.run.stopped_at ?? value.run.started_at) < now - HISTORY_AGE_MS;
      if (expired || count >= HISTORY_LIMIT || bytes + value.bytes > HISTORY_BYTES) return true;
      count += 1;
      bytes += value.bytes;
      return false;
    })
    .map(({ run }) => run.id);
}

/**
 * Recover a checkpoint without representing an interrupted request as completed.
 *
 * @param {DebugRecording} recording
 * @returns {DebugRecording} The same recording, mutated in place.
 */
export function interrupted(recording) {
  if (recording.run.state !== 'capturing') return recording;
  recording.run.state = 'stopped';
  recording.run.active_rules = 0;
  for (const rule of recording.rules ?? []) {
    if (['enabled', 'disabled'].includes(rule.state)) rule.state = 'stopped';
  }
  for (const replay of recording.replays ?? []) if (replay.state === 'running') replay.state = 'interrupted';
  recording.run.stopped_at = recording.saved_at;
  recording.run.stop_reason = 'browser_restarted';
  recording.run.coverage = [...new Set([...recording.run.coverage, 'interrupted_checkpoint'])];
  for (const request of recording.requests) {
    if (request.intervention?.state === 'pending') {
      request.intervention.state = 'cancelled';
      request.intervention.error = 'browser restarted before control completed';
    }
    if (request.state === 'pending') request.state = 'interrupted';
    for (const body of [request.request_body, request.response_body]) {
      if (body.state === 'pending') {
        body.state = 'unavailable';
        body.reason = 'browser_restarted';
      }
    }
  }
  for (const entry of recording.performance ?? []) interruptPerformance(entry, 'browser_restarted');
  for (const operation of recording.operations) if (operation.state === 'running') operation.state = 'interrupted';
  return recording;
}

function emptyRecording(run, now) {
  return {
    version: 1,
    saved_at: now,
    run: structuredClone(run),
    requests: [],
    operations: [],
    console: [],
    pages: [],
    performance: [],
    rules: [],
    replays: [],
  };
}

/** One bounded database per extension/browser profile. No remote daemon dependency.
 * Implements the `DebugArchive` contract for stored history.
 *
 * Runs, recordings, request evidence and the sequence index live in separate
 * object stores so a listing does not read bodies. A recording checkpoint stores
 * the run and the requests known at `saved_at`; request evidence is merged from
 * its own store on read. Reads drop expired runs and report a missing database
 * as an unavailable archive rather than falling back silently.
 */
export class LocalDebugArchive {
  /**
   * @param {object} [factory] Browser-local database factory; when absent the
   *   archive keeps history in memory for this session only.
   * @param {() => number} [now] Epoch-millisecond clock used for expiry.
   */
  constructor(factory = globalThis.indexedDB, now = Date.now) {
    this.factory = factory;
    this.now = now;
    this.database = undefined;
    this.fallback = factory ? undefined : new MemoryDebugArchive([], now);
  }

  /**
   * Open the database once and create the required object stores on first use.
   *
   * @returns {Promise<object>} Resolved database handle.
   */
  async open() {
    if (!this.factory) throw new Error('debug history storage unavailable');
    if (this.database) return this.database;
    this.database = new Promise((resolve, reject) => {
      const request = this.factory.open('bb-debug-history', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('runs')) db.createObjectStore('runs', { keyPath: 'run.id' });
        if (!db.objectStoreNames.contains('recordings')) db.createObjectStore('recordings', { keyPath: 'run.id' });
        if (!db.objectStoreNames.contains('requests')) {
          const requests = db.createObjectStore('requests', { keyPath: ['entry.run_id', 'entry.id'] });
          requests.createIndex('run', 'entry.run_id');
        }
        if (!db.objectStoreNames.contains('request_index')) {
          const index = db.createObjectStore('request_index', { keyPath: ['run_id', 'id'] });
          index.createIndex('run', 'run_id');
          index.createIndex('sequence', ['run_id', 'sequence']);
        }
      };
      request.onerror = () => reject(request.error ?? new Error('debug history unavailable'));
      request.onblocked = () => reject(new Error('debug history database is blocked'));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); this.database = undefined; };
        resolve(db);
      };
    });
    return this.database;
  }

  /**
   * @returns {Promise<DebugRun[]>} Stored run summaries, newest first.
   */
  async list() {
    if (!this.factory) return this.fallback.list();
    const db = await this.open();
    const read = db.transaction('runs');
    const all = await result(read.objectStore('runs').getAll());
    return all.map(({ run }) => run).sort((a, b) => b.started_at - a.started_at);
  }

  /**
   * Read one run and merge its separately stored request evidence.
   *
   * @param {string} id Run id.
   * @param {boolean} [bodies] Include retained body text; metadata only otherwise.
   * @returns {Promise<DebugRecording | undefined>} Recording, or undefined when
   *   the run is missing or has expired.
   */
  async get(id, bodies = true) {
    if (!this.factory) return this.fallback.get(id, bodies);
    const db = await this.open();
    const recording = await result(db.transaction('recordings').objectStore('recordings').get(id));
    if (!recording) return undefined;
    if (recording.run.state !== 'capturing' && (recording.run.stopped_at ?? recording.run.started_at) < this.now() - HISTORY_AGE_MS) {
      await this.delete(id);
      return undefined;
    }
    const tx = db.transaction(['runs', 'requests']);
    const [saved, requests] = await Promise.all([
      result(tx.objectStore('runs').get(id)),
      result(tx.objectStore('requests').index('run').getAll(IDBKeyRange.only(id))),
    ]);
    const { mergeRequest, requestMetadata } = await import('./journal.js');
    const merged = new Map(recording.requests.map((entry) => [entry.id, bodies ? entry : requestMetadata(entry)]));
    for (const value of requests) {
      const entry = bodies ? value.entry : requestMetadata(value.entry);
      merged.set(entry.id, mergeRequest(merged.get(entry.id), entry));
    }
    recording.requests = [...merged.values()].sort((a, b) => a.started_at - b.started_at || a.sequence - b.sequence);
    if (saved?.run.storage) {
      recording.run.storage = saved.run.storage;
      recording.run.dropped_requests = saved.run.storage.dropped;
    }
    recording.run.requests = recording.requests.length;
    return recording;
  }

  /**
   * @param {DebugRecording} recording Checkpoint to store.
   * @returns {Promise<void>}
   */
  async put(recording) {
    if (!this.factory) return this.fallback.put(recording);
    if (!recording?.run?.id) throw new Error('recording run id is required');
    const db = await this.open();
    const tx = db.transaction(['runs', 'recordings', 'requests'], 'readwrite');
    const done = complete(tx);
    const incoming = recording.requests ?? [];
    tx.objectStore('recordings').put({ ...recording, requests: [] });
    const requests = tx.objectStore('requests');
    for (const request of incoming) {
      requests.put({ entry: { ...request, run_id: recording.run.id } });
    }
    tx.objectStore('runs').put({
      run: recording.run,
      bytes: jsonBytes(recording),
    });
    await done;
  }

  /**
   * @param {string} id Run id to delete together with its request evidence.
   * @returns {Promise<void>}
   */
  async delete(id) {
    if (!this.factory) return this.fallback.delete(id);
    const db = await this.open();
    const tx = db.transaction(['runs', 'recordings', 'requests', 'request_index'], 'readwrite');
    const done = complete(tx);
    tx.objectStore('runs').delete(id);
    tx.objectStore('recordings').delete(id);
    for (const name of ['requests', 'request_index']) {
      const cursor = tx.objectStore(name).index('run').openCursor(IDBKeyRange.only(id));
      cursor.onsuccess = () => {
        const item = cursor.result;
        if (item) { item.delete(); item.continue(); }
      };
    }
    await done;
  }

  /**
   * Read retained data for a stored run; this path never attaches to a page.
   *
   * @param {string} runId
   * @param {DebugParams} params
   * @returns {Promise<DebugResult | undefined>} Result, or undefined when the run
   *   is missing or has expired.
   */
  async query(runId, params) {
    if (!this.factory) return this.fallback.query(runId, params);
    const recording = await this.get(runId, true);
    if (!recording) return undefined;
    const { readRecording } = await import('./recording.js');
    return readRecording(recording, params);
  }

  /**
   * @param {DebugRun} run
   * @param {DebugRequest[]} entries Evidence to merge by request id.
   * @returns {Promise<void>}
   */
  async retain(run, entries) {
    if (!this.factory) return this.fallback.retain(run, entries);
    let recording = await this.get(run.id, true);
    if (!recording) recording = emptyRecording(run, this.now());
    const { mergeRequest } = await import('./journal.js');
    const merged = new Map(recording.requests.map((entry) => [entry.id, entry]));
    for (const entry of entries) merged.set(entry.id, mergeRequest(merged.get(entry.id), entry));
    recording.requests = [...merged.values()];
    recording.run.requests = recording.requests.length;
    await this.put(recording);
  }

  /**
   * @param {string} runId
   * @param {string} id Request id.
   * @param {boolean} pinned
   * @param {number} [sequence] New ordering sequence for the request.
   * @returns {Promise<void>}
   */
  async pin(runId, id, pinned, sequence) {
    if (!this.factory) return this.fallback.pin(runId, id, pinned, sequence);
    const recording = await this.get(runId, true);
    if (!recording) return;
    const entry = recording.requests.find((item) => item.id === id);
    if (!entry) return;
    entry.pinned = pinned;
    if (sequence !== undefined) entry.sequence = sequence;
    await this.put(recording);
  }
}

/**
 * @param {object} request Pending database read request.
 * @returns {Promise<any>} Resolved request result.
 */
function result(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('debug history read failed'));
  });
}
/**
 * @param {object} transaction Database transaction about to be used.
 * @returns {Promise<void>} Resolves on commit, rejects on abort.
 */
function complete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('debug history write failed'));
    transaction.onerror = () => {};
  });
}

/** In-memory archive with the same retention contract as the stored one. */
export class MemoryDebugArchive {
  /**
   * @param {DebugRecording[]} [seed] Recordings copied into memory storage.
   * @param {() => number} [now] Epoch-millisecond clock used for expiry.
   */
  constructor(seed = [], now = Date.now) {
    this.recordings = new Map();
    this.now = now;
    for (const recording of seed) this.recordings.set(recording.run.id, structuredClone(recording));
  }

  /**
   * @returns {Promise<DebugRun[]>} Stored run summaries, newest first.
   */
  async list() {
    return [...this.recordings.values()]
      .map((recording) => recording.run)
      .sort((a, b) => b.started_at - a.started_at);
  }

  /**
   * @param {string} id Run id.
   * @param {boolean} [bodies] Include retained body text; metadata only otherwise.
   * @returns {Promise<DebugRecording | undefined>} Copy of the recording, or
   *   undefined when missing or expired.
   */
  async get(id, bodies = true) {
    const recording = this.recordings.get(id);
    if (!recording) return undefined;
    if (recording.run.state !== 'capturing' && (recording.run.stopped_at ?? recording.run.started_at) < this.now() - HISTORY_AGE_MS) {
      this.recordings.delete(id);
      return undefined;
    }
    const copy = structuredClone(recording);
    if (!bodies) {
      const { requestMetadata } = await import('./journal.js');
      copy.requests = copy.requests.map(requestMetadata);
    }
    return copy;
  }

  /**
   * @param {DebugRecording} recording Checkpoint to store; stored as a copy.
   * @returns {Promise<void>}
   */
  async put(recording) {
    const copy = structuredClone(recording);
    const existing = this.recordings.get(copy.run.id);
    if (!copy.requests?.length && existing?.requests?.length) copy.requests = existing.requests;
    this.recordings.set(copy.run.id, copy);
  }

  /**
   * @param {string} id Run id to delete together with its request evidence.
   * @returns {Promise<void>}
   */
  async delete(id) {
    this.recordings.delete(id);
  }

  /**
   * @param {DebugRun} run
   * @param {DebugRequest[]} entries Evidence to merge by request id.
   * @returns {Promise<void>}
   */
  async retain(run, entries) {
    let recording = this.recordings.get(run.id);
    if (!recording) {
      recording = emptyRecording(run, this.now());
      this.recordings.set(run.id, recording);
    }
    const { mergeRequest } = await import('./journal.js');
    const map = new Map(recording.requests.map((entry) => [entry.id, entry]));
    for (const entry of entries) map.set(entry.id, mergeRequest(map.get(entry.id), entry));
    recording.requests = [...map.values()].sort((a, b) => a.started_at - b.started_at || a.sequence - b.sequence);
    recording.run.requests = recording.requests.length;
  }

  /**
   * @param {string} runId
   * @param {string} id Request id.
   * @param {boolean} pinned
   * @param {number} [sequence] New ordering sequence for the request.
   * @returns {Promise<void>}
   */
  async pin(runId, id, pinned, sequence) {
    const recording = this.recordings.get(runId);
    if (!recording) return;
    const entry = recording.requests.find((item) => item.id === id);
    if (entry) {
      entry.pinned = pinned;
      if (sequence !== undefined) entry.sequence = sequence;
    }
  }

  /**
   * @param {string} runId
   * @param {DebugParams} params
   * @returns {Promise<DebugResult | undefined>} Result, or undefined when the run
   *   is missing or has expired.
   */
  async query(runId, params) {
    const recording = this.recordings.get(runId);
    if (!recording) return undefined;
    const { readRecording } = await import('./recording.js');
    return readRecording(recording, params);
  }
}

