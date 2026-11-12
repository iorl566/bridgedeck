import { shareScreencasts } from '../browser-driver/screencast-coordinator.js';

/** Request-scoped input leases and a final fence at native dispatch. */
export function guardedRunner(cdp, options = {}) {
  const { prepare, dispatch, verifyPointerTarget, beginDomMutation, detach } = options;
  const leases = new Map();
  const attachments = new Map();
  const cleanupSend = (target, method, params) => {
    if (!['Runtime.callFunctionOn', 'Runtime.releaseObjectGroup'].includes(method)) throw new Error('Resource cleanup cannot dispatch page input');
    if (!attachments.has(target.tabId)) throw new Error('No resources owned on this tab');
    return cdp.sendGuarded
      ? cdp.sendGuarded(target, method, params, { attachmentId: attachments.get(target.tabId) })
      : target.sessionId && cdp.sendToTarget
        ? cdp.sendToTarget(target, method, params)
        : cdp.send(target.tabId, method, params);
  };
  const resourceCleanup = {
    send: (tabId, method, params) => cleanupSend({ tabId }, method, params),
    sendToTarget: cleanupSend,
  };
  const send = async (target, method, params, guard) => {
    const p = params;
    const mouse = method === 'Input.dispatchMouseEvent';
    const key = method === 'Input.dispatchKeyEvent';
    const focus = method === 'Emulation.setFocusEmulationEnabled';
    const drag = method === 'Input.dispatchDragEvent';
    const cancelDrag = method === 'Input.cancelDragging';
    const chooser = method === 'Page.setInterceptFileChooserDialog';
    const identity = `${target.tabId}:${target.sessionId ?? ''}:${cancelDrag ? 'mouse:left' : chooser ? 'chooser' : drag ? 'drag' : focus ? 'focus' : mouse ? 'mouse:' + String(p?.button) : 'key:' + String(p?.key)}`;
    const release = (cancelDrag || (mouse && p?.type === 'mouseReleased') || (key && p?.type === 'keyUp') || (focus && p?.enabled === false) || (chooser && p?.enabled === false) || (drag && p?.type === 'dragCancel')) && leases.has(identity);
    const input = mouse && p?.type === 'mousePressed'
      ? { type: 'pointerdown', x: Number(p.x), y: Number(p.y) }
      : mouse && p?.type === 'mouseWheel'
        ? { type: 'wheel', x: Number(p.x), y: Number(p.y) }
        : key && ['keyDown', 'rawKeyDown', 'char'].includes(String(p?.type))
          ? { type: p?.type === 'char' ? 'keypress' : 'keydown', key: String(p?.key ?? ''), ...(p?.type === 'keyDown' && typeof p.text === 'string' && p.text.length > 0 ? { keypress: true } : {}) }
          : method === 'Input.insertText'
            ? { type: 'beforeinput', text: String(p?.text ?? ''), id: crypto.randomUUID() }
            : undefined;
    if (input && input.type !== 'beforeinput') {
      input.timestamp = Date.now();
      params = { ...params, timestamp: input.timestamp / 1000 };
    }
    const effect = method.startsWith('Input.') || method === 'Runtime.callFunctionOn' || (method === 'Runtime.evaluate' && options.scriptedEffect === true) || method === 'DOM.setFileInputFiles' || chooser || method === 'DOM.focus' || method === 'DOM.scrollIntoViewIfNeeded' || method.startsWith('Emulation.') || ['Page.navigate', 'Page.navigateToHistoryEntry', 'Page.reload'].includes(method);
    if (!prepare && effect && !['Runtime.callFunctionOn', 'Runtime.evaluate'].includes(method)) throw new Error('Shared-tab observation cannot dispatch browser input');
    const check = () => {
      if (effect && !release) dispatch?.(!!input || method === 'Input.insertText' || method === 'DOM.setFileInputFiles' || drag, method);
      if (!attachments.has(target.tabId)) attachments.set(target.tabId, cdp.getAttachmentId?.(target.tabId));
      guard?.onDispatch?.();
      if (input?.type === 'pointerdown' || input?.type === 'keydown' || (focus && p?.enabled === true) || (chooser && p?.enabled === true) || (drag && p?.type === 'dragEnter')) leases.set(identity, cdp.getAttachmentId?.(target.tabId));
      if (release && !cancelDrag) leases.delete(identity);
    };
    const sendNative = () => {
      if (cdp.sendGuarded) return cdp.sendGuarded(target, method, params, { ...guard, ...(release ? { signal: undefined, attachmentId: leases.get(identity) } : {}), onDispatch: check });
      check();
      return target.sessionId && cdp.sendToTarget ? cdp.sendToTarget(target, method, params) : cdp.send(target.tabId, method, params);
    };
    try {
      if ((effect && !release) || method === 'DOM.getBoxModel') await prepare?.(input, method);
      return await sendNative();
    } finally {
      if (input?.type === 'beforeinput') await options.finishInput?.(input);
    }
  };
  const runner = new Proxy(cdp, {
    get(target, key, receiver) {
      if (key === 'resourceCleanup') return resourceCleanup;
      if (key === 'runBrowserMutation') return async (operation) => {
        if (!prepare) throw new Error('Shared-tab observation cannot mutate the browser');
        await beginDomMutation?.();
        await prepare();
        dispatch?.(true, 'Browser.mutate');
        return operation();
      };
      if (key === 'beginDomMutation') return beginDomMutation;
      if (key === 'verifyPointerTarget') return verifyPointerTarget;
      if (key === 'detach' && detach) return detach;
      if (['acquireBackgroundExecution', 'ownsBackgroundExecution', 'restoreBackgroundExecution'].includes(String(key))) return undefined;
      if (key === 'send') return (tabId, method, params) => send({ tabId }, method, params);
      if (key === 'sendToTarget' || key === 'sendGuarded') return send;
      const value = Reflect.get(target, key);
      if (['setDeviceMetricsOverride', 'clearDeviceMetricsOverride', 'setUserAgentOverride', 'setTouchEmulationEnabled'].includes(String(key))) return typeof value === 'function' ? value.bind(receiver) : value;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  shareScreencasts(cdp, runner);
  return runner;
}
