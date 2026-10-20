import { createEffect, createSignal, For, Match, on, onMount, Show, Switch, type JSX } from 'solid-js';
import type { EpochMs, VaultId } from '@ankylock/core';
import type { VaultEntry } from '@ankylock/storage';
import type { RemoteVault } from '@ankylock/sync';
import { MAX_VAULT_NAME_LENGTH, type Runtime } from '../runtime/createRuntime.js';
import { touchSized, useNarrowScreen } from '../layout/screen.js';
import { tokens } from './sidebar/styles.js';

/** Passphrases are the only thing protecting the vault; short ones fall to offline guessing. */
export const MIN_PASSPHRASE_LENGTH = 8;

const baseFieldStyle: JSX.CSSProperties = {
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
  color: tokens.accent,
  cursor: 'pointer',
  font: tokens.font,
  'text-decoration': 'underline',
};

const when = (at: EpochMs): string => new Date(at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

/** Vault names are encrypted, so before unlocking a vault is told apart by when it was created. */
export function vaultLabel(entry: VaultEntry): string {
  return `Vault created ${when(entry.createdAt)}`;
}

export function remoteVaultLabel(vault: RemoteVault): string {
  const backup = vault.lastBackupAt === null ? 'no backup yet' : `last backup ${when(vault.lastBackupAt)}`;
  return `Vault created ${when(vault.createdAt)} · ${backup}`;
}

type Mode = 'unlock' | 'create' | 'remote';
type RemoteList = { readonly kind: 'loading' } | { readonly kind: 'error'; readonly message: string } | { readonly kind: 'ready'; readonly vaults: readonly RemoteVault[] };

/**
 * Vault picker. Each vault is isolated: its own passphrase, key and notes. Unlock one of the
 * vaults on this device, create a new one, or open one that another device backed up to Google
 * Drive. Passphrases never leave this device and are never stored.
 */
export function UnlockScreen(props: { readonly runtime: Runtime }): JSX.Element {
  let firstField: HTMLInputElement | undefined;
  // The app opens straight into the first field so the user can type immediately.
  const focusFirst = (): void => {
    firstField?.focus();
    firstField?.select();
  };
  onMount(() => queueMicrotask(focusFirst));

  const narrow = useNarrowScreen();
  const fieldStyle = (): JSX.CSSProperties => touchSized(baseFieldStyle, narrow());
  const [chosenMode, setMode] = createSignal<Mode>('unlock');
  const mode = (): Mode =>
    chosenMode() === 'unlock' && props.runtime.status() === 'uninitialized' ? 'create' : chosenMode();
  const canUseDrive = (): boolean => props.runtime.syncStatus().auth !== 'unavailable';
  const [selected, setSelected] = createSignal<VaultId | null>(null);
  const vaultId = (): VaultId | null => selected() ?? props.runtime.vaults()[0]?.id ?? null;
  const [remote, setRemote] = createSignal<RemoteList>({ kind: 'loading' });
  const [selectedRemote, setSelectedRemote] = createSignal<VaultId | null>(null);
  const remoteId = (): VaultId | null => {
    const list = remote();
    return list.kind === 'ready' ? (selectedRemote() ?? list.vaults[0]?.vaultId ?? null) : null;
  };
  const [name, setName] = createSignal('');
  const [passphrase, setPassphrase] = createSignal('');
  const [confirmation, setConfirmation] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const loadRemote = async (): Promise<void> => {
    setRemote({ kind: 'loading' });
    setSelectedRemote(null);
    const found = await props.runtime.findRemoteVaults();
    setRemote('error' in found ? { kind: 'error', message: found.error } : { kind: 'ready', vaults: found.vaults });
    queueMicrotask(focusFirst);
  };

  // Switching modes starts from a clean form.
  createEffect(
    on(
      mode,
      (current) => {
        setPassphrase('');
        setConfirmation('');
        setError(null);
        if (current === 'remote') void loadRemote();
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

  const run = (): Promise<string | null> => {
    switch (mode()) {
      case 'create':
        return props.runtime.createVault(name(), passphrase());
      case 'remote': {
        const id = remoteId();
        return id === null ? Promise.resolve('Choose a vault.') : props.runtime.openRemoteVault(id, passphrase());
      }
      case 'unlock': {
        const id = vaultId();
        return id === null ? Promise.resolve('Choose a vault.') : props.runtime.unlock(id, passphrase());
      }
    }
  };

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const invalid = mode() === 'create' ? validateNew() : null;
    if (invalid !== null) {
      setError(invalid);
      return;
    }
    setBusy(true);
    const failure = await run();
    setBusy(false);
    setError(failure);
    if (failure === null) {
      setName('');
      setPassphrase('');
      setConfirmation('');
      setMode('unlock');
    } else {
      focusFirst();
    }
  };

  const passphraseInput = (first: boolean): JSX.Element => (
    <input
      ref={(el) => {
        if (first) firstField = el;
      }}
      type="password"
      aria-label="Passphrase"
      placeholder="Passphrase"
      autocomplete={mode() === 'create' ? 'new-password' : 'current-password'}
      value={passphrase()}
      onInput={(e) => setPassphrase(e.currentTarget.value)}
      style={fieldStyle()}
    />
  );

  const submitLabel = (): string => {
    if (busy()) return mode() === 'remote' ? 'Restoring…' : 'Deriving key…';
    return { unlock: 'Unlock', create: 'Create vault', remote: 'Open vault' }[mode()];
  };
  const showSubmit = (): boolean => mode() !== 'remote' || (remote().kind === 'ready' && remoteId() !== null);

  return (
    <main style={{ display: 'grid', 'place-items': 'center', height: '100%', font: tokens.font }}>
      <form onSubmit={(e) => void submit(e)} style={{ width: '340px', 'max-width': 'calc(100% - 32px)' }}>
        <Switch>
          <Match when={mode() === 'unlock'}>
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
                style={fieldStyle()}
              >
                <For each={props.runtime.vaults()}>{(entry) => <option value={entry.id}>{vaultLabel(entry)}</option>}</For>
              </select>
            </Show>
            {passphraseInput(true)}
          </Match>
          <Match when={mode() === 'create'}>
            <h1 style={{ 'font-size': '18px', margin: '0 0 4px' }}>Create a vault</h1>
            <p style={{ margin: '0', color: tokens.muted }}>
              A vault keeps its notes apart, under its own passphrase. The passphrase cannot be recovered if lost.
            </p>
            <input
              ref={(el) => (firstField = el)}
              aria-label="Vault name"
              placeholder="Vault name, e.g. Personal"
              maxLength={MAX_VAULT_NAME_LENGTH}
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              style={fieldStyle()}
            />
            {passphraseInput(false)}
            <input
              type="password"
              aria-label="Confirm passphrase"
              placeholder="Confirm passphrase"
              autocomplete="new-password"
              value={confirmation()}
              onInput={(e) => setConfirmation(e.currentTarget.value)}
              style={fieldStyle()}
            />
          </Match>
          <Match when={mode() === 'remote'}>
            <h1 style={{ 'font-size': '18px', margin: '0 0 4px' }}>Open a vault from Google Drive</h1>
            <p style={{ margin: '0', color: tokens.muted }}>
              Vaults that your other devices back up to Google Drive. Each one opens with its own passphrase.
            </p>
            <Switch>
              <Match when={remote().kind === 'loading'}>
                <p role="status" style={{ color: tokens.muted }}>
                  Looking for your vaults in Google Drive…
                </p>
              </Match>
              <Match when={remote().kind === 'error'}>
                <div role="alert" style={{ color: tokens.danger, 'margin-top': '8px' }}>
                  {(remote() as { message: string }).message}
                </div>
                <button type="button" style={{ ...linkButton, 'margin-top': '8px' }} onClick={() => void loadRemote()}>
                  Try again
                </button>
              </Match>
              <Match when={remote().kind === 'ready' && remoteId() === null}>
                <p style={{ color: tokens.muted }}>No other vaults were found in your Google Drive.</p>
              </Match>
              <Match when={remote().kind === 'ready'}>
                <select
                  aria-label="Vault in Google Drive"
                  value={remoteId() ?? ''}
                  onChange={(e) => {
                    setSelectedRemote(e.currentTarget.value as VaultId);
                    setError(null);
                  }}
                  style={fieldStyle()}
                >
                  <For each={(remote() as { vaults: readonly RemoteVault[] }).vaults}>
                    {(vault) => <option value={vault.vaultId}>{remoteVaultLabel(vault)}</option>}
                  </For>
                </select>
                {passphraseInput(true)}
              </Match>
            </Switch>
          </Match>
        </Switch>
        <Show when={error()}>
          <div role="alert" style={{ color: tokens.danger, 'margin-top': '8px' }}>
            {error()}
          </div>
        </Show>
        <Show when={showSubmit()}>
          <button type="submit" disabled={busy()} style={{ ...fieldStyle(), cursor: 'pointer' }}>
            {submitLabel()}
          </button>
        </Show>
        <div style={{ display: 'flex', gap: '16px', 'margin-top': '16px', 'flex-wrap': 'wrap' }}>
          <Show when={mode() !== 'unlock' && (props.runtime.status() === 'locked' || mode() === 'remote')}>
            <button type="button" style={linkButton} disabled={busy()} onClick={() => setMode('unlock')}>
              {props.runtime.status() === 'locked' ? 'Back to my vaults' : 'Back'}
            </button>
          </Show>
          <Show when={mode() === 'unlock'}>
            <button type="button" style={linkButton} onClick={() => setMode('create')}>
              Create a new vault
            </button>
          </Show>
          <Show when={mode() !== 'remote' && canUseDrive()}>
            <button type="button" style={linkButton} onClick={() => setMode('remote')}>
              Use my existing vault
            </button>
          </Show>
        </div>
      </form>
    </main>
  );
}
