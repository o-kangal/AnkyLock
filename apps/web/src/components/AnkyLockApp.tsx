import { createEffect, createSignal, Match, on, onCleanup, onMount, Switch, type Accessor, type JSX } from 'solid-js';
import type { Platform } from '../keyboard/shortcuts.js';
import { createNarrowScreen, ScreenContext } from '../layout/screen.js';
import type { Runtime } from '../runtime/createRuntime.js';
import { SaveFileContext, downloadFile, type SaveFile } from '../export/saveFile.js';
import { applyColorScheme, createThemePreference, ThemeContext, type ThemePreference } from '../theme/colorScheme.js';
import { loadAppFonts } from '../theme/fonts.js';
import { createReducedMotion, LOGO_TRANSITION_MS } from './AnkyLogo.jsx';
import { tokens } from './sidebar/styles.js';
import { UnlockScreen } from './UnlockScreen.jsx';
import { Workspace } from './Workspace.jsx';

/** Root UI shared by desktop and web: the vault must be unlocked before any note is shown. */
export function AnkyLockApp(props: {
  readonly runtime: Runtime;
  readonly platform?: Platform;
  /** Overrides window-width detection (tests). */
  readonly narrow?: Accessor<boolean>;
  /** Saves exports; defaults to a browser download. */
  readonly saveFile?: SaveFile;
  /** How links in notes open; defaults to a new browser tab. */
  readonly openLink?: (url: string) => void;
  /** Overrides the stored theme preference (tests). */
  readonly theme?: ThemePreference;
}): JSX.Element {
  onMount(() => void props.runtime.init());
  // Before any editor exists, so notes open with their font already loaded.
  loadAppFonts();
  const narrow = props.narrow ?? createNarrowScreen();
  const theme = props.theme ?? createThemePreference();
  // The whole document follows, including the desktop title bar outside this tree.
  createEffect(() => applyColorScheme(theme.scheme()));
  // An unlock plays on the vault picker's logo before the workspace replaces it. Locking shows
  // the picker right away; its logo then plays the lock.
  const reducedMotion = createReducedMotion();
  const [screen, setScreen] = createSignal(props.runtime.status());
  let opening: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(props.runtime.status, (status) => {
      clearTimeout(opening);
      const fromPicker = screen() === 'locked' || screen() === 'uninitialized';
      if (status === 'unlocked' && fromPicker && !reducedMotion()) opening = setTimeout(() => setScreen(status), LOGO_TRANSITION_MS);
      else setScreen(status);
    }),
  );
  onCleanup(() => clearTimeout(opening));

  return (
    <ThemeContext.Provider value={theme}>
      <SaveFileContext.Provider value={props.saveFile ?? downloadFile}>
        <ScreenContext.Provider value={narrow}>
          <Switch>
            <Match when={screen() === 'loading'}>
              <div style={{ display: 'grid', 'place-items': 'center', height: '100%', font: tokens.font }}>Loading…</div>
            </Match>
            <Match when={screen() === 'unlocked' && props.runtime.status() === 'unlocked'}>
              <Workspace runtime={props.runtime} platform={props.platform ?? 'web'} {...(props.openLink ? { openLink: props.openLink } : {})} />
            </Match>
            <Match when={screen() !== 'loading'}>
              <UnlockScreen runtime={props.runtime} />
            </Match>
          </Switch>
        </ScreenContext.Provider>
      </SaveFileContext.Provider>
    </ThemeContext.Provider>
  );
}
