import { createContext, createSignal, onCleanup, useContext, type Accessor, type JSX } from 'solid-js';
import { NARROW_SCREEN_PX } from '../preferences/devicePreferences.js';

/** Phone-sized screens get the drawer layout, a short status bar and touch-sized targets. */
export const NARROW_QUERY = `(max-width: ${NARROW_SCREEN_PX - 0.02}px)`;

/** Touch-sized rows and buttons on narrow screens (40 px minimum target). */
export const TOUCH_TARGET_PX = 40;

/** Follows the window width; without `matchMedia` (tests, old engines) the layout is wide. */
export function createNarrowScreen(): Accessor<boolean> {
  if (typeof matchMedia !== 'function') return () => false;
  const query = matchMedia(NARROW_QUERY);
  const [narrow, setNarrow] = createSignal(query.matches);
  const onChange = (event: MediaQueryListEvent): void => {
    setNarrow(event.matches);
  };
  query.addEventListener('change', onChange);
  onCleanup(() => query.removeEventListener('change', onChange));
  return narrow;
}

export const ScreenContext = createContext<Accessor<boolean>>(() => false);

/** Whether the app is laid out for a narrow screen. */
export const useNarrowScreen = (): Accessor<boolean> => useContext(ScreenContext);

/**
 * Touch sizing for fields and buttons on narrow screens: 40 px targets, and 16 px text, below
 * which iOS zooms into a focused field.
 */
export const touchSized = (style: JSX.CSSProperties, narrow: boolean): JSX.CSSProperties =>
  narrow ? { ...style, 'font-size': '16px', 'min-height': `${TOUCH_TARGET_PX}px` } : style;
