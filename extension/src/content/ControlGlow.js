import React from 'react';

/**
 * Decorative glow rendered behind the cooperation card.
 *
 * Purely presentational: no props, no pointer input, hidden from assistive
 * technology, and its animation is disabled by a reduced-motion preference.
 *
 * @returns {object}
 */
export function ControlGlow() {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement('style', null, `
      @keyframes bb-breathe {
        0%, 100% { opacity: 0; }
        50% { opacity: 1; }
      }
      .bb-control-glow-pulse {
        animation: bb-breathe 3s ease-in-out 2;
      }
      @media (prefers-reduced-motion: reduce) {
        .bb-control-glow-pulse { animation: none; }
      }
    `),
    React.createElement(
      'div',
      {
        'data-slot': 'control-overlay',
        'aria-hidden': 'true',
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 2147483646,
          pointerEvents: 'none',
          boxShadow: 'inset 0 0 20px 4px rgba(249,115,22,0.25)',
        },
      },
      React.createElement('div', {
        'data-slot': 'control-overlay-pulse',
        className: 'bb-control-glow-pulse',
        style: {
          position: 'absolute',
          inset: 0,
          boxShadow: 'inset 0 0 40px 8px rgba(249,115,22,0.5)',
          opacity: 0,
        },
      }),
    ),
  );
}
