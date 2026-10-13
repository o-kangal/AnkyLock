import type { JSX } from 'solid-js';

/** Shared design tokens; components use inline styles only (no global CSS). */
export const tokens = {
  rowHeight: 24,
  indent: 14,
  font: '13px system-ui, -apple-system, "Segoe UI", sans-serif',
  muted: '#6b6b6b',
  activeBackground: 'rgba(0, 120, 212, 0.14)',
  border: 'rgba(127, 127, 127, 0.25)',
  danger: '#b3261e',
} as const;

export function rowStyle(depth: number, active = false): JSX.CSSProperties {
  return {
    display: 'flex',
    'align-items': 'center',
    gap: '4px',
    height: `${tokens.rowHeight}px`,
    'padding-left': `${8 + depth * tokens.indent}px`,
    'padding-right': '8px',
    font: tokens.font,
    cursor: 'pointer',
    'white-space': 'nowrap',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'user-select': 'none',
    background: active ? tokens.activeBackground : 'transparent',
  };
}
