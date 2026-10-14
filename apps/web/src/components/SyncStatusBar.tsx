import { createSignal, Match, Show, Switch, type JSX } from 'solid-js';
import type { BackupStatus } from '@ankylock/sync';
import type { Runtime } from '../runtime/createRuntime.js';
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
    case 'ok':
      return `Backed up ${new Date(backup.at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
    case 'error':
      return {
        quota: 'Google Drive is full; backup paused',
        auth: 'Drive access denied; sign in again',
        network: 'Backup waiting for a connection',
        http: 'Backup failed; will retry',
        snapshot: 'Backup failed; will retry',
      }[backup.reason];
  }
}

/**
 * Non-intrusive status line (SPEC §7): the open vault, sign-in, relay connection and Drive backup
 * state. Sync problems never block local editing; they only show up here.
 */
export function SyncStatusBar(props: { readonly runtime: Runtime }): JSX.Element {
  const status = (): ReturnType<Runtime['syncStatus']> => props.runtime.syncStatus();
  const [error, setError] = createSignal<string | null>(null);

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
        <span style={{ color: 'CanvasText' }}>{props.runtime.vaultName() ?? 'Unnamed vault'}</span>
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
      <span>{backupLabel(status().backup)}</span>
    </footer>
  );
}
