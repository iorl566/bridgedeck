/** Message kind that marks a debug bridge request. */
export const DEBUG_MESSAGE = 'bb_debug';

/** Only extension-owned UI may read evidence; content scripts are excluded.
 *
 * @param {object} sender Message sender identity.
 * @param {object} [runtime] Extension runtime with `id` and `getURL`.
 * @returns {boolean} True for a page rendered by this extension.
 */
export function isDebugPage(sender, runtime = globalThis.chrome?.runtime) {
  if (sender.id !== runtime.id || !sender.url) return false;
  try {
    const origin = new URL(runtime.getURL('/'));
    const url = new URL(sender.url);
    return url.protocol === origin.protocol && url.host === origin.host && ['/popup.html', '/debug.html'].includes(url.pathname);
  } catch {
    return false;
  }
}

/**
 * Register the debug message handler for the extension runtime.
 *
 * Message handling is ordered, not concurrent: reads and mutations observe the
 * same sequence, and a start or stop also becomes a write barrier so a later
 * read cannot overtake it. Unauthorized senders, unknown actions and invalid
 * recording ids all become error replies instead of rejected promises.
 *
 * @param {object} sessions Session registry used by debug actions.
 * @param {object} debug Debug controller exposing tasks and history methods.
 * @param {{
 *   runtime?: object,
 *   validateDebugParams: (params: object) => string | undefined,
 *   handleDebug: (sessions: object, params: object, debug: object) => Promise<object>,
 *   isRpcError: (value: object) => boolean,
 * }} deps Injected runtime and action handlers.
 */
export function attachDebugBridge(sessions, debug, deps) {
  const runtime = deps.runtime ?? globalThis.chrome.runtime;
  let writes = Promise.resolve();
  runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.kind !== DEBUG_MESSAGE) return false;
    if (!isDebugPage(sender, runtime)) {
      respond({ ok: false, error: 'forbidden' });
      return false;
    }
    const action = message.action;
    const execute = async () => {
      if (action === 'tasks') return { tasks: await debug.tasks() };
      if (action === 'history') return debug.history();
      if (action === 'delete') {
        if (typeof message.run_id !== 'string' || !/^d[a-zA-Z0-9]+$/.test(message.run_id)) throw new Error('invalid recording ID');
        await debug.deleteHistory(message.run_id);
        return {};
      }
      const params = message.params;
      if (action === 'record') {
        const invalid = deps.validateDebugParams(params);
        if (invalid) throw new Error(invalid);
        return debug.readHistory(params);
      }
      if (action !== 'debug') throw new Error('unsupported debug message');
      const result = await deps.handleDebug(sessions, params, debug);
      if (deps.isRpcError(result)) throw new Error(result.message);
      return result;
    };
    const request = writes.then(execute);
    if (action === 'delete' || message.params?.action === 'start' || message.params?.action === 'stop') {
      writes = request.then(() => {}, () => {});
    }
    void request.then(
      (data) => respond({ ok: true, data }),
      (error) => respond({ ok: false, error: error instanceof Error ? error.message : 'unavailable' }),
    );
    return true;
  });
}
