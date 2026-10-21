import { createContext, createSignal, onCleanup, useContext, type Accessor } from 'solid-js';
import type { ColorScheme } from '@ankylock/editor';
import { defaultStorage, readPreference, writePreference, type PreferenceStorage } from '../preferences/devicePreferences.js';
import { UI_WEIGHT_VAR, uiWeight } from './fonts.js';

export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];
export const THEME_KEY = 'ankylock.theme';

export interface ThemeColors {
  /** Editor and main panes; matches the editor's own background. */
  readonly background: string;
  /** Bars and the sidebar, one step off the background. */
  readonly surface: string;
  readonly text: string;
  readonly muted: string;
  /** Dividers between panes and bars. */
  readonly border: string;
  /** Outline of sidebar rows. */
  readonly rowBorder: string;
  /** Fields and buttons, drawn by the app so they take the radius scale. */
  readonly fieldBorder: string;
  readonly fieldBackground: string;
  readonly buttonBackground: string;
  readonly buttonHoverBackground: string;
  readonly hoverBackground: string;
  readonly activeBackground: string;
  readonly accent: string;
  readonly danger: string;
  readonly overlay: string;
  readonly shadow: string;
}

// Neutral greys matching the editor palettes (packages/editor theme.ts), one blue accent.
export const THEME_COLORS: Record<ColorScheme, ThemeColors> = {
  light: {
    background: '#ffffff',
    surface: '#f3f3f3',
    text: '#1f1f1f',
    muted: '#6b6b6b',
    border: '#dcdcdc',
    rowBorder: '#e1e1e1',
    fieldBorder: '#c4c4c4',
    fieldBackground: '#ffffff',
    buttonBackground: '#ececec',
    buttonHoverBackground: '#e0e0e0',
    hoverBackground: 'rgba(0, 0, 0, 0.05)',
    activeBackground: 'rgba(0, 120, 212, 0.14)',
    accent: '#0067c0',
    danger: '#b3261e',
    overlay: 'rgba(0, 0, 0, 0.3)',
    shadow: 'rgba(0, 0, 0, 0.18)',
  },
  dark: {
    background: '#1e1e1e',
    surface: '#252526',
    text: '#d4d4d4',
    muted: '#9d9d9d',
    border: '#3c3c3c',
    rowBorder: '#363636',
    fieldBorder: '#4a4a4a',
    fieldBackground: '#2a2a2b',
    buttonBackground: '#333334',
    buttonHoverBackground: '#3d3d3e',
    hoverBackground: 'rgba(255, 255, 255, 0.06)',
    activeBackground: 'rgba(55, 148, 255, 0.24)',
    accent: '#4fa3ff',
    danger: '#f28b82',
    overlay: 'rgba(0, 0, 0, 0.5)',
    shadow: 'rgba(0, 0, 0, 0.5)',
  },
};

/** CSS custom property holding each color; components use `var(...)` through `tokens`. */
export const colorVar = (name: keyof ThemeColors): string => `--al-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/**
 * Sets the palette as custom properties on the root element (inline, no stylesheet), plus
 * `color-scheme` so native controls and scrollbars match, and the browser's theme color. A root
 * marked `data-transparent-window` (the desktop app drawing its own rounded window) keeps a
 * transparent background.
 */
export function applyColorScheme(scheme: ColorScheme, root: HTMLElement = document.documentElement): void {
  const colors = THEME_COLORS[scheme];
  for (const name of Object.keys(colors) as (keyof ThemeColors)[]) root.style.setProperty(colorVar(name), colors[name]);
  root.style.setProperty(UI_WEIGHT_VAR, String(uiWeight(scheme)));
  root.style.colorScheme = scheme;
  root.style.background = root.hasAttribute('data-transparent-window') ? 'transparent' : colors.background;
  root.style.color = colors.text;
  root.ownerDocument.querySelector('meta[name="theme-color"]')?.setAttribute('content', colors.surface);
}

const parseChoice = (value: string | null): ThemeChoice =>
  value === 'light' || value === 'dark' ? value : 'system';

const darkQuery = (): MediaQueryList | null =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

const resolve = (choice: ThemeChoice, systemDark: boolean): ColorScheme =>
  choice === 'system' ? (systemDark ? 'dark' : 'light') : choice;

/** The scheme to paint before the app renders, so a dark setup never flashes light. */
export function initialColorScheme(
  storage: PreferenceStorage | null = defaultStorage(),
  query: MediaQueryList | null = darkQuery(),
): ColorScheme {
  return resolve(parseChoice(readPreference(storage, THEME_KEY)), query?.matches ?? false);
}

export interface ThemePreference {
  /** What the user picked: System follows the OS. */
  readonly choice: Accessor<ThemeChoice>;
  /** What is shown now. */
  readonly scheme: Accessor<ColorScheme>;
  choose(choice: ThemeChoice): void;
  /** System → Light → Dark → System. */
  cycle(): void;
}

/**
 * The theme is a preference of this device, for every vault, like word wrap: it holds no content,
 * so it is neither synced nor encrypted. System (the default) follows OS changes live.
 */
export function createThemePreference(
  storage: PreferenceStorage | null = defaultStorage(),
  query: MediaQueryList | null = darkQuery(),
): ThemePreference {
  const [choice, setChoice] = createSignal<ThemeChoice>(parseChoice(readPreference(storage, THEME_KEY)));
  const [systemDark, setSystemDark] = createSignal(query?.matches ?? false);
  if (query) {
    const onChange = (event: MediaQueryListEvent): void => {
      setSystemDark(event.matches);
    };
    query.addEventListener('change', onChange);
    onCleanup(() => query.removeEventListener('change', onChange));
  }
  const choose = (next: ThemeChoice): void => {
    setChoice(next);
    writePreference(storage, THEME_KEY, next);
  };
  return {
    choice,
    scheme: () => resolve(choice(), systemDark()),
    choose,
    cycle: () => choose(THEME_CHOICES[(THEME_CHOICES.indexOf(choice()) + 1) % THEME_CHOICES.length] as ThemeChoice),
  };
}

export const ThemeContext = createContext<ThemePreference>();

export function useTheme(): ThemePreference {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('useTheme needs a ThemeContext provider (AnkyLockApp).');
  return theme;
}
