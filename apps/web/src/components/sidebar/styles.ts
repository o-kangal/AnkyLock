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
  /** Corner radii: rows, buttons and fields; popovers, menus and dialogs; tabs and small chips. */
  radiusControl: '8px',
  radiusPanel: '12px',
  radiusChip: '6px',
  background: color('background'),
  surface: color('surface'),
  text: color('text'),
  muted: color('muted'),
  border: color('border'),
  rowBorder: color('rowBorder'),
  fieldBorder: color('fieldBorder'),
  fieldBackground: color('fieldBackground'),
  buttonBackground: color('buttonBackground'),
  hoverBackground: color('hoverBackground'),
  activeBackground: color('activeBackground'),
  accent: color('accent'),
  danger: color('danger'),
  overlay: color('overlay'),
  shadow: color('shadow'),
} as const;

/**
 * Fields and buttons drawn by the app instead of the platform: native controls ignore a radius,
 * and WebKit falls back to bevelled borders when given one. Focus rings follow the corners.
 */
export const fieldStyle: JSX.CSSProperties = {
  appearance: 'none',
  border: `1px solid ${tokens.fieldBorder}`,
  'border-radius': tokens.radiusControl,
  background: tokens.fieldBackground,
  color: tokens.text,
};

export const buttonStyle: JSX.CSSProperties = { ...fieldStyle, background: tokens.buttonBackground, cursor: 'pointer' };

/** A field-styled `<select>`, with its arrow drawn back in (`appearance: none` removes it). */
export const selectStyle: JSX.CSSProperties = {
  ...fieldStyle,
  'background-image': `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%23888' stroke-width='1.5'/%3E%3C/svg%3E")`,
  'background-repeat': 'no-repeat',
  'background-position': 'right 10px center',
  'padding-right': '28px',
};

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
    'border-radius': tokens.radiusControl,
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
