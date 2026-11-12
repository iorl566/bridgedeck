import React from 'react';
import { RiCloseLine } from '@remixicon/react';
import { useTranslation } from '../vendor/i18n-lite.js';

const h = React.createElement;
const logoUrl = new URL('../assets/logo.png', import.meta.url).href;

/** Matches the progress bar / countdown ring transition duration (duration-1000). */
const PROGRESS_TRANSITION_MS = 1000;

/**
 * One pending tab-borrow request.
 *
 * The request for the tab currently in view renders as a modal with a countdown;
 * the rest render as stacked toasts. `timeoutMs` is the whole ask window and the
 * item auto-denies when it reaches zero without an answer.
 *
 * @typedef {Object} BorrowRequestData
 * @property {string} id
 * @property {boolean} isActiveTab
 * @property {string} tabTitle
 * @property {number} timeoutMs
 * @property {() => void} onAllow
 * @property {(timedOut?: boolean) => void} onDeny
 */

/**
 * Props for the borrow confirmation overlay.
 *
 * @typedef {object} BorrowConfirmationOverlayProps
 * @property {BorrowRequestData[]} requests Pending tab-borrow requests; the
 * active-tab request renders as a modal and the rest render as toasts.
 */

/**
 * Props for the modal backdrop that dims the active tab.
 *
 * @typedef {object} BorrowBackdropProps
 * @property {React.ReactNode} children Modal card.
 */

/**
 * Props for the stack that holds inactive-tab toasts.
 *
 * @typedef {object} BorrowToastStackProps
 * @property {React.ReactNode} children Toast cards.
 */

/**
 * Props for one pending borrow request, rendered as a modal or a toast.
 *
 * @typedef {object} BorrowRequestItemProps
 * @property {BorrowRequestData} request
 * @property {boolean} isModal Modal on the request's own tab; toast on any other tab.
 */

/**
 * Props for the toast header row.
 *
 * @typedef {object} BorrowToastHeaderProps
 * @property {() => void} onDeny Dismiss the toast and deny the request.
 */

/**
 * Props for the remaining-time bar shown on a toast.
 *
 * @typedef {object} BorrowProgressBarProps
 * @property {number} progress Fraction of time left in the range 0..1.
 * @property {(event: { propertyName: string }) => void} [onProgressTransitionEnd]
 * Reports the transitioned CSS property so the caller can complete a timed-out deny once.
 */

/**
 * Props for the deny/allow button row.
 *
 * @typedef {object} BorrowActionButtonsProps
 * @property {() => void} onDeny
 * @property {() => void} onAllow
 * @property {string} [gapClass] Spacing utility applied to the row.
 */

/**
 * Props for the countdown ring shown in the modal.
 *
 * @typedef {object} BorrowCountdownRingProps
 * @property {number} progress Fraction of time left in the range 0..1.
 * @property {number} seconds Whole seconds left, rendered in the ring.
 * @property {(propertyName: string) => void} [onProgressTransitionEnd]
 * Reports the transitioned CSS property so the caller can complete a timed-out deny once.
 */

/**
 * @param {BorrowConfirmationOverlayProps} props
 * @returns {object} Active-tab modal and any inactive-tab toasts.
 */
export function BorrowConfirmationOverlay({ requests }) {
  const activeRequest = requests.find((request) => request.isActiveTab);
  const inactiveRequests = requests.filter((request) => !request.isActiveTab);
  return h(React.Fragment, null,
    activeRequest ? h(BorrowBackdrop, null, h(BorrowRequestItem, { key: activeRequest.id, request: activeRequest, isModal: true })) : null,
    inactiveRequests.length > 0
      ? h(BorrowToastStack, null, inactiveRequests.map((request) => h(BorrowRequestItem, { key: request.id, request, isModal: false })))
      : null);
}

/**
 * @param {BorrowBackdropProps} props
 * @returns {object}
 */
function BorrowBackdrop({ children }) {
  return h('div', { 'data-slot': 'borrow-confirmation-modal-backdrop', className: 'fixed inset-0 z-[2147483646] flex items-center justify-center bg-black/40 backdrop-blur-sm' }, children);
}
/**
 * @param {BorrowToastStackProps} props
 * @returns {object}
 */
function BorrowToastStack({ children }) {
  return h('div', { 'data-slot': 'borrow-confirmation-toast-stack', className: 'fixed top-4 right-4 z-[2147483647] flex flex-col gap-3' }, children);
}

/**
 * Countdown and settle state for one pending request.
 *
 * @param {BorrowRequestItemProps} props
 * @returns {object}
 */
function BorrowRequestItem({ request, isModal }) {
  const { t } = useTranslation('extension');
  /** Whole seconds requested, used as the countdown denominator (`number`). */
  const totalSeconds = Math.ceil(request.timeoutMs / 1000);
  /** Whole seconds left (`number`); reaching 0 starts the auto-deny handshake. */
  const [secondsLeft, setSecondsLeft] = React.useState(totalSeconds);
  /** True once the card has been answered (`boolean`); fades the card out. */
  const [exiting, setExiting] = React.useState(false);
  /** True after the countdown reaches 0 and before the deny is sent (`boolean`). */
  const [awaitingAutoDeny, setAwaitingAutoDeny] = React.useState(false);
  /** Guards against answering the same request twice (`boolean`). */
  const settledRef = React.useRef(false);
  /** Latest allow handler (`() => void`), kept current across re-renders. */
  const onAllowRef = React.useRef(request.onAllow);
  /** Latest deny handler (`(timedOut?: boolean) => void`), kept current across re-renders. */
  const onDenyRef = React.useRef(request.onDeny);
  onAllowRef.current = request.onAllow;
  onDenyRef.current = request.onDeny;

  /**
   * Settle the request as allowed, at most once, and start the exit fade.
   *
   * @returns {void}
   */
  const triggerAllow = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    setAwaitingAutoDeny(false);
    setExiting(true);
    onAllowRef.current();
  };
  /** @returns {void} */
  const handleAllow = () => {
    triggerAllow();
  };
  /**
   * Settle the request as denied, at most once, and start the exit fade.
   *
   * @param {boolean} [timedOut] True when the request timed out unanswered.
   * @returns {void}
   */
  const handleDeny = (timedOut = false) => {
    if (settledRef.current) return;
    settledRef.current = true;
    setAwaitingAutoDeny(false);
    setExiting(true);
    onDenyRef.current(timedOut);
  };

  /**
   * Tick the countdown once per second; at zero, hand over to the auto-deny
   * handshake instead of going negative.
   *
   * @returns {void}
   */
  React.useEffect(() => {
    if (secondsLeft <= 0) {
      if (!settledRef.current) setAwaitingAutoDeny(true);
      return undefined;
    }
    const id = setTimeout(() => setSecondsLeft((value) => value - 1), 1000);
    return () => clearTimeout(id);
  }, [secondsLeft]);

  /**
   * Prefer transitionend for visual sync, but fall back to a timer so
   * background tabs / suppressed CSS transitions still auto-deny.
   */
  React.useEffect(() => {
    if (!awaitingAutoDeny || settledRef.current) return undefined;
    const id = setTimeout(() => handleDeny(true), PROGRESS_TRANSITION_MS);
    return () => clearTimeout(id);
  }, [awaitingAutoDeny]);

  /** @type {number} Fraction of the timeout still remaining, in the range 0..1. */
  const progress = secondsLeft / totalSeconds;
  /** Tab title shortened for the toast body (`string`). */
  const truncatedTitle = request.tabTitle.length > 30 ? `${request.tabTitle.slice(0, 30)}…` : request.tabTitle;
  /** Opacity classes shared by the modal and toast cards (`string`). */
  const cardClass = `transition-opacity duration-150 ease-out ${exiting ? 'opacity-0' : 'opacity-100'}`;

  if (isModal) {
    return h('div', { 'data-slot': 'borrow-confirmation-modal', className: `flex w-[400px] flex-col gap-4 rounded-2xl bg-white px-7 pb-6 pt-7 shadow-[0_25px_50px_rgba(124,45,18,0.1)] ${cardClass}` },
      h('div', { className: 'flex items-center gap-2.5' },
        h('img', { src: logoUrl, alt: 'BridgeDeck', className: 'size-6 rounded' }),
        h('span', { className: 'text-base font-semibold text-[#111]' }, t('borrowConfirmation.title'))),
      h('p', { className: 'm-0 text-sm leading-relaxed text-[#555]' }, t('borrowConfirmation.body')),
      h('div', { className: 'flex items-center justify-center gap-3 py-2' },
        h(CountdownRing, {
          progress,
          seconds: secondsLeft,
          onProgressTransitionEnd: (propertyName) => {
            if (!awaitingAutoDeny || secondsLeft !== 0 || propertyName !== 'stroke-dashoffset') return;
            handleDeny(true);
          },
        }),
        h('span', { className: 'text-[13px] text-gray-500' }, t('borrowConfirmation.autoDeny', { count: secondsLeft }))),
      h(ActionButtons, { onDeny: () => handleDeny(), onAllow: handleAllow }));
  }

  return h('div', { 'data-slot': 'borrow-confirmation-toast', className: `flex w-80 flex-col rounded-xl border border-[#ffedd5] bg-[#FFFBF7] p-4 pb-3.5 shadow-[0_10px_40px_rgba(124,45,18,0.1)] ${cardClass}` },
    h(BorrowToastHeader, { onDeny: () => handleDeny() }),
    h('p', { className: 'mb-2.5 text-[13px] leading-relaxed text-[#555]' },
      t('borrowConfirmation.targetTab'),
      h('br'),
      h('span', { className: 'font-medium text-[#333]' }, `"${truncatedTitle}"`)),
    h(BorrowProgressBar, {
      progress,
      onProgressTransitionEnd: (event) => {
        if (!awaitingAutoDeny || secondsLeft !== 0 || event.propertyName !== 'width') return;
        handleDeny();
      },
    }),
    h(ActionButtons, { onDeny: () => handleDeny(), onAllow: handleAllow, gapClass: 'gap-2' }));
}

/**
 * @param {BorrowToastHeaderProps} props
 * @returns {object}
 */
function BorrowToastHeader({ onDeny }) {
  const { t } = useTranslation('extension');
  return h('div', { className: 'mb-2 flex items-center gap-2' },
    h('img', { src: logoUrl, alt: 'BridgeDeck', className: 'size-[18px] rounded' }),
    h('span', { className: 'flex-1 text-sm font-semibold text-[#111]' }, t('borrowConfirmation.titleInactive')),
    h('button', { type: 'button', 'data-slot': 'borrow-confirmation-deny-button', onClick: onDeny, className: 'cursor-pointer border-0 bg-transparent p-0.5 text-gray-500', 'aria-label': t('borrowConfirmation.deny') },
      h(RiCloseLine, { size: 16 })));
}

/**
 * @param {BorrowProgressBarProps} props
 * @returns {object}
 */
function BorrowProgressBar({ progress, onProgressTransitionEnd }) {
  return h('div', { className: 'mb-3 h-1 overflow-hidden rounded-sm bg-gray-100' },
    h('div', { className: 'h-full rounded-sm bg-orange-500 transition-[width] duration-1000 ease-linear', style: { width: `${progress * 100}%` }, onTransitionEnd: onProgressTransitionEnd }));
}

/**
 * @param {BorrowActionButtonsProps} props
 * @returns {object}
 */
function ActionButtons({ onDeny, onAllow, gapClass = 'gap-2.5' }) {
  const { t } = useTranslation('extension');
  return h('div', { className: `flex justify-end ${gapClass}` },
    h('button', { type: 'button', 'data-slot': 'borrow-confirmation-deny-button', onClick: onDeny, className: 'cursor-pointer rounded-lg border border-gray-200 bg-transparent px-4 py-2 text-[13px] font-medium text-gray-600' }, t('borrowConfirmation.deny')),
    h('button', { type: 'button', 'data-slot': 'borrow-confirmation-allow-button', onClick: onAllow, className: 'cursor-pointer rounded-lg border-0 bg-orange-500 px-4 py-2 text-[13px] font-semibold text-white' }, t('borrowConfirmation.allow')));
}

/**
 * @param {BorrowCountdownRingProps} props
 * @returns {object}
 */
function CountdownRing({ progress, seconds, onProgressTransitionEnd }) {
  const r = 28;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - progress);
  return h('svg', { width: 72, height: 72, className: '-rotate-90', 'aria-hidden': true },
    h('circle', { cx: 36, cy: 36, r, fill: 'none', stroke: '#f3f4f6', strokeWidth: 5 }),
    h('circle', {
      cx: 36, cy: 36, r, fill: 'none', stroke: '#f97316', strokeWidth: 5,
      strokeDasharray: circ, strokeDashoffset: offset, strokeLinecap: 'round',
      className: 'transition-[stroke-dashoffset] duration-1000 ease-linear',
      onTransitionEnd: (event) => onProgressTransitionEnd?.(event.propertyName),
    }),
    h('text', { x: 36, y: 36, textAnchor: 'middle', dominantBaseline: 'central', className: 'fill-[#111] text-xl font-bold', style: { transform: 'rotate(90deg)', transformOrigin: '36px 36px' } }, seconds));
}
