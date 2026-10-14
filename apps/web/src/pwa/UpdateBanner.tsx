import { createSignal, Show, type JSX } from 'solid-js';
import { tokens } from '../components/sidebar/styles.js';

/**
 * Bottom-corner notice that a new app version is ready. Reload saves open notes first, then
 * activates the new ServiceWorker; the page reloads when it takes control.
 */
export function UpdateBanner(props: {
  readonly activate: (() => void) | null;
  readonly beforeReload: () => Promise<void>;
}): JSX.Element {
  const [busy, setBusy] = createSignal(false);

  const reload = async (activate: () => void): Promise<void> => {
    setBusy(true);
    await props.beforeReload();
    activate();
  };

  return (
    <Show when={props.activate}>
      {(activate) => (
        <div
          role="status"
          style={{
            position: 'fixed',
            right: '16px',
            bottom: '16px',
            display: 'flex',
            gap: '12px',
            'align-items': 'center',
            padding: '8px 12px',
            background: 'Canvas',
            color: 'CanvasText',
            border: `1px solid ${tokens.border}`,
            'box-shadow': '0 4px 12px rgba(0, 0, 0, 0.18)',
            font: tokens.font,
            'z-index': '1000',
          }}
        >
          A new version of AnkyLock is available.
          <button type="button" disabled={busy()} style={{ font: tokens.font, cursor: 'pointer' }} onClick={() => void reload(activate())}>
            {busy() ? 'Saving…' : 'Reload'}
          </button>
        </div>
      )}
    </Show>
  );
}
