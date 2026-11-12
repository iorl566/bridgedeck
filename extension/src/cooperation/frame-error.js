const describe = (frames) => frames.map((frame) => `${frame.frame_id} (${frame.url})`).join(', ');

/** Permanent collection failures must not suggest another wait/sync loop. */
export class FrameCollectionError extends Error {
  constructor(reason, frames) {
    super(reason === 'page_load_failed' ? `The main page failed to load (${frames[0]?.url})` : `Page frames cannot be observed: ${describe(frames)}`);
    this.reason = reason;
    this.frames = frames;
    this.name = 'FrameCollectionError';
  }

  toRpcError(effect = 'none') {
    return {
      code: 'permission_denied',
      message: this.message,
      data: {
        reason: this.reason,
        effect_state: effect,
        frames: this.frames,
        recovery: effect === 'unknown'
          ? 'Inspect the application result before reloading or choosing another action. Never replay an uncertain submission.'
          : this.reason === 'page_load_failed'
            ? 'Check the page URL and network connection, then reload the tab and synchronize.'
            : 'Reload the tab once. If it persists, use read-only commands such as get-html or snapshot.',
      },
    };
  }
}

/** Live documents that did not answer before the collection deadline. */
export class FrameUnresponsiveError extends Error {
  constructor(frames) {
    super(`A page frame is not responding: ${describe(frames)}`);
    this.frames = frames;
    this.name = 'FrameUnresponsiveError';
  }
}
