import { Match, onMount, Switch, type JSX } from 'solid-js';
import type { Platform } from '../keyboard/shortcuts.js';
import type { Runtime } from '../runtime/createRuntime.js';
import { tokens } from './sidebar/styles.js';
import { UnlockScreen } from './UnlockScreen.jsx';
import { Workspace } from './Workspace.jsx';

/** Root UI shared by desktop and web: the vault must be unlocked before any note is shown. */
export function AnkyLockApp(props: { readonly runtime: Runtime; readonly platform?: Platform }): JSX.Element {
  onMount(() => void props.runtime.init());

  return (
    <Switch>
      <Match when={props.runtime.status() === 'loading'}>
        <div style={{ display: 'grid', 'place-items': 'center', height: '100%', font: tokens.font }}>Loading…</div>
      </Match>
      <Match when={props.runtime.status() === 'unlocked'}>
        <Workspace runtime={props.runtime} platform={props.platform ?? 'web'} />
      </Match>
      <Match when={props.runtime.status() === 'uninitialized' || props.runtime.status() === 'locked'}>
        <UnlockScreen runtime={props.runtime} />
      </Match>
    </Switch>
  );
}
