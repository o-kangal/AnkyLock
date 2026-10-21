import { createSignal, Match, Show, Switch, type JSX } from 'solid-js';
import { MAX_RETENTION_DAYS } from '@ankylock/core';
import type { WorkspaceStore } from '../../stores/workspaceStore.js';
import { Popover } from '../Popover.jsx';
import { buttonStyle, fieldStyle, rowStyle, tokens } from './styles.js';

const iconButton: JSX.CSSProperties = {
  display: 'inline-flex',
  'align-items': 'center',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  padding: '2px 4px',
  cursor: 'pointer',
};

const actionButton: JSX.CSSProperties = { ...buttonStyle, font: tokens.font, padding: '3px 10px' };

const POPOVER_WIDTH = 260;
const popoverStyle: JSX.CSSProperties = { padding: '10px 12px' };

function GearIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

function BinIcon(): JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />
    </svg>
  );
}

/** Trash retention setting (BR-LIFE-03) with the SPEC §6 confirmation before shortening it purges items. */
function RetentionSettings(props: { readonly store: WorkspaceStore; readonly onDone: () => void }): JSX.Element {
  const initial = props.store.state.retentionDays;
  const [manual, setManual] = createSignal(initial === 0);
  const [days, setDays] = createSignal(String(initial === 0 ? 28 : initial));
  const [affected, setAffected] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  const value = (): number => (manual() ? 0 : Number(days()));

  const apply = async (confirmed: boolean): Promise<void> => {
    setError(null);
    const result = await props.store.changeRetention(value(), confirmed);
    if (!result.ok) setError(result.error.message);
    else if (result.value.kind === 'confirm_required') setAffected(result.value.affected);
    else props.onDone();
  };

  return (
    <>
      <Switch>
        <Match when={affected() === null}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void apply(false);
            }}
          >
            <label style={{ display: 'block' }}>
              Delete items in Trash after{' '}
              <input
                type="number"
                aria-label="Retention days"
                min="1"
                max={MAX_RETENTION_DAYS}
                disabled={manual()}
                value={days()}
                onInput={(e) => setDays(e.currentTarget.value)}
                style={{ ...fieldStyle, width: '56px', padding: '2px 6px', font: tokens.font }}
              />{' '}
              days
            </label>
            <label style={{ display: 'flex', gap: '6px', 'align-items': 'center', margin: '8px 0' }}>
              <input
                type="checkbox"
                aria-label="Never delete automatically"
                checked={manual()}
                onChange={(e) => setManual(e.currentTarget.checked)}
              />
              Never delete automatically
            </label>
            <button type="submit" style={actionButton}>
              Save
            </button>
          </form>
        </Match>
        <Match when={affected() !== null}>
          <p style={{ margin: '0 0 8px' }}>
            {affected()} {affected() === 1 ? 'item' : 'items'} in Trash will be deleted permanently now. Continue?
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" style={{ ...actionButton, color: tokens.danger }} onClick={() => void apply(true)}>
              Delete and save
            </button>
            <button type="button" style={actionButton} onClick={() => setAffected(null)}>
              Cancel
            </button>
          </div>
        </Match>
      </Switch>
      <Show when={error()}>
        <div role="alert" style={{ color: tokens.danger, 'margin-top': '6px' }}>
          {error()}
        </div>
      </Show>
    </>
  );
}

/** Header of the Trash view: retention settings (gear) and Empty Trash (bin), each in a popover. */
export function TrashToolbar(props: { readonly store: WorkspaceStore }): JSX.Element {
  let row!: HTMLDivElement;
  const [open, setOpen] = createSignal<'settings' | 'empty' | null>(null);
  /** Opens below the toolbar, right-aligned with it. */
  const anchor = () => {
    const rect = row.getBoundingClientRect();
    return { x: rect.right - POPOVER_WIDTH, y: rect.bottom + 2 };
  };
  const [error, setError] = createSignal<string | null>(null);
  const count = (): number =>
    props.store.state.folders.filter((f) => f.deletedAt !== null).length +
    Object.values(props.store.state.notes).filter((n) => n.deletedAt !== null).length;

  const toggle = (panel: 'settings' | 'empty'): void => {
    setError(null);
    setOpen((current) => (current === panel ? null : panel));
  };

  const empty = async (): Promise<void> => {
    const result = await props.store.emptyTrash();
    if (result.ok) setOpen(null);
    else setError(result.error.message);
  };

  return (
    <div ref={row} style={{ ...rowStyle(0), cursor: 'default', color: tokens.muted }}>
      <span style={{ flex: '1' }}>Trash</span>
      <button type="button" aria-label="Trash settings" title="Trash settings" style={iconButton} onClick={() => toggle('settings')}>
        <GearIcon />
      </button>
      <button
        type="button"
        aria-label="Empty Trash"
        title="Empty Trash"
        disabled={count() === 0}
        style={{ ...iconButton, opacity: count() === 0 ? '0.4' : '1' }}
        onClick={() => toggle('empty')}
      >
        <BinIcon />
      </button>
      <Show when={open() === 'settings'}>
        <Popover label="Trash settings" at={anchor()} width={POPOVER_WIDTH} onClose={() => setOpen(null)} style={popoverStyle}>
          <RetentionSettings store={props.store} onDone={() => setOpen(null)} />
        </Popover>
      </Show>
      <Show when={open() === 'empty'}>
        <Popover label="Empty Trash" at={anchor()} width={POPOVER_WIDTH} onClose={() => setOpen(null)} style={popoverStyle}>
          <p style={{ margin: '0 0 8px', color: tokens.text }}>
            Permanently delete all {count()} {count() === 1 ? 'item' : 'items'} in Trash? This cannot be undone.
          </p>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button type="button" style={{ ...actionButton, color: tokens.danger }} onClick={() => void empty()}>
              Delete permanently
            </button>
            <button type="button" style={actionButton} onClick={() => setOpen(null)}>
              Cancel
            </button>
          </div>
          <Show when={error()}>
            <div role="alert" style={{ color: tokens.danger, 'margin-top': '6px' }}>
              {error()}
            </div>
          </Show>
        </Popover>
      </Show>
    </div>
  );
}
