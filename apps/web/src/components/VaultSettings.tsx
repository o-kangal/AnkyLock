import { createSignal, For, Match, Show, Switch, useContext, type JSX } from 'solid-js';
import { MAX_VAULT_NAME_LENGTH, type Runtime } from '../runtime/createRuntime.js';
import { touchSized, useNarrowScreen } from '../layout/screen.js';
import { useExport } from '../export/saveFile.js';
import { THEME_CHOICES, ThemeContext } from '../theme/colorScheme.js';
import { buttonStyle, fieldStyle, tokens } from './sidebar/styles.js';
import { THEME_LABELS, ThemeIcon } from './ThemeIcon.jsx';

export type VaultSettingsView = 'menu' | 'remove' | 'delete' | 'wipe' | 'relay';

const baseField: JSX.CSSProperties = {
  display: 'block',
  width: '100%',
  'box-sizing': 'border-box',
  padding: '5px 8px',
  'margin-top': '6px',
  font: tokens.font,
};

/** Typed to confirm deleting all Drive data. */
const WIPE_CONFIRMATION = 'DELETE';

/**
 * The open vault's settings: rename it, remove it from this device, or delete it everywhere.
 * Removing asks for confirmation that spells out what happens to the notes; deleting everywhere,
 * and removing a vault that has no copy in Google Drive, ask for the vault's name to be typed.
 * The danger zone also deletes all AnkyLock data from Google Drive, confirmed by typing DELETE.
 */
export function VaultSettings(props: {
  readonly runtime: Runtime;
  readonly initialView?: VaultSettingsView;
  readonly onClose: () => void;
}): JSX.Element {
  const narrow = useNarrowScreen();
  const theme = useContext(ThemeContext);
  const openExport = useExport();
  const field = (): JSX.CSSProperties => touchSized({ ...fieldStyle, ...baseField }, narrow());
  const button = (): JSX.CSSProperties => touchSized({ ...buttonStyle, ...baseField, 'text-align': 'left' }, narrow());
  const danger = (): JSX.CSSProperties => ({ ...button(), color: tokens.danger });
  const displayName = (): string => props.runtime.vaultName() ?? 'Unnamed vault';
  const [view, setView] = createSignal<VaultSettingsView>(props.initialView ?? 'menu');
  const [name, setName] = createSignal(props.runtime.vaultName() ?? '');
  const [typed, setTyped] = createSignal('');
  const [relayInput, setRelayInput] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const status = (): ReturnType<Runtime['syncStatus']> => props.runtime.syncStatus();
  const signedIn = (): boolean => status().auth === 'signed-in';
  /** Removing a vault without a Drive copy loses its notes for good: make that deliberate. */
  const needsTypedName = (): boolean => view() === 'delete' || !status().onDrive;
  const confirmed = (): boolean => !needsTypedName() || typed().trim() === displayName();

  const run = async (work: () => Promise<string | null>, closeOnSuccess: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    const failure = await work();
    setBusy(false);
    setError(failure);
    if (failure === null && closeOnSuccess) props.onClose();
  };

  const open = (next: VaultSettingsView): void => {
    setTyped('');
    setRelayInput(props.runtime.ownRelayUrl() ?? '');
    setError(null);
    setView(next);
  };

  return (
    <div style={{ font: tokens.font }}>
      <Switch>
        <Match when={view() === 'menu'}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => props.runtime.renameVault(name()), true);
            }}
          >
            <label style={{ color: tokens.muted, 'font-size': '12px' }}>
              Vault name
              <input
                aria-label="Vault name"
                maxLength={MAX_VAULT_NAME_LENGTH}
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                style={field()}
              />
            </label>
            <button type="submit" disabled={busy() || name().trim() === (props.runtime.vaultName() ?? '')} style={button()}>
              Rename
            </button>
          </form>
          <Show when={status().vaultDrive === 'deleted'}>
            <p role="note" style={{ margin: '8px 0 0', color: tokens.danger }}>
              This vault was deleted from Google Drive on another device. Sync is off.
            </p>
            <button type="button" disabled={busy()} style={button()} onClick={() => void props.runtime.keepLocalOnly().then(props.onClose)}>
              Keep local only
            </button>
          </Show>
          <button type="button" disabled={busy()} style={button()} onClick={() => void props.runtime.lock().then(props.onClose)}>
            Lock
          </button>
          <Show when={signedIn() || status().auth === 'stale'}>
            <button type="button" disabled={busy()} style={button()} onClick={() => void props.runtime.signOut().then(props.onClose)}>
              Sign out of Google
            </button>
          </Show>
          <Show when={status().vaultDrive === 'local-only'}>
            <button type="button" disabled={busy() || !signedIn()} style={button()} onClick={() => void props.runtime.backUpAgain().then(props.onClose)}>
              Back up to Google Drive again
            </button>
          </Show>
          <Show when={openExport}>
            {(open) => (
              <button
                type="button"
                disabled={busy()}
                style={button()}
                onClick={() => {
                  props.onClose();
                  open()({ kind: 'vault' }, `the vault “${displayName()}”`);
                }}
              >
                Export vault…
              </button>
            )}
          </Show>
          <button type="button" disabled={busy()} style={button()} onClick={() => open('relay')}>
            {props.runtime.ownRelayUrl() === null ? 'Instant sync (own relay)…' : 'Instant sync: on…'}
          </button>
          <Show when={theme}>
            {(current) => (
              <div role="group" aria-label="Theme" style={{ 'margin-top': '10px' }}>
                <span style={{ color: tokens.muted, 'font-size': '12px' }}>Theme (this device)</span>
                <div style={{ display: 'flex', gap: '4px', 'margin-top': '6px' }}>
                  <For each={THEME_CHOICES}>
                    {(choice) => (
                      <button
                        type="button"
                        aria-pressed={current().choice() === choice}
                        style={{
                          ...button(),
                          'margin-top': '0',
                          display: 'inline-flex',
                          'align-items': 'center',
                          'justify-content': 'center',
                          gap: '4px',
                          cursor: 'pointer',
                          'border-color': current().choice() === choice ? tokens.accent : undefined,
                        }}
                        onClick={() => current().choose(choice)}
                      >
                        <ThemeIcon choice={choice} />
                        {THEME_LABELS[choice]}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            )}
          </Show>
          <hr style={{ border: 'none', 'border-top': `1px solid ${tokens.border}`, margin: '10px 0 4px' }} />
          <button type="button" style={danger()} onClick={() => open('remove')}>
            Remove from this device…
          </button>
          <button
            type="button"
            style={danger()}
            disabled={!signedIn() || !status().onDrive}
            title={signedIn() ? undefined : 'Sign in with Google to delete the vault from Google Drive too.'}
            onClick={() => open('delete')}
          >
            Delete everywhere…
          </button>
          <button
            type="button"
            style={danger()}
            disabled={!signedIn()}
            title={signedIn() ? undefined : 'Sign in with Google to delete your data from Google Drive.'}
            onClick={() => open('wipe')}
          >
            Delete all Google Drive data…
          </button>
        </Match>
        <Match when={view() === 'relay'}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => props.runtime.setOwnRelay(relayInput()), true);
            }}
          >
            <strong>Instant sync with your own relay</strong>
            <p role="note" style={{ margin: '6px 0', color: tokens.muted }}>
              Without a relay, your devices sync through Google Drive: changes from another device arrive within a few
              minutes. A relay you run makes it instant.
            </p>
            <Show
              when={props.runtime.ownRelaySupported}
              fallback={
                <p role="note" style={{ margin: '6px 0', color: tokens.muted }}>
                  The web app connects only to the relay it was built with, so no other server can be reached from this
                  page. Use the desktop app to set your own relay, or host the web app yourself with{' '}
                  <code>VITE_RELAY_URL</code>.
                </p>
              }
            >
              <p role="note" style={{ margin: '6px 0', color: tokens.muted }}>
                It is set for this device. The relay only ever sees encrypted data, but it receives your short-lived Google
                sign-in token, so use only a relay you trust. A self-hosted relay must accept AnkyLock's Google client ids.
              </p>
              <input
                aria-label="Relay address"
                placeholder="wss://relay.example.com/ws"
                value={relayInput()}
                onInput={(e) => setRelayInput(e.currentTarget.value)}
                style={field()}
              />
              <button type="submit" disabled={busy()} style={button()}>
                Save
              </button>
              <Show when={props.runtime.ownRelayUrl() !== null}>
                <button type="button" disabled={busy()} style={button()} onClick={() => void run(() => props.runtime.setOwnRelay(''), true)}>
                  Turn off instant sync
                </button>
              </Show>
            </Show>
            <button type="button" disabled={busy()} style={button()} onClick={() => open('menu')}>
              {props.runtime.ownRelaySupported ? 'Cancel' : 'Back'}
            </button>
          </form>
        </Match>
        <Match when={view() === 'wipe'}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (typed().trim() === WIPE_CONFIRMATION) void run(() => props.runtime.deleteAllDriveData(), true);
            }}
          >
            <strong>Delete all AnkyLock data from Google Drive?</strong>
            <p role="note" style={{ margin: '6px 0', color: tokens.muted }}>
              Every vault’s header and every device’s backups in Google Drive are deleted, for all your vaults. Notes on this
              device stay, and this vault is kept on this device only. Other devices stop syncing and can keep their copies
              locally. Then AnkyLock’s access to your Google account is revoked and you are signed out. This cannot be undone.
            </p>
            <input
              aria-label="Type DELETE to confirm"
              placeholder={WIPE_CONFIRMATION}
              value={typed()}
              onInput={(e) => setTyped(e.currentTarget.value)}
              style={field()}
            />
            <button type="submit" disabled={busy() || typed().trim() !== WIPE_CONFIRMATION} style={danger()}>
              {busy() ? 'Deleting…' : 'Delete all Drive data'}
            </button>
            <button type="button" disabled={busy()} style={button()} onClick={() => open('menu')}>
              Cancel
            </button>
          </form>
        </Match>
        <Match when={view() === 'remove' || view() === 'delete'}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (confirmed()) void run(() => props.runtime.removeVault({ everywhere: view() === 'delete' }), true);
            }}
          >
            <strong>{view() === 'delete' ? `Delete “${displayName()}” everywhere?` : `Remove “${displayName()}” from this device?`}</strong>
            <p role="note" style={{ margin: '6px 0', color: tokens.muted }}>
              <Switch>
                <Match when={view() === 'delete'}>
                  Its notes are deleted from this device and from Google Drive. Other devices with this vault stop syncing it
                  and can keep their copy locally. This cannot be undone.
                </Match>
                <Match when={status().onDrive}>
                  Its notes are removed from this device. The copy in Google Drive stays: open it again any time with “Use my
                  existing vault”.
                </Match>
                <Match when={true}>
                  This vault has no copy in Google Drive. Removing it deletes its notes for good.
                </Match>
              </Switch>
            </p>
            <Show when={needsTypedName()}>
              <input
                aria-label="Type the vault name to confirm"
                placeholder={displayName()}
                value={typed()}
                onInput={(e) => setTyped(e.currentTarget.value)}
                style={field()}
              />
            </Show>
            <button type="submit" disabled={busy() || !confirmed()} style={danger()}>
              {busy() ? 'Removing…' : view() === 'delete' ? 'Delete everywhere' : 'Remove from this device'}
            </button>
            <button type="button" disabled={busy()} style={button()} onClick={() => open('menu')}>
              Cancel
            </button>
          </form>
        </Match>
      </Switch>
      <Show when={error()}>
        <div role="alert" style={{ color: tokens.danger, 'margin-top': '6px' }}>
          {error()}
        </div>
      </Show>
    </div>
  );
}
