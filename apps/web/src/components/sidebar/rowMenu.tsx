import type { JSX } from 'solid-js';
import { t } from '../../i18n/index.js';
import { tokens } from './styles.js';

type PointerHandlers = Pick<JSX.HTMLAttributes<HTMLElement>, 'onPointerDown' | 'onPointerUp' | 'onPointerCancel' | 'onPointerMove'>;

const LONG_PRESS_MS = 500;
/** A finger that drifts further than this is scrolling, not pressing. */
const MOVE_TOLERANCE_PX = 10;

/** Swallows the click that ends a long press, so the row isn't also activated. */
function swallowNextClick(): void {
  const swallow = (event: MouseEvent): void => {
    event.stopPropagation();
    event.preventDefault();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  // If the press ends without a click, stop listening before an unrelated click arrives.
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 1_000);
}

/**
 * Opens a row's menu on a touch long press. iOS Safari sends no `contextmenu` for it, and HTML5
 * drag-and-drop doesn't work on touch, so this (with "Move to…") is how touch users reach row
 * actions.
 */
export function longPress(open: (event: MouseEvent) => void): PointerHandlers {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start: { x: number; y: number } | null = null;
  const cancel = (): void => {
    clearTimeout(timer);
    start = null;
  };
  return {
    onPointerDown: (event) => {
      if (event.pointerType !== 'touch') return;
      start = { x: event.clientX, y: event.clientY };
      const { clientX, clientY } = event;
      timer = setTimeout(() => {
        swallowNextClick();
        open(new MouseEvent('contextmenu', { clientX, clientY }));
      }, LONG_PRESS_MS);
    },
    onPointerMove: (event) => {
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
  };
}

/** "⋯" at the end of a row on narrow screens: the visible way to the row's menu. */
export function RowMenuButton(props: { readonly label: string; readonly onOpen: (event: MouseEvent) => void }): JSX.Element {
  return (
    <button
      type="button"
      aria-label={t('menu.actionsFor', { name: props.label })}
      style={{
        'margin-left': 'auto',
        'min-width': '40px',
        height: '100%',
        border: 'none',
        background: 'transparent',
        color: tokens.muted,
        font: tokens.font,
        'font-size': '18px',
        cursor: 'pointer',
      }}
      onClick={(event) => {
        event.stopPropagation();
        props.onOpen(event);
      }}
    >
      ⋯
    </button>
  );
}
