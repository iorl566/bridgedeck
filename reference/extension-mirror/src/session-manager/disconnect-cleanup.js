/**
 * One session that could not follow the safe stop path during transport loss.
 * @typedef {object} DisconnectCleanupFailure
 * @property {string} sessionId Session whose teardown failed.
 * @property {string} message Concatenated failure detail safe to log.
 *
 * @typedef {object} DisconnectCleanupReport
 * @property {string[]} stoppedSessionIds Sessions that stopped cleanly.
 * @property {DisconnectCleanupFailure[]} failures Sessions left behind, if any.
 *
 * @typedef {object} DisconnectCleanupOptions
 * @property {object} manager Session registry exposing `list()`.
 * @property {(ctx: object) => Promise<object>} stopSession Normal stop path for one context.
 * @property {() => void} [onSessionsChanged] Refresh side caches after the sweep.
 */

/**
 * Build a coalesced cleanup operation for transport loss.
 *
 * The daemon purges its registry when the extension socket disappears. To
 * keep the extension-side mirror consistent, every local session must follow
 * the normal safe stop path as well: return borrowed tabs, clear refs, detach
 * CDP, and only then close the Agent Window.
 *
 * @param {DisconnectCleanupOptions} options Injected session stop path.
 * @returns {() => Promise<DisconnectCleanupReport>} Cleanup callable; concurrent calls share one run.
 */
export function createDisconnectCleanup(options) {
  let inFlight = null;
  return () => {
    if (inFlight) return inFlight;
    inFlight = cleanupSessions(options).finally(() => { inFlight = null; });
    return inFlight;
  };
}

/**
 * Stop every registered session through the normal safe path.
 *
 * Each stop is attempted independently: one failure is recorded and the sweep
 * continues, so a single stuck tab cannot keep the remaining sessions alive.
 * The callback runs once at the end even when every stop failed, because the
 * caller still needs to refresh its published session list.
 *
 * @param {DisconnectCleanupOptions} options Injected session stop path.
 * @returns {Promise<DisconnectCleanupReport>} Stopped ids and per-session failures.
 */
async function cleanupSessions(options) {
  const stoppedSessionIds = [];
  const failures = [];
  for (const ctx of options.manager.list()) {
    try {
      const result = await options.stopSession(ctx);
      if (result && typeof result === 'object' && 'code' in result) {
        failures.push({ sessionId: ctx.sessionId, message: result.message });
        continue;
      }
      if (result?.return_failures?.length) {
        failures.push({ sessionId: ctx.sessionId, message: result.return_failures.map((failure) => failure.message).join('; ') });
        continue;
      }
      stoppedSessionIds.push(ctx.sessionId);
    } catch (error) {
      failures.push({ sessionId: ctx.sessionId, message: error instanceof Error ? error.message : String(error) });
    }
  }
  options.onSessionsChanged?.();
  return { stoppedSessionIds, failures };
}
