import { createSignal, Match, Show, Switch, type JSX } from 'solid-js';
import { MAX_VAULT_NAME_LENGTH, type Runtime } from '../runtime/createRuntime.js';
import { tokens } from './sidebar/styles.js';

export type VaultSettingsView = 'menu' | 'remove' | 'delete';

const field: JSX.CSSProperties = {
  display: 'block',
  width: '100%',
  'box-sizing': 'border-box',
  padding: '5px 8px',
  'margin-top': '6px',
  font: tokens.font,
};

const button: JSX.CSSProperties = { ...field, cursor: 'pointer', 'text-align': 'left' };
const danger: JSX.CSSProperties = { ...button, color: tokens.danger };

/**
 * The open vault's settings: rename it, remove it from this device, or delete it everywhere.
 * Removing asks for confirmation that spells out what happens to the notes; deleting everywhere,
 * and removing a vault that has no copy in Google Drive, ask for the vault's name to be typed.
 */
export function VaultSettings(props: {
  readonly runtime: Runtime;
  readonly initialView?: VaultSettingsView;
  readonly onClose: () => void;
}): JSX.Element {
  const displayName = (): string => props.runtime.vaultName() ?? 'Unnamed vault';
  const [view, setView] = createSignal<VaultSettingsView>(props.initialView ?? 'menu');
  const [name, setName] = createSignal(props.runtime.vaultName() ?? '');
  const [typed, setTyped] = createSignal('');
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
                style={field}
              />
            </label>
            <button type="submit" disabled={busy() || name().trim() === (props.runtime.vaultName() ?? '')} style={button}>
              Rename
            </button>
          </form>
          <Show when={status().vaultDrive === 'local-only'}>
            <button type="button" disabled={busy() || !signedIn()} style={button} onClick={() => void props.runtime.backUpAgain().then(props.onClose)}>
              Back up to Google Drive again
            </button>
          </Show>
          <hr style={{ border: 'none', 'border-top': `1px solid ${tokens.border}`, margin: '10px 0 4px' }} />
          <button type="button" style={danger} onClick={() => open('remove')}>
            Remove from this device…
          </button>
          <button
            type="button"
            style={danger}
            disabled={!signedIn() || !status().onDrive}
            title={signedIn() ? undefined : 'Sign in with Google to delete the vault from Google Drive too.'}
            onClick={() => open('delete')}
          >
            Delete everywhere…
          </button>
        </Match>
        <Match when={view() !== 'menu'}>
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
                style={field}
              />
            </Show>
            <button type="submit" disabled={busy() || !confirmed()} style={danger}>
              {busy() ? 'Removing…' : view() === 'delete' ? 'Delete everywhere' : 'Remove from this device'}
            </button>
            <button type="button" disabled={busy()} style={button} onClick={() => open('menu')}>
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
