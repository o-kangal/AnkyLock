import { onCleanup, onMount, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { tokens } from './sidebar/styles.js';

/** Viewport position; the panel is clamped so it never leaves the window. */
export interface PopoverPosition {
  readonly x: number;
  readonly y: number;
}

export interface PopoverProps {
  readonly onClose: () => void;
  readonly at: PopoverPosition;
  /** `above`: the panel's bottom edge sits at `at.y` (for anchors at the bottom of the window). */
  readonly placement?: 'below' | 'above';
  readonly width: number;
  readonly style?: JSX.CSSProperties;
  readonly role?: 'dialog' | 'menu';
  readonly label?: string;
  readonly children: JSX.Element;
}

const MARGIN = 8;

/**
 * Floating panel that closes on Escape or a click outside it. It renders in a Portal on <body>
 * with fixed positioning: inside the sidebar, WebKit composites the scrolling list on its own
 * layer and paints it over the panel regardless of z-index.
 */
export function Popover(props: PopoverProps): JSX.Element {
  let panel!: HTMLDivElement;

  onMount(() => {
    const onPointerDown = (event: MouseEvent): void => {
      if (!panel.contains(event.target as Node)) props.onClose();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onClose();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    onCleanup(() => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    });
  });

  const left = (): number => Math.max(MARGIN, Math.min(props.at.x, window.innerWidth - props.width - MARGIN));

  return (
    <Portal>
      <div
        ref={panel}
        role={props.role ?? 'dialog'}
        aria-label={props.label}
        style={{
          position: 'fixed',
          left: `${left()}px`,
          ...(props.placement === 'above'
            ? { bottom: `${Math.max(MARGIN, window.innerHeight - props.at.y)}px` }
            : { top: `${Math.max(MARGIN, props.at.y)}px` }),
          width: `${props.width}px`,
          'box-sizing': 'border-box',
          'max-height': `calc(100vh - ${2 * MARGIN}px)`,
          'overflow-y': 'auto',
          background: 'Canvas',
          color: 'CanvasText',
          border: `1px solid ${tokens.border}`,
          'box-shadow': '0 4px 12px rgba(0, 0, 0, 0.18)',
          'z-index': '1000',
          font: tokens.font,
          ...props.style,
        }}
      >
        {props.children}
      </div>
    </Portal>
  );
}
