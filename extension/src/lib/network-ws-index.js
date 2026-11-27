// src/lib/network-ws-index.js —— WebSocket 帧索引：按连接 / 方向 / 时间建立索引，支持分页与截断标记。
//
// 为什么需要独立索引：network.js 原先把帧顺序塞进 `socket.frames` 数组，查询只能
// `slice(-limit)`，无法按方向/时间窗翻页，也没有"payload 被截断"的可信标记（截断后的
// 字符串会被当成完整 payload）。这里把帧存成带 seq 的不可变记录，并维护：
//   * sockets: id → {id, requestId, url, createdAt, closed, error, stats, frames[]}
//   * byDirection: sent/received/error → 有序帧序列（同一连接内仍可按方向查）
//   * frames: 全局按时间(seq 稳定)排序的帧序列，支持 since/until 二分 + offset/limit 分页
// 每条帧记录 payloadBytes（原始字节数）与 truncated/truncatedAtBytes，查询时可按
// maxPayload 再做一次更小的截断（第二次截断同样有标记，不会伪装成原始帧）。
//
// 消费点：extension/src/network.js —— networkWebSockets（debug.current / debug ws）
// 与 networkDetail（HAR 导出 _webSocketMessages）。

export const DEFAULT_FRAME_LIMIT = 2000;
export const DEFAULT_PAYLOAD_LIMIT = 4096;
export const DIRECTIONS = Object.freeze(['sent', 'received', 'error']);

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeDirection(value) {
  const text = String(value == null ? '' : value).toLowerCase();
  if (text === 'sent' || text === 'send') return 'sent';
  if (text === 'received' || text === 'receive') return 'received';
  if (text === 'error') return 'error';
  return 'received';
}

function encoder() {
  return new TextEncoder();
}

function decoder() {
  return new TextDecoder('utf-8', { fatal: false });
}

/** 返回 {text, bytes, truncated, storedBytes}；按 UTF-8 字节截断且不切坏多字节字符。 */
export function truncateFramePayload(payload, limit = DEFAULT_PAYLOAD_LIMIT) {
  const text = String(payload == null ? '' : payload);
  const max = Math.max(0, Number(limit) || 0);
  const bytes = encoder().encode(text);
  if (bytes.length <= max) return { text, bytes: bytes.length, truncated: false, storedBytes: bytes.length };
  if (max === 0) return { text: '', bytes: bytes.length, truncated: true, storedBytes: 0 };
  let slice = bytes.subarray(0, max);
  let decoded = decoder().decode(slice);
  if (decoded.includes('\uFFFD')) {
    // 截断点落在多字节字符中间：去掉最后一个不完整字符。
    const last = decoded.lastIndexOf('\uFFFD');
    if (last >= 0) decoded = decoded.slice(0, last);
    slice = encoder().encode(decoded);
  }
  return { text: decoded, bytes: bytes.length, truncated: true, storedBytes: slice.length };
}

function lowerBound(list, at) {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (Number(list[middle].at) < at) low = middle + 1;
    else high = middle;
  }
  return low;
}

function insertSorted(list, record) {
  list.splice(lowerBound(list, record.at), 0, record);
}

function removeFrom(list, record) {
  const index = list.indexOf(record);
  if (index >= 0) list.splice(index, 1);
}

/**
 * 创建 WS 帧索引。
 * options: maxSockets / maxFramesPerSocket / maxPayload / now（可注入时钟）
 */
export function createWebSocketIndex(options = {}) {
  const maxSockets = Math.max(1, Number(options.maxSockets) || 500);
  const maxFramesPerSocket = Math.max(1, Number(options.maxFramesPerSocket) || DEFAULT_FRAME_LIMIT);
  const maxPayload = Math.max(0, Number(options.maxPayload) || DEFAULT_PAYLOAD_LIMIT);
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  const sockets = new Map();
  const sentFrames = [];
  const receivedFrames = [];
  const errorFrames = [];
  const allFrames = [];
  let socketSeq = 0;
  let frameSeq = 0;
  let lastAt = 0;
  let droppedFrames = 0;
  let truncatedFrames = 0;

  function directionList(direction) {
    if (direction === 'sent') return sentFrames;
    if (direction === 'error') return errorFrames;
    return receivedFrames;
  }

  function ensureSocket(input = {}) {
    const requestId = input.requestId == null ? null : String(input.requestId);
    if (requestId) {
      for (const socket of sockets.values()) {
        if (socket.requestId === requestId) return socket;
      }
    }
    socketSeq += 1;
    const createdAt = finite(input.createdAt) ?? clock();
    const socket = {
      id: Number(input.id) > 0 ? Number(input.id) : socketSeq,
      requestId,
      url: String(input.url || ''),
      createdAt,
      closed: input.closed === true,
      error: input.error || null,
      frames: [],
      stats: { sent: 0, received: 0, error: 0, bytes: 0, truncated: 0 },
    };
    sockets.set(socket.id, socket);
    // 有界：超出 maxSockets 时淘汰最老的已关闭连接（没有已关闭则淘汰最老连接）。
    if (sockets.size > maxSockets) {
      const oldest = [...sockets.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) sockets.delete(oldest.id);
    }
    return socket;
  }

  function addSocket(input = {}) {
    return ensureSocket(input);
  }

  /**
   * 追加一条帧。raw: {direction, opcode, payload, at, error}
   * 返回帧记录（含 truncated/payloadBytes/storedBytes）。
   */
  function addFrame(socketId, raw = {}) {
    const socket = sockets.get(Number(socketId)) || ensureSocket({ id: socketId });
    const at = finite(raw.at) ?? Math.max(clock(), lastAt + 1);
    lastAt = Math.max(lastAt, at);
    const clipped = truncateFramePayload(raw.payload !== undefined ? raw.payload : raw.data, maxPayload);
    frameSeq += 1;
    const record = {
      seq: frameSeq,
      socketId: socket.id,
      connectionId: socket.id,
      requestId: socket.requestId,
      direction: normalizeDirection(raw.direction || raw.type),
      opcode: raw.opcode == null ? null : Number(raw.opcode),
      at,
      payload: clipped.text,
      payloadBytes: clipped.bytes,
      storedBytes: clipped.storedBytes,
      truncated: raw.truncated === true || clipped.truncated,
      ...(raw.error ? { error: String(raw.error) } : {}),
    };
    if (record.truncated) truncatedFrames += 1;
    insertSorted(socket.frames, record);
    // 有界：超出上限时淘汰该连接最老的帧，并同步从方向/全局索引移除。
    while (socket.frames.length > maxFramesPerSocket) {
      const removed = socket.frames.shift();
      droppedFrames += 1;
      if (removed !== record) {
        socket.stats[removed.direction] = Math.max(0, socket.stats[removed.direction] - 1);
        socket.stats.bytes = Math.max(0, socket.stats.bytes - removed.payloadBytes);
        if (removed.truncated) socket.stats.truncated = Math.max(0, socket.stats.truncated - 1);
        removeFrom(allFrames, removed);
        removeFrom(directionList(removed.direction), removed);
      }
    }
    if (!socket.frames.includes(record)) return record;
    socket.stats[record.direction] += 1;
    socket.stats.bytes += record.payloadBytes;
    if (record.truncated) socket.stats.truncated += 1;
    insertSorted(directionList(record.direction), record);
    insertSorted(allFrames, record);
    return record;
  }

  function closeSocket(socketId, info = {}) {
    const socket = sockets.get(Number(socketId));
    if (!socket) return null;
    socket.closed = true;
    if (info.error) socket.error = String(info.error);
    if (finite(info.at) != null) socket.closedAt = Number(info.at);
    return socket;
  }

  function getSocket(socketId) {
    return sockets.get(Number(socketId)) || null;
  }

  function findByRequestId(requestId) {
    const needle = String(requestId);
    for (const socket of sockets.values()) {
      if (socket.requestId === needle) return socket;
    }
    return null;
  }

  /** 无 requestId 关联：按握手 URL + 时间邻域找连接（HAR 导入复用同一语义）。 */
  function findByUrl(url, at, { timeWindowMs = 1500 } = {}) {
    const needle = String(url || '');
    if (!needle) return null;
    const target = finite(at);
    let best = null;
    let bestDelta = Infinity;
    for (const socket of sockets.values()) {
      if (socket.url !== needle) continue;
      const delta = target == null ? 0 : Math.abs(socket.createdAt - target);
      if (delta <= timeWindowMs && delta < bestDelta) {
        best = socket;
        bestDelta = delta;
      }
    }
    return best;
  }

  function frameView(frame, viewLimit) {
    if (viewLimit == null || viewLimit >= frame.payloadBytes) {
      return {
        seq: frame.seq,
        socketId: frame.socketId,
        direction: frame.direction,
        opcode: frame.opcode,
        at: frame.at,
        bytes: frame.payloadBytes,
        payload: frame.payload,
        truncated: frame.truncated === true,
        ...(frame.error ? { error: frame.error } : {}),
      };
    }
    const clipped = truncateFramePayload(frame.payload, viewLimit);
    return {
      seq: frame.seq,
      socketId: frame.socketId,
      direction: frame.direction,
      opcode: frame.opcode,
      at: frame.at,
      bytes: frame.payloadBytes,
      payload: clipped.text,
      truncated: frame.truncated === true || clipped.truncated,
      ...(frame.error ? { error: frame.error } : {}),
    };
  }

  /**
   * 分页查询帧。
   * filter: {socketId, direction, since, until, opcode, offset, limit, order, maxPayload}
   * order: 'asc'（默认，按时间）| 'desc'
   */
  function query(filter = {}) {
    const options = filter && typeof filter === 'object' ? filter : {};
    const limit = Math.max(1, Math.min(Number(options.limit) || 200, 2000));
    const offset = Math.max(0, Number(options.offset) || 0);
    const order = options.order === 'desc' ? 'desc' : 'asc';
    const maxPayload = options.maxPayload == null ? null : Math.max(0, Number(options.maxPayload));
    const socketId = options.socketId == null ? null : Number(options.socketId);
    const direction = options.direction == null ? null : normalizeDirection(options.direction);
    const opcode = options.opcode == null ? null : Number(options.opcode);
    const since = finite(options.since);
    const until = finite(options.until);
    let base;
    if (socketId != null) base = sockets.get(socketId) ? sockets.get(socketId).frames : [];
    else if (direction) base = directionList(direction);
    else base = allFrames;
    let start = 0;
    if (since != null) start = lowerBound(base, since);
    let end = base.length;
    if (until != null) {
      let low = start;
      let high = base.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (Number(base[middle].at) <= until) low = middle + 1;
        else high = middle;
      }
      end = low;
    }
    const matched = [];
    for (let index = start; index < end; index += 1) {
      const frame = base[index];
      if (socketId != null && frame.socketId !== socketId) continue;
      if (direction && frame.direction !== direction) continue;
      if (opcode != null && Number(frame.opcode) !== opcode) continue;
      matched.push(frame);
    }
    if (order === 'desc') matched.reverse();
    const page = matched.slice(offset, offset + limit).map((frame) => frameView(frame, maxPayload));
    const truncatedInPage = page.filter((frame) => frame.truncated).length;
    return {
      frames: page,
      total: matched.length,
      matched: matched.length,
      offset,
      limit,
      order,
      hasMore: offset + page.length < matched.length,
      nextOffset: offset + page.length < matched.length ? offset + page.length : null,
      truncatedFrames: truncatedInPage,
      socketId,
      direction,
      timeRange: matched.length
        ? { from: matched[0].at, to: matched[matched.length - 1].at }
        : null,
    };
  }

  /** 连接列表（可附最近 N 帧摘要；debug.current 用 frameLimit）。 */
  function listSockets(options = {}) {
    const offset = Math.max(0, Number(options.offset) || 0);
    const limit = Math.max(1, Math.min(Number(options.limit) || 100, 500));
    const frameLimit = options.frameLimit == null ? 0 : Math.max(0, Math.min(Number(options.frameLimit), 2000));
    const list = [...sockets.values()].sort((a, b) => a.id - b.id);
    const page = list.slice(offset, offset + limit);
    return {
      total: list.length,
      offset,
      limit,
      sockets: page.map((socket) => ({
        id: socket.id,
        requestId: socket.requestId,
        url: socket.url,
        createdAt: socket.createdAt,
        closed: socket.closed === true,
        error: socket.error || null,
        frameCount: socket.frames.length,
        stats: { ...socket.stats },
        ...(frameLimit > 0 ? { frames: socket.frames.slice(-frameLimit).map((frame) => frameView(frame)) } : {}),
      })),
      hasMore: offset + page.length < list.length,
    };
  }

  function stats() {
    let bytes = 0;
    let sent = 0;
    let received = 0;
    let errors = 0;
    let closed = 0;
    let truncated = 0;
    for (const socket of sockets.values()) {
      bytes += socket.stats.bytes;
      sent += socket.stats.sent;
      received += socket.stats.received;
      errors += socket.stats.error;
      truncated += socket.stats.truncated;
      if (socket.closed) closed += 1;
    }
    return {
      sockets: sockets.size,
      closed,
      open: sockets.size - closed,
      frames: allFrames.length,
      sent,
      received,
      errors,
      bytes,
      truncatedFrames: truncated,
      droppedFrames,
      limits: { maxSockets, maxFramesPerSocket, maxPayload },
      timeRange: allFrames.length ? { from: allFrames[0].at, to: allFrames[allFrames.length - 1].at } : null,
      averagePayloadBytes: allFrames.length ? round(bytes / allFrames.length) : 0,
    };
  }

  /** 清理早于 at 的帧（长会话内存保护）；连接保留。 */
  function purgeBefore(at) {
    const cutoff = finite(at);
    if (cutoff == null) return 0;
    let removed = 0;
    for (const socket of sockets.values()) {
      const kept = socket.frames.filter((frame) => frame.at >= cutoff);
      removed += socket.frames.length - kept.length;
      socket.frames = kept;
      socket.stats = kept.reduce((accumulator, frame) => {
        accumulator[frame.direction] += 1;
        accumulator.bytes += frame.payloadBytes;
        if (frame.truncated) accumulator.truncated += 1;
        return accumulator;
      }, { sent: 0, received: 0, error: 0, bytes: 0, truncated: 0 });
    }
    for (const list of [allFrames, sentFrames, receivedFrames, errorFrames]) {
      for (let index = list.length - 1; index >= 0; index -= 1) {
        if (list[index].at < cutoff) list.splice(index, 1);
      }
    }
    return removed;
  }

  return {
    addSocket,
    ensureSocket,
    addFrame,
    closeSocket,
    getSocket,
    findByRequestId,
    findByUrl,
    query,
    listSockets,
    stats,
    purgeBefore,
    get size() {
      return sockets.size;
    },
    get frameCount() {
      return allFrames.length;
    },
    toJSON() {
      return { sockets: listSockets({ limit: 500, frameLimit: 200 }).sockets, stats: stats() };
    },
  };
}
