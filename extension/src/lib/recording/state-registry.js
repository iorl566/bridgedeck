/**
 * Registry of recorded VOM states, deduplicated by URL and rendered text.
 *
 * @typedef {object} RecordedStateEntry
 * @property {string} id
 * @property {string} url
 * @property {string} [title]
 * @property {string} vomText
 * @property {boolean} truncated
 * @property {number[]} stepsHere
 */

export class RecordingStateRegistry {
  constructor() {
    this.entriesById = new Map();
    this.idByIdentity = new Map();
    this.nextId = 1;
  }

  /**
   * @param {{ url: string, title?: string, vomText: string, truncated?: boolean }} input
   * @returns {RecordedStateEntry}
   */
  register(input) {
    const identity = `${input.url}\0${input.vomText}`;
    const existingId = this.idByIdentity.get(identity);
    if (existingId) {
      const existing = this.entriesById.get(existingId);
      if (!existing.title && input.title) existing.title = input.title;
      if (input.truncated) existing.truncated = true;
      return existing;
    }
    const entry = {
      id: `s${this.nextId}`,
      url: input.url,
      ...(input.title ? { title: input.title } : {}),
      vomText: input.vomText,
      truncated: input.truncated ?? false,
      stepsHere: [],
    };
    this.nextId += 1;
    this.entriesById.set(entry.id, entry);
    this.idByIdentity.set(identity, entry.id);
    return entry;
  }

  /** @returns {RecordedStateEntry[]} */
  values() {
    return [...this.entriesById.values()];
  }

  /**
   * @param {string} stateId
   * @param {number} draftId
   * @returns {void}
   */
  markStep(stateId, draftId) {
    const entry = this.entriesById.get(stateId);
    if (entry && !entry.stepsHere.includes(draftId)) entry.stepsHere.push(draftId);
  }
}
