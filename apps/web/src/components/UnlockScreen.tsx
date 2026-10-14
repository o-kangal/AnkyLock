import { createSignal, onMount, Show, type JSX } from 'solid-js';
import type { Runtime } from '../runtime/createRuntime.js';
import { tokens } from './sidebar/styles.js';

/** Passphrases are the only thing protecting the vault; short ones fall to offline guessing. */
export const MIN_PASSPHRASE_LENGTH = 8;

const fieldStyle: JSX.CSSProperties = {
  display: 'block',
  width: '100%',
  'box-sizing': 'border-box',
  padding: '6px 8px',
  'margin-top': '8px',
  font: tokens.font,
};

/**
 * First launch: choose a passphrase (there is no recovery without it). Later launches: unlock.
 * The passphrase never leaves this device and is never stored.
 */
export function UnlockScreen(props: { readonly runtime: Runtime }): JSX.Element {
  let passphraseField!: HTMLInputElement;
  // The app opens straight into this field so the user can type the passphrase immediately.
  const focusPassphrase = (): void => {
    passphraseField.focus();
    passphraseField.select();
  };
  onMount(() => queueMicrotask(focusPassphrase));
  const creating = (): boolean => props.runtime.status() === 'uninitialized';
  const [passphrase, setPassphrase] = createSignal('');
  const [confirmation, setConfirmation] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (creating()) {
      if ([...passphrase()].length < MIN_PASSPHRASE_LENGTH) {
        setError(`Use at least ${MIN_PASSPHRASE_LENGTH} characters.`);
        return;
      }
      if (passphrase() !== confirmation()) {
        setError('The passphrases do not match.');
        return;
      }
    }
    setBusy(true);
    const failure = creating() ? await props.runtime.createVault(passphrase()) : await props.runtime.unlock(passphrase());
    setBusy(false);
    setError(failure);
    if (failure === null) {
      setPassphrase('');
      setConfirmation('');
    } else {
      focusPassphrase();
    }
  };

  return (
    <main style={{ display: 'grid', 'place-items': 'center', height: '100%', font: tokens.font }}>
      <form onSubmit={(e) => void submit(e)} style={{ width: '320px' }}>
        <h1 style={{ 'font-size': '18px', margin: '0 0 4px' }}>{creating() ? 'Create your vault' : 'Unlock AnkyLock'}</h1>
        <p style={{ margin: '0', color: tokens.muted }}>
          {creating()
            ? 'Choose a passphrase. It encrypts everything on this device and cannot be recovered if lost.'
            : 'Enter your passphrase to decrypt your notes.'}
        </p>
        <input
          ref={passphraseField}
          type="password"
          aria-label="Passphrase"
          placeholder="Passphrase"
          autocomplete={creating() ? 'new-password' : 'current-password'}
          value={passphrase()}
          onInput={(e) => setPassphrase(e.currentTarget.value)}
          style={fieldStyle}
        />
        <Show when={creating()}>
          <input
            type="password"
            aria-label="Confirm passphrase"
            placeholder="Confirm passphrase"
            autocomplete="new-password"
            value={confirmation()}
            onInput={(e) => setConfirmation(e.currentTarget.value)}
            style={fieldStyle}
          />
        </Show>
        <Show when={error()}>
          <div role="alert" style={{ color: tokens.danger, 'margin-top': '8px' }}>
            {error()}
          </div>
        </Show>
        <button type="submit" disabled={busy()} style={{ ...fieldStyle, cursor: 'pointer' }}>
          {busy() ? 'Deriving key…' : creating() ? 'Create vault' : 'Unlock'}
        </button>
      </form>
    </main>
  );
}
