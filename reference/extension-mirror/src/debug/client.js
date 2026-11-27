/**
 * Debug client helpers used by extension UI pages.
 *
 * Every call funnels through the extension runtime and unwraps the bridge
 * envelope, so callers see data or a rejected promise rather than a partially
 * checked reply. The runtime and tab surfaces are injectable for tests.
 *
 * @param {object} message Bridge action and payload.
 * @param {object} [runtime] Extension runtime with `sendMessage`.
 * @returns {Promise<unknown>} Reply data.
 * @throws {Error} When the bridge reports a failure code or message.
 */
async function request(message, runtime = globalThis.chrome?.runtime) {
  const response = await runtime.sendMessage({ kind: 'bb_debug', ...message });
  if (!response?.ok) throw new Error(response?.error ?? 'unavailable');
  return response.data;
}

/** Run one debug action.
 * @param {import('./types.js').DebugParams} params Action and options.
 * @param {{ runtime?: object }} [deps] Runtime override.
 * @returns {Promise<import('./types.js').DebugResult>} Action result.
 */
export const debugRequest = (params, deps) => request({ action: 'debug', params }, deps?.runtime);
/** List live debug tasks.
 * @param {{ runtime?: object }} [deps] Runtime override.
 * @returns {Promise<{ tasks: object[] }>} Task summaries.
 */
export const debugTasks = (deps) => request({ action: 'tasks' }, deps?.runtime);
/** List stored recordings.
 * @param {{ runtime?: object }} [deps] Runtime override.
 * @returns {Promise<object>} History index.
 */
export const debugHistory = (deps) => request({ action: 'history' }, deps?.runtime);
/** Read one stored recording.
 * @param {import('./types.js').DebugParams} params Read options.
 * @param {{ runtime?: object }} [deps] Runtime override.
 * @returns {Promise<import('./types.js').DebugResult>} Recording projection.
 */
export const recordingRequest = (params, deps) => request({ action: 'record', params }, deps?.runtime);
/** Delete one stored recording.
 * @param {string} id Recording identity.
 * @param {{ runtime?: object }} [deps] Runtime override.
 * @returns {Promise<object>} Empty acknowledgement.
 */
export const deleteRecording = (id, deps) => request({ action: 'delete', run_id: id }, deps?.runtime);

/** Open the debug page, optionally focused on a session and run.
 * @param {string} [sessionId] Session to preselect.
 * @param {string} [runId] Recording to preselect.
 * @param {{ runtime?: object, tabs?: object }} [deps] Surface overrides.
 */
export function openDebugPage(sessionId, runId, deps = {}) {
  const runtime = deps.runtime ?? globalThis.chrome?.runtime;
  const tabs = deps.tabs ?? globalThis.chrome?.tabs;
  const url = new URL(runtime.getURL('debug.html'));
  if (sessionId) url.searchParams.set('session', sessionId);
  if (runId) url.searchParams.set('run', runId);
  void tabs.create({ url: url.href });
}
