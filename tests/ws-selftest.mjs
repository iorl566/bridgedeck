#!/usr/bin/env node
// tests/ws-selftest.mjs — lib/ws.mjs 自测：小消息、大消息（>64KB，触发 16/64 位长度）、
// 分片帧、ping/pong、客户端主动关闭。
import http from 'node:http';
import { attachWsServer, connectWs, encodeFrame } from '../lib/ws.mjs';

let passed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => res.end('ok'));
let serverConn = null;
let pongCount = 0;
attachWsServer(server, (c) => {
  serverConn = c;
  c.on('message', (m, isBinary) => {
    if (isBinary) { c.socket.write(encodeFrame(0x2, m, false)); return; }
    c.sendText(m);
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const c = await connectWs(`ws://127.0.0.1:${port}/ws?role=extension&v=test`);
ok('握手成功', !!c);

// 1. 小消息往返
const roundtrip = await new Promise((resolve) => {
  c.on('message', (m) => resolve(m));
  c.sendJson({ hello: 'world', n: 1 });
});
ok('小消息往返', roundtrip === '{"hello":"world","n":1}', roundtrip);

// 2. 大消息（200KB 中文，触发 64 位长度 + UTF-8 边界）
const bigText = '中'.repeat(70000);
const bigBack = await new Promise((resolve) => {
  c.on('message', (m) => resolve(m));
  c.sendText(bigText);
});
ok('大消息往返（200KB）', bigBack === bigText, `len=${bigBack?.length}`);

// 3. 二进制帧
const binBack = await new Promise((resolve) => {
  c.on('message', (m, isBinary) => resolve({ m, isBinary }));
  c.socket.write(encodeFrame(0x2, Buffer.from([1, 2, 3, 4, 5]), true));
});
ok('二进制帧往返', binBack.isBinary && Buffer.compare(Buffer.from(binBack.m), Buffer.from([1, 2, 3, 4, 5])) === 0);

// 4. 分片帧：客户端把一条文本拆成两帧（首帧 opcode=text 且 FIN=0，续帧 CONTINUATION）
{
  const head = Buffer.from('{"frag":');
  const tail = Buffer.from('"mented"}');
  const f1 = encodeFrame(0x1, head, true);
  f1[0] &= 0x7f; // 清 FIN
  c.socket.write(Buffer.concat([f1, encodeFrame(0x0, tail, true)]));
  const fragMsg = await new Promise((resolve) => {
    c.on('message', (m) => resolve(m));
    // 若没收到会在超时后报错
    setTimeout(() => resolve(null), 2000);
  });
  ok('分片消息重组', fragMsg === '{"frag":"mented"}', String(fragMsg));
}

// 5. ping/pong 保活
{
  const before = serverConn;
  c.ping();
  await sleep(300);
  ok('服务端连接保持（ping 未导致断开）', !!serverConn && serverConn === before && !serverConn.closed);
}

// 6. 关闭后服务端感知
{
  c.close();
  await sleep(300);
  ok('客户端关闭后服务端标记 closed', serverConn?.closed === true);
}

server.close();
console.log(`\n${passed} 通过，${fails.length} 失败`);
if (fails.length) { console.log('失败：' + fails.join(', ')); process.exit(1); }
process.exit(0);
