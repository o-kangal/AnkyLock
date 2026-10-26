import { createSignal, Show, type JSX } from 'solid-js';
import { buttonStyle, tokens } from '../components/sidebar/styles.js';
import { t } from '../i18n/index.js';

/** A new version, ready to switch to: the web app's waiting ServiceWorker, or a desktop update. */
export interface PendingUpdate {
  readonly message: string;
  readonly action: string;
  /** Shown on the button while `apply` runs. */
  readonly busy: string;
  /** Saves open notes, then switches; the app reloads or restarts when it does. */
  readonly apply: () => Promise<void>;
}

/** Bottom-corner notice that a new app version is ready. */
export function UpdateBanner(props: { readonly update: PendingUpdate | null }): JSX.Element {
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);

  const run = async (update: PendingUpdate): Promise<void> => {
    setBusy(true);
    setFailed(false);
    try {
      await update.apply();
    } catch (error) {
      console.error('Update failed', error);
      setFailed(true);
      setBusy(false);
    }
  };

  return (
    <Show when={props.update}>
      {(update) => (
        <div
          role="status"
          style={{
            position: 'fixed',
            right: '16px',
            bottom: '16px',
            display: 'flex',
            gap: '12px',
            'align-items': 'center',
            padding: '8px 8px 8px 12px',
            background: tokens.background,
            color: tokens.text,
            border: `1px solid ${tokens.border}`,
            'border-radius': tokens.radiusPanel,
            'box-shadow': `0 4px 12px ${tokens.shadow}`,
            font: tokens.font,
            'z-index': '1000',
          }}
        >
          {failed() ? t('update.failed') : update().message}
          <button type="button" disabled={busy()} style={{ ...buttonStyle, font: tokens.font }} onClick={() => void run(update())}>
            {busy() ? update().busy : update().action}
          </button>
        </div>
      )}
    </Show>
  );
}
