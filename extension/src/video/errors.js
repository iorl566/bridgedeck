export class VideoError extends Error {
  constructor(error) {
    super(error.message);
    this.code = error.code;
    this.data = error.data;
  }
}

export function videoError(error, fallback = 'cdp_failed') {
  if (error && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string') {
    return { code: error.code, message: error.message, ...(error.data ? { data: error.data } : {}) };
  }
  return { code: fallback, message: error instanceof Error ? error.message : String(error) };
}
