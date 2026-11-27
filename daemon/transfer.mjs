// daemon/transfer.mjs —— 文件传输 staging（transfer.*）域模块。
//
// 页面/CLI 只拿 opaque transferId；真实路径只在 daemon 内部与 daemon->扩展 出现。
// 由 server.mjs 注入 dir / log / BridgeError，本模块不依赖 daemon 全局状态。
//
// 第九批 B 在 0.3.0 的 begin/chunk/finish/read/release 之上补齐：
//   - 配额：并发槽位 / 总字节 / 单会话槽位与字节（daemon/transfer-policy.js）；
//   - 断点续传：resume=true 时允许重发已收区间，重叠段与磁盘比对，只追加尾巴；
//     read 回包带 received/byteSize/remaining，客户端可算续传起点；
//   - 校验：chunk.sha256（单块摘要，坏块不落盘）、finish.sha256（整文件摘要，失败即释放 staging）；
//   - 失败清理：finish 校验失败 / 超时空闲（sweep）都会删 staging 目录并释放配额；
//   - 诊断：snapshot() 输出不含真实路径的公共视图 + 配额用量，供 status/CLI/doctor 消费。
//
// 兼容边界：不带新参数的旧调用，chunk 仍只返回 { nextOffset, eof }，错误码/文案保持不变。
// 错误码复用已登记清单：配额=E_TRANSFER_LIMIT、续传/摘要不一致=E_TRANSFER_STATE、
// 客户端单块摘要错=E_BAD_ARG（均带 data.reason 供 CLI 定位）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  TRANSFER_DEFAULT_POLICY,
  buildTransferSnapshot,
  compareResumeOverlap,
  evaluateResumeChunk,
  evaluateTransferAdmission,
  normalizeTransferPolicy,
  planFailureCleanup,
  planTransferSweep,
  sha256Hex,
  verifyChecksum,
} from './transfer-policy.js';

export const TRANSFER_MAX_BYTES = 64 * 1024 * 1024;
export const TRANSFER_CHUNK_BYTES = 1024 * 1024;
export { TRANSFER_DEFAULT_POLICY };

export function createTransferStore({ dir, log = () => {}, BridgeError, policy = null, now = () => Date.now() }) {
  const transfers = new Map();
  const limits = normalizeTransferPolicy(policy || TRANSFER_DEFAULT_POLICY);
  /** 计数：begin 次数、拒绝次数（按原因）、清理次数、校验失败次数。 */
  const counters = {
    begun: 0,
    finished: 0,
    released: 0,
    quotaRejected: 0,
    checksumFailed: 0,
    sweepRemoved: 0,
    resumeReplays: 0,
    rejectReasons: Object.create(null),
  };

  function bump(name, reason) {
    counters[name] = (counters[name] || 0) + 1;
    if (reason) counters.rejectReasons[reason] = (counters.rejectReasons[reason] || 0) + 1;
  }

  function safeTransferName(value) {
    const raw = String(value == null ? '' : value).trim();
    const base = path.basename(raw);
    if (!raw || raw !== base || raw === '.' || raw === '..' || /[\\/]/.test(raw)) {
      throw new BridgeError('E_BAD_ARG', 'transfer 需要合法文件名（不能包含路径）');
    }
    if (/[\u0000-\u001f<>:"|?*]/.test(base)) throw new BridgeError('E_BAD_ARG', '文件名包含非法字符');
    return base.slice(0, 200);
  }

  function requireTransfer(transferId) {
    const entry = transfers.get(String(transferId || ''));
    if (!entry) throw new BridgeError('E_TRANSFER_NOT_FOUND', 'transfer 不存在或已释放');
    return entry;
  }

  function closeTransferFile(entry) {
    if (entry && entry.fd != null) {
      try { fs.closeSync(entry.fd); } catch { /* 忽略 */ }
      entry.fd = null;
    }
  }

  function removeTransfer(entry, reason) {
    if (!entry) return false;
    closeTransferFile(entry);
    try { fs.rmSync(path.dirname(entry.filePath), { recursive: true, force: true }); } catch { /* 忽略 */ }
    transfers.delete(entry.id);
    log(`transfer ${entry.id} 释放${reason ? '（' + reason + '）' : ''}`);
    return true;
  }

  function releaseForSession(sessionId) {
    let released = 0;
    for (const entry of [...transfers.values()]) {
      if (entry.sessionId === sessionId) {
        if (removeTransfer(entry, 'session stop')) released += 1;
      }
    }
    return released;
  }

  /** 配额准入：拒绝时不创建目录/文件，返回结构化证据供 CLI/doctor 解释。 */
  function assertAdmission(sessionId, byteSize) {
    const decision = evaluateTransferAdmission([...transfers.values()], { sessionId, byteSize, policy: limits });
    if (decision.allowed) return decision;
    bump('quotaRejected', decision.reason);
    log(`transfer 配额拒绝 session=${sessionId} bytes=${byteSize} reason=${decision.reason} limit=${decision.limit}`);
    throw new BridgeError('E_TRANSFER_LIMIT', `transfer 配额已满（${decision.reason}，上限 ${decision.limit}）`, {
      reason: decision.reason,
      limit: decision.limit,
      usage: decision.usage,
    });
  }

  function begin({ sessionId, name, byteSize } = {}) {
    const safeName = safeTransferName(name);
    const size = Number(byteSize);
    if (!Number.isInteger(size) || size <= 0 || size > TRANSFER_MAX_BYTES) {
      throw new BridgeError('E_BAD_ARG', `byteSize 必须是 1..${TRANSFER_MAX_BYTES} 的整数`);
    }
    assertAdmission(sessionId, size);
    let transferId = '';
    do {
      transferId = 'tr_' + crypto.randomBytes(8).toString('hex');
    } while (transfers.has(transferId));
    const filePath = path.join(dir, transferId, safeName);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const fd = fs.openSync(filePath, 'w');
    const at = now();
    const entry = {
      id: transferId, sessionId, name: safeName, byteSize: size, received: 0, filePath, fd,
      createdAt: at, updatedAt: at, lastActivityAt: at, finished: false, direction: 'upload',
      verified: false, checksum: null, resumeCount: 0,
    };
    transfers.set(transferId, entry);
    bump('begun');
    log(`transfer ${transferId} begin name=${safeName} bytes=${size} session=${sessionId}`);
    return { transferId, chunkSize: TRANSFER_CHUNK_BYTES, byteSize: size, resumable: true };
  }

  /** 读 staging 文件的一段（续传重叠比对用）。 */
  function readSlice(filePath, offset, length) {
    if (!(length > 0)) return Buffer.alloc(0);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, offset);
    } finally {
      fs.closeSync(fd);
    }
    return buffer;
  }

  function chunk(params = {}) {
    const entry = requireTransfer(params.transferId);
    if (entry.finished) throw new BridgeError('E_TRANSFER_STATE', 'transfer 已完成，不能继续写入');
    const offset = Number(params.offset);
    const resume = params.resume === true;
    const wantsDiagnostics = resume || params.sha256 !== undefined || params.digest === true;
    // 旧路径（未开 resume）先判 offset 连续性，保持 0.3.0 的错误优先级与文案。
    if (!resume && (!Number.isInteger(offset) || offset !== entry.received)) {
      throw new BridgeError('E_TRANSFER_OFFSET', `offset 不连续：期望 ${entry.received}，收到 ${params.offset}`);
    }
    const raw = String(params.dataBase64 == null ? '' : params.dataBase64);
    let buffer;
    try {
      buffer = Buffer.from(raw, 'base64');
    } catch {
      throw new BridgeError('E_BAD_ARG', 'dataBase64 不是合法 base64');
    }
    if (!buffer.length) throw new BridgeError('E_BAD_ARG', 'dataBase64 不能为空');
    if (buffer.length > TRANSFER_CHUNK_BYTES) {
      throw new BridgeError('E_TRANSFER_LIMIT', `单块不能超过 ${TRANSFER_CHUNK_BYTES} 字节`);
    }
    // 可选：单块摘要（在落盘前校验，坏块不污染 staging；摘要与内容不符属于调用参数错误）。
    if (params.sha256 !== undefined) {
      const actual = sha256Hex(buffer);
      const verdict = verifyChecksum(params.sha256, actual);
      if (!verdict.ok) {
        bump('checksumFailed', verdict.reason);
        throw new BridgeError('E_BAD_ARG', 'chunk 摘要不匹配（' + verdict.reason + '）', {
          expected: String(params.sha256).slice(0, 72),
          actual,
          offset: Number.isFinite(offset) ? offset : null,
          reason: verdict.reason,
        });
      }
    }
    const plan = evaluateResumeChunk({
      received: entry.received,
      offset,
      chunkLength: buffer.length,
      byteSize: entry.byteSize,
      resume,
    });
    if (!plan.allowed) {
      if (plan.reason === 'gap' || plan.reason === 'not-contiguous' || plan.reason === 'bad-offset') {
        throw new BridgeError('E_TRANSFER_OFFSET', `offset 不连续：期望 ${entry.received}，收到 ${params.offset}`);
      }
      if (plan.reason === 'overflow') {
        throw new BridgeError('E_TRANSFER_LIMIT', `写入超过声明的 byteSize=${entry.byteSize}`);
      }
      throw new BridgeError('E_BAD_ARG', 'dataBase64 不能为空');
    }
    let verifiedBytes = 0;
    if (plan.mode === 'replay') {
      // 断点续传：重发的已收区间必须与磁盘字节一致，然后只追加尾巴。
      const onDisk = readSlice(entry.filePath, plan.offset, plan.overlap);
      const comparison = compareResumeOverlap(onDisk, buffer.subarray(0, plan.overlap));
      if (!comparison.ok) {
        bump('checksumFailed', comparison.reason);
        throw new BridgeError('E_TRANSFER_STATE', '续传内容与已收字节不一致（' + comparison.reason + '）', {
          transferId: entry.id,
          offset: plan.offset,
          received: entry.received,
          at: comparison.at,
          reason: comparison.reason,
        });
      }
      verifiedBytes = plan.overlap;
      if (plan.writeLength > 0) {
        fs.writeSync(entry.fd, buffer, plan.writeFrom, plan.writeLength, entry.received);
        entry.received += plan.writeLength;
      }
      entry.resumeCount = (entry.resumeCount || 0) + 1;
      bump('resumeReplays');
    } else {
      fs.writeSync(entry.fd, buffer, 0, buffer.length, entry.received);
      entry.received += buffer.length;
    }
    entry.lastActivityAt = now();
    entry.updatedAt = entry.lastActivityAt;
    const eof = entry.received === entry.byteSize;
    if (!wantsDiagnostics) return { nextOffset: entry.received, eof };
    return {
      nextOffset: entry.received,
      eof,
      received: entry.received,
      byteSize: entry.byteSize,
      remaining: Math.max(0, entry.byteSize - entry.received),
      mode: plan.mode,
      verifiedBytes,
      resumes: entry.resumeCount || 0,
    };
  }

  function digestFile(filePath) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(TRANSFER_CHUNK_BYTES);
      let position = 0;
      for (;;) {
        const read = fs.readSync(fd, buffer, 0, buffer.length, position);
        if (read <= 0) break;
        hash.update(buffer.subarray(0, read));
        position += read;
      }
    } finally {
      fs.closeSync(fd);
    }
    return hash.digest('hex');
  }

  function finish(params = {}) {
    const entry = requireTransfer(params.transferId);
    if (entry.finished) return { transferId: entry.id, byteSize: entry.received };
    if (entry.received !== entry.byteSize) {
      throw new BridgeError('E_TRANSFER_INCOMPLETE', `已写入 ${entry.received}/${entry.byteSize} 字节，不能 finish`);
    }
    let digest = null;
    const wantChecksum = params.sha256 !== undefined;
    if (wantChecksum || params.digest === true) digest = digestFile(entry.filePath);
    if (wantChecksum) {
      const verdict = verifyChecksum(params.sha256, digest);
      if (!verdict.ok) {
        // 失败清理：摘要不符的 staging 不能留给 upload 复用，直接释放配额与磁盘。
        bump('checksumFailed', verdict.reason);
        const cleanup = planFailureCleanup(entry, 'checksum-failed');
        removeTransfer(entry, 'checksum-failed');
        throw new BridgeError('E_TRANSFER_STATE', '整文件摘要不匹配（' + verdict.reason + '）', {
          transferId: cleanup ? cleanup.id : entry.id,
          expected: String(params.sha256).slice(0, 72),
          actual: digest,
          released: true,
          reason: verdict.reason,
        });
      }
      entry.verified = true;
      entry.checksum = digest;
    } else if (digest) {
      entry.checksum = digest;
    }
    try { fs.fsyncSync(entry.fd); } catch { /* 忽略 */ }
    closeTransferFile(entry);
    entry.finished = true;
    entry.lastActivityAt = now();
    entry.updatedAt = entry.lastActivityAt;
    bump('finished');
    log(`transfer ${entry.id} finish bytes=${entry.received}`);
    const result = { transferId: entry.id, byteSize: entry.received };
    if (digest) result.sha256 = digest;
    if (entry.verified) result.verified = true;
    return result;
  }

  function read(params = {}) {
    const entry = requireTransfer(params.transferId);
    const offset = Number(params.offset);
    if (!Number.isInteger(offset) || offset < 0 || offset > entry.byteSize) {
      throw new BridgeError('E_BAD_ARG', `offset 必须在 0..${entry.byteSize}`);
    }
    const wanted = Number(params.maxBytes);
    const maxBytes = Number.isInteger(wanted) && wanted > 0 ? Math.min(wanted, TRANSFER_CHUNK_BYTES) : TRANSFER_CHUNK_BYTES;
    const remaining = entry.byteSize - offset;
    const size = Math.min(maxBytes, remaining);
    const buffer = Buffer.alloc(size);
    if (size > 0) {
      const fd = fs.openSync(entry.filePath, 'r');
      try {
        fs.readSync(fd, buffer, 0, size, offset);
      } finally {
        fs.closeSync(fd);
      }
    }
    const result = {
      nextOffset: offset + size,
      eof: offset + size >= entry.byteSize,
      dataBase64: buffer.toString('base64'),
      // 新增只读字段：客户端据此恢复断点（daemon 端 received 是权威进度）。
      received: entry.received,
      byteSize: entry.byteSize,
      remaining: Math.max(0, entry.byteSize - entry.received),
      finished: entry.finished === true,
      resumable: entry.finished !== true,
    };
    if (params.digest === true) result.sha256 = digestFile(entry.filePath);
    return result;
  }

  function release(params = {}) {
    const id = String(params.transferId || '');
    const entry = transfers.get(id);
    if (!entry) return { released: false };
    removeTransfer(entry, 'release');
    bump('released');
    return { released: true };
  }

  /** upload 前把 transferId 换成 daemon 内部 staging 路径；路径只出现在 daemon->扩展。 */
  function injectPaths(params = {}) {
    const files = Array.isArray(params.files) ? params.files : [];
    const paths = Array.isArray(params.paths) ? params.paths.slice() : [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (!file || !file.transferId) continue;
      const entry = requireTransfer(file.transferId);
      if (entry.sessionId !== params.sessionId && entry.sessionId !== params.session) {
        throw new BridgeError('E_TRANSFER_STATE', 'transfer 不属于当前会话');
      }
      if (!entry.finished) throw new BridgeError('E_TRANSFER_INCOMPLETE', 'transfer 尚未 finish');
      file.stagedPath = entry.filePath;
      paths[index] = entry.filePath;
    }
    if (paths.length) params.paths = paths;
    return params;
  }

  /** 把扩展下载到浏览器的文件导入 daemon staging，CLI 用 transfer.read 流式读取。 */
  function stageDownload(result, sessionId) {
    try {
      if (!result || typeof result.filename !== 'string' || !result.filename) return result;
      const stat = fs.statSync(result.filename);
      if (!stat.isFile() || stat.size <= 0 || stat.size > TRANSFER_MAX_BYTES) return result;
      let transferId = '';
      do {
        transferId = 'tr_' + crypto.randomBytes(8).toString('hex');
      } while (transfers.has(transferId));
      const name = safeTransferName(path.basename(result.filename));
      const filePath = path.join(dir, transferId, name);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.copyFileSync(result.filename, filePath);
      const at = now();
      transfers.set(transferId, {
        id: transferId, sessionId, name, byteSize: stat.size, received: stat.size,
        filePath, fd: null, createdAt: at, updatedAt: at, lastActivityAt: at,
        finished: true, direction: 'download', verified: true, checksum: null, resumeCount: 0,
      });
      log(`transfer ${transferId} download staged name=${name} bytes=${stat.size}`);
      return { ...result, transferId, transferBytes: stat.size };
    } catch (error) {
      log('下载文件导入 staging 失败（继续用浏览器路径）：' + ((error && error.message) || error));
      return result;
    }
  }

  /**
   * 清理空闲/过期的 staging（失败清理）：
   * - 未完成且最近活动早于 idleTtlMs（客户端断连后不再续传）→ 释放；
   * - 已完成且早于 finishedTtlMs（消费方没来读/读漏）→ 释放磁盘。
   */
  function sweep({ nowMs = now(), idleTtlMs = limits.idleTtlMs, finishedTtlMs = limits.finishedTtlMs } = {}) {
    const plan = planTransferSweep([...transfers.values()], {
      now: nowMs,
      policy: { ...limits, idleTtlMs, finishedTtlMs },
    });
    const removed = [];
    for (const item of plan.remove) {
      const entry = transfers.get(item.id);
      if (!entry) continue;
      removeTransfer(entry, item.reason);
      bump('sweepRemoved', item.reason);
      removed.push(item);
    }
    return { removed, bytes: plan.bytes, scanned: plan.scanned, keep: plan.keep, at: plan.at };
  }

  /** 公共诊断视图（无真实路径）：/status views=transfers 与 CLI `daemon transfer` 消费。 */
  function snapshot({ limit = 20, nowMs = now() } = {}) {
    const snapshotValue = buildTransferSnapshot([...transfers.values()], { now: nowMs, policy: limits, limit });
    return {
      ...snapshotValue,
      counters: { ...counters, rejectReasons: { ...counters.rejectReasons } },
      policy: { ...limits },
    };
  }

  /** 内部条目（daemon 内部/单测用；含 filePath，不对外）。 */
  function entries() {
    return [...transfers.values()].map((entry) => ({
      id: entry.id,
      sessionId: entry.sessionId,
      name: entry.name,
      byteSize: entry.byteSize,
      received: entry.received,
      finished: entry.finished,
      direction: entry.direction,
      createdAt: entry.createdAt,
      lastActivityAt: entry.lastActivityAt,
      verified: entry.verified,
    }));
  }

  return {
    begin,
    chunk,
    finish,
    read,
    release,
    releaseForSession,
    injectPaths,
    stageDownload,
    sweep,
    snapshot,
    entries,
    policy: limits,
    counters,
    get size() { return transfers.size; },
  };
}
