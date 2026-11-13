import React from 'react';

/**
 * Props for the fallback page-input blocker.
 *
 * @typedef {object} ControlInputBlockerProps
 * @property {boolean} automationBypass Whether automated input may pass the
 * blocker. When true the element stays mounted but ignores pointer events.
 */

/**
 * Fallback page-input blocker shown while no cooperation state exists.
 *
 * Blocks pointer, wheel and touch scrolling until a real cooperation state
 * takes over.
 *
 * @param {ControlInputBlockerProps} props
 * @returns {object}
 */
export function ControlInputBlocker({ automationBypass }) {
  const blockerRef = React.useRef(null);

  React.useEffect(() => {
    if (automationBypass) return;
    const blocker = blockerRef.current;
    const stopScroll = (event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    blocker?.addEventListener('wheel', stopScroll, { passive: false });
    blocker?.addEventListener('touchmove', stopScroll, { passive: false });
    window.addEventListener('wheel', stopScroll, { capture: true, passive: false });
    window.addEventListener('touchmove', stopScroll, { capture: true, passive: false });
    return () => {
      blocker?.removeEventListener('wheel', stopScroll);
      blocker?.removeEventListener('touchmove', stopScroll);
      window.removeEventListener('wheel', stopScroll, { capture: true });
      window.removeEventListener('touchmove', stopScroll, { capture: true });
    };
  }, [automationBypass]);

  const stopPointer = (event) => {
    if (automationBypass) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return React.createElement('div', {
    ref: blockerRef,
    'data-slot': 'control-overlay-blocker',
    'aria-hidden': 'true',
    onPointerDown: stopPointer,
    onClick: stopPointer,
    style: {
      position: 'fixed',
      inset: 0,
      zIndex: 2147483646,
      pointerEvents: automationBypass ? 'none' : 'auto',
      background: 'transparent',
    },
  });
}
