import { For, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { shortcutGuide } from '../keyboard/shortcutGuide.js';
import { formatKeys, isApplePlatform, type Platform } from '../keyboard/shortcuts.js';
import { t } from '../i18n/index.js';
import { buttonStyle, tokens } from './sidebar/styles.js';

const kbdStyle: JSX.CSSProperties = {
  display: 'inline-block',
  'min-width': '1.4em',
  padding: '1px 5px',
  'text-align': 'center',
  font: tokens.font,
  'font-size': '12px',
  color: tokens.text,
  background: tokens.background,
  border: `1px solid ${tokens.border}`,
  'border-bottom-width': '2px',
  'border-radius': '4px',
};

/** Mouse actions are words, translated; keys stay as printed on the keyboard. */
const keyName = (key: string): string => (key === 'Click' ? t('keys.click') : key === 'Drag' ? t('keys.drag') : key);

function Keys(props: { readonly keys: string; readonly apple: boolean }): JSX.Element {
  return (
    <span style={{ display: 'inline-flex', gap: '3px', 'align-items': 'center' }}>
      <For each={formatKeys(props.keys, props.apple)}>{(key) => <kbd style={kbdStyle}>{keyName(key)}</kbd>}</For>
    </span>
  );
}

/** Every keyboard shortcut, grouped (F1 or the status bar button); Escape or a click outside closes it. */
export function ShortcutGuide(props: { readonly platform: Platform; readonly onClose: () => void }): JSX.Element {
  const apple = isApplePlatform();
  return (
    <Portal>
      <div
        style={{ position: 'fixed', inset: '0', 'z-index': '1500', display: 'grid', 'place-items': 'center', background: tokens.overlay }}
        onClick={(event) => event.target === event.currentTarget && props.onClose()}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          props.onClose();
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('guide.title')}
          style={{
            width: '560px',
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
          <div style={{ display: 'flex', 'justify-content': 'space-between', 'align-items': 'center', 'margin-bottom': '8px' }}>
            <strong style={{ 'font-size': '15px' }}>{t('guide.title')}</strong>
            <button
              type="button"
              ref={(el) => queueMicrotask(() => el.focus())}
              style={{ ...buttonStyle, font: tokens.font }}
              onClick={() => props.onClose()}
            >
              {t('guide.close')}
            </button>
          </div>
          <For each={shortcutGuide(props.platform, apple)}>
            {(group) => (
              <section style={{ 'margin-top': '12px' }}>
                <h3 style={{ margin: '0 0 4px', 'font-size': '12px', 'text-transform': 'uppercase', color: tokens.muted }}>{t(group.title)}</h3>
                <For each={group.entries}>
                  {(entry) => (
                    <div style={{ display: 'flex', 'justify-content': 'space-between', gap: '12px', padding: '4px 0', 'border-bottom': `1px solid ${tokens.border}` }}>
                      <span>{t(entry.action)}</span>
                      <span style={{ display: 'inline-flex', gap: '6px', 'align-items': 'center', 'flex-wrap': 'wrap', 'justify-content': 'flex-end' }}>
                        <For each={entry.keys}>
                          {(keys, index) => (
                            <>
                              {index() > 0 && <span style={{ color: tokens.muted, 'font-size': '12px' }}>{t('keys.or')}</span>}
                              <Keys keys={keys} apple={apple} />
                            </>
                          )}
                        </For>
                      </span>
                    </div>
                  )}
                </For>
              </section>
            )}
          </For>
        </div>
      </div>
    </Portal>
  );
}
