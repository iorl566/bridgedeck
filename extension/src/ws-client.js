// src/ws-client.js —— 扩展 ↔ daemon 的 WebSocket 客户端（PROTOCOL.md §3）
import { readSettings } from './settings.js';
import { log, warn } from './log.js';
import { PROTOCOL_VERSION, protocolSkew } from './protocol-version.js';

const PORTS = [52900, 52901, 52902, 52903, 52904, 52905, 52906, 52907, 52908, 52909];
const CONNECT_TIMEOUT_MS = 2500;
const HANDSHAKE_TIMEOUT_MS = 4000;
const RETRY_MS = 3000;
const CAPABILITIES = ['observe', 'frames', 'dialog', 'screenshot', 'network', 'rules', 'video', 'recording', 'pairing', 'auth-challenge'];

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text))));
}

async function hmacHex(key, text) {
  const imported = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(key)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', imported, new TextEncoder().encode(String(text))));
}

function browserName() {
  return /Edg\//i.test(navigator.userAgent) ? 'edge' : 'chrome';
}

function browserVersion() {
  const match = /(?:Edg|Chrome)\/([\d.]+)/i.exec(navigator.userAgent);
  return match ? match[1] : '';
}

function withQuery(rawUrl, params) {
  const url = new URL(rawUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export class BridgeSocket {
  constructor({ onCommand, onEvent } = {}) {
    this.onCommand = typeof onCommand === 'function' ? onCommand : () => {};
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.socket = null;
    this.port = null;
    this.instanceId = null;
    this.daemonVersion = null;
    this.localAuth = null;
    this.lastError = null;
    this.helloDone = false;
    this.pairToken = '';
    this.stopped = true;
    this.connecting = false;
    this.retryTimer = null;
    this.handshakeTimer = null;
    this.pending = new Map();
    this.callSeq = 0;
    this.connectionState = 'idle';
    this.protocol = null;
    this.protocolSkew = null;
    this.retryCount = 0;
    this.connectedAt = null;
    this.lastPort = null;
  }

  setState(state) {
    if (this.connectionState !== state) {
      this.connectionState = state;
      log('连接状态 → ' + state);
    }
  }

  getSnapshot() {
    return {
      connectionState: this.connectionState,
      protocol: this.protocol,
      protocolSkew: this.protocolSkew,
      daemonVersion: this.daemonVersion,
      instanceId: this.instanceId,
      port: this.port,
      localAuth: this.localAuth,
      lastError: this.lastError,
      retryCount: this.retryCount,
      connectedAt: this.connectedAt,
      connected: this.isOpen(),
    };
  }

  isOpen() {
    return Boolean(this.socket && this.socket.readyState === 1 && this.helloDone);
  }

  start() {
    if (!this.stopped) {
      if (!this.isOpen()) this.connectLoop();
      return;
    }
    this.stopped = false;
    this.connectLoop();
  }

  stop() {
    this.stopped = true;
    this.setState('disabled');
    this.connecting = false;
    this.clearTimers();
    this.closeSocket(1000, 'client stop');
  }

  ensureConnected() {
    if (this.stopped) return this.start();
    if (!this.isOpen() && !this.connecting) this.connectLoop();
  }

  reconnect() {
    this.closeSocket(1000, 'reconnect');
    this.stopped = false;
    this.connecting = false;
    this.clearTimers();
    this.connectLoop();
  }

  sendJson(payload) {
    if (!this.socket || this.socket.readyState !== 1) return false;
    try {
      this.socket.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      warn('发送失败', error && error.message);
      return false;
    }
  }

  call(method, params, timeoutMs = 10000) {
    if (!this.isOpen()) {
      return Promise.reject(Object.assign(new Error('daemon 未连接'), { code: 'E_NO_DAEMON' }));
    }
    const id = 'call-' + (++this.callSeq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('调用 ' + method + ' 超时'), { code: 'E_TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.sendJson({ type: 'call', id, method, params: params || {} })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(Object.assign(new Error('发送调用失败'), { code: 'E_NO_DAEMON' }));
      }
    });
  }

  clearTimers() {
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = null; }
  }

  closeSocket(code = 1000, reason = '') {
    const socket = this.socket;
    this.socket = null;
    this.helloDone = false;
    this.port = null;
    if (socket && socket.readyState <= 1) {
      try { socket.close(code, reason); } catch { /* 忽略 */ }
    }
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(Object.assign(new Error('连接已断开'), { code: 'E_NO_DAEMON' }));
      this.pending.delete(id);
    }
  }

  scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.connectLoop();
    }, RETRY_MS);
  }

  async endpoints() {
    const settings = await readSettings();
    if (settings.daemonUrl) {
      return [{ url: withQuery(settings.daemonUrl, { role: 'extension', v: chrome.runtime.getManifest().version }), token: settings.daemonToken || '', remote: true }];
    }
    if (!this.lastPort) {
      try {
        const stored = await chrome.storage.session.get('bb.lastPort');
        const saved = Number(stored && stored['bb.lastPort']);
        if (PORTS.includes(saved)) this.lastPort = saved;
      } catch {
        // 读取失败按默认顺序
      }
    }
    const order = this.lastPort ? [this.lastPort, ...PORTS.filter((port) => port !== this.lastPort)] : PORTS;
    return order.map((port) => ({
      url: 'ws://127.0.0.1:' + port + '/ws?role=extension&v=' + encodeURIComponent(chrome.runtime.getManifest().version),
      token: '',
      remote: false,
      port,
    }));
  }

  async connectLoop() {
    if (this.stopped || this.connecting || this.isOpen()) return;
    this.connecting = true;
    this.setState('connecting');
    let settings;
    try {
      settings = await readSettings();
    } catch {
      settings = {};
    }
    const endpoints = await this.endpoints().catch(() => []);
    const failures = [];
    for (const endpoint of endpoints) {
      if (this.stopped) break;
      try {
        await this.open(endpoint, settings);
        this.connecting = false;
        return;
      } catch (error) {
        if (this.stopped) break;
        this.retryCount += 1;
        failures.push((endpoint.port ? 'port=' + endpoint.port : endpoint.url) + ': ' + ((error && error.message) || error));
      }
    }
    // 一轮扫描只记一条摘要：daemon 未运行时扫 10 个端口会把控制台刷满。
    if (failures.length) {
      const first = failures[0];
      log('WS 连接失败（' + failures.length + ' 个端点）' + (failures.length > 1 ? '，首个 ' + first : '：' + first));
    }
    this.connecting = false;
    if (!this.stopped) {
      this.setState('reconnecting');
      this.scheduleRetry();
    }
  }

  open(endpoint, settings) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let socket;
      try {
        socket = new WebSocket(endpoint.url);
      } catch (error) {
        reject(error);
        return;
      }
      this.socket = socket;
      this.setState('handshaking');
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (error) {
          if (this.socket === socket) this.closeSocket(1000, 'handshake failed');
          reject(error);
        } else {
          resolve();
        }
      };
      socket.onopen = async () => {
        this.port = endpoint.port || Number((new URL(endpoint.url)).port) || null;
        this.pairToken = endpoint.token || '';
        log('WS 连接 ' + endpoint.url.replace(/\?.*$/, '') + ' 已建立，发送 hello');
        this.handshakeTimer = setTimeout(() => finish(new Error('hello-ack 超时')), HANDSHAKE_TIMEOUT_MS);
        let keyId;
        try { keyId = this.pairToken ? (await sha256Hex(this.pairToken)).slice(0, 32) : undefined; } catch { keyId = undefined; }
        this.sendJson({
          type: 'hello',
          role: 'extension',
          browser: browserName(),
          browserVersion: browserVersion(),
          extVersion: chrome.runtime.getManifest().version,
          instanceId: this.instanceId || undefined,
          protocol: '1.8',
          capabilities: CAPABILITIES,
          label: settings.instanceLabel || '',
          settings: {
            borrowConfirm: settings.borrowConfirm !== false,
            allowHelp: settings.allowHelp !== false,
            pageGuard: settings.pageGuard !== false,
            controlHint: settings.controlHint !== false,
            longShotMode: settings.longShotMode === 'manual' ? 'manual' : 'auto',
          },
          userAgent: navigator.userAgent,
          authChallenge: true,
          authKeyId: keyId,
        });
      };
      socket.onmessage = (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch (error) { warn('WS 消息解析失败', error && error.message); return; }
        this.handleMessage(message, finish);
      };
      socket.onerror = () => {
        if (!this.helloDone) finish(new Error('WebSocket 错误'));
      };
      socket.onclose = (event) => {
        const wasOpen = this.helloDone;
        if (this.socket === socket) {
          this.socket = null;
          this.helloDone = false;
          this.port = null;
          this.connectedAt = null;
        }
        if (!settled) finish(new Error('连接关闭 code=' + (event && event.code)));
        else if (wasOpen && !this.stopped) {
          log('WS 断开，准备重连');
          this.setState('reconnecting');
          this.scheduleRetry();
        }
      };
    });
  }

  handleMessage(message, finish) {
    switch (message.type) {
      case 'auth-challenge': {
        if (!this.pairToken) {
          finish(new Error('daemon 要求认证，但本地没有 token'));
          return;
        }
        hmacHex(this.pairToken, 'bridgedeck-auth-v1\n' + String(message.challenge || ''))
          .then((proof) => this.sendJson({ type: 'auth-response', challenge: message.challenge, proof }))
          .catch((error) => finish(new Error('challenge-response 失败：' + ((error && error.message) || error))));
        return;
      }
      case 'hello-ack': {
        this.helloDone = true;
        this.daemonVersion = message.daemonVersion || null;
        this.protocol = message.protocol || null;
        this.protocolSkew = protocolSkew(message.protocol);
        this.retryCount = 0;
        this.connectedAt = Date.now();
        this.lastPort = this.port;
        chrome.storage.session.set({ 'bb.lastPort': this.port }).catch(() => {});
        this.setState(this.protocolSkew ? 'version_skew' : 'connected');
        this.localAuth = message.localAuth && typeof message.localAuth === 'object' ? message.localAuth : null;
        this.lastError = null;
        if (message.instanceId) {
          this.instanceId = message.instanceId;
          chrome.storage.local.set({ 'bb.instanceId': message.instanceId }).catch(() => {});
        }
        if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = null; }
        log('握手完成 instance=' + (message.instanceId || '?') + ' daemon=' + (message.daemonVersion || '?') + ' protocol=' + (message.protocol || '?'));
        finish();
        return;
      }
      case 'hello-error': {
        this.lastError = message.message || message.code || 'daemon 拒绝连接';
        this.setState('rejected');
        log('daemon 拒绝连接：' + message.code + ' ' + (message.message || ''));
        this.stopped = true;
        if (this.handshakeTimer) { clearTimeout(this.handshakeTimer); this.handshakeTimer = null; }
        finish(new Error(message.message || message.code || 'hello rejected'));
        return;
      }
      case 'cmd':
        try { this.onCommand(message); } catch (error) { warn('处理命令失败', error && error.message); }
        return;
      case 'event':
        try { this.onEvent(message); } catch (error) { warn('处理事件失败', error && error.message); }
        return;
      case 'call-res': {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(message.id);
        if (message.ok) entry.resolve(message.result);
        else entry.reject(Object.assign(new Error((message.error && message.error.message) || '调用失败'), { code: (message.error && message.error.code) || 'E_INTERNAL' }));
        return;
      }
      case 'ping':
        this.sendJson({ type: 'pong' });
        return;
      case 'pong':
        return;
      default:
        return;
    }
  }
}
