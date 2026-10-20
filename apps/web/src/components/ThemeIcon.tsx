import { Match, Switch, type JSX } from 'solid-js';
import type { ThemeChoice } from '../theme/colorScheme.js';

export const THEME_LABELS: Record<ThemeChoice, string> = { system: 'System', light: 'Light', dark: 'Dark' };

/** Half-filled circle for System, sun for Light, moon for Dark (inline SVG, follows text color). */
export function ThemeIcon(props: { readonly choice: ThemeChoice }): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <Switch>
        <Match when={props.choice === 'system'}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
        </Match>
        <Match when={props.choice === 'light'}>
          <circle cx="12" cy="12" r="4" />
          <path
            d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
            stroke-linecap="round"
          />
        </Match>
        <Match when={props.choice === 'dark'}>
          <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z" stroke-linejoin="round" />
        </Match>
      </Switch>
    </svg>
  );
}
