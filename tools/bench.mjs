#!/usr/bin/env node
// tools/bench.mjs —— 可重复的微基准（纯函数 + 账本写入），用于回归对比，不参与门禁。
//
// 用法：
//   node tools/bench.mjs           人类可读
//   node tools/bench.mjs --json    机器可读
// 说明：数值与机器状态强相关，只用于同机前后对比；不要把绝对数写进对外承诺。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IntentLedger } from '../lib/intent-ledger.mjs';
import { buildVomGraph } from '../extension/src/lib/vom-graph.js';
import { buildFrameVomGraphs } from '../extension/src/lib/frame-vom.js';

const jsonMode = process.argv.includes('--json');

function syntheticGraph(nodes, edges) {
  const list = [];
  for (let index = 0; index < nodes; index += 1) {
    list.push({
      key: 'k' + index,
      ref: '@e' + (index + 1),
      tag: index % 5 === 0 ? 'button' : 'div',
      role: index % 5 === 0 ? 'button' : null,
      domId: index % 7 === 0 ? 'n' + index : null,
      parentKey: index === 0 ? null : 'k' + Math.floor((index - 1) / 4),
      frameIndex: 0,
    });
  }
  const edgeList = [];
  for (let index = 0; index < edges; index += 1) {
    edgeList.push({
      type: index % 3 === 0 ? 'label' : 'contain',
      from: 'k' + (index % nodes),
      to: 'k' + ((index * 7 + 3) % nodes),
    });
  }
  return { nodes: list, edges: edgeList };
}

function runBench(name, iterations, fn) {
  for (let index = 0; index < Math.min(3, iterations); index += 1) fn(index);
  const started = process.hrtime.bigint();
  for (let index = 0; index < iterations; index += 1) fn(index);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    name,
    iterations,
    totalMs: Math.round(ms * 100) / 100,
    msPerOp: Math.round((ms / iterations) * 1000) / 1000,
    opsPerSec: Math.round((iterations / ms) * 1000) / 10,
  };
}

const results = [];

// 1) 意图账本：begin 同步写 + finish 合并写（一次动作的真实开销）
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-bench-ledger-'));
  const ledger = new IntentLedger({ dir, staleMs: 60_000 });
  results.push(runBench('intent-ledger begin+finish', 200, (index) => {
    const entry = ledger.begin('click', { ref: '@e' + (index % 50), selector: '#b' + (index % 50) }, { tabId: 1, sessionId: 'bench' });
    ledger.finish(entry, 'done');
  }));
  ledger.flush();
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2) VOM 关系图归一化：600 节点 / 1200 边（默认上限附近）
{
  const graph = syntheticGraph(600, 1200);
  results.push(runBench('vom-graph 600n/1200e', 100, () => buildVomGraph({ graph, nodes: [] })));
}

// 3) 跨帧子图：8 帧，每帧 60 节点 / 120 边
{
  const entries = [];
  for (let frameId = 0; frameId < 8; frameId += 1) {
    entries.push({ frameId, url: 'https://bench.test/f' + frameId, frameIndex: frameId, graph: syntheticGraph(60, 120) });
  }
  results.push(runBench('frame-vom 8f x 60n', 50, () => buildFrameVomGraphs(entries)));
}

if (jsonMode) {
  process.stdout.write(JSON.stringify({ platform: process.platform, node: process.version, results }) + '\n');
} else {
  console.log('platform=' + process.platform + ' node=' + process.version);
  for (const item of results) {
    console.log(
      String(item.name).padEnd(32) + ' ' + String(item.iterations).padStart(5) + ' iters  '
      + String(item.msPerOp).padStart(8) + ' ms/op  ' + String(item.opsPerSec).padStart(8) + ' ops/s',
    );
  }
}
