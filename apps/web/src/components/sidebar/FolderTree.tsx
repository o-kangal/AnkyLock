import { createEffect, createMemo, createSignal, Match, Show, Switch, type JSX } from 'solid-js';
import type { FolderId } from '@ankylock/core';
import type { DragDropManager } from '../../dnd/dragDropManager.js';
import { createSortPreference } from '../../preferences/devicePreferences.js';
import type { WorkspaceStore } from '../../stores/workspaceStore.js';
import { VirtualList } from '../VirtualList.jsx';
import type { MenuTarget } from './ContextMenu.jsx';
import { TrashToolbar } from './TrashToolbar.jsx';
import { NoteItem } from './NoteItem.jsx';
import { SortMenu } from './SortMenu.jsx';
import { TOUCH_TARGET_PX, useNarrowScreen } from '../../layout/screen.js';
import { longPress, RowMenuButton } from './rowMenu.jsx';
import { createHover, itemRowHeight, itemStyle, rowStyle, tokens } from './styles.js';
import { buildTreeRows, type TreeRow } from './treeRows.js';
import { t } from '../../i18n/index.js';

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
  const sort = createSortPreference();
  const rows = createMemo(() => buildTreeRows(props.store.state, expanded(), sort.order()));

  // Rows decrypt their titles when they first render; sorting by name needs every title first.
  createEffect(() => {
    if (sort.order().key !== 'name') return;
    for (const note of Object.values(props.store.state.notes)) {
      if (note.title === undefined) void props.store.loadTitle(note.id);
    }
  });
  const narrow = useNarrowScreen();
  const headerHeight = (): number => (narrow() ? TOUCH_TARGET_PX : tokens.rowHeight);
  const rowHeight = (): number => itemRowHeight(narrow());

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
          <div style={{ ...rowStyle(0, headerHeight()), cursor: 'default', color: tokens.muted, 'justify-content': 'space-between' }}>
            <span>{t('sidebar.folders')}</span>
            <span style={{ display: 'flex', gap: '4px' }}>
              <SortMenu sort={sort} />
              <Show when={canCreate()}>
                <button
                  type="button"
                  aria-label={t('menu.newFolder')}
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', font: tokens.font, color: 'inherit' }}
                  onClick={(event) => props.onItemMenu?.(event, { kind: 'root' })}
                >
                  +
                </button>
              </Show>
            </span>
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
                const [hovered, hover] = createHover();
                return (
                  <div
                    {...props.dnd.dragSource(() => ({ kind: 'folder', id: folderRow().folder.id }))}
                    {...props.dnd.dropTarget({ kind: 'folder', id: folderRow().folder.id })}
                    {...longPress(openMenu)}
                    {...hover}
                    data-folder-id={folderRow().folder.id}
                    role="treeitem"
                    aria-expanded={folderRow().expanded}
                    style={itemStyle(folderRow().depth, { hovered: hovered() }, rowHeight())}
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
