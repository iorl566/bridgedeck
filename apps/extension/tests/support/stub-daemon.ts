// tests/support/stub-daemon.ts —— 单测用的本地 stub daemon 与可注入时钟/假 WebSocket。
//
// 不 mock 协议细节：HTTP 客户端测试用真实的 node:http 服务，验证请求头/请求体/状态码/
// 超时取消等真实网络行为；WebSocket 测试用假 WebSocket + 假时钟，精确控制打开/消息/关闭
// 与退避计时。真实 daemon 冒烟见 tests/daemon-smoke.test.ts。

import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

export interface StubHttpCall {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  /** JSON.parse 后的请求体；不是 JSON 时为 undefined。 */
  body: unknown;
  rawBody: string;
}

export type StubHttpHandler = (call: StubHttpCall, response: http.ServerResponse) => void | Promise<void>;

export interface StubHttpServer {
  baseUrl: string;
  port: number;
  calls: StubHttpCall[];
  close: () => Promise<void>;
}

/** 起一个真实 HTTP stub；每个请求记录方法/URL/头/体后交给 handler。 */
export async function startStubHttpServer(handler: StubHttpHandler): Promise<StubHttpServer> {
  const calls: StubHttpCall[] = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = rawBody ? JSON.parse(rawBody) : undefined;
      } catch {
        body = undefined;
      }
      const call: StubHttpCall = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
        rawBody,
      };
      calls.push(call);
      try {
        await handler(call, response);
      } catch {
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
        try {
          response.end(JSON.stringify({ ok: false, error: { code: 'E_STUB_FAILURE', message: 'stub handler 抛错' } }));
        } catch {
          // 连接已被客户端中止时忽略
        }
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    calls,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 写 JSON 响应。 */
export function sendJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

/** 取一个当前空闲的回环端口（先 bind 0 再关闭；用于“连接被拒”用例）。 */
export async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// 假时钟
// ---------------------------------------------------------------------------

interface FakeTimer {
  at: number;
  handler: () => void;
  cancelled: boolean;
}

/** 手动推进的时钟：所有延迟/心跳/超时在测试里显式 advance()。 */
export class FakeClock {
  private current = 0;
  private sequence = 0;
  private readonly timers = new Map<number, FakeTimer>();

  now(): number {
    return this.current;
  }

  setTimeout(handler: () => void, ms: number): unknown {
    const id = ++this.sequence;
    this.timers.set(id, { at: this.current + Math.max(0, ms), handler, cancelled: false });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (typeof handle === 'number') this.timers.delete(handle);
  }

  /** 推进到 current+ms，按到期顺序同步执行回调（回调新注册的定时器也参与本轮）。 */
  advance(ms: number): void {
    const target = this.current + Math.max(0, ms);
    for (let guard = 0; guard < 10_000; guard += 1) {
      let nextId: number | null = null;
      let nextTimer: FakeTimer | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.cancelled || timer.at > target) continue;
        if (!nextTimer || timer.at < nextTimer.at || (timer.at === nextTimer.at && id < nextId!)) {
          nextId = id;
          nextTimer = timer;
        }
      }
      if (!nextTimer || nextId === null) break;
      this.timers.delete(nextId);
      this.current = Math.max(this.current, nextTimer.at);
      nextTimer.handler();
    }
    this.current = target;
  }

  pending(): number {
    return this.timers.size;
  }
}

// ---------------------------------------------------------------------------
// 假 WebSocket
// ---------------------------------------------------------------------------

export interface FakeSocketClose {
  code: number | null;
  reason: string | null;
}

/** 可手工驱动 open/message/close 的 WebSocket 替身。 */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = 0;
  readonly sent: string[] = [];
  closed: FakeSocketClose | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('FakeWebSocket: 未打开时 send');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed = { code: code ?? null, reason: reason ?? null };
  }

  /** 解析已发送帧。 */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  lastFrame(): Record<string, unknown> | null {
    const last = this.sent[this.sent.length - 1];
    return last ? (JSON.parse(last) as Record<string, unknown>) : null;
  }

  // ---- 测试驱动面 ----

  driveOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  }

  driveServerClose(code = 1006, reason = 'server close'): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  driveError(message = 'socket error'): void {
    this.onerror?.({ message });
  }
}

export interface FakeTransport {
  clock: FakeClock;
  sockets: FakeWebSocket[];
  factory: (url: string) => FakeWebSocket;
  latest(): FakeWebSocket;
}

/** 每次连接返回新的 FakeWebSocket，并记录创建顺序。 */
export function createFakeTransport(): FakeTransport {
  const clock = new FakeClock();
  const sockets: FakeWebSocket[] = [];
  return {
    clock,
    sockets,
    factory(url: string): FakeWebSocket {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    latest(): FakeWebSocket {
      const socket = sockets[sockets.length - 1];
      if (!socket) throw new Error('createFakeTransport: 还没有创建任何 socket');
      return socket;
    },
  };
}
