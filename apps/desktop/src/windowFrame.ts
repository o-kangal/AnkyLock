import type { JSX } from 'solid-js';
import type { tokens } from '@ankylock/web/workspace';

/** The design tokens the frame uses (passed in, so this module stays free of UI imports). */
export type FrameTokens = Pick<typeof tokens, 'background' | 'border' | 'radiusPanel'>;

/**
 * Whether the app draws the window's rounded corners itself. The window is frameless, so the OS
 * draws square ones. On Linux the window is transparent (`tauri.linux.conf.json`) and the app
 * paints a rounded frame inside it. Windows 11 rounds frameless windows itself; macOS follows
 * with the signed builds (Task 13).
 */
export const drawsWindowCorners = (userAgent: string = navigator.userAgent): boolean =>
  /Linux/.test(userAgent) && !/Android/.test(userAgent);

/** Marks the page so the theme leaves its background transparent (see `applyColorScheme`). */
export const TRANSPARENT_WINDOW_ATTRIBUTE = 'data-transparent-window';

/**
 * The app's frame: rounded with a hairline border while the window floats; square and
 * borderless when maximized or fullscreen, so the app fills the screen edge to edge.
 */
export function frameStyle(theme: FrameTokens, ownCorners: boolean, filled: boolean): JSX.CSSProperties {
  const rounded = ownCorners && !filled;
  return {
    display: 'flex',
    'flex-direction': 'column',
    height: '100%',
    'box-sizing': 'border-box',
    overflow: 'hidden',
    background: theme.background,
    'border-radius': rounded ? theme.radiusPanel : '0',
    border: rounded ? `1px solid ${theme.border}` : 'none',
  };
}

/** The parts of a Tauri window the frame follows; injectable for tests. */
export interface FrameWindow {
  isMaximized(): Promise<boolean>;
  isFullscreen(): Promise<boolean>;
  onResized(handler: () => void): Promise<() => void>;
}

/** Reports whether the window fills the screen now and after every resize; returns a stop function. */
export function watchWindowFill(window: FrameWindow, onChange: (filled: boolean) => void): () => void {
  let stopped = false;
  const check = async (): Promise<void> => {
    const [maximized, fullscreen] = await Promise.all([window.isMaximized(), window.isFullscreen()]);
    if (!stopped) onChange(maximized || fullscreen);
  };
  void check();
  const unlisten = window.onResized(() => void check());
  return () => {
    stopped = true;
    void unlisten.then((stop) => stop());
  };
}
