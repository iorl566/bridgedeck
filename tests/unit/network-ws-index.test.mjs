// tests/unit/network-ws-index.test.mjs —— WebSocket 帧索引：连接/方向/时间索引、分页、截断标记。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createWebSocketIndex,
  truncateFramePayload,
} from '../../extension/src/lib/network-ws-index.js';

const T0 = 1_700_000_000_000;

function seed() {
  const index = createWebSocketIndex({ maxFramesPerSocket: 100, maxPayload: 64, now: () => T0 });
  const a = index.addSocket({ requestId: 'req-a', url: 'wss://a.test/socket', createdAt: T0 });
  const b = index.addSocket({ requestId: 'req-b', url: 'wss://b.test/socket', createdAt: T0 + 10 });
  index.addFrame(a.id, { direction: 'sent', opcode: 1, payload: 'hello', at: T0 + 100 });
  index.addFrame(a.id, { direction: 'received', opcode: 1, payload: 'world', at: T0 + 200 });
  index.addFrame(a.id, { direction: 'sent', opcode: 1, payload: 'again', at: T0 + 300 });
  index.addFrame(b.id, { direction: 'received', opcode: 2, payload: 'x'.repeat(100), at: T0 + 250 });
  index.addFrame(b.id, { direction: 'error', opcode: null, payload: '', at: T0 + 260, error: 'reset' });
  return { index, a, b };
}

test('addSocket/addFrame：按连接维护帧与方向/字节统计', () => {
  const { index, a, b } = seed();
  assert.equal(index.size, 2);
  assert.equal(index.frameCount, 5);
  const socketA = index.getSocket(a.id);
  assert.equal(socketA.frames.length, 3);
  assert.equal(socketA.stats.sent, 2);
  assert.equal(socketA.stats.received, 1);
  assert.equal(socketA.stats.bytes, 15);
  const socketB = index.getSocket(b.id);
  assert.equal(socketB.stats.error, 1);
  assert.equal(index.findByRequestId('req-a').id, a.id);
  assert.equal(index.findByRequestId('nope'), null);
});

test('重复 requestId 复用连接，不会创建重复 socket', () => {
  const index = createWebSocketIndex({ now: () => T0 });
  const first = index.addSocket({ requestId: 'dup', url: 'wss://d', createdAt: T0 });
  const second = index.addSocket({ requestId: 'dup', url: 'wss://d', createdAt: T0 + 1 });
  assert.equal(first.id, second.id);
  assert.equal(index.size, 1);
});

test('query：按连接/方向/时间过滤 + asc/desc + offset/limit 分页', () => {
  const { index, a } = seed();
  const all = index.query({ limit: 10 });
  assert.equal(all.total, 5);
  assert.deepEqual(all.frames.map((frame) => frame.direction), ['sent', 'received', 'received', 'error', 'sent']);
  assert.equal(all.timeRange.from, T0 + 100);
  assert.equal(all.timeRange.to, T0 + 300);

  const onlyA = index.query({ socketId: a.id });
  assert.equal(onlyA.total, 3);
  assert.equal(onlyA.frames.every((frame) => frame.socketId === a.id), true);

  const sent = index.query({ direction: 'sent' });
  assert.deepEqual(sent.frames.map((frame) => frame.payload), ['hello', 'again']);

  const windowed = index.query({ since: T0 + 200, until: T0 + 260 });
  assert.deepEqual(windowed.frames.map((frame) => frame.at), [T0 + 200, T0 + 250, T0 + 260]);

  const byOpcode = index.query({ opcode: 2 });
  assert.equal(byOpcode.total, 1);

  const page1 = index.query({ limit: 2, offset: 0 });
  assert.equal(page1.frames.length, 2);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.nextOffset, 2);
  const page2 = index.query({ limit: 2, offset: page1.nextOffset });
  assert.equal(page2.hasMore, true);
  const page3 = index.query({ limit: 2, offset: 4 });
  assert.equal(page3.hasMore, false);
  assert.equal(page3.nextOffset, null);
  assert.equal(page3.frames[0].direction, 'sent');

  const desc = index.query({ order: 'desc', limit: 2 });
  assert.deepEqual(desc.frames.map((frame) => frame.direction), ['sent', 'error']);
});

test('truncateFramePayload：按 UTF-8 字节截断，标记原始字节数', () => {
  const clipped = truncateFramePayload('中文abc', 5);
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.bytes, 9);
  assert.equal(clipped.storedBytes <= 5, true);
  assert.equal(clipped.text.includes('\uFFFD'), false);
  const untouched = truncateFramePayload('short', 64);
  assert.equal(untouched.truncated, false);
  assert.equal(untouched.text, 'short');
});

test('addFrame：超限 payload 保留前缀并带 truncated 标记', () => {
  const { index, b } = seed();
  const frames = index.query({ socketId: b.id, direction: 'received' }).frames;
  const frame = frames[0];
  assert.equal(frame.bytes, 100);
  assert.equal(frame.truncated, true);
  assert.equal(Buffer.byteLength(frame.payload, 'utf8') <= 64, true);
  assert.equal(index.stats().truncatedFrames >= 1, true);
  // 查询时按 maxPayload 二次截断，仍然标记 truncated
  const small = index.query({ socketId: b.id, maxPayload: 8 }).frames[0];
  assert.equal(small.truncated, true);
  assert.equal(Buffer.byteLength(small.payload, 'utf8') <= 8, true);
});

test('帧数上限：超出 maxFramesPerSocket 淘汰最老帧并计入 droppedFrames', () => {
  const index = createWebSocketIndex({ maxFramesPerSocket: 3, now: () => T0 });
  const socket = index.addSocket({ requestId: 'cap', url: 'wss://cap', createdAt: T0 });
  for (let i = 0; i < 5; i += 1) {
    index.addFrame(socket.id, { direction: 'sent', opcode: 1, payload: 'f' + i, at: T0 + i });
  }
  assert.equal(index.getSocket(socket.id).frames.length, 3);
  assert.equal(index.frameCount, 3);
  assert.equal(index.stats().droppedFrames, 2);
  assert.deepEqual(index.query({ socketId: socket.id }).frames.map((frame) => frame.payload), ['f2', 'f3', 'f4']);
});

test('closeSocket / findByUrl 时间邻域 / purgeBefore / listSockets 分页', () => {
  const { index, a, b } = seed();
  index.closeSocket(a.id, { error: 'closed-by-peer', at: T0 + 400 });
  const closed = index.getSocket(a.id);
  assert.equal(closed.closed, true);
  assert.equal(closed.error, 'closed-by-peer');
  assert.equal(index.stats().closed, 1);
  assert.equal(index.stats().open, 1);

  assert.equal(index.findByUrl('wss://a.test/socket', T0 + 200).id, a.id);
  assert.equal(index.findByUrl('wss://a.test/socket', T0 + 5000), null);
  assert.equal(index.findByUrl('wss://a.test/socket', T0 + 5000, { timeWindowMs: 6000 }).id, a.id);

  const list = index.listSockets({ frameLimit: 2 });
  assert.equal(list.total, 2);
  const socketA = list.sockets.find((socket) => socket.id === a.id);
  assert.equal(socketA.frameCount, 3);
  assert.deepEqual(socketA.frames.map((frame) => frame.payload), ['world', 'again']);
  const page = index.listSockets({ limit: 1, offset: 1 });
  assert.equal(page.sockets.length, 1);
  assert.equal(page.hasMore, false);
  assert.equal(page.sockets[0].id, b.id);

  const removed = index.purgeBefore(T0 + 250);
  assert.equal(removed, 2); // T0+100、T0+200 被清理
  assert.equal(index.frameCount, 3);
  assert.equal(index.query({ socketId: a.id }).frames.length, 1);
});

test('toJSON 输出可序列化快照（debug.current / CLI debug ws 消费）', () => {
  const { index } = seed();
  const snapshot = index.toJSON();
  assert.equal(snapshot.sockets.length, 2);
  assert.equal(snapshot.stats.frames, 5);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(snapshot)));
  const socket = snapshot.sockets[0];
  assert.equal(Array.isArray(socket.frames), true);
  assert.equal(typeof socket.frames[0].payload, 'string');
});
