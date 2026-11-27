// daemon/health.js —— /health 与 daemon.status 载荷。

export function createHealthPayload({ SERVICE, PROTOCOL_VERSION, VERSION, startedAt, getCurrentPort, TLS_ENABLED, BIND_ADDRESS, PUBLIC_URL, instances, sessions, browserList, sessionList, inflightList, sessionQueue, authGuard, featureMatrix, compareProtocol, recovery = null }) {
  function healthPayload() {
    return {
      ok: true,
      service: SERVICE,
      protocol: PROTOCOL_VERSION,
      version: VERSION,
      pid: process.pid,
      uptimeMs: Date.now() - startedAt,
      port: getCurrentPort(),
      tls: TLS_ENABLED,
      bind: BIND_ADDRESS,
      publicUrl: PUBLIC_URL || null,
      browsers: instances.size,
      sessions: sessions.size,
    };
  }

  function buildStatus() {
    return {
      service: SERVICE,
      version: VERSION,
      protocol: PROTOCOL_VERSION,
      pid: process.pid,
      port: getCurrentPort(),
      uptimeMs: Date.now() - startedAt,
      browsers: browserList(),
      sessions: sessionList(),
      inflight: inflightList(),
      queues: sessionQueue.snapshot(),
      auth: authGuard.snapshot(),
      // 启动恢复证据：账本 pending→unknown、持久化会话分类、tab 租约重建。
      ...(typeof recovery === 'function' ? { recovery: recovery() } : {}),
      compatibility: {
        daemon: { protocol: PROTOCOL_VERSION, features: featureMatrix({ protocol: PROTOCOL_VERSION }, compareProtocol) },
        browsers: browserList().map((item) => ({
          instanceId: item.instanceId,
          protocol: item.protocol,
          features: featureMatrix(item, compareProtocol),
        })),
      },
    };
  }

  return { healthPayload, buildStatus };
}
