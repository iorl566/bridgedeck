import { VideoError } from './errors.js';
import { VIDEO_HOST_PORT } from './types.js';

/**
 * Dependencies for one host connection; omitted values fall back to the
 * extension runtime and offscreen APIs exposed by the global scope.
 *
 * `VideoHostCommand` and `VideoHostReply` are declared in ./host-protocol.js.
 *
 * @typedef {object} BrowserVideoHostDeps
 * @property {object} [runtime] Port provider with `id` and `connect({ name })`.
 * @property {object} [offscreen] Offscreen document API: `hasDocument`,
 *   `createDocument` and `closeDocument`.
 * @property {number} [timeoutMs] Per-command timeout in milliseconds.
 */

class HostDisconnectedError extends Error {}

/**
 * One connection per offscreen lifetime, shared by control messages and frames.
 *
 * Commands are serialized while the document is created, then sent as
 * `{ id, command }`; the matching reply resolves that entry in `pending`.
 * Implements the `VideoHost` contract declared in ./host-protocol.js.
 */
export class BrowserVideoHost {
  /**
   * @param {BrowserVideoHostDeps} [deps]
   */
  constructor(deps = {}) {
    this.runtime = deps.runtime ?? globalThis.chrome?.runtime;
    this.offscreen = deps.offscreen ?? globalThis.chrome?.offscreen;
    this.timeoutMs = deps.timeoutMs ?? 30000;
    this.port = undefined;
    this.lifecycle = Promise.resolve();
    this.requests = 0;
    this.pending = new Map();
  }

  /**
   * Queue one lifecycle operation behind every earlier operation.
   *
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  serialize(operation) {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.then(() => {}, () => {});
    return result;
  }

  /**
   * Connect to the offscreen encoder, creating its document when allowed.
   *
   * @param {boolean} [create=true] Create the offscreen document when absent.
   * @returns {Promise<boolean>} True when a port is available.
   */
  async ensure(create = true) {
    if (this.port) return true;
    if (!(await this.offscreen.hasDocument())) {
      if (!create) return false;
      await this.offscreen.createDocument({ url: 'video-offscreen.html', reasons: [], justification: 'Encode task videos in a worker and stream MP4 files to browser storage' });
    }
    const port = this.runtime.connect({ name: VIDEO_HOST_PORT });
    this.port = port;
    port.onMessage.addListener((reply) => {
      if (this.port === port) this.pending.get(reply.id)?.(reply);
    });
    port.onDisconnect.addListener(() => {
      if (this.port !== port) return;
      this.port = undefined;
      for (const [id, respond] of this.pending) respond({ id }, true);
    });
    return true;
  }

  /**
   * Send one command, retrying only idempotent cleanup across a disconnect.
   *
   * @template T
   * @param {VideoHostCommand} command
   * @returns {Promise<T>} Command-specific result.
   */
  async request(command) {
    await this.serialize(async () => { await this.ensure(); this.requests += 1; });
    try {
      try {
        return await this.send(command);
      } catch (error) {
        // A closed document's disconnect event may arrive after the next request.
        // Only idempotent cleanup/recovery commands can safely cross that race.
        if (!(error instanceof HostDisconnectedError) || !['stop', 'recover', 'idle'].includes(command.action)) throw error;
        await this.serialize(() => this.ensure());
        return await this.send(command);
      }
    } finally {
      this.requests -= 1;
      if (['stop', 'recover', 'revoke_url'].includes(command.action)) void this.closeWhenIdle().catch(() => {});
    }
  }

  /**
   * Post one command and settle on its reply, timeout, or disconnect.
   *
   * @template T
   * @param {VideoHostCommand} command
   * @returns {Promise<T>}
   */
  send(command) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new VideoError({ code: 'timeout', message: 'Video encoder did not respond' }));
      }, this.timeoutMs);
      this.pending.set(id, (reply, disconnected) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (disconnected) reject(new HostDisconnectedError('Video encoder disconnected'));
        else if (reply.error) reject(new VideoError(reply.error));
        else resolve(reply.result);
      });
      try {
        if (!this.port) throw new Error('Video encoder disconnected');
        this.port.postMessage({ id, command });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * Close the document once this host has no pending command or download URL.
   *
   * @returns {Promise<void>}
   */
  async closeWhenIdle() {
    await this.serialize(async () => {
      if (this.requests || !(await this.ensure(false))) return;
      if (await this.send({ action: 'idle' })) {
        const port = this.port;
        await this.offscreen.closeDocument();
        if (this.port === port) this.port = undefined;
        port?.disconnect();
      }
    });
  }
}
