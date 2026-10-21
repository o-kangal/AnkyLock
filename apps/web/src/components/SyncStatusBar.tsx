import { createSignal, Match, Show, Switch, type JSX } from 'solid-js';
import type { BackupStatus } from '@ankylock/sync';
import type { Runtime } from '../runtime/createRuntime.js';
import { THEME_LABELS, ThemeIcon } from './ThemeIcon.jsx';
import type { ThemePreference } from '../theme/colorScheme.js';
import { Popover, type PopoverPosition } from './Popover.jsx';
import { VaultSettings, type VaultSettingsView } from './VaultSettings.jsx';
import { tokens } from './sidebar/styles.js';

const linkButton: JSX.CSSProperties = {
  border: 'none',
  background: 'transparent',
  // Vertical padding widens the click target without changing how the link looks.
  padding: '6px 2px',
  color: tokens.accent,
  cursor: 'pointer',
  font: tokens.font,
  'text-decoration': 'underline',
};

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

const iconButton: JSX.CSSProperties = {
  display: 'inline-flex',
  border: 'none',
  background: 'transparent',
  padding: '6px',
  color: 'inherit',
  cursor: 'pointer',
};

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
        // Tall enough for easy clicks, with links clear of the frameless window's bottom resize edge.
        'min-height': '40px',
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
      <span style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
        <button
          ref={vaultButton}
          type="button"
          aria-haspopup="dialog"
          title="Vault settings: rename, remove or delete"
          style={{
            ...linkButton,
            color: tokens.text,
            'text-decoration': 'none',
            'white-space': 'nowrap',
            overflow: 'hidden',
            'text-overflow': 'ellipsis',
            'max-width': props.compact ? '40vw' : 'none',
            ...(props.compact ? { 'min-height': '40px' } : {}),
          }}
          onClick={() => openSettings('menu')}
        >
          {props.runtime.vaultName() ?? 'Unnamed vault'} ▾
        </button>
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
        <Show when={props.compact} fallback={<>
        <button
          type="button"
          style={linkButton}
          title="Lock this vault and return to the vault list"
          onClick={() => void props.runtime.lock()}
        >
          Lock
        </button>
        <span aria-hidden="true">|</span>
        <Switch>
          <Match when={status().vaultDrive === 'deleted'}>
            <span style={{ color: tokens.danger }}>Deleted from Google Drive on another device</span> ·
            <button type="button" style={linkButton} onClick={() => void props.runtime.keepLocalOnly()}>
              Keep local only
            </button>
            ·
            <button type="button" style={linkButton} onClick={() => openSettings('remove')}>
              Remove from this device
            </button>
          </Match>
          <Match when={status().vaultDrive === 'local-only'}>Local only (this vault)</Match>
          <Match when={status().auth === 'unavailable'}>Local only</Match>
          <Match when={status().auth === 'signed-out'}>
            Not syncing ·
            <button type="button" style={linkButton} onClick={() => void signIn()}>
              Sign in with Google
            </button>
          </Match>
          <Match when={status().auth === 'signing-in'}>Waiting for Google sign-in in your browser…</Match>
          <Match when={status().auth === 'expired'}>
            <span style={{ color: tokens.danger }}>Google sign-in expired</span> ·
            <button type="button" style={linkButton} onClick={() => void signIn()}>
              Sign in again
            </button>
          </Match>
          <Match when={status().auth === 'stale'}>
            {status().connection === 'open' ? 'Synced' : 'Offline; changes are queued'} ·
            <button
              type="button"
              style={linkButton}
              title="Google access expired; renewing takes one click and no new consent"
              onClick={() => void signIn()}
            >
              Renew Google access
            </button>
          </Match>
          <Match when={status().auth === 'signed-in'}>
            {status().connection === 'open'
              ? 'Synced'
              : status().connection === 'connecting'
                ? 'Connecting…'
                : 'Offline; changes are queued'}{' '}
            ·
            <button type="button" style={linkButton} onClick={() => void props.runtime.signOut()}>
              Sign out
            </button>
          </Match>
        </Switch>
        </>}>
          <span style={{ 'white-space': 'nowrap' }}>
            <Switch>
              <Match when={status().vaultDrive === 'deleted'}>
                <button type="button" style={{ ...linkButton, color: tokens.danger }} onClick={() => openSettings('menu')}>
                  Deleted elsewhere
                </button>
              </Match>
              <Match when={status().vaultDrive === 'local-only' || status().auth === 'unavailable'}>Local only</Match>
              <Match when={status().auth === 'signed-out'}>
                <button type="button" style={linkButton} onClick={() => void signIn()}>
                  Sign in
                </button>
              </Match>
              <Match when={status().auth === 'signing-in'}>Signing in…</Match>
              <Match when={status().auth === 'expired'}>
                <button type="button" style={{ ...linkButton, color: tokens.danger }} onClick={() => void signIn()}>
                  Sign in again
                </button>
              </Match>
              <Match when={status().auth === 'stale'}>
                <button type="button" style={linkButton} onClick={() => void signIn()}>
                  Renew
                </button>
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
      <span style={{ display: 'flex', gap: '6px', 'align-items': 'center' }}>
        <Show when={props.wordWrap}>
          {(wrap) => (
            <button
              type="button"
              aria-pressed={wrap().on()}
              {...(props.compact ? { 'aria-label': `Word wrap (${wrap().shortcut})` } : {})}
              title="Wrap long lines in the editor"
              style={{
                ...iconButton,
                ...(props.compact ? { 'min-width': '40px', 'min-height': '40px', 'justify-content': 'center', 'align-items': 'center' } : {}),
                padding: '6px 8px',
                'border-radius': tokens.radiusChip,
                font: tokens.font,
                'font-size': '12px',
                color: wrap().on() ? tokens.text : 'inherit',
                background: wrap().on() ? tokens.activeBackground : 'transparent',
              }}
              onClick={() => wrap().toggle()}
            >
              <span aria-hidden="true">↵</span>
              <Show when={!props.compact}>
                <span style={{ 'margin-left': '4px' }}>Wrap ({wrap().shortcut})</span>
              </Show>
            </button>
          )}
        </Show>
        <Show when={props.theme}>
          {(theme) => (
            <button
              type="button"
              {...(props.compact ? { 'aria-label': `Theme: ${THEME_LABELS[theme().choice()]}` } : {})}
              title="Color theme: System, Light or Dark"
              style={{
                ...iconButton,
                ...(props.compact ? { 'min-width': '40px', 'min-height': '40px', 'justify-content': 'center', 'align-items': 'center' } : {}),
                padding: '6px 8px',
                'align-items': 'center',
                gap: '4px',
                font: tokens.font,
                'font-size': '12px',
              }}
              onClick={() => theme().cycle()}
            >
              <ThemeIcon choice={theme().choice()} />
              <Show when={!props.compact}>
                <span>{THEME_LABELS[theme().choice()]}</span>
              </Show>
            </button>
          )}
        </Show>
        <Show
          when={status().catchingUp || status().backup.kind === 'running'}
          fallback={
            <Show when={status().connection !== 'off'}>
              <button
                type="button"
                aria-label="Sync now"
                title="Sync now: merge other devices' backups from Google Drive and back up"
                style={
                  props.compact
                    ? { ...iconButton, 'min-width': '40px', 'min-height': '40px', 'justify-content': 'center', 'align-items': 'center' }
                    : iconButton
                }
                onClick={() => void props.runtime.syncNow()}
              >
                <SyncIcon spinning={false} />
              </button>
            </Show>
          }
        >
          <span role="progressbar" aria-label="Syncing" style={{ display: 'inline-flex', padding: '6px' }}>
            <SyncIcon spinning={true} />
          </span>
        </Show>
        <span style={{ 'white-space': 'nowrap' }}>
          {status().catchingUp ? (props.compact ? '' : 'Syncing…') : backupLabel(status().backup, props.compact ?? false)}
        </span>
      </span>
    </footer>
  );
}
