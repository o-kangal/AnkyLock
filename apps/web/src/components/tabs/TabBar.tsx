import { createSignal, For, Show, type JSX } from 'solid-js';
import type { NoteId } from '@ankylock/core';
import { tabLabel, type WorkspaceStore } from '../../stores/workspaceStore.js';
import { tokens } from '../sidebar/styles.js';
import { t } from '../../i18n/index.js';

export interface TabBarProps {
  readonly store: WorkspaceStore;
  /** Whether a scratchpad's doc is still empty and untouched; such tabs are discarded on close. */
  readonly isEmptyAndUnmodified?: (noteId: NoteId) => boolean;
  /** Narrow screens: touch-sized tabs that scroll sideways. */
  readonly compact?: boolean;
  /** Shows the ☰ button that opens the sidebar drawer. */
  readonly onOpenNavigation?: () => void;
  /** Shows a search button that opens the open note's find panel (touch screens have no Ctrl+F). */
  readonly onSearch?: () => void;
}

const tabStyle = (active: boolean, compact: boolean): JSX.CSSProperties => ({
  display: 'flex',
  'flex-shrink': '0',
  'align-items': 'center',
  gap: '6px',
  padding: '0 8px 0 12px',
  // Rounded on top, resting on the bar's bottom edge.
  'align-self': 'flex-end',
  height: compact ? '36px' : '28px',
  margin: '0 0 0 4px',
  'max-width': '200px',
  font: tokens.font,
  cursor: 'pointer',
  'user-select': 'none',
  'border-radius': `${tokens.radiusChip} ${tokens.radiusChip} 0 0`,
  background: active ? tokens.activeBackground : 'transparent',
});

const buttonStyle: JSX.CSSProperties = {
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  font: tokens.font,
  padding: '0 6px',
};

/** Open tabs: instant `Untitled-N` creation, close, and drag reordering. */
export function TabBar(props: TabBarProps): JSX.Element {
  const [dragFrom, setDragFrom] = createSignal<number | null>(null);

  const close = (index: number, noteId: NoteId): void => {
    void props.store.closeTab(index, props.isEmptyAndUnmodified?.(noteId) ?? false);
  };

  return (
    <div
      role="tablist"
      style={{
        display: 'flex',
        'align-items': 'stretch',
        // Keeps its height when no tab is open; the tabs alone would otherwise set it.
        'min-height': props.compact ? '40px' : '32px',
        'flex-shrink': '0',
        'border-bottom': `1px solid ${tokens.border}`,
        background: tokens.surface,
        'overflow-x': 'auto',
        'scrollbar-width': 'thin',
      }}
    >
      <Show when={props.onOpenNavigation}>
        {(openNavigation) => (
          <button
            type="button"
            aria-label={t('tabs.openNavigation')}
            style={{ ...buttonStyle, 'min-width': '40px', 'font-size': '18px', 'flex-shrink': '0' }}
            onClick={() => openNavigation()()}
          >
            ☰
          </button>
        )}
      </Show>
      <For each={props.store.state.tabs}>
        {(tab, index) => (
          <div
            role="tab"
            draggable={true}
            aria-selected={index() === props.store.state.activeTabIndex}
            style={tabStyle(index() === props.store.state.activeTabIndex, props.compact ?? false)}
            onClick={() => props.store.activateTab(index())}
            onAuxClick={(e) => e.button === 1 && close(index(), tab.noteId)}
            onDragStart={() => setDragFrom(index())}
            onDragOver={(e) => dragFrom() !== null && e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const from = dragFrom();
              if (from !== null) props.store.moveTab(from, index());
              setDragFrom(null);
            }}
            onDragEnd={() => setDragFrom(null)}
          >
            <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}>
              {tabLabel(tab, props.store.state.notes[tab.noteId])}
            </span>
            <button
              type="button"
              aria-label={t('tabs.close')}
              style={props.compact ? { ...buttonStyle, 'min-width': '32px', height: '100%' } : buttonStyle}
              onClick={(e) => {
                e.stopPropagation();
                close(index(), tab.noteId);
              }}
            >
              ×
            </button>
          </div>
        )}
      </For>
      <button
        type="button"
        aria-label={t('tabs.new')}
        style={props.compact ? { ...buttonStyle, 'min-width': '40px', 'flex-shrink': '0' } : buttonStyle}
        onClick={() => void props.store.createTab()}
      >
        +
      </button>
      <Show when={props.onSearch}>
        {(search) => (
          <button
            type="button"
            aria-label={t('tabs.search')}
            // Stays in view at the right edge while the tabs scroll sideways under it.
            style={{
              ...buttonStyle,
              position: 'sticky',
              right: '0',
              'margin-left': 'auto',
              'min-width': '40px',
              'flex-shrink': '0',
              background: tokens.surface,
              color: 'inherit',
            }}
            onClick={() => search()()}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style={{ display: 'block', margin: 'auto' }}>
              <circle cx="6.5" cy="6.5" r="4.75" fill="none" stroke="currentColor" stroke-width="1.5" />
              <path d="M10 10l4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </button>
        )}
      </Show>
    </div>
  );
}
