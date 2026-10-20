import { createEffect, Match, onMount, Switch, type Accessor, type JSX } from 'solid-js';
import type { Platform } from '../keyboard/shortcuts.js';
import { createNarrowScreen, ScreenContext } from '../layout/screen.js';
import type { Runtime } from '../runtime/createRuntime.js';
import { SaveFileContext, downloadFile, type SaveFile } from '../export/saveFile.js';
import { applyColorScheme, createThemePreference, ThemeContext, type ThemePreference } from '../theme/colorScheme.js';
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
  const narrow = props.narrow ?? createNarrowScreen();
  const theme = props.theme ?? createThemePreference();
  // The whole document follows, including the desktop title bar outside this tree.
  createEffect(() => applyColorScheme(theme.scheme()));

  return (
    <ThemeContext.Provider value={theme}>
      <SaveFileContext.Provider value={props.saveFile ?? downloadFile}>
        <ScreenContext.Provider value={narrow}>
          <Switch>
            <Match when={props.runtime.status() === 'loading'}>
              <div style={{ display: 'grid', 'place-items': 'center', height: '100%', font: tokens.font }}>Loading…</div>
            </Match>
            <Match when={props.runtime.status() === 'unlocked'}>
              <Workspace runtime={props.runtime} platform={props.platform ?? 'web'} {...(props.openLink ? { openLink: props.openLink } : {})} />
            </Match>
            <Match when={props.runtime.status() === 'uninitialized' || props.runtime.status() === 'locked'}>
              <UnlockScreen runtime={props.runtime} />
            </Match>
          </Switch>
        </ScreenContext.Provider>
      </SaveFileContext.Provider>
    </ThemeContext.Provider>
  );
}
