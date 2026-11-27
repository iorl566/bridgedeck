// daemon/start-requests.js —— recoverable session.start 的 prepare/claim/cancel/status。

export function createStartRequests({ startJournal, normalizeStartToken, BridgeError }) {
  const normalizeRequestToken = (value) => {
    try { return normalizeStartToken(String(value)); }
    catch (error) { throw new BridgeError('E_BAD_ARG', String((error && error.message) || error)); }
  };

function unusedNormalize(value) {
    try {
      return normalizeStartToken(String(value));
    } catch (error) {
      throw new BridgeError('E_BAD_ARG', String((error && error.message) || error));
    }
  }
  
  function startRequestMeta(params) {
    return {
      browser: params.browser ?? null,
      focus: params.focus === true,
      noFocus: params.noFocus === true,
      incognito: params.incognito === true,
      tab: params.tab ?? null,
    };
  }
  
  /** 预登记：不创建任何窗口，只占住 token（prepare 语义）。 */
  async function prepareStartRequest(params) {
    const requestId = normalizeRequestToken(params.requestId);
    const existing = startJournal.get(requestId);
    if (existing) {
      if (existing.state === 'cancelled') {
        throw new BridgeError('E_REQUEST_CANCELLED', '该 requestId 已被取消，请重新生成', { requestId, state: existing.state });
      }
      return { requestId, entry: existing };
    }
    return { requestId, entry: startJournal.prepare(requestId, startRequestMeta(params)) };
  }
  
  /** 认领：ready/claimed → claimed，表示调用方已经持久化会话。 */
  async function claimStartRequest(params) {
    const requestId = normalizeRequestToken(params.requestId);
    const existing = startJournal.get(requestId);
    if (!existing) throw new BridgeError('E_BAD_ARG', 'requestId 不存在；请先 prepare 或 start', { requestId });
    if (existing.state === 'cancelled') {
      throw new BridgeError('E_REQUEST_CANCELLED', '该 requestId 已被取消', { requestId, state: existing.state });
    }
    if (existing.state !== 'ready' && existing.state !== 'claimed') {
      throw new BridgeError('E_START_NOT_READY', '会话尚未 ready，不能认领', { requestId, state: existing.state });
    }
    if (existing.state === 'claimed') return { requestId, entry: existing };
    return { requestId, entry: startJournal.setState(requestId, 'claimed', {}) };
  }
  
  /** 取消：prepared/ready/claimed 可直接取消并留下墓碑；starting 进行中拒绝。 */
  async function cancelStartRequest(params) {
    const requestId = normalizeRequestToken(params.requestId);
    const existing = startJournal.get(requestId);
    if (existing && existing.state === 'cancelled') return { requestId, entry: existing };
    if (existing && existing.state === 'starting') {
      throw new BridgeError('E_START_PENDING', '启动进行中，暂不能取消；稍后用同一 requestId 查询', {
        requestId,
        startedAt: existing.at || null,
      });
    }
    const sessionId = existing && existing.result ? existing.result.sessionId : null;
    return { requestId, sessionId, entry: startJournal.setState(requestId, 'cancelled', {}) };
  }
  
  async function startRequestStatus(params) {
    const requestId = normalizeRequestToken(params.requestId);
    return { requestId, entry: startJournal.get(requestId) };
  }
  return { prepareStartRequest, claimStartRequest, cancelStartRequest, startRequestStatus };
}
