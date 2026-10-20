import { onMount, Show, type JSX } from 'solid-js';
import type { DragDropManager, DragItem } from '../../dnd/dragDropManager.js';
import type { NoteView, WorkspaceStore } from '../../stores/workspaceStore.js';
import { useNarrowScreen } from '../../layout/screen.js';
import { longPress, RowMenuButton } from './rowMenu.jsx';
import { createHover, itemRowHeight, itemStyle } from './styles.js';

export interface NoteItemProps {
  readonly store: WorkspaceStore;
  readonly dnd: DragDropManager;
  readonly note: NoteView;
  readonly depth: number;
  readonly onItemMenu?: (event: MouseEvent, item: DragItem) => void;
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

  const narrow = useNarrowScreen();
  const [hovered, hover] = createHover();
  const openMenu = (event: MouseEvent): void => props.onItemMenu?.(event, { kind: 'note', id: props.note.id });

  return (
    <div
      {...props.dnd.dragSource(() => ({ kind: 'note', id: props.note.id }))}
      {...longPress(openMenu)}
      {...hover}
      data-note-id={props.note.id}
      style={itemStyle(props.depth, { active: active(), hovered: hovered() }, itemRowHeight(narrow()))}
      title={props.note.title ?? 'Untitled'}
      onClick={() => props.store.openNote(props.note.id)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        props.onItemMenu?.(event, { kind: 'note', id: props.note.id });
      }}
    >
      <span style={{ opacity: props.note.title ? '1' : '0.6', overflow: 'hidden', 'text-overflow': 'ellipsis' }}>
        {props.note.title ?? 'Untitled'}
      </span>
      <Show when={narrow() && props.onItemMenu}>
        <RowMenuButton label={props.note.title ?? 'Untitled'} onOpen={openMenu} />
      </Show>
    </div>
  );
}
