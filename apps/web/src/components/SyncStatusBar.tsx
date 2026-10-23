import { createSignal, Match, Show, splitProps, Switch, type JSX, For } from 'solid-js';
import type { BackupStatus } from '@ankylock/sync';
import type { Runtime } from '../runtime/createRuntime.js';
import { formatTime, t, type MessageKey } from '../i18n/index.js';
import { themeLabel, ThemeIcon } from './ThemeIcon.jsx';
import type { ThemePreference } from '../theme/colorScheme.js';
import { Popover, type PopoverPosition } from './Popover.jsx';
import { VaultSettings, type VaultSettingsView } from './VaultSettings.jsx';
import { buttonStyle, createHover, tokens } from './sidebar/styles.js';

function backupLabel(backup: BackupStatus, compact: boolean): string | null {
  switch (backup.kind) {
    case 'never':
      return null;
    case 'running':
      return compact ? null : t('backup.running');
    case 'ok': {
      const time = formatTime(backup.at);
      return compact ? time : t('backup.ok', { time });
    }
    case 'error':
      if (compact) return t('backup.paused');
      return t(BACKUP_ERRORS[backup.reason]);
  }
}

const BACKUP_ERRORS = {
  quota: 'backup.errorQuota',
  auth: 'backup.errorAuth',
  network: 'backup.errorNetwork',
  http: 'backup.errorRetry',
  snapshot: 'backup.errorRetry',
  conflict: 'backup.errorConflict',
  deleted: 'sync.deletedElsewhere',
} as const satisfies Record<Extract<BackupStatus, { kind: 'error' }>['reason'], MessageKey>;

/** Circular-arrow icon; spins (SVG animation, no stylesheet needed) while sync work runs. */
function SyncIcon(props: { readonly spinning: boolean }): JSX.Element {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
      <g>
        <path d="M20 12a8 8 0 1 1-2.34-5.66" stroke-linecap="round" />
        <path d="M20 4v5h-5" stroke-linecap="round" stroke-linejoin="round" />
        <Show when={props.spinning}>
          <animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="1s" repeatCount="indefinite" />
        </Show>
      </g>
    </svg>
  );
}

/** Height of a status bar button, inside the 46 px bar; touch screens get 40 px targets. */
const BUTTON_HEIGHT_PX = 30;

type BarButtonProps = JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly compact?: boolean | undefined;
  /** Danger actions keep the danger color. */
  readonly danger?: boolean;
  /** A toggle that is on (Word wrap). */
  readonly pressed?: boolean;
};

/** A drawn status bar button (12l), with a hover background; touch never hovers. */
function BarButton(props: BarButtonProps): JSX.Element {
  const [own, rest] = splitProps(props, ['compact', 'danger', 'pressed', 'style', 'children']);
  const [hovered, hover] = createHover();
  return (
    <button
      type="button"
      {...hover}
      {...rest}
      aria-pressed={own.pressed}
      style={{
        ...buttonStyle,
        display: 'inline-flex',
        'align-items': 'center',
        'justify-content': 'center',
        gap: '5px',
        'flex-shrink': '0',
        'box-sizing': 'border-box',
        height: own.compact ? '40px' : `${BUTTON_HEIGHT_PX}px`,
        'min-width': own.compact ? '40px' : '0',
        padding: '0 10px',
        font: tokens.font,
        'font-size': '12px',
        'white-space': 'nowrap',
        color: own.danger ? tokens.danger : tokens.text,
        'border-color': own.pressed ? tokens.accent : tokens.fieldBorder,
        background: own.pressed
          ? tokens.activeBackground
          : hovered() && !rest.disabled
            ? tokens.buttonHoverBackground
            : tokens.buttonBackground,
        cursor: rest.disabled ? 'default' : 'pointer',
        ...(typeof own.style === 'object' ? own.style : {}),
      }}
    >
      {own.children}
    </button>
  );
}

/**
 * The backup label, in a box as wide as its longest regular text, so the buttons beside it never
 * move as it changes. Longer messages (errors) are cut with an ellipsis; the tooltip has them whole.
 */
function BackupLabel(props: { readonly text: string | null; readonly compact: boolean }): JSX.Element {
  // Digits are tabular, so any time is as wide as noon.
  const noon = (): string => formatTime(new Date(2000, 0, 1, 12, 0).getTime());
  const longest = (): readonly string[] =>
    props.compact ? [noon()] : [t('backup.ok', { time: noon() }), t('backup.running'), t('sync.syncing')];
  return (
    <span
      data-backup-label
      title={props.text ?? undefined}
      style={{ display: 'inline-grid', 'max-width': '320px', 'white-space': 'nowrap' }}
    >
      <For each={longest()}>{(text) => (
        <span aria-hidden="true" style={{ 'grid-area': '1 / 1', visibility: 'hidden' }}>
          {text}
        </span>
      )}</For>
      <span style={{ 'grid-area': '1 / 1', overflow: 'hidden', 'text-overflow': 'ellipsis', 'min-width': '0' }}>{props.text ?? ''}</span>
    </span>
  );
}

/**
 * Non-intrusive status line (SPEC §7): the open vault, sign-in, relay connection and Drive backup
 * state. Sync problems never block local editing; they only show up here.
 */
export interface WordWrapToggle {
  readonly on: () => boolean;
  readonly toggle: () => void;
  /** e.g. "Alt+Z", shown on the button so the shortcut is discoverable. */
  readonly shortcut: string;
}

export function SyncStatusBar(props: {
  readonly runtime: Runtime;
  readonly wordWrap?: WordWrapToggle;
  readonly theme?: ThemePreference;
  /** Narrow screens: short labels and icon buttons; Lock and Sign out live in the vault menu. */
  readonly compact?: boolean;
}): JSX.Element {
  const status = (): ReturnType<Runtime['syncStatus']> => props.runtime.syncStatus();
  const [error, setError] = createSignal<string | null>(null);
  const [settings, setSettings] = createSignal<{ at: PopoverPosition; view: VaultSettingsView } | null>(null);
  let vaultButton!: HTMLButtonElement;
  const openSettings = (view: VaultSettingsView): void => {
    const rect = vaultButton.getBoundingClientRect();
    setSettings({ at: { x: rect.left, y: rect.top - 4 }, view });
  };
  const syncing = (): boolean => status().catchingUp || status().backup.kind === 'running';
  /** Signed in and syncing: through Drive only, or live through a relay. */
  const syncText = (): string => {
    if (status().mode === 'drive') return status().auth === 'stale' ? t('sync.waitingForGoogle') : t('sync.viaDrive');
    if (status().connection === 'open') return t('sync.synced');
    if (status().auth === 'stale') return t('sync.offlineQueued');
    return status().connection === 'connecting' ? t('sync.connecting') : t('sync.offlineQueued');
  };
  const catchUpTitle = (): string | undefined => {
    const at = status().lastCatchUpAt;
    if (status().mode !== 'drive' || at === null) return undefined;
    return t('sync.checkedAt', { time: formatTime(at) });
  };

  const signIn = async (): Promise<void> => {
    setError(null);
    setError(await props.runtime.signIn());
  };

  return (
    <footer
      role="status"
      style={{
        display: 'flex',
        'justify-content': 'space-between',
        'align-items': 'center',
        gap: '12px',
        // Tall enough for easy clicks, with buttons clear of the frameless window's bottom resize edge.
        'min-height': '46px',
        'box-sizing': 'border-box',
        padding: '0 12px',
        'border-top': `1px solid ${tokens.border}`,
        font: tokens.font,
        'font-size': '12px',
        // Backup times keep their width as the digits change.
        'font-variant-numeric': 'tabular-nums',
        color: tokens.muted,
        background: tokens.surface,
      }}
    >
      <span style={{ display: 'flex', gap: '8px', 'align-items': 'center', 'min-width': '0' }}>
        <BarButton
          ref={vaultButton}
          compact={props.compact}
          aria-haspopup="dialog"
          title={t('sync.vaultSettingsTitle')}
          style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'max-width': props.compact ? '40vw' : '240px' }}
          onClick={() => openSettings('menu')}
        >
          <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis' }}>{props.runtime.vaultName() ?? t('vault.unnamed')}</span>
          <span aria-hidden="true">▾</span>
        </BarButton>
        <Show when={settings()}>
          {(open) => (
            <Popover
              at={open().at}
              placement="above"
              width={300}
              label={t('sync.vaultSettings')}
              onClose={() => setSettings(null)}
              style={{ padding: '10px 12px' }}
            >
              <VaultSettings runtime={props.runtime} initialView={open().view} onClose={() => setSettings(null)} />
            </Popover>
          )}
        </Show>
        <Show
          when={props.compact}
          fallback={
            <>
              <BarButton title={t('sync.lockTitle')} onClick={() => void props.runtime.lock()}>
                {t('sync.lock')}
              </BarButton>
              <Switch>
                <Match when={status().vaultDrive === 'deleted'}>
                  <span style={{ color: tokens.danger }}>{t('sync.deletedElsewhere')}</span>
                  <BarButton onClick={() => void props.runtime.keepLocalOnly()}>{t('sync.keepLocalOnly')}</BarButton>
                  <BarButton danger onClick={() => openSettings('remove')}>
                    {t('vault.removeFromDevice')}
                  </BarButton>
                </Match>
                <Match when={status().vaultDrive === 'local-only'}>{t('sync.localOnlyVault')}</Match>
                <Match when={status().auth === 'unavailable'}>{t('sync.localOnly')}</Match>
                <Match when={status().auth === 'signed-out'}>
                  {t('sync.notSyncing')}
                  <BarButton onClick={() => void signIn()}>{t('sync.signInWithGoogle')}</BarButton>
                </Match>
                <Match when={status().auth === 'signing-in'}>{t('sync.waitingForSignIn')}</Match>
                <Match when={status().auth === 'expired'}>
                  <span style={{ color: tokens.danger }}>{t('sync.signInExpired')}</span>
                  <BarButton onClick={() => void signIn()}>{t('sync.signInAgain')}</BarButton>
                </Match>
                <Match when={status().auth === 'stale'}>
                  <span title={catchUpTitle()}>{syncText()}</span>
                  <BarButton title={t('sync.renewTitle')} onClick={() => void signIn()}>
                    {t('sync.renewAccess')}
                  </BarButton>
                </Match>
                <Match when={status().auth === 'signed-in'}>
                  <span title={catchUpTitle()}>{syncText()}</span>
                  <BarButton onClick={() => void props.runtime.signOut()}>{t('sync.signOut')}</BarButton>
                </Match>
              </Switch>
            </>
          }
        >
          <span style={{ display: 'flex', gap: '8px', 'align-items': 'center', 'white-space': 'nowrap' }}>
            <Switch>
              <Match when={status().vaultDrive === 'deleted'}>
                <BarButton compact danger onClick={() => openSettings('menu')}>
                  {t('sync.deletedElsewhereShort')}
                </BarButton>
              </Match>
              <Match when={status().vaultDrive === 'local-only' || status().auth === 'unavailable'}>{t('sync.localOnly')}</Match>
              <Match when={status().auth === 'signed-out'}>
                <BarButton compact onClick={() => void signIn()}>
                  {t('sync.signIn')}
                </BarButton>
              </Match>
              <Match when={status().auth === 'signing-in'}>{t('sync.signingIn')}</Match>
              <Match when={status().auth === 'expired'}>
                <BarButton compact danger onClick={() => void signIn()}>
                  {t('sync.signInAgain')}
                </BarButton>
              </Match>
              <Match when={status().auth === 'stale'}>
                <BarButton compact onClick={() => void signIn()}>
                  {t('sync.renew')}
                </BarButton>
              </Match>
              <Match when={status().auth === 'signed-in'}>
                <span title={catchUpTitle()}>
                  {status().mode === 'drive' || status().connection === 'open'
                    ? t('sync.synced')
                    : status().connection === 'connecting'
                      ? t('sync.connecting')
                      : t('sync.offline')}
                </span>
              </Match>
            </Switch>
          </span>
        </Show>
        <Show when={error()}>
          <span style={{ color: tokens.danger }}>{error()}</span>
        </Show>
      </span>
      <span style={{ display: 'flex', gap: '6px', 'align-items': 'center', 'flex-shrink': '0' }}>
        <Show when={props.wordWrap}>
          {(wrap) => (
            <BarButton
              compact={props.compact}
              pressed={wrap().on()}
              {...(props.compact ? { 'aria-label': t('sync.wordWrapLabel', { shortcut: wrap().shortcut }) } : {})}
              title={t('sync.wordWrapTitle')}
              onClick={() => wrap().toggle()}
            >
              <span aria-hidden="true">↵</span>
              <Show when={!props.compact}>
                <span>{t('sync.wrap', { shortcut: wrap().shortcut })}</span>
              </Show>
            </BarButton>
          )}
        </Show>
        <Show when={props.theme}>
          {(theme) => (
            <BarButton
              compact={props.compact}
              {...(props.compact ? { 'aria-label': t('sync.themeLabel', { theme: themeLabel(theme().choice()) }) } : {})}
              title={t('sync.themeTitle')}
              onClick={() => theme().cycle()}
            >
              <ThemeIcon choice={theme().choice()} />
              <Show when={!props.compact}>
                <span>{themeLabel(theme().choice())}</span>
              </Show>
            </BarButton>
          )}
        </Show>
        {/* One button that spins while sync runs, so nothing beside it changes size. */}
        <Show when={status().mode !== 'off' || syncing()}>
          <BarButton
            compact={props.compact}
            aria-label={t('sync.syncNow')}
            aria-busy={syncing()}
            disabled={syncing()}
            title={t('sync.syncNowTitle')}
            style={{ padding: '0 7px' }}
            onClick={() => void props.runtime.syncNow()}
          >
            <SyncIcon spinning={syncing()} />
          </BarButton>
        </Show>
        {/* Reserved while syncing or backed up; nothing to show leaves no gap at the edge. */}
        <Show when={status().mode !== 'off' || status().backup.kind !== 'never' || syncing()}>
          <BackupLabel
            compact={props.compact ?? false}
            text={status().catchingUp ? (props.compact ? null : t('sync.syncing')) : backupLabel(status().backup, props.compact ?? false)}
          />
        </Show>
      </span>
    </footer>
  );
}
