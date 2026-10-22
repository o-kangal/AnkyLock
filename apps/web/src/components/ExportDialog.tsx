import { createSignal, Show, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { MIN_EXPORT_PASSWORD_LENGTH } from '../export/exportNotes.js';
import type { ExportScope } from '../export/exportPlan.js';
import { useSaveFile } from '../export/saveFile.js';
import { touchSized, useNarrowScreen } from '../layout/screen.js';
import type { Runtime } from '../runtime/createRuntime.js';
import { t } from '../i18n/index.js';
import { buttonStyle, fieldStyle, tokens } from './sidebar/styles.js';

/**
 * Confirms an export: it says the files leave AnkyLock's protection, and offers an AES-256 zip
 * password with its trade-offs (needs a tool like 7-Zip; names inside stay readable).
 */
export function ExportDialog(props: {
  readonly runtime: Runtime;
  readonly scope: ExportScope;
  /** What is exported, e.g. `“Plans”` or `the vault “Personal”`. */
  readonly label: string;
  readonly onClose: () => void;
}): JSX.Element {
  const save = useSaveFile();
  const narrow = useNarrowScreen();
  const [protect, setProtect] = createSignal(false);
  const [password, setPassword] = createSignal('');
  const [confirm, setConfirm] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const problem = (): string | null => {
    if (!protect()) return null;
    if (password().length < MIN_EXPORT_PASSWORD_LENGTH) return t('unlock.passphraseTooShort', { min: MIN_EXPORT_PASSWORD_LENGTH });
    if (confirm() !== password()) return t('export.passwordMismatch');
    return null;
  };

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    if (busy() || problem() !== null) return;
    setBusy(true);
    setError(null);
    try {
      const file = await props.runtime.exportNotes(props.scope, protect() ? password() : null);
      if (await save(file)) props.onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const field = (): JSX.CSSProperties =>
    touchSized({ ...fieldStyle, display: 'block', width: '100%', 'box-sizing': 'border-box', padding: '5px 8px', 'margin-top': '6px', font: tokens.font }, narrow());
  const button = (): JSX.CSSProperties => touchSized({ ...buttonStyle, font: tokens.font, padding: '6px 14px' }, narrow());

  return (
    <Portal>
      <div
        style={{ position: 'fixed', inset: '0', 'z-index': '1500', display: 'grid', 'place-items': 'center', background: tokens.overlay }}
        onClick={(event) => event.target === event.currentTarget && !busy() && props.onClose()}
        onKeyDown={(event) => event.key === 'Escape' && !busy() && props.onClose()}
      >
        <form
          role="dialog"
          aria-label={t('export.title')}
          onSubmit={(event) => void submit(event)}
          style={{
            width: '380px',
            'max-width': 'calc(100% - 32px)',
            'max-height': 'calc(100% - 32px)',
            'overflow-y': 'auto',
            padding: '16px 18px',
            'box-sizing': 'border-box',
            font: tokens.font,
            color: tokens.text,
            background: tokens.surface,
            border: `1px solid ${tokens.border}`,
            'border-radius': tokens.radiusPanel,
            'box-shadow': `0 8px 24px ${tokens.shadow}`,
          }}
        >
          <strong>{t('export.heading', { what: props.label })}</strong>
          <p role="note" style={{ margin: '8px 0', color: tokens.danger }}>
            {t('export.warning')}
          </p>
          <p style={{ margin: '0 0 10px', color: tokens.muted }}>{t('export.note')}</p>
          <label style={{ display: 'flex', gap: '8px', 'align-items': 'center', cursor: 'pointer' }}>
            <input type="checkbox" checked={protect()} onChange={(e) => setProtect(e.currentTarget.checked)} />
            {t('export.protect')}
          </label>
          <Show when={protect()}>
            <input
              type="password"
              aria-label={t('export.zipPassword')}
              placeholder={t('export.password')}
              autocomplete="new-password"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
              style={field()}
            />
            <input
              type="password"
              aria-label={t('export.confirmZipPassword')}
              placeholder={t('export.confirmPassword')}
              autocomplete="new-password"
              value={confirm()}
              onInput={(e) => setConfirm(e.currentTarget.value)}
              style={field()}
            />
            <p role="note" style={{ margin: '8px 0 0', color: tokens.muted, 'font-size': '12px' }}>
              {t('export.zipNote')}
            </p>
            <Show when={password() !== '' && problem()}>
              <p role="alert" style={{ margin: '6px 0 0', color: tokens.danger }}>
                {problem()}
              </p>
            </Show>
          </Show>
          <Show when={error()}>
            <p role="alert" style={{ margin: '8px 0 0', color: tokens.danger }}>
              {error()}
            </p>
          </Show>
          <div style={{ display: 'flex', gap: '8px', 'justify-content': 'flex-end', 'margin-top': '14px' }}>
            <button type="button" style={button()} disabled={busy()} onClick={() => props.onClose()}>
              {t('common.cancel')}
            </button>
            <button type="submit" style={button()} disabled={busy() || problem() !== null}>
              {busy() ? t('export.exporting') : t('export.submit')}
            </button>
          </div>
        </form>
      </div>
    </Portal>
  );
}
