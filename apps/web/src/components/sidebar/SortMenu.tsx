import { createSignal, For, Show, type JSX } from 'solid-js';
import type { SortPreference } from '../../preferences/devicePreferences.js';
import { TOUCH_TARGET_PX, useNarrowScreen } from '../../layout/screen.js';
import { Popover } from '../Popover.jsx';
import { t, type MessageKey } from '../../i18n/index.js';
import type { SortKey } from './treeRows.js';
import { tokens } from './styles.js';

const CHOICES: readonly { readonly key: SortKey; readonly label: MessageKey }[] = [
  { key: 'modified', label: 'sort.modified' },
  { key: 'created', label: 'sort.created' },
  { key: 'name', label: 'sort.name' },
];

const headerButtonStyle: JSX.CSSProperties = {
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  font: tokens.font,
  color: 'inherit',
};

/** The "Sort" button beside the folder header and its menu: what to order by, and which way. */
export function SortMenu(props: { readonly sort: SortPreference }): JSX.Element {
  const [at, setAt] = createSignal<{ x: number; y: number } | null>(null);
  const narrow = useNarrowScreen();
  const itemStyle = (): JSX.CSSProperties => ({
    display: 'flex',
    gap: '8px',
    width: '100%',
    'text-align': 'left',
    border: 'none',
    background: 'transparent',
    padding: '4px 8px',
    'border-radius': tokens.radiusChip,
    font: tokens.font,
    color: 'inherit',
    cursor: 'pointer',
    ...(narrow() ? { 'min-height': `${TOUCH_TARGET_PX}px`, 'font-size': '16px', 'align-items': 'center' } : {}),
  });
  const mark = (on: boolean): JSX.Element => <span style={{ width: '1em' }}>{on ? '✓' : ''}</span>;

  return (
    <>
      <button
        type="button"
        aria-label={t('sort.button')}
        title={t('sort.button')}
        aria-haspopup="menu"
        style={headerButtonStyle}
        onClick={(event) => {
          event.stopPropagation();
          setAt({ x: event.clientX, y: event.clientY });
        }}
      >
        ⇅
      </button>
      <Show when={at()}>
        {(position) => (
          <Popover role="menu" label={t('sort.button')} onClose={() => setAt(null)} at={position()} width={200} style={{ padding: '6px' }}>
            <For each={CHOICES}>
              {(choice) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={props.sort.order().key === choice.key}
                  style={itemStyle()}
                  onClick={() => {
                    props.sort.set({ ...props.sort.order(), key: choice.key });
                    setAt(null);
                  }}
                >
                  {mark(props.sort.order().key === choice.key)}
                  {t(choice.label)}
                </button>
              )}
            </For>
            <div role="separator" style={{ 'border-top': `1px solid ${tokens.border}`, margin: '4px 0' }} />
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={props.sort.order().reversed}
              style={itemStyle()}
              onClick={() => {
                props.sort.set({ ...props.sort.order(), reversed: !props.sort.order().reversed });
                setAt(null);
              }}
            >
              {mark(props.sort.order().reversed)}
              {t('sort.reverse')}
            </button>
          </Popover>
        )}
      </Show>
    </>
  );
}
