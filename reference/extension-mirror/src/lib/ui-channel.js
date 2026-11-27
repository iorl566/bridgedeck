import { uiError } from '../session-manager/ui-activity.js';

/**
 * Optional UI request channel for authenticated remote gateways.
 *
 * A gateway that renders its own view of a running task needs a small preview
 * and a focus action even while the session's tool queue is busy — during a
 * long navigation, or while a help request waits for the user. Those are
 * exactly the moments when ordinary tool calls cannot run because they are
 * serialized per session. The requests handled here are therefore answered
 * directly and never enter the tool dispatcher.
 *
 * Attach this listener before the transport listener so a `ui.*` frame is
 * consumed here rather than reported as an unknown method. Only authenticated
 * remote sockets carry the channel; a local socket keeps the native protocol
 * unchanged.
 *
 * @typedef {object} UiChannelHandlers
 * @property {(sessionId: string) => Promise<unknown>} focus
 *   Activate the task's own tab and raise its window; must never start a task.
 * @property {(sessionId: string) => Promise<unknown>} preview
 *   Return one downscaled frame of the task's own tab.
 *
 * @typedef {object} UiChannelSocket
 * @property {number} readyState  Socket state constant; sending is skipped unless open.
 * @property {(data: string) => void} send  Serialize one text frame.
 * @property {(type: string, listener: (event: { data: string, stopImmediatePropagation: () => void }) => void) => void} addEventListener
 *   Register a message listener that can stop later listeners for the same event.
 *
 * @typedef {object} UiChannelDeps
 * @property {number} [openState]  Ready-state value meaning "open"; defaults to 1 for tests.
 */

/**
 * Attach the UI request listener before the transport listener so a UI frame
 * is consumed here rather than reported as an unknown method.
 *
 * Frames that are not valid JSON, do not name a `ui.*` method, or lack a string
 * request id are ignored entirely and remain available to the transport
 * listener. A recognized frame is always consumed: it is stopped from reaching
 * later listeners first, then a missing `session_id` is answered with an
 * `invalid_params` error. Handler failures are serialized through the shared UI
 * error mapper, and replies are dropped when the socket is no longer open.
 *
 * @param {UiChannelSocket} socket  Socket to listen on.
 * @param {UiChannelHandlers} handlers  Focus and preview implementations.
 * @param {UiChannelDeps} [deps]  Test seams.
 * @returns {void}
 */
export function attachUiChannel(socket, handlers, deps = {}) {
  const openState = deps.openState ?? 1;
  socket.addEventListener('message', (event) => {
    let request;
    try {
      request = JSON.parse(event.data);
      if (!request || typeof request !== 'object') return;
    } catch { return; }
    const methods = {
      'ui.task_focus': (id) => handlers.focus(id),
      'ui.task_preview': (id) => handlers.preview(id),
    };
    if (typeof request.method !== 'string' || !Object.hasOwn(methods, request.method)) return;
    event.stopImmediatePropagation();
    if (typeof request.id !== 'string' || !request.id) return;
    const id = request.id;
    const sessionId = request.params?.session_id;
    /** Reply on the request's id, unless the socket closed meanwhile. */
    const send = (body) => {
      if (socket.readyState === openState) socket.send(JSON.stringify({ id, ...body }));
    };
    if (typeof sessionId !== 'string' || !sessionId) {
      send({ error: { code: 'invalid_params', message: 'session_id is required' } });
      return;
    }
    void Promise.resolve()
      .then(() => methods[request.method](sessionId))
      .then((result) => send({ result }), (error) => send({ error: uiError(error) }));
  });
}
