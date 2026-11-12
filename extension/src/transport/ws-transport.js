const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 5_000;

function wellFormed(_key, value) {
  if (typeof value !== 'string') return value;
  return typeof value.toWellFormed === 'function' ? value.toWellFormed() : value;
}

/**
 * WebSocket transport with reconnect/backoff and async socket authentication.
 */
export class WSTransport {
  /** Capture endpoint, authenticator, and reconnect options. */
  constructor(options) {
    this.url = options.url;
    this.authenticate = options.authenticate;
    this.onAuthenticationError = options.onAuthenticationError;
    this.factory = options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.initialDelayMs = options.reconnect?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.maxDelayMs = options.reconnect?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.authentication = null;
    this.authenticationTimer = null;
    this.authFailures = 0;
    this.authBackoffUntil = 0;
    this.socket = null;
    this.currentState = 'disconnected';
    this.explicitlyClosed = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.socketGeneration = 0;
    this.connectingPromise = null;
    this.resolveConnect = null;
    this.rejectConnect = null;
    this.messageHandlers = new Set();
    this.stateHandlers = new Set();
  }

  /** Current connection state. */
  get state() { return this.currentState; }

  /** Switch endpoints; returns whether the URL actually changed. */
  setUrl(url) {
    if (url === this.url) return false;
    this.url = url;
    return true;
  }

  /** Clear authentication backoff after a successful local pairing. */
  resetAuthenticationBackoff() {
    this.authBackoffUntil = 0;
    this.authFailures = 0;
  }

  /**
   * Open the socket once; concurrent callers share the pending promise and a
   * reconnect timer is cancelled.
   */
  connect() {
    if (this.currentState === 'connected') return Promise.resolve();
    if (Date.now() < this.authBackoffUntil) return Promise.reject(new Error('local_auth_backoff'));
    this.explicitlyClosed = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connectingPromise) {
      const pending = this.connectingPromise;
      if (!this.socket) this.openSocket();
      return pending;
    }
    this.connectingPromise = new Promise((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    const pending = this.connectingPromise;
    this.openSocket();
    return pending;
  }

  /** Close the socket, cancel reconnect/auth work, and reject a pending connect. */
  async disconnect() {
    this.explicitlyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.endAuthentication();
    this.socket = null;
    this.socketGeneration += 1;
    if (socket) {
      try { socket.close(); } catch { /* ignore */ }
    }
    this.setState('disconnected');
    const reject = this.rejectConnect;
    this.connectingPromise = null;
    this.resolveConnect = null;
    this.rejectConnect = null;
    reject?.(new Error('[WSTransport] disconnect during connect'));
  }

  /** Serialize one frame, escaping lone surrogates so the socket stays valid UTF-8. */
  send(msg) {
    if (this.currentState !== 'connected' || !this.socket || this.socket.readyState !== 1) {
      throw new Error('[WSTransport] cannot send while not connected');
    }
    const text = JSON.stringify(msg);
    this.socket.send(/\\u[dD][89a-fA-F]/.test(text) ? JSON.stringify(msg, wellFormed) : text);
  }

  /** Subscribe to decoded frames; dispose removes the handler. */
  onMessage(handler) {
    this.messageHandlers.add(handler);
    return { dispose: () => { this.messageHandlers.delete(handler); } };
  }

  /** Subscribe to connection state transitions; dispose removes the handler. */
  onConnectionStateChange(handler) {
    this.stateHandlers.add(handler);
    return { dispose: () => { this.stateHandlers.delete(handler); } };
  }

  /** Create the socket and run authentication for this generation. */
  openSocket() {
    let socket;
    try {
      socket = this.factory(this.url);
    } catch (error) {
      const reject = this.rejectConnect;
      this.connectingPromise = null;
      this.resolveConnect = null;
      this.rejectConnect = null;
      reject?.(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.setState('connecting');
    const generation = ++this.socketGeneration;
    this.socket = socket;
    socket.addEventListener('open', () => {
      if (!this.isCurrentSocket(socket, generation)) return;
      const connected = () => {
        if (!this.isCurrentSocket(socket, generation)) return;
        if (socket.readyState !== 1) { failed(new Error('Connection closed during authentication')); return; }
        this.endAuthentication();
        this.resetAuthenticationBackoff();
        this.reconnectAttempt = 0;
        this.setState('connected');
        const resolve = this.resolveConnect;
        this.resolveConnect = null;
        this.rejectConnect = null;
        this.connectingPromise = null;
        resolve?.();
      };
      const failed = (error) => {
        if (!this.isCurrentSocket(socket, generation)) return;
        this.onAuthenticationError?.();
        this.authBackoffUntil = Date.now() + Math.min(30_000 * 2 ** this.authFailures++, 300_000);
        this.endAuthentication();
        const reject = this.rejectConnect;
        this.resolveConnect = null;
        this.rejectConnect = null;
        this.connectingPromise = null;
        reject?.(error instanceof Error ? error : new Error('Local authentication failed'));
        socket.close();
        this.handleClose(socket, generation, {});
      };
      if (!this.authenticate) { connected(); return; }
      const abort = new AbortController();
      this.authentication = abort;
      this.authenticationTimer = setTimeout(() => failed(new Error('Local authentication timed out')), 5_000);
      try { Promise.resolve(this.authenticate(socket, abort.signal)).then(connected, failed); } catch (error) { failed(error); }
    });
    socket.addEventListener('message', (event) => {
      if (!this.isCurrentSocket(socket, generation) || this.currentState !== 'connected') return;
      this.handleInbound(event.data);
    });
    socket.addEventListener('close', (event) => this.handleClose(socket, generation, event));
    socket.addEventListener('error', () => {});
  }

  /** Decode one socket message and notify subscribers. */
  handleInbound(data) {
    if (typeof data !== 'string') return;
    let parsed;
    try { parsed = JSON.parse(data); } catch { return; }
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string' && parsed.type.startsWith('local.auth.')) {
      this.onAuthenticationError?.();
      this.authFailures += 1;
      this.authBackoffUntil = Date.now() + 30_000;
      this.socket?.close();
      return;
    }
    for (const handler of this.messageHandlers) {
      try { handler(parsed); } catch { /* handler isolation */ }
    }
  }

  /** Handle a socket close for the current generation and schedule reconnect. */
  handleClose(socket, generation, _event) {
    if (!this.isCurrentSocket(socket, generation)) return;
    if (this.authentication) return;
    this.endAuthentication();
    this.socket = null;
    if (this.explicitlyClosed) { this.setState('disconnected'); return; }
    this.setState('disconnected');
    this.scheduleReconnect();
  }

  /** Schedule a reconnect with capped exponential backoff. */
  scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.max(this.authBackoffUntil - Date.now(), Math.min(this.initialDelayMs * 2 ** this.reconnectAttempt, this.maxDelayMs));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.explicitlyClosed) return;
      void this.connect().catch(() => {});
    }, delay);
    this.reconnectTimer?.unref?.();
  }

  /** Clear per-generation authentication state. */
  endAuthentication() {
    this.authentication?.abort();
    this.authentication = null;
    if (this.authenticationTimer) clearTimeout(this.authenticationTimer);
    this.authenticationTimer = null;
  }

  /** Whether the event belongs to the live socket generation. */
  isCurrentSocket(socket, generation) {
    return this.socket === socket && this.socketGeneration === generation;
  }

  /** Publish a state transition to subscribers. */
  setState(next) {
    if (this.currentState === next) return;
    this.currentState = next;
    for (const handler of this.stateHandlers) {
      try { handler(next); } catch { /* handler isolation */ }
    }
  }
}
