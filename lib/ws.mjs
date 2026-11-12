// lib/ws.mjs — 零依赖 WebSocket (RFC 6455) 服务端 + 客户端最小实现。
// 只支持：文本帧、二进制帧、分片、ping/pong、close。够本项目的 JSON RPC 用。
// 不依赖任何 npm 包，只 import node 内置模块。
import crypto from 'node:crypto';

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BIN = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 64 * 1024 * 1024; // 64MB 上限，防内存失控

/** 把一段 payload 编码成 WebSocket 帧。 */
export function encodeFrame(opcode, payload, masked) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN=1
  if (!masked) return Buffer.concat([header, data]);
  header[1] |= 0x80;
  const key = crypto.randomBytes(4);
  const out = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) out[i] = data[i] ^ key[i & 3];
  return Buffer.concat([header, key, out]);
}

/** 单条连接：收发 JSON / 文本，自动回应 ping。 */
export class WsConnection {
  constructor(socket, { isServer, handshakeHeaders = null }) {
    this.socket = socket;
    this.isServer = isServer;
    this.handshakeHeaders = handshakeHeaders;
    this.closed = false;
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this._fragOpcode = null;
    this._handlers = { message: [], close: [], error: [] };
    this._closeSent = false;

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (err) => this._emit('error', err));
    socket.on('close', () => this._onClosed());
  }

  on(event, fn) { (this._handlers[event] ||= []).push(fn); return this; }
  _emit(event, ...args) { for (const fn of this._handlers[event] || []) try { fn(...args); } catch { /* 忽略回调异常 */ } }

  sendText(text) { if (!this.closed) this.socket.write(encodeFrame(OP_TEXT, text, !this.isServer)); }
  sendJson(obj) { this.sendText(JSON.stringify(obj)); }
  ping() { if (!this.closed) this.socket.write(encodeFrame(OP_PING, Buffer.alloc(0), !this.isServer)); }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
    payload.writeUInt16BE(code, 0);
    payload.write(reason, 2, 'utf8');
    try { this.socket.write(encodeFrame(OP_CLOSE, payload, !this.isServer)); } catch { /* ignore */ }
    this._closeSent = true;
    this.closed = true;
    setTimeout(() => { try { this.socket.destroy(); } catch { /* ignore */ } }, 50).unref?.();
  }

  _onClosed() {
    const wasClosed = this.closed;
    this.closed = true;
    if (!wasClosed || !this._closeSent) this._emit('close');
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    while (true) {
      const frame = this._readFrame();
      if (!frame) return;
      this._handleFrame(frame);
    }
  }

  _readFrame() {
    const buf = this._buf;
    if (buf.length < 2) return null;
    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(MAX_MESSAGE)) { this.close(1009, 'message too big'); return null; }
      len = Number(big);
      offset += 8;
    }
    let maskKey = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      maskKey = buf.subarray(offset, offset + 4);
      offset += 4;
    }
    if (buf.length < offset + len) return null;
    let payload = Buffer.from(buf.subarray(offset, offset + len));
    if (maskKey) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    }
    this._buf = buf.subarray(offset + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OP_PING:
        if (!this.closed) this.socket.write(encodeFrame(OP_PONG, payload, !this.isServer));
        return;
      case OP_PONG:
        return;
      case OP_CLOSE:
        if (!this.closed) {
          try { this.socket.write(encodeFrame(OP_CLOSE, payload, !this.isServer)); } catch { /* ignore */ }
          this._closeSent = true;
          this.closed = true;
          try { this.socket.end(); } catch { /* ignore */ }
          // 对端主动关闭：必须派发 close，否则上层（daemon 实例清理 / 配对撤销）收不到
          this._emit('close');
        }
        return;
      case OP_CONT: {
        if (this._fragOpcode == null) return; // 非法续帧，忽略
        this._fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this._fragments);
          const op = this._fragOpcode;
          this._fragments = [];
          this._fragOpcode = null;
          this._deliver(op, full);
        }
        return;
      }
      case OP_TEXT:
      case OP_BIN: {
        if (!fin) { this._fragOpcode = opcode; this._fragments = [payload]; return; }
        this._deliver(opcode, payload);
        return;
      }
      default:
        return;
    }
  }

  _deliver(opcode, payload) {
    if (opcode === OP_TEXT) this._emit('message', payload.toString('utf8'), false);
    else this._emit('message', payload, true);
  }
}

function computeAccept(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/** 服务端：在 http.Server 上挂 /ws 升级处理。返回 { connection } 由回调拿到。 */
export function attachWsServer(httpServer, onConnection, { path = '/ws' } = {}) {
  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers.upgrade || '').toLowerCase();
    if (!key || upgrade !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${computeAccept(key)}`,
      '\r\n',
    ].join('\r\n');
    socket.write(headers);
    const conn = new WsConnection(socket, { isServer: true, handshakeHeaders: req.headers });
    conn.query = url.searchParams;
    if (head && head.length) socket.unshift(head);
    try { onConnection(conn, req); } catch { /* 忽略回调异常 */ }
  });
}

/** 客户端：连一个 ws:// 地址，握手成功返回 WsConnection。 */
export function connectWs(rawUrl, { timeoutMs = 5000, headers = {}, rejectUnauthorized = true } = {}) {
  const url = new URL(rawUrl);
  const secure = url.protocol === 'wss:';
  const mod = secure ? import('node:https') : import('node:http');
  const key = crypto.randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    mod.then(({ default: http }) => {
      const req = http.request({
        host: url.hostname,
        port: url.port || (secure ? 443 : 80),
        path: url.pathname + url.search,
        method: 'GET',
        rejectUnauthorized,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': key,
          ...headers,
        },
        timeout: timeoutMs,
      });
      req.on('upgrade', (res, socket, head) => {
        if (res.statusCode !== 101) { reject(new Error(`websocket upgrade failed: HTTP ${res.statusCode}`)); socket.destroy(); return; }
        const conn = new WsConnection(socket, { isServer: false, handshakeHeaders: res.headers });
        if (head && head.length) socket.unshift(head);
        resolve(conn);
      });
      req.on('response', (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
        res.on('end', () => reject(new Error(`websocket upgrade rejected: HTTP ${res.statusCode} ${body.slice(0, 200)}`)));
      });
      req.on('timeout', () => req.destroy(new Error('websocket connect timeout')));
      req.on('error', (err) => reject(err));
      req.end();
    }, reject);
  });
}
