import { Show, type JSX } from 'solid-js';
import { buttonStyle, tokens } from '../components/sidebar/styles.js';
import { TOUCH_TARGET_PX } from '../layout/screen.js';
import { t } from '../i18n/index.js';
import type { InstallSuggestion } from './install.js';

const actionStyle: JSX.CSSProperties = { ...buttonStyle, font: tokens.font, 'min-height': `${TOUCH_TARGET_PX}px` };
const quietStyle: JSX.CSSProperties = { ...actionStyle, background: 'transparent', border: 'none', color: tokens.muted };

const promptOf = (suggestion: InstallSuggestion): Extract<InstallSuggestion, { kind: 'prompt' }> | null =>
  suggestion.kind === 'prompt' ? suggestion : null;

/** The iOS Share icon (a box with an arrow), so the instruction points at what users see. */
function ShareIcon(): JSX.Element {
  return (
    <svg width="14" height="16" viewBox="0 0 14 16" aria-hidden="true" style={{ 'vertical-align': '-2px', margin: '0 2px' }}>
      <path d="M7 1v9M3.5 4.5 7 1l3.5 3.5M4.5 7H2v8h10V7H9.5" fill="none" stroke="currentColor" stroke-width="1.4" />
    </svg>
  );
}

/** Bottom notice on phones and tablets suggesting to add AnkyLock to the home screen. */
export function InstallBanner(props: {
  readonly suggestion: InstallSuggestion | null;
  readonly onLater: () => void;
  readonly onNever: () => void;
}): JSX.Element {
  return (
    <Show when={props.suggestion}>
      {(suggestion) => (
        <div
          role="status"
          style={{
            position: 'fixed',
            left: '16px',
            right: '16px',
            bottom: '16px',
            display: 'flex',
            'flex-direction': 'column',
            gap: '8px',
            padding: '12px',
            background: tokens.background,
            color: tokens.text,
            border: `1px solid ${tokens.border}`,
            'border-radius': tokens.radiusPanel,
            'box-shadow': `0 4px 12px ${tokens.shadow}`,
            font: tokens.font,
            'font-size': '16px',
            'z-index': '1000',
          }}
        >
          <span>
            {t('install.message')}{' '}
            <Show when={suggestion().kind === 'ios'}>
              {t('install.iosBefore')}
              <ShareIcon />
              {t('install.iosAfter')}
            </Show>
          </span>
          <div style={{ display: 'flex', 'flex-wrap': 'wrap', gap: '8px', 'justify-content': 'flex-end' }}>
            <button type="button" style={quietStyle} onClick={() => props.onNever()}>
              {t('install.never')}
            </button>
            <button type="button" style={quietStyle} onClick={() => props.onLater()}>
              {t('install.later')}
            </button>
            <Show when={promptOf(suggestion())}>
              {(prompt) => (
                <button type="button" style={actionStyle} onClick={() => void prompt().install()}>
                  {t('install.action')}
                </button>
              )}
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}
