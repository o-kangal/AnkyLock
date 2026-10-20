import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { createSignal, Match, onCleanup, Switch, type JSX } from 'solid-js';
import { bytesToBase64, createWorkerSealer, type MessagePortLike } from '@ankylock/crypto';
import CryptoWorker from '@ankylock/crypto/worker?worker';
import { TauriVaultDirectory } from '@ankylock/storage';
import { createAuthSession } from '@ankylock/sync';
import { AnkyLockApp, CLOSE_BACKUP_WAIT_MS, createRuntime, tokens } from '@ankylock/web/workspace';
import { guardWindowClose, type CloseState, type WindowCloseGuard } from './closeGuard.js';
import { createTauriAuthTransport } from './googleAuthTransport.js';
import { TitleBar } from './TitleBar.jsx';

/**
 * Desktop composition: notes persist through Tauri IPC into one SQLite database per vault in the
 * Rust host, and all
 * encryption runs in a Dedicated Web Worker holding the vault key.
 */
export function App(): JSX.Element {
  const worker = new CryptoWorker();
  const sealer = createWorkerSealer(worker as MessagePortLike);
  const auth = createAuthSession(createTauriAuthTransport(), { onError: (error) => console.error(error) });
  const runtime = createRuntime({
    vaults: new TauriVaultDirectory(),
    sealer,
    auth,
    relayUrl: import.meta.env.VITE_RELAY_URL ?? 'ws://127.0.0.1:8787/ws',
    onError: (message) => console.error(message),
  });
  const [closing, setClosing] = createSignal<CloseState>('open');
  const closeGuard = guardWindowClose(getCurrentWindow(), runtime, setClosing, CLOSE_BACKUP_WAIT_MS);
  onCleanup(() => {
    closeGuard.dispose();
    auth.dispose();
    sealer.dispose();
    worker.terminate();
  });

  return (
    <div style={{ display: 'flex', 'flex-direction': 'column', height: '100%' }}>
      <TitleBar />
      <div style={{ flex: '1', 'min-height': '0' }}>
        <AnkyLockApp
          runtime={runtime}
          platform="desktop"
          // The host checks the scheme again and hands the link to the system browser.
          openLink={(url) => void invoke('link_open', { url }).catch((error: unknown) => console.error(error))}
          // Native save dialog; the host writes the file where the user picks.
          saveFile={(file) => invoke<boolean>('export_save', { file: { name: file.name, bytes: bytesToBase64(file.bytes) } })}
        />
      </div>
      <CloseDialog state={closing()} guard={closeGuard} />
    </div>
  );
}

const dialogButton: JSX.CSSProperties = { font: tokens.font, padding: '6px 14px', cursor: 'pointer' };

/** Shown while the last backup runs on close, and when it could not finish. */
function CloseDialog(props: { readonly state: CloseState; readonly guard: WindowCloseGuard }): JSX.Element {
  return (
    <Switch>
      <Match when={props.state !== 'open'}>
        <div
          style={{ position: 'fixed', inset: '0', 'z-index': '2000', display: 'grid', 'place-items': 'center', background: tokens.overlay }}
        >
          <div
            role={props.state === 'unbacked' ? 'alertdialog' : 'status'}
            aria-label={props.state === 'unbacked' ? 'Not backed up' : 'Backing up'}
            style={{
              width: '360px',
              'max-width': 'calc(100% - 32px)',
              padding: '16px 18px',
              'box-sizing': 'border-box',
              font: tokens.font,
              color: tokens.text,
              background: tokens.surface,
              border: `1px solid ${tokens.border}`,
              'border-radius': '6px',
              'box-shadow': `0 8px 24px ${tokens.shadow}`,
            }}
          >
            <Switch>
              <Match when={props.state === 'backing-up'}>Backing up to Google Drive before closing…</Match>
              <Match when={props.state === 'unbacked'}>
                <strong>Your latest changes are not in Google Drive yet</strong>
                <p style={{ margin: '8px 0 14px', color: tokens.muted }}>
                  They are saved on this device and will be backed up the next time AnkyLock runs. Wait to keep the app
                  open while it retries in the background.
                </p>
                <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end' }}>
                  <button type="button" style={dialogButton} onClick={() => void props.guard.quit()}>
                    Quit anyway
                  </button>
                  <button type="button" style={dialogButton} autofocus onClick={() => props.guard.stay()}>
                    Wait
                  </button>
                </div>
              </Match>
            </Switch>
          </div>
        </div>
      </Match>
    </Switch>
  );
}
