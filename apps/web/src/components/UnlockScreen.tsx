import { createEffect, createSignal, For, Match, on, onMount, Show, Switch, type JSX } from 'solid-js';
import type { VaultId } from '@ankylock/core';
import type { VaultEntry } from '@ankylock/storage';
import type { RemoteVault } from '@ankylock/sync';
import { MAX_VAULT_NAME_LENGTH, type Runtime } from '../runtime/createRuntime.js';
import { touchSized, useNarrowScreen } from '../layout/screen.js';
import { AnkyLogo } from './AnkyLogo.jsx';
import { formatDateTime, t } from '../i18n/index.js';
import { buttonStyle, fieldStyle as drawnField, selectStyle, tokens } from './sidebar/styles.js';

import { isEasyToGuess, MIN_PASSPHRASE_LENGTH } from './passphrase.js';

export { MIN_PASSPHRASE_LENGTH } from './passphrase.js';

const baseFieldStyle: JSX.CSSProperties = {
  display: 'block',
  width: '100%',
  'box-sizing': 'border-box',
  padding: '6px 8px',
  'margin-top': '8px',
  font: tokens.font,
};

const headingStyle: JSX.CSSProperties = { 'font-size': '18px', 'font-weight': tokens.strongWeight, margin: '0 0 4px' };

const linkButton: JSX.CSSProperties = {
  border: 'none',
  background: 'transparent',
  padding: '0',
  color: tokens.accent,
  cursor: 'pointer',
  font: tokens.font,
  'text-decoration': 'underline',
};

/** Vault names are encrypted, so before unlocking a vault is told apart by when it was created. */
export function vaultLabel(entry: VaultEntry): string {
  return t('unlock.vaultCreated', { when: formatDateTime(entry.createdAt) });
}

export function remoteVaultLabel(vault: RemoteVault): string {
  const backup = vault.lastBackupAt === null ? t('unlock.noBackupYet') : t('unlock.lastBackup', { when: formatDateTime(vault.lastBackupAt) });
  return `${t('unlock.vaultCreated', { when: formatDateTime(vault.createdAt) })} · ${backup}`;
}

type Mode = 'unlock' | 'create' | 'remote' | 'remove' | 'remote-delete';

type RemoteList = { readonly kind: 'loading' } | { readonly kind: 'error'; readonly message: string } | { readonly kind: 'ready'; readonly vaults: readonly RemoteVault[] };

/**
 * Vault picker. Each vault is isolated: its own passphrase, key and notes. Unlock one of the
 * vaults on this device, create a new one, or open one that another device backed up to Google
 * Drive. Passphrases never leave this device and are never stored. A vault can also be removed
 * here without its passphrase (from this device, or from Google Drive), confirmed by typing DELETE.
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
  const fieldStyle = (): JSX.CSSProperties => touchSized({ ...drawnField, ...baseFieldStyle }, narrow());
  const pickerStyle = (): JSX.CSSProperties => touchSized({ ...selectStyle, ...baseFieldStyle }, narrow());
  const [chosenMode, setMode] = createSignal<Mode>('unlock');
  const mode = (): Mode =>
    chosenMode() === 'unlock' && props.runtime.status() === 'uninitialized' ? 'create' : chosenMode();
  const canUseDrive = (): boolean => props.runtime.syncStatus().auth !== 'unavailable';
  const [selected, setSelected] = createSignal<VaultId | null>(null);
  // A removed vault may still be the selected one.
  const vaultId = (): VaultId | null =>
    props.runtime.vaults().find((v) => v.id === selected())?.id ?? props.runtime.vaults()[0]?.id ?? null;
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
  /** The vault being removed, and whether it has a Drive copy (null while checking). */
  const [target, setTarget] = createSignal<VaultId | null>(null);
  const [targetOnDrive, setTargetOnDrive] = createSignal<boolean | null>(null);
  const [typed, setTyped] = createSignal('');
  const confirming = (): boolean => mode() === 'remove' || mode() === 'remote-delete';
  /** Typed to confirm removing a vault, whose name stays encrypted while it is locked. */
  const confirmWord = (): string => t('common.confirmWord');
  const confirmed = (): boolean => typed().trim() === confirmWord();
  const targetLabel = (): string => {
    const id = target();
    const list = remote();
    if (mode() === 'remote-delete' && list.kind === 'ready') {
      const vault = list.vaults.find((v) => v.vaultId === id);
      return vault ? remoteVaultLabel(vault) : '';
    }
    const entry = props.runtime.vaults().find((v) => v.id === id);
    return entry ? vaultLabel(entry) : '';
  };

  const confirmRemoval = (next: 'remove' | 'remote-delete', id: VaultId): void => {
    setTarget(id);
    setTargetOnDrive(null);
    if (next === 'remove') void props.runtime.lockedVaultOnDrive(id).then(setTargetOnDrive, () => setTargetOnDrive(false));
    setMode(next);
  };
  const leaveRemoval = (): void => {
    setMode(mode() === 'remote-delete' ? 'remote' : 'unlock');
  };

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
        setTyped('');
        setError(null);
        if (current === 'remote') void loadRemote();
        queueMicrotask(focusFirst);
      },
      { defer: true },
    ),
  );

  const validateNew = (): string | null => {
    if (name().trim() === '') return t('vault.nameRequired');
    if ([...passphrase()].length < MIN_PASSPHRASE_LENGTH) return t('unlock.passphraseTooShort', { min: MIN_PASSPHRASE_LENGTH });
    if (passphrase() !== confirmation()) return t('unlock.passphraseMismatch');
    return null;
  };

  const run = (): Promise<string | null> => {
    switch (mode()) {
      case 'create':
        return props.runtime.createVault(name(), passphrase());
      case 'remote': {
        const id = remoteId();
        return id === null ? Promise.resolve(t('unlock.chooseVault')) : props.runtime.openRemoteVault(id, passphrase());
      }
      case 'unlock': {
        const id = vaultId();
        return id === null ? Promise.resolve(t('unlock.chooseVault')) : props.runtime.unlock(id, passphrase());
      }
      case 'remove': {
        const id = target();
        return id === null ? Promise.resolve(t('unlock.chooseVault')) : props.runtime.removeLockedVault(id, { everywhere: false });
      }
      case 'remote-delete': {
        const id = target();
        return id === null ? Promise.resolve(t('unlock.chooseVault')) : props.runtime.deleteRemoteVault(id);
      }
    }
  };

  const execute = async (work: () => Promise<string | null>): Promise<void> => {
    setBusy(true);
    const failure = await work();
    setBusy(false);
    setError(failure);
    if (failure === null) {
      setName('');
      setPassphrase('');
      setConfirmation('');
      if (confirming()) leaveRemoval();
      else setMode('unlock');
    } else {
      focusFirst();
    }
  };

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const invalid =
      mode() === 'create' ? validateNew() : confirming() && !confirmed() ? t('common.typeToConfirm', { word: confirmWord() }) : null;
    if (invalid !== null) {
      setError(invalid);
      return;
    }
    await execute(run);
  };

  const confirmationInput = (): JSX.Element => (
    <input
      ref={(el) => (firstField = el)}
      aria-label={t('common.typeToConfirm', { word: confirmWord() })}
      placeholder={confirmWord()}
      value={typed()}
      onInput={(e) => setTyped(e.currentTarget.value)}
      style={fieldStyle()}
    />
  );

  const passphraseInput = (first: boolean): JSX.Element => (
    <input
      ref={(el) => {
        if (first) firstField = el;
      }}
      type="password"
      aria-label={t('unlock.passphrase')}
      placeholder={t('unlock.passphrase')}
      autocomplete={mode() === 'create' ? 'new-password' : 'current-password'}
      value={passphrase()}
      onInput={(e) => setPassphrase(e.currentTarget.value)}
      style={fieldStyle()}
    />
  );

  const submitLabel = (): string => {
    if (busy()) {
      return {
        unlock: t('unlock.derivingKey'),
        create: t('unlock.derivingKey'),
        remote: t('unlock.restoring'),
        remove: t('common.removing'),
        'remote-delete': t('common.deleting'),
      }[mode()];
    }
    return {
      unlock: t('unlock.unlock'),
      create: t('unlock.createVault'),
      remote: t('unlock.openVault'),
      remove: t('vault.removeFromDevice'),
      'remote-delete': t('unlock.deleteFromDrive'),
    }[mode()];
  };
  const showSubmit = (): boolean => mode() !== 'remote' || (remote().kind === 'ready' && remoteId() !== null);
  const submitDisabled = (): boolean =>
    busy() || (confirming() && (!confirmed() || (mode() === 'remove' && targetOnDrive() === null)));
  const submitStyle = (): JSX.CSSProperties =>
    touchSized({ ...buttonStyle, ...baseFieldStyle, ...(confirming() ? { color: tokens.danger } : {}) }, narrow());

  return (
    <main style={{ display: 'grid', 'place-items': 'center', height: '100%', font: tokens.font }}>
      <form onSubmit={(e) => void submit(e)} style={{ width: '340px', 'max-width': 'calc(100% - 32px)' }}>
        <div style={{ display: 'flex', 'flex-direction': 'column', 'align-items': 'center', gap: '6px', 'margin-bottom': '20px' }}>
          <AnkyLogo face={props.runtime.logoFace()} size={96} animateIn />
          <span style={{ 'font-family': tokens.brandFamily, 'font-size': '26px', 'font-weight': '600', 'letter-spacing': '0' }}>
            AnkyLock
          </span>
        </div>
        <Switch>
          <Match when={mode() === 'unlock'}>
            <h1 style={headingStyle}>{t('unlock.title')}</h1>
            <Show
              when={props.runtime.vaults().length > 1}
              fallback={<p style={{ margin: '0', color: tokens.muted }}>{t('unlock.enterPassphrase')}</p>}
            >
              <select
                aria-label={t('unlock.vault')}
                value={vaultId() ?? ''}
                onChange={(e) => {
                  setSelected(e.currentTarget.value as VaultId);
                  setError(null);
                }}
                style={pickerStyle()}
              >
                <For each={props.runtime.vaults()}>{(entry) => <option value={entry.id}>{vaultLabel(entry)}</option>}</For>
              </select>
            </Show>
            {passphraseInput(true)}
          </Match>
          <Match when={mode() === 'create'}>
            <h1 style={headingStyle}>{t('unlock.createTitle')}</h1>
            <p style={{ margin: '0', color: tokens.muted }}>{t('unlock.createIntro')}</p>
            <input
              ref={(el) => (firstField = el)}
              aria-label={t('vault.name')}
              placeholder={t('unlock.vaultNamePlaceholder')}
              maxLength={MAX_VAULT_NAME_LENGTH}
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              style={fieldStyle()}
            />
            {passphraseInput(false)}
            <p role="note" style={{ margin: '4px 0 0', color: tokens.muted, 'font-size': '12px' }}>
              {t('unlock.passphraseHint', { min: MIN_PASSPHRASE_LENGTH })}
            </p>
            <Show when={[...passphrase()].length >= MIN_PASSPHRASE_LENGTH && isEasyToGuess(passphrase())}>
              <p role="alert" style={{ margin: '4px 0 0', color: tokens.danger, 'font-size': '12px' }}>
                {t('unlock.passphraseWeak')}
              </p>
            </Show>
            <input
              type="password"
              aria-label={t('unlock.confirmPassphrase')}
              placeholder={t('unlock.confirmPassphrase')}
              autocomplete="new-password"
              value={confirmation()}
              onInput={(e) => setConfirmation(e.currentTarget.value)}
              style={fieldStyle()}
            />
          </Match>
          <Match when={mode() === 'remote'}>
            <h1 style={headingStyle}>{t('unlock.remoteTitle')}</h1>
            <p style={{ margin: '0', color: tokens.muted }}>{t('unlock.remoteIntro')}</p>
            <Switch>
              <Match when={remote().kind === 'loading'}>
                <p role="status" style={{ color: tokens.muted }}>
                  {t('unlock.remoteLoading')}
                </p>
              </Match>
              <Match when={remote().kind === 'error'}>
                <div role="alert" style={{ color: tokens.danger, 'margin-top': '8px' }}>
                  {(remote() as { message: string }).message}
                </div>
                <button type="button" style={{ ...linkButton, 'margin-top': '8px' }} onClick={() => void loadRemote()}>
                  {t('common.tryAgain')}
                </button>
              </Match>
              <Match when={remote().kind === 'ready' && remoteId() === null}>
                <p style={{ color: tokens.muted }}>{t('unlock.remoteNone')}</p>
              </Match>
              <Match when={remote().kind === 'ready'}>
                <select
                  aria-label={t('unlock.remoteVault')}
                  value={remoteId() ?? ''}
                  onChange={(e) => {
                    setSelectedRemote(e.currentTarget.value as VaultId);
                    setError(null);
                  }}
                  style={pickerStyle()}
                >
                  <For each={(remote() as { vaults: readonly RemoteVault[] }).vaults}>
                    {(vault) => <option value={vault.vaultId}>{remoteVaultLabel(vault)}</option>}
                  </For>
                </select>
                {passphraseInput(true)}
              </Match>
            </Switch>
          </Match>
          <Match when={mode() === 'remove'}>
            <h1 style={headingStyle}>{t('unlock.removeTitle')}</h1>
            <p style={{ margin: '0', color: tokens.muted }}>{t('unlock.removeIntro', { vault: targetLabel() })}</p>
            <p role="note" style={{ margin: '8px 0 0', color: tokens.muted }}>
              <Switch>
                <Match when={targetOnDrive() === null}>{t('unlock.removeChecking')}</Match>
                <Match when={targetOnDrive()}>
                  {t('unlock.removeKeepsDrive', { useExisting: t('unlock.useExisting') })}
                  <Show when={canUseDrive()}> {t('unlock.removeEverywhereNote', { everywhere: t('vault.deleteEverywhere') })}</Show>
                </Match>
                <Match when={true}>{t('unlock.removeNoDrive')}</Match>
              </Switch>
            </p>
            {confirmationInput()}
          </Match>
          <Match when={mode() === 'remote-delete'}>
            <h1 style={headingStyle}>{t('unlock.remoteDeleteTitle')}</h1>
            <p style={{ margin: '0', color: tokens.muted }}>{t('unlock.remoteDeleteIntro', { vault: targetLabel() })}</p>
            {confirmationInput()}
          </Match>
        </Switch>
        <Show when={error()}>
          <div role="alert" style={{ color: tokens.danger, 'margin-top': '8px' }}>
            {error()}
          </div>
        </Show>
        <Show when={showSubmit()}>
          <button type="submit" disabled={submitDisabled()} style={submitStyle()}>
            {submitLabel()}
          </button>
        </Show>
        <Show when={mode() === 'remove' && targetOnDrive() && canUseDrive()}>
          <button
            type="button"
            disabled={submitDisabled()}
            style={submitStyle()}
            onClick={() => {
              const id = target();
              if (id !== null) void execute(() => props.runtime.removeLockedVault(id, { everywhere: true }));
            }}
          >
            {t('vault.deleteEverywhere')}
          </button>
        </Show>
        <div style={{ display: 'flex', gap: '16px', 'margin-top': '16px', 'flex-wrap': 'wrap' }}>
          <Show when={confirming()}>
            <button type="button" style={linkButton} disabled={busy()} onClick={leaveRemoval}>
              {t('common.cancel')}
            </button>
          </Show>
          <Show when={!confirming() && mode() !== 'unlock' && (props.runtime.status() === 'locked' || mode() === 'remote')}>
            <button type="button" style={linkButton} disabled={busy()} onClick={() => setMode('unlock')}>
              {props.runtime.status() === 'locked' ? t('unlock.backToVaults') : t('common.back')}
            </button>
          </Show>
          <Show when={mode() === 'unlock'}>
            <button type="button" style={linkButton} onClick={() => setMode('create')}>
              {t('unlock.createNew')}
            </button>
          </Show>
          <Show when={!confirming() && mode() !== 'remote' && canUseDrive()}>
            <button type="button" style={linkButton} onClick={() => setMode('remote')}>
              {t('unlock.useExisting')}
            </button>
          </Show>
          <Show when={mode() === 'unlock' ? vaultId() : null}>
            {(id) => (
              <button type="button" style={{ ...linkButton, color: tokens.danger }} onClick={() => confirmRemoval('remove', id())}>
                {t('unlock.removeVault')}
              </button>
            )}
          </Show>
          <Show when={mode() === 'remote' && !busy() ? remoteId() : null}>
            {(id) => (
              <button type="button" style={{ ...linkButton, color: tokens.danger }} onClick={() => confirmRemoval('remote-delete', id())}>
                {t('unlock.deleteFromDriveMenu')}
              </button>
            )}
          </Show>
        </div>
      </form>
    </main>
  );
}
