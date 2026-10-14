import { createEffect, createSignal, For, on, onMount, Show, type JSX } from 'solid-js';
import type { VaultId } from '@ankylock/core';
import type { VaultEntry } from '@ankylock/storage';
import { MAX_VAULT_NAME_LENGTH, type Runtime } from '../runtime/createRuntime.js';
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

const linkButton: JSX.CSSProperties = {
  border: 'none',
  background: 'transparent',
  padding: '0',
  'margin-top': '16px',
  color: 'LinkText',
  cursor: 'pointer',
  font: tokens.font,
  'text-decoration': 'underline',
};

/** Vault names are encrypted, so before unlocking a vault is told apart by when it was created. */
export function vaultLabel(entry: VaultEntry): string {
  const created = new Date(entry.createdAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  return `Vault created ${created}`;
}

/**
 * Vault picker. Each vault is isolated: its own passphrase, key and notes. Unlocking picks one of
 * the vaults on this device; creating starts a new, empty vault. Passphrases never leave this
 * device and are never stored.
 */
export function UnlockScreen(props: { readonly runtime: Runtime }): JSX.Element {
  let firstField!: HTMLInputElement;
  // The app opens straight into the first field so the user can type immediately.
  const focusFirst = (): void => {
    firstField.focus();
    firstField.select();
  };
  onMount(() => queueMicrotask(focusFirst));

  const [wantsCreate, setWantsCreate] = createSignal(false);
  const creating = (): boolean => wantsCreate() || props.runtime.status() === 'uninitialized';
  const [selected, setSelected] = createSignal<VaultId | null>(null);
  const vaultId = (): VaultId | null => selected() ?? props.runtime.vaults()[0]?.id ?? null;
  const [name, setName] = createSignal('');
  const [passphrase, setPassphrase] = createSignal('');
  const [confirmation, setConfirmation] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  // Switching between unlock and create starts from a clean form.
  createEffect(
    on(
      creating,
      () => {
        setPassphrase('');
        setConfirmation('');
        setError(null);
        queueMicrotask(focusFirst);
      },
      { defer: true },
    ),
  );

  const validateNew = (): string | null => {
    if (name().trim() === '') return 'Give the vault a name.';
    if ([...passphrase()].length < MIN_PASSPHRASE_LENGTH) return `Use at least ${MIN_PASSPHRASE_LENGTH} characters.`;
    if (passphrase() !== confirmation()) return 'The passphrases do not match.';
    return null;
  };

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const invalid = creating() ? validateNew() : null;
    if (invalid !== null) {
      setError(invalid);
      return;
    }
    const id = vaultId();
    if (!creating() && id === null) return;
    setBusy(true);
    const failure = creating()
      ? await props.runtime.createVault(name(), passphrase())
      : await props.runtime.unlock(id as VaultId, passphrase());
    setBusy(false);
    setError(failure);
    if (failure === null) {
      setName('');
      setPassphrase('');
      setConfirmation('');
      setWantsCreate(false);
    } else {
      focusFirst();
    }
  };

  const passphraseInput = (ref: boolean): JSX.Element => (
    <input
      ref={(el) => {
        if (ref) firstField = el;
      }}
      type="password"
      aria-label="Passphrase"
      placeholder="Passphrase"
      autocomplete={creating() ? 'new-password' : 'current-password'}
      value={passphrase()}
      onInput={(e) => setPassphrase(e.currentTarget.value)}
      style={fieldStyle}
    />
  );

  return (
    <main style={{ display: 'grid', 'place-items': 'center', height: '100%', font: tokens.font }}>
      <form onSubmit={(e) => void submit(e)} style={{ width: '320px' }}>
        <Show
          when={creating()}
          fallback={
            <>
              <h1 style={{ 'font-size': '18px', margin: '0 0 4px' }}>Unlock AnkyLock</h1>
              <Show
                when={props.runtime.vaults().length > 1}
                fallback={<p style={{ margin: '0', color: tokens.muted }}>Enter your passphrase to decrypt your notes.</p>}
              >
                <select
                  aria-label="Vault"
                  value={vaultId() ?? ''}
                  onChange={(e) => {
                    setSelected(e.currentTarget.value as VaultId);
                    setError(null);
                  }}
                  style={fieldStyle}
                >
                  <For each={props.runtime.vaults()}>{(entry) => <option value={entry.id}>{vaultLabel(entry)}</option>}</For>
                </select>
              </Show>
              {passphraseInput(true)}
            </>
          }
        >
          <h1 style={{ 'font-size': '18px', margin: '0 0 4px' }}>Create a vault</h1>
          <p style={{ margin: '0', color: tokens.muted }}>
            A vault keeps its notes apart, under its own passphrase. The passphrase cannot be recovered if lost.
          </p>
          <input
            ref={firstField}
            aria-label="Vault name"
            placeholder="Vault name, e.g. Personal"
            maxLength={MAX_VAULT_NAME_LENGTH}
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            style={fieldStyle}
          />
          {passphraseInput(false)}
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
        <Show when={props.runtime.status() === 'locked'}>
          <button type="button" style={linkButton} onClick={() => setWantsCreate(!wantsCreate())}>
            {creating() ? 'Back to my vaults' : 'Create a new vault'}
          </button>
        </Show>
      </form>
    </main>
  );
}
