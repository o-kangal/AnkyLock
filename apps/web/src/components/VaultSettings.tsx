import { createSignal, For, Match, Show, Switch, untrack, useContext, type JSX } from 'solid-js';
import { MAX_VAULT_NAME_LENGTH, type Runtime } from '../runtime/createRuntime.js';
import { touchSized, useNarrowScreen } from '../layout/screen.js';
import { useExport } from '../export/saveFile.js';
import { THEME_CHOICES, ThemeContext } from '../theme/colorScheme.js';
import { buttonStyle, fieldStyle, tokens } from './sidebar/styles.js';
import { chooseLocale, LOCALE_CHOICES, localeChoice, t, type LocaleChoice } from '../i18n/index.js';
import { themeLabel, ThemeIcon } from './ThemeIcon.jsx';

export type VaultSettingsView = 'menu' | 'remove' | 'delete' | 'wipe' | 'relay';

const baseField: JSX.CSSProperties = {
  display: 'block',
  width: '100%',
  'box-sizing': 'border-box',
  padding: '5px 8px',
  'margin-top': '6px',
  font: tokens.font,
};

/** Languages are named in their own language, so anyone can find theirs. */
const localeLabel = (choice: LocaleChoice): string => (choice === 'en' ? 'English' : choice === 'tr' ? 'Türkçe' : t('settings.languageSystem'));

/**
 * The open vault's settings: rename it, remove it from this device, or delete it everywhere.
 * Removing asks for confirmation that spells out what happens to the notes; deleting everywhere,
 * and removing a vault that has no copy in Google Drive, ask for the vault's name to be typed.
 * The danger zone also deletes all AnkyLock data from Google Drive, confirmed by typing DELETE
 * (in the current language). Theme and language are preferences of this device.
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
  const displayName = (): string => props.runtime.vaultName() ?? t('vault.unnamed');
  /** Typed to confirm deleting all Drive data. */
  const confirmWord = (): string => t('common.confirmWord');
  const [view, setView] = createSignal<VaultSettingsView>(props.initialView ?? 'menu');
  const [name, setName] = createSignal(untrack(() => props.runtime.vaultName()) ?? '');
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
              {t('vault.name')}
              <input
                aria-label={t('vault.name')}
                maxLength={MAX_VAULT_NAME_LENGTH}
                value={name()}
                onInput={(e) => setName(e.currentTarget.value)}
                style={field()}
              />
            </label>
            <button type="submit" disabled={busy() || name().trim() === (props.runtime.vaultName() ?? '')} style={button()}>
              {t('settings.rename')}
            </button>
          </form>
          <Show when={status().vaultDrive === 'deleted'}>
            <p role="note" style={{ margin: '8px 0 0', color: tokens.danger }}>
              {t('settings.deletedElsewhere')}
            </p>
            <button type="button" disabled={busy()} style={button()} onClick={() => void props.runtime.keepLocalOnly().then(props.onClose)}>
              {t('sync.keepLocalOnly')}
            </button>
          </Show>
          <button type="button" disabled={busy()} style={button()} onClick={() => void props.runtime.lock().then(props.onClose)}>
            {t('sync.lock')}
          </button>
          <Show when={signedIn() || status().auth === 'stale'}>
            <button type="button" disabled={busy()} style={button()} onClick={() => void props.runtime.signOut().then(props.onClose)}>
              {t('settings.signOutOfGoogle')}
            </button>
          </Show>
          <Show when={status().vaultDrive === 'local-only'}>
            <button type="button" disabled={busy() || !signedIn()} style={button()} onClick={() => void props.runtime.backUpAgain().then(props.onClose)}>
              {t('settings.backUpAgain')}
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
                  open()({ kind: 'vault' }, t('export.vaultLabel', { name: displayName() }));
                }}
              >
                {t('settings.exportVault')}
              </button>
            )}
          </Show>
          <button type="button" disabled={busy()} style={button()} onClick={() => open('relay')}>
            {props.runtime.ownRelayUrl() === null ? t('settings.instantSync') : t('settings.instantSyncOn')}
          </button>
          <Show when={theme}>
            {(current) => (
              <div role="group" aria-label={t('settings.theme')} style={{ 'margin-top': '10px' }}>
                <span style={{ color: tokens.muted, 'font-size': '12px' }}>{t('settings.themeThisDevice')}</span>
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
                        {themeLabel(choice)}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            )}
          </Show>
          <div role="group" aria-label={t('settings.language')} style={{ 'margin-top': '10px' }}>
            <span style={{ color: tokens.muted, 'font-size': '12px' }}>{t('settings.languageThisDevice')}</span>
            <div style={{ display: 'flex', gap: '4px', 'margin-top': '6px' }}>
              <For each={LOCALE_CHOICES}>
                {(choice) => (
                  <button
                    type="button"
                    aria-pressed={localeChoice() === choice}
                    style={{
                      ...button(),
                      'margin-top': '0',
                      display: 'inline-flex',
                      'justify-content': 'center',
                      'border-color': localeChoice() === choice ? tokens.accent : undefined,
                    }}
                    onClick={() => chooseLocale(choice)}
                  >
                    {localeLabel(choice)}
                  </button>
                )}
              </For>
            </div>
          </div>
          <hr style={{ border: 'none', 'border-top': `1px solid ${tokens.border}`, margin: '10px 0 4px' }} />
          <button type="button" style={danger()} onClick={() => open('remove')}>
            {t('settings.removeFromDeviceMenu')}
          </button>
          <button
            type="button"
            style={danger()}
            disabled={!signedIn() || !status().onDrive}
            title={signedIn() ? undefined : t('settings.signInToDeleteEverywhere')}
            onClick={() => open('delete')}
          >
            {t('settings.deleteEverywhereMenu')}
          </button>
          <button
            type="button"
            style={danger()}
            disabled={!signedIn()}
            title={signedIn() ? undefined : t('settings.signInToWipe')}
            onClick={() => open('wipe')}
          >
            {t('settings.wipeMenu')}
          </button>
        </Match>
        <Match when={view() === 'relay'}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => props.runtime.setOwnRelay(relayInput()), true);
            }}
          >
            <strong>{t('relay.title')}</strong>
            <p role="note" style={{ margin: '6px 0', color: tokens.muted }}>
              {t('relay.intro')}
            </p>
            <Show
              when={props.runtime.ownRelaySupported}
              fallback={
                <p role="note" style={{ margin: '6px 0', color: tokens.muted }}>
                  {t('relay.webOnly')} <code>VITE_RELAY_URL</code>.
                </p>
              }
            >
              <p role="note" style={{ margin: '6px 0', color: tokens.muted }}>
                {t('relay.warning')}
              </p>
              <input
                aria-label={t('relay.address')}
                placeholder="wss://relay.example.com/ws"
                value={relayInput()}
                onInput={(e) => setRelayInput(e.currentTarget.value)}
                style={field()}
              />
              <button type="submit" disabled={busy()} style={button()}>
                {t('common.save')}
              </button>
              <Show when={props.runtime.ownRelayUrl() !== null}>
                <button type="button" disabled={busy()} style={button()} onClick={() => void run(() => props.runtime.setOwnRelay(''), true)}>
                  {t('relay.turnOff')}
                </button>
              </Show>
            </Show>
            <button type="button" disabled={busy()} style={button()} onClick={() => open('menu')}>
              {props.runtime.ownRelaySupported ? t('common.cancel') : t('common.back')}
            </button>
          </form>
        </Match>
        <Match when={view() === 'wipe'}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (typed().trim() === confirmWord()) void run(() => props.runtime.deleteAllDriveData(), true);
            }}
          >
            <strong>{t('wipe.title')}</strong>
            <p role="note" style={{ margin: '6px 0', color: tokens.muted }}>
              {t('wipe.intro')}
            </p>
            <input
              aria-label={t('common.typeToConfirm', { word: confirmWord() })}
              placeholder={confirmWord()}
              value={typed()}
              onInput={(e) => setTyped(e.currentTarget.value)}
              style={field()}
            />
            <button type="submit" disabled={busy() || typed().trim() !== confirmWord()} style={danger()}>
              {busy() ? t('common.deleting') : t('wipe.submit')}
            </button>
            <button type="button" disabled={busy()} style={button()} onClick={() => open('menu')}>
              {t('common.cancel')}
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
            <strong>{view() === 'delete' ? t('remove.deleteTitle', { name: displayName() }) : t('remove.removeTitle', { name: displayName() })}</strong>
            <p role="note" style={{ margin: '6px 0', color: tokens.muted }}>
              <Switch>
                <Match when={view() === 'delete'}>{t('remove.deleteIntro')}</Match>
                <Match when={status().onDrive}>{t('remove.keepsDrive', { useExisting: t('unlock.useExisting') })}</Match>
                <Match when={true}>{t('remove.noDrive')}</Match>
              </Switch>
            </p>
            <Show when={needsTypedName()}>
              <input
                aria-label={t('remove.typeName')}
                placeholder={displayName()}
                value={typed()}
                onInput={(e) => setTyped(e.currentTarget.value)}
                style={field()}
              />
            </Show>
            <button type="submit" disabled={busy() || !confirmed()} style={danger()}>
              {busy() ? t('common.removing') : view() === 'delete' ? t('vault.deleteEverywhere') : t('vault.removeFromDevice')}
            </button>
            <button type="button" disabled={busy()} style={button()} onClick={() => open('menu')}>
              {t('common.cancel')}
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
