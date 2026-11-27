/**
 * Ordered delivery of recorded steps to the background.
 *
 * One request id may be served by several documents (root plus child frames),
 * so every message carries a producer id and a per-producer sequence. The
 * background acknowledges each sequence; draining stops at the first rejected
 * or failed message so a step is never reported as delivered when it was not.
 *
 * @typedef {(message: import('../lib/record-bridge.js').RecordStepMessage) => Promise<unknown>} SendRecordStepMessage
 */

export const RECORD_STEP = 'record.step';

/**
 * Whether a transport response acknowledges this exact producer sequence.
 *
 * @param {unknown} value
 * @param {number} sequence
 * @returns {boolean}
 */
export function isAcceptedRecordStepAck(value, sequence) {
  if (typeof value !== 'object' || value === null) return false;
  return value.ok === true && value.sequence === sequence;
}

/** @returns {string} */
export function createRandomUuid() {
  return crypto.randomUUID();
}

/**
 * Serializes captured steps for one recording producer.
 *
 * Enqueue is synchronous and non-blocking; draining is chained so messages
 * leave in sequence order. A rejected ack or transport error leaves the
 * remaining steps pending, and `flush` reports that they were not accepted.
 */
export class RecordStepDelivery {
  /**
   * @param {string} requestId Recording request every message belongs to.
   * @param {SendRecordStepMessage} [send] Transport; defaults to one that rejects.
   * @param {string} [producerId] Stable producer identity for this document.
   */
  constructor(requestId, send = (message) => Promise.reject(new Error('record step transport unavailable')), producerId = createRandomUuid()) {
    this.requestId = requestId;
    this.producerId = producerId;
    this.send = send;
    this.pending = new Map();
    this.nextSequence = 1;
    this.tail = Promise.resolve();
  }

  /**
   * Queue one step under the next sequence number.
   *
   * @param {import('../lib/record-bridge.js').RecordStepPayload} step
   * @returns {void}
   */
  enqueue(step) {
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    this.pending.set(sequence, step);
    void this.schedule();
  }

  /**
   * Wait for the queue to settle, then drain once more.
   *
   * @returns {Promise<boolean>} True only when every queued step was accepted.
   */
  async flush() {
    await this.tail;
    await this.schedule();
    return this.pending.size === 0;
  }

  /** @returns {Promise<void>} Tail of the drain chain. */
  schedule() {
    const drain = () => this.drain();
    this.tail = this.tail.then(drain, drain);
    return this.tail;
  }

  /**
   * Send pending steps in sequence order until one is rejected or fails.
   *
   * @returns {Promise<void>}
   */
  async drain() {
    for (const [sequence, step] of this.pending) {
      const message = { type: RECORD_STEP, requestId: this.requestId, producerId: this.producerId, sequence, step };
      try {
        const response = await this.send(message);
        if (!isAcceptedRecordStepAck(response, sequence)) return;
        this.pending.delete(sequence);
      } catch {
        return;
      }
    }
  }
}
