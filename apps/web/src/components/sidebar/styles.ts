import { createSignal, type Accessor, type JSX } from 'solid-js';
import { TOUCH_TARGET_PX } from '../../layout/screen.js';
import { colorVar, type ThemeColors } from '../../theme/colorScheme.js';
import { BRAND_FAMILY, UI_FAMILY, UI_WEIGHT_VAR } from '../../theme/fonts.js';

const color = (name: keyof ThemeColors): string => `var(${colorVar(name)})`;

/**
 * Shared design tokens; components use inline styles only (no global CSS). Colors resolve to the
 * active theme's custom properties (see `applyColorScheme`).
 */
export const tokens = {
  rowHeight: 28,
  indent: 14,
  /** UI text: Plus Jakarta Sans at the theme's weight, falling back to the system font. */
  font: `var(${UI_WEIGHT_VAR}, 500) 13px "${UI_FAMILY}", system-ui, -apple-system, "Segoe UI", sans-serif`,
  /** The "AnkyLock" wordmark only; callers set the size. */
  brandFamily: `"${BRAND_FAMILY}", "${UI_FAMILY}", system-ui, sans-serif`,
  /** Headings and emphasis. */
  strongWeight: '600',
  background: color('background'),
  surface: color('surface'),
  text: color('text'),
  muted: color('muted'),
  border: color('border'),
  rowBorder: color('rowBorder'),
  hoverBackground: color('hoverBackground'),
  activeBackground: color('activeBackground'),
  accent: color('accent'),
  danger: color('danger'),
  overlay: color('overlay'),
  shadow: color('shadow'),
} as const;

/** Space around each framed sidebar item, inside its fixed-height row. */
export const ROW_GAP_PX = 2;

/** Height of a sidebar item's row; on touch screens the item itself stays 40 px tall. */
export const itemRowHeight = (narrow: boolean): number => (narrow ? TOUCH_TARGET_PX + 2 * ROW_GAP_PX : tokens.rowHeight);

/** Plain row: headers and toolbars in the sidebar. */
export function rowStyle(depth: number, height: number = tokens.rowHeight): JSX.CSSProperties {
  return {
    display: 'flex',
    'align-items': 'center',
    gap: '4px',
    height: `${height}px`,
    'padding-left': `${8 + depth * tokens.indent}px`,
    'padding-right': '8px',
    font: tokens.font,
    cursor: 'pointer',
    'white-space': 'nowrap',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'user-select': 'none',
  };
}

export interface ItemState {
  readonly active?: boolean;
  readonly hovered?: boolean;
}

/**
 * A category, folder or note: an outlined box inset in its row, indented by depth so nesting
 * reads as a tree. Selected items get the accent outline; hover only tints the background.
 */
export function itemStyle(depth: number, state: ItemState, rowHeight: number = tokens.rowHeight): JSX.CSSProperties {
  return {
    ...rowStyle(0, rowHeight - 2 * ROW_GAP_PX),
    'box-sizing': 'border-box',
    margin: `${ROW_GAP_PX}px 6px ${ROW_GAP_PX}px ${6 + depth * tokens.indent}px`,
    'padding-left': '7px',
    border: `1px solid ${state.active ? tokens.accent : tokens.rowBorder}`,
    'border-radius': '5px',
    background: state.active ? tokens.activeBackground : state.hovered ? tokens.hoverBackground : 'transparent',
    color: tokens.text,
  };
}

/** Mouse hover for inline-styled rows (no stylesheet, so no `:hover`); touch never hovers. */
export function createHover(): readonly [Accessor<boolean>, Pick<JSX.HTMLAttributes<HTMLElement>, 'onPointerEnter' | 'onPointerLeave'>] {
  const [hovered, setHovered] = createSignal(false);
  return [
    hovered,
    {
      onPointerEnter: (event: PointerEvent) => setHovered(event.pointerType === 'mouse'),
      onPointerLeave: () => setHovered(false),
    },
  ];
}
