import { createMemo, createSignal, Match, Show, Switch, type JSX } from 'solid-js';
import type { FolderId } from '@ankylock/core';
import type { DragDropManager } from '../../dnd/dragDropManager.js';
import type { WorkspaceStore } from '../../stores/workspaceStore.js';
import { VirtualList } from '../VirtualList.jsx';
import type { MenuTarget } from './ContextMenu.jsx';
import { TrashToolbar } from './TrashToolbar.jsx';
import { NoteItem } from './NoteItem.jsx';
import { TOUCH_TARGET_PX, useNarrowScreen } from '../../layout/screen.js';
import { longPress, RowMenuButton } from './rowMenu.jsx';
import { rowStyle, tokens } from './styles.js';
import { buildTreeRows, type TreeRow } from './treeRows.js';

export interface FolderTreeProps {
  readonly store: WorkspaceStore;
  readonly dnd: DragDropManager;
  readonly onItemMenu?: (event: MouseEvent, item: MenuTarget) => void;
}

/**
 * Folder hierarchy and notes for the current selection, always rendered through a virtual list.
 * Folders are drag sources and drop targets; the empty area below the rows is the root target.
 */
export function FolderTree(props: FolderTreeProps): JSX.Element {
  const [expanded, setExpanded] = createSignal<ReadonlySet<FolderId>>(new Set());
  const rows = createMemo(() => buildTreeRows(props.store.state, expanded()));
  const narrow = useNarrowScreen();
  const rowHeight = (): number => (narrow() ? TOUCH_TARGET_PX : tokens.rowHeight);

  const toggle = (id: FolderId): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  const canCreate = (): boolean => {
    const { selection } = props.store.state;
    return selection.kind !== 'system' || selection.id === 'system_all';
  };

  return (
    <div
      {...props.dnd.dropTarget({ kind: 'root' })}
      style={{ flex: '1', 'min-height': '0', display: 'flex', 'flex-direction': 'column' }}
      data-testid="folder-tree"
      onContextMenu={(event) => {
        event.preventDefault();
        props.onItemMenu?.(event, { kind: 'root' });
      }}
    >
      <Show
        when={props.store.state.selection.kind === 'system' && props.store.state.selection.id === 'system_trash'}
        fallback={
          <div style={{ ...rowStyle(0, false, rowHeight()), cursor: 'default', color: tokens.muted, 'justify-content': 'space-between' }}>
            <span>Folders</span>
            <Show when={canCreate()}>
              <button
                type="button"
                aria-label="New folder"
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', font: tokens.font, color: 'inherit' }}
                onClick={(event) => props.onItemMenu?.(event, { kind: 'root' })}
              >
                +
              </button>
            </Show>
          </div>
        }
      >
        <TrashToolbar store={props.store} />
      </Show>
      <div style={{ flex: '1', 'min-height': '0' }}>
        <VirtualList items={rows()} rowHeight={rowHeight()}>
        {(row: TreeRow) => (
          <Switch>
            <Match when={row.kind === 'folder' && row}>
              {(folderRow) => {
                const openMenu = (event: MouseEvent): void =>
                  props.onItemMenu?.(event, { kind: 'folder', id: folderRow().folder.id });
                return (
                  <div
                    {...props.dnd.dragSource(() => ({ kind: 'folder', id: folderRow().folder.id }))}
                    {...props.dnd.dropTarget({ kind: 'folder', id: folderRow().folder.id })}
                    {...longPress(openMenu)}
                    data-folder-id={folderRow().folder.id}
                    role="treeitem"
                    aria-expanded={folderRow().expanded}
                    style={rowStyle(folderRow().depth, false, rowHeight())}
                    onClick={() => toggle(folderRow().folder.id)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      openMenu(event);
                    }}
                  >
                    <span aria-hidden="true" style={{ width: '10px', color: tokens.muted }}>
                      {folderRow().expanded ? '▾' : '▸'}
                    </span>
                    <span style={{ overflow: 'hidden', 'text-overflow': 'ellipsis' }}>{folderRow().folder.name}</span>
                    <Show when={narrow() && props.onItemMenu}>
                      <RowMenuButton label={folderRow().folder.name} onOpen={openMenu} />
                    </Show>
                  </div>
                );
              }}
            </Match>
            <Match when={row.kind === 'note' && row}>
              {(noteRow) => (
                <NoteItem
                  store={props.store}
                  dnd={props.dnd}
                  note={noteRow().note}
                  depth={noteRow().depth}
                  {...(props.onItemMenu ? { onItemMenu: props.onItemMenu } : {})}
                />
              )}
            </Match>
          </Switch>
        )}
        </VirtualList>
      </div>
    </div>
  );
}
