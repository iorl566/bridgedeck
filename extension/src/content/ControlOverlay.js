/**
 * Cooperation control surface.
 *
 * The card is shared by two states: the fallback card shown while no cooperation
 * state exists (page input blocked, stop available) and the toolbar shown while
 * a session is being cooperatively controlled (status, hand-back action, stop,
 * minimize). When minimized, only the expand affordance renders.
 */
import React from 'react';
import {
  RiAlertLine, RiArrowLeftSLine, RiCursorLine, RiHand, RiPauseLine,
  RiPlayLine, RiRefreshLine, RiStopLine, RiSubtractLine, RiTimeLine,
} from '@remixicon/react';
import { COOPERATION_CONTROL } from '../cooperation/types.js';
import { controllerColor } from '../lib/controller-info.js';
import { useTranslation } from '../vendor/i18n-lite.js';
import { ControlGlow } from './ControlGlow.js';
import { ControlInputBlocker } from './ControlInputBlocker.js';

const h = React.createElement;
const logoUrl = new URL('../assets/logo.png', import.meta.url).href;
/** Icon per cooperation mode; every mode value needs an entry (`Record<string, object>`). */
const statusIcons = {
  ready: RiCursorLine,
  acting: RiCursorLine,
  human: RiHand,
  held: RiPauseLine,
  yielding: RiTimeLine,
  syncing: RiRefreshLine,
  unavailable: RiAlertLine,
};

/**
 * Cooperation state mirrored into the overlay.
 *
 * `revision` is echoed in control messages so the background can reject stale
 * hold/resume actions.
 *
 * @typedef {object} CooperationView
 * @property {number} revision Monotonic revision used to reject stale control messages.
 * @property {'ready'|'acting'|'human'|'held'|'yielding'|'syncing'|'unavailable'} mode
 * @property {boolean} [editing] Whether the human is editing a field right now.
 * @property {{ x: number, y: number, expires: number }} [target] Agent cursor target and its expiry in epoch ms.
 */

/**
 * @typedef {object} ControllerInfo
 * @property {string} name Display name of the controlling agent.
 * @property {string} [project] Project label, rendered only when a session is known.
 * @property {string} [color] Optional explicit accent color.
 */

/**
 * @typedef {object} ControlOverlayProps
 * @property {string | null} [sessionId] Active cooperation session id.
 * @property {ControllerInfo} [controller] Controlling agent metadata.
 * @property {boolean} visible Host-level visibility; hidden renders nothing.
 * @property {CooperationView} [state] Current cooperation view, absent for the fallback card.
 * @property {boolean} interrupting Whether an interrupt request is in flight.
 * @property {boolean} automationBypass Whether automated input may pass the page blocker.
 * @property {boolean} [minimized] Whether the card is collapsed to its expand affordance.
 * @property {(minimized: boolean) => void} [onMinimizedChange] Collapse/expand request.
 * @property {() => void} onInterrupt Stop-all request.
 */

/**
 * Viewport-coordinate cursor marker for the controlling agent.
 *
 * @typedef {object} AgentCursorTarget
 * @property {number} x Viewport X in CSS pixels.
 * @property {number} y Viewport Y in CSS pixels.
 * @property {number} expires Epoch ms after which the marker is stale.
 */

/**
 * Props for the agent cursor marker.
 *
 * @typedef {object} AgentTargetProps
 * @property {AgentCursorTarget} [target] Cursor target; absent hides the marker.
 * @property {string} [name] Label rendered next to the marker.
 */

/**
 * Primary control action forwarded to the background.
 *
 * @typedef {'hold' | 'resume'} ControlOverlayAction
 */

/**
 * Agent cursor marker pinned to viewport coordinates until the deadline carried
 * by the target passes.
 *
 * @param {AgentTargetProps} props
 * @returns {object | null}
 */
function AgentTarget({ target, name = 'Agent' }) {
  const [expired, setExpired] = React.useState(false);
  /** Expire the marker when its deadline passes; a new target resets the timer. */
  React.useEffect(() => {
    setExpired(false);
    if (!target) return undefined;
    const timer = setTimeout(() => setExpired(true), Math.max(0, target.expires - Date.now()));
    return () => clearTimeout(timer);
  }, [target]);
  if (!target || expired || target.expires <= Date.now()) return null;
  return h('div', { className: 'bb-cooperation-target', 'aria-hidden': 'true', style: { left: target.x, top: target.y } }, h('span', null, name));
}

/**
 * Render the cooperation card.
 *
 * Semantics kept from the reference: hidden renders nothing; without a state the
 * page blocker stays active unless automation bypass is granted; with a state the
 * primary action holds or resumes according to mode, and is disabled while a
 * message is pending or while the agent is yielding; the stop button is disabled
 * only when there is no state and an interrupt is already in flight.
 *
 * @param {ControlOverlayProps} props
 * @returns {object | null}
 */
export function ControlOverlay({ sessionId, controller, visible, state, interrupting, automationBypass, minimized = false, onMinimizedChange, onInterrupt }) {
  const { t } = useTranslation('extension');
  /** True while a hold/resume message is in flight (`boolean`); gates the primary action. */
  const [pending, setPending] = React.useState(false);
  if (!visible) return null;
  // Hold/resume round-trips through the background; `pending` only gates the
  // hand-back action, stop stays available while the message is in flight.
  /**
   * Ask the background to hold or resume the cooperation session.
   *
   * The message echoes `state.revision` so stale actions are rejected.
   *
   * @param {ControlOverlayAction} action Requested transition.
   * @returns {Promise<void>}
   */
  const control = async (action) => {
    if (!state) return;
    setPending(true);
    try {
      await chrome.runtime.sendMessage({ kind: COOPERATION_CONTROL, revision: state.revision, action });
    } finally {
      setPending(false);
    }
  };
  /** @type {string | undefined} Status key for i18n; `editing` while the human edits a field. */
  const status = state?.editing && state.mode === 'human' ? 'editing' : state?.mode;
  /** True when the primary action hands control back to the agent (`boolean`). */
  const resuming = state?.mode === 'held' || state?.mode === 'human';
  /** Icon component for the current cooperation mode. */
  const StatusIcon = state ? statusIcons[state.mode] : RiCursorLine;
  /** True when stop is the only action left and its request is in flight (`boolean`). */
  const stopping = !state && interrupting;
  /** Icon for the hold/resume action. */
  const ActionIcon = resuming ? RiPlayLine : RiPauseLine;
  /** Localized label for the hold/resume action, naming the controller when known. */
  const actionLabel = controller
    ? t(resuming ? 'controlOverlay.resumeController' : 'controlOverlay.holdController', { name: controller.name })
    : t(resuming ? 'cooperation.resume' : 'cooperation.hold');

  /** Brand row: controller identity with its accent color, plus the state badge. */
  const header = h('div', { className: 'bb-cooperation-header' },
    h('span', { className: 'bb-cooperation-brand' },
      h('img', { src: logoUrl, alt: '' }),
      controller
        ? h(React.Fragment, null,
          h('span', { className: 'bb-controller-color', 'aria-hidden': 'true', style: { backgroundColor: controllerColor(sessionId ?? '', controller) } }),
          h('bdi', { className: 'bb-controller-name', title: controller.name }, controller.name))
        : t('popup.brandName')),
    h('span', { className: 'bb-cooperation-badge' }, t('cooperation.label')));

  /** Project and session identifiers, rendered only while a session is active. */
  const details = sessionId
    ? h('dl', { className: 'bb-controller-details' },
      controller?.project ? h('div', null, h('dt', null, t('controlOverlay.project')), h('dd', null, h('bdi', null, controller.project))) : null,
      h('div', null, h('dt', null, t('controlOverlay.session')), h('dd', null, h('bdi', null, sessionId))))
    : null;

  /** Status icon, current mode text and its hint, announced politely. */
  const body = h('div', { className: 'bb-cooperation-body' },
    h('span', { className: 'bb-cooperation-icon', 'aria-hidden': 'true' }, h(StatusIcon, { size: 20 })),
    h('div', { className: 'bb-cooperation-copy', role: 'status', 'aria-live': 'polite' },
      h('div', { className: 'bb-cooperation-status' },
        h('span', { className: 'bb-cooperation-dot', 'aria-hidden': 'true' }),
        h('span', null, status ? t(`cooperation.${status}`) : t('controlOverlay.status'))),
      status ? h('span', { className: 'bb-cooperation-hint' }, t(`cooperation.hints.${status}`)) : null));

  /** Hold/resume and stop buttons; the primary action is absent without a state. */
  const actions = h('div', { className: 'bb-cooperation-actions' },
    state ? h('button', { className: 'bb-cooperation-primary', type: 'button', disabled: pending || state.mode === 'yielding', onClick: () => void control(resuming ? 'resume' : 'hold') },
      h(ActionIcon, { size: 16, 'aria-hidden': 'true' }),
      h('span', { className: 'bb-controller-action', title: actionLabel }, actionLabel)) : null,
    h('button', { className: 'bb-cooperation-stop', 'data-slot': 'control-overlay-stop-all', type: 'button', disabled: stopping, onClick: onInterrupt },
      h(RiStopLine, { size: 16, 'aria-hidden': 'true' }),
      t(stopping ? 'controlOverlay.interrupting' : 'cooperation.stop')));

  /** Collapse control that keeps the card's stop action reachable as an affordance. */
  const minimize = h('button', { className: 'bb-cooperation-minimize', type: 'button', 'aria-label': t('controlOverlay.minimize'), 'aria-expanded': true, title: t('controlOverlay.minimize'), onClick: () => onMinimizedChange?.(true) },
    h(RiSubtractLine, { size: 16, 'aria-hidden': 'true' }));

  /** Expand control rendered in place of the card while minimized. */
  const expand = h('button', { className: 'bb-cooperation-expand', type: 'button', 'aria-label': t('controlOverlay.expand'), 'aria-expanded': false, title: t('controlOverlay.expand'), onClick: () => onMinimizedChange?.(false) },
    h(RiArrowLeftSLine, { size: 20, 'aria-hidden': 'true' }));

  /** Card root; `data-slot` distinguishes the cooperation toolbar from the fallback card. */
  const card = h('div', {
    className: 'bb-cooperation',
    'data-slot': state ? 'cooperation-toolbar' : 'control-overlay-card',
    'data-mode': state?.mode,
    'data-minimized': minimized || undefined,
    role: 'toolbar',
    'aria-label': t('cooperation.label'),
    onPointerDown: (event) => { if (state) event.preventDefault(); },
  }, minimized ? expand : h(React.Fragment, null,
    h('div', { className: 'bb-cooperation-details' }, header, details, body),
    actions,
    minimize));

  return h(React.Fragment, null,
    h(ControlGlow),
    !state ? h(ControlInputBlocker, { automationBypass }) : null,
    h(AgentTarget, { target: state?.target, name: controller?.name }),
    card);
}
