import { createSignal, Match, Show, splitProps, Switch, type JSX } from 'solid-js';
import type { BackupStatus } from '@ankylock/sync';
import type { Runtime } from '../runtime/createRuntime.js';
import { THEME_LABELS, ThemeIcon } from './ThemeIcon.jsx';
import type { ThemePreference } from '../theme/colorScheme.js';
import { Popover, type PopoverPosition } from './Popover.jsx';
import { VaultSettings, type VaultSettingsView } from './VaultSettings.jsx';
import { buttonStyle, createHover, tokens } from './sidebar/styles.js';

function backupLabel(backup: BackupStatus, compact: boolean): string | null {
  switch (backup.kind) {
    case 'never':
      return null;
    case 'running':
      return compact ? null : 'Backing up…';
    case 'ok': {
      const time = new Date(backup.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      return compact ? time : `Backed up ${time}`;
    }
    case 'error':
      if (compact) return 'Backup paused';
      return {
        quota: 'Google Drive is full; backup paused',
        auth: 'Drive access denied; sign in again',
        network: 'Backup waiting for a connection',
        http: 'Backup failed; will retry',
        snapshot: 'Backup failed; will retry',
        conflict: 'Google Drive holds a different vault with this id; backup stopped',
        deleted: 'Deleted from Google Drive on another device',
      }[backup.reason];
  }
}

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
  const longest = (): readonly string[] => (props.compact ? ['12:00 PM'] : ['Backed up 12:00 PM', 'Backing up…', 'Syncing…']);
  return (
    <span
      data-backup-label
      title={props.text ?? undefined}
      style={{ display: 'inline-grid', 'max-width': '320px', 'white-space': 'nowrap' }}
    >
      {longest().map((text) => (
        <span aria-hidden="true" style={{ 'grid-area': '1 / 1', visibility: 'hidden' }}>
          {text}
        </span>
      ))}
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
          title="Vault settings: rename, remove or delete"
          style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'max-width': props.compact ? '40vw' : '240px' }}
          onClick={() => openSettings('menu')}
        >
          <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis' }}>{props.runtime.vaultName() ?? 'Unnamed vault'}</span>
          <span aria-hidden="true">▾</span>
        </BarButton>
        <Show when={settings()}>
          {(open) => (
            <Popover
              at={open().at}
              placement="above"
              width={300}
              label="Vault settings"
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
              <BarButton title="Lock this vault and return to the vault list" onClick={() => void props.runtime.lock()}>
                Lock
              </BarButton>
              <Switch>
                <Match when={status().vaultDrive === 'deleted'}>
                  <span style={{ color: tokens.danger }}>Deleted from Google Drive on another device</span>
                  <BarButton onClick={() => void props.runtime.keepLocalOnly()}>Keep local only</BarButton>
                  <BarButton danger onClick={() => openSettings('remove')}>
                    Remove from this device
                  </BarButton>
                </Match>
                <Match when={status().vaultDrive === 'local-only'}>Local only (this vault)</Match>
                <Match when={status().auth === 'unavailable'}>Local only</Match>
                <Match when={status().auth === 'signed-out'}>
                  Not syncing
                  <BarButton onClick={() => void signIn()}>Sign in with Google</BarButton>
                </Match>
                <Match when={status().auth === 'signing-in'}>Waiting for Google sign-in in your browser…</Match>
                <Match when={status().auth === 'expired'}>
                  <span style={{ color: tokens.danger }}>Google sign-in expired</span>
                  <BarButton onClick={() => void signIn()}>Sign in again</BarButton>
                </Match>
                <Match when={status().auth === 'stale'}>
                  {status().connection === 'open' ? 'Synced' : 'Offline; changes are queued'}
                  <BarButton title="Google access expired; renewing takes one click and no new consent" onClick={() => void signIn()}>
                    Renew Google access
                  </BarButton>
                </Match>
                <Match when={status().auth === 'signed-in'}>
                  {status().connection === 'open'
                    ? 'Synced'
                    : status().connection === 'connecting'
                      ? 'Connecting…'
                      : 'Offline; changes are queued'}
                  <BarButton onClick={() => void props.runtime.signOut()}>Sign out</BarButton>
                </Match>
              </Switch>
            </>
          }
        >
          <span style={{ display: 'flex', gap: '8px', 'align-items': 'center', 'white-space': 'nowrap' }}>
            <Switch>
              <Match when={status().vaultDrive === 'deleted'}>
                <BarButton compact danger onClick={() => openSettings('menu')}>
                  Deleted elsewhere
                </BarButton>
              </Match>
              <Match when={status().vaultDrive === 'local-only' || status().auth === 'unavailable'}>Local only</Match>
              <Match when={status().auth === 'signed-out'}>
                <BarButton compact onClick={() => void signIn()}>
                  Sign in
                </BarButton>
              </Match>
              <Match when={status().auth === 'signing-in'}>Signing in…</Match>
              <Match when={status().auth === 'expired'}>
                <BarButton compact danger onClick={() => void signIn()}>
                  Sign in again
                </BarButton>
              </Match>
              <Match when={status().auth === 'stale'}>
                <BarButton compact onClick={() => void signIn()}>
                  Renew
                </BarButton>
              </Match>
              <Match when={status().auth === 'signed-in'}>
                {status().connection === 'open' ? 'Synced' : status().connection === 'connecting' ? 'Connecting…' : 'Offline'}
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
              {...(props.compact ? { 'aria-label': `Word wrap (${wrap().shortcut})` } : {})}
              title="Wrap long lines in the editor"
              onClick={() => wrap().toggle()}
            >
              <span aria-hidden="true">↵</span>
              <Show when={!props.compact}>
                <span>Wrap ({wrap().shortcut})</span>
              </Show>
            </BarButton>
          )}
        </Show>
        <Show when={props.theme}>
          {(theme) => (
            <BarButton
              compact={props.compact}
              {...(props.compact ? { 'aria-label': `Theme: ${THEME_LABELS[theme().choice()]}` } : {})}
              title="Color theme: System, Light or Dark"
              onClick={() => theme().cycle()}
            >
              <ThemeIcon choice={theme().choice()} />
              <Show when={!props.compact}>
                <span>{THEME_LABELS[theme().choice()]}</span>
              </Show>
            </BarButton>
          )}
        </Show>
        {/* One button that spins while sync runs, so nothing beside it changes size. */}
        <Show when={status().connection !== 'off' || syncing()}>
          <BarButton
            compact={props.compact}
            aria-label="Sync now"
            aria-busy={syncing()}
            disabled={syncing()}
            title="Sync now: merge other devices' backups from Google Drive and back up"
            style={{ padding: '0 7px' }}
            onClick={() => void props.runtime.syncNow()}
          >
            <SyncIcon spinning={syncing()} />
          </BarButton>
        </Show>
        {/* Reserved while syncing or backed up; nothing to show leaves no gap at the edge. */}
        <Show when={status().connection !== 'off' || status().backup.kind !== 'never' || syncing()}>
          <BackupLabel
            compact={props.compact ?? false}
            text={status().catchingUp ? (props.compact ? null : 'Syncing…') : backupLabel(status().backup, props.compact ?? false)}
          />
        </Show>
      </span>
    </footer>
  );
}
