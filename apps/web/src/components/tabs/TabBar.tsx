import { createSignal, For, type JSX } from 'solid-js';
import type { NoteId } from '@ankylock/core';
import { tabLabel, type WorkspaceStore } from '../../stores/workspaceStore.js';
import { tokens } from '../sidebar/styles.js';

export interface TabBarProps {
  readonly store: WorkspaceStore;
  /** Whether a scratchpad's doc is still empty and untouched; such tabs are discarded on close. */
  readonly isEmptyAndUnmodified?: (noteId: NoteId) => boolean;
}

const tabStyle = (active: boolean): JSX.CSSProperties => ({
  display: 'flex',
  'align-items': 'center',
  gap: '6px',
  padding: '0 8px 0 12px',
  height: '32px',
  'max-width': '200px',
  font: tokens.font,
  cursor: 'pointer',
  'user-select': 'none',
  'border-right': `1px solid ${tokens.border}`,
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
    <div role="tablist" style={{ display: 'flex', 'align-items': 'stretch', 'border-bottom': `1px solid ${tokens.border}` }}>
      <For each={props.store.state.tabs}>
        {(tab, index) => (
          <div
            role="tab"
            draggable={true}
            aria-selected={index() === props.store.state.activeTabIndex}
            style={tabStyle(index() === props.store.state.activeTabIndex)}
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
              aria-label="Close tab"
              style={buttonStyle}
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
      <button type="button" aria-label="New tab" style={buttonStyle} onClick={() => void props.store.createTab()}>
        +
      </button>
    </div>
  );
}
