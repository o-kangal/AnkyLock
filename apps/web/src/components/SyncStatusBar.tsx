import { createSignal, Match, Show, Switch, type JSX } from 'solid-js';
import type { BackupStatus } from '@ankylock/sync';
import type { Runtime } from '../runtime/createRuntime.js';
import { Popover, type PopoverPosition } from './Popover.jsx';
import { VaultSettings, type VaultSettingsView } from './VaultSettings.jsx';
import { tokens } from './sidebar/styles.js';

const linkButton: JSX.CSSProperties = {
  border: 'none',
  background: 'transparent',
  padding: '0',
  color: 'LinkText',
  cursor: 'pointer',
  font: tokens.font,
  'text-decoration': 'underline',
};

function backupLabel(backup: BackupStatus): string | null {
  switch (backup.kind) {
    case 'never':
      return null;
    case 'running':
      return 'Backing up…';
    case 'ok':
      return `Backed up ${new Date(backup.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
    case 'error':
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
  padding: '2px',
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

export function SyncStatusBar(props: { readonly runtime: Runtime; readonly wordWrap?: WordWrapToggle }): JSX.Element {
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
        // Tall enough that its links sit clear of the frameless window's bottom resize edge.
        'min-height': '30px',
        'box-sizing': 'border-box',
        padding: '0 12px',
        'border-top': `1px solid ${tokens.border}`,
        font: tokens.font,
        'font-size': '12px',
        color: tokens.muted,
      }}
    >
      <span style={{ display: 'flex', gap: '8px', 'align-items': 'center' }}>
        <button
          ref={vaultButton}
          type="button"
          aria-haspopup="dialog"
          title="Vault settings: rename, remove or delete"
          style={{ ...linkButton, color: 'CanvasText', 'text-decoration': 'none' }}
          onClick={() => openSettings('menu')}
        >
          {props.runtime.vaultName() ?? 'Unnamed vault'} ▾
        </button>
        <Show when={settings()}>
          {(open) => (
            <Popover at={open().at} placement="above" width={300} label="Vault settings" onClose={() => setSettings(null)}>
              <VaultSettings runtime={props.runtime} initialView={open().view} onClose={() => setSettings(null)} />
            </Popover>
          )}
        </Show>
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
              title="Wrap long lines in the editor"
              style={{
                ...iconButton,
                padding: '1px 6px',
                'border-radius': '3px',
                font: tokens.font,
                'font-size': '12px',
                color: wrap().on() ? 'CanvasText' : 'inherit',
                background: wrap().on() ? tokens.activeBackground : 'transparent',
              }}
              onClick={() => wrap().toggle()}
            >
              Wrap ({wrap().shortcut})
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
                style={iconButton}
                onClick={() => void props.runtime.syncNow()}
              >
                <SyncIcon spinning={false} />
              </button>
            </Show>
          }
        >
          <span role="progressbar" aria-label="Syncing" style={{ display: 'inline-flex', padding: '2px' }}>
            <SyncIcon spinning={true} />
          </span>
        </Show>
        <span>{status().catchingUp ? 'Syncing…' : backupLabel(status().backup)}</span>
      </span>
    </footer>
  );
}
