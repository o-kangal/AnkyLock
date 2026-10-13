import { onMount, type JSX } from 'solid-js';
import type { DragDropManager } from '../../dnd/dragDropManager.js';
import type { NoteView, WorkspaceStore } from '../../stores/workspaceStore.js';
import { rowStyle } from './styles.js';

export interface NoteItemProps {
  readonly store: WorkspaceStore;
  readonly dnd: DragDropManager;
  readonly note: NoteView;
  readonly depth: number;
}

/** One note row. Its title is decrypted lazily when the (virtualized) row first renders. */
export function NoteItem(props: NoteItemProps): JSX.Element {
  onMount(() => {
    if (props.note.title === undefined) void props.store.loadTitle(props.note.id);
  });

  const active = (): boolean => {
    const { tabs, activeTabIndex } = props.store.state;
    return tabs[activeTabIndex]?.noteId === props.note.id;
  };

  return (
    <div
      {...props.dnd.dragSource(() => ({ kind: 'note', id: props.note.id }))}
      data-note-id={props.note.id}
      style={rowStyle(props.depth, active())}
      title={props.note.title ?? 'Untitled'}
      onClick={() => props.store.openNote(props.note.id)}
    >
      <span style={{ opacity: props.note.title ? '1' : '0.6' }}>{props.note.title ?? 'Untitled'}</span>
    </div>
  );
}
