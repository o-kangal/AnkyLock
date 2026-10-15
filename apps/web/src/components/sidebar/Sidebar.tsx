import { createSignal, Show, type JSX } from 'solid-js';
import { createDragDropManager } from '../../dnd/dragDropManager.js';
import type { WorkspaceStore } from '../../stores/workspaceStore.js';
import { CategoryList } from './CategoryList.jsx';
import { ContextMenu, type MenuTarget } from './ContextMenu.jsx';
import { FolderTree } from './FolderTree.jsx';
import { tokens } from './styles.js';

export interface SidebarProps {
  readonly store: WorkspaceStore;
}

/** Left navigation: categories on top, the virtualized folder/note tree below. */
export function Sidebar(props: SidebarProps): JSX.Element {
  const [dropError, setDropError] = createSignal<string | null>(null);
  const dnd = createDragDropManager(props.store, setDropError);
  const [menu, setMenu] = createSignal<{ item: MenuTarget; x: number; y: number } | null>(null);
  const openMenu = (event: MouseEvent, item: MenuTarget): void => {
    setMenu({ item, x: event.clientX, y: event.clientY });
  };

  return (
    <aside
      style={{
        display: 'flex',
        'flex-direction': 'column',
        height: '100%',
        'min-width': '0',
        font: tokens.font,
        'border-right': `1px solid ${tokens.border}`,
      }}
    >
      <CategoryList store={props.store} dnd={dnd} onItemMenu={openMenu} />
      <Show when={dropError()}>
        <div role="alert" style={{ color: tokens.danger, padding: '4px 8px' }} onClick={() => setDropError(null)}>
          {dropError()}
        </div>
      </Show>
      <FolderTree
        store={props.store}
        dnd={dnd}
        onItemMenu={openMenu}
      />
      <Show when={menu()}>
        {(open) => (
          <ContextMenu
            store={props.store}
            item={open().item}
            x={open().x}
            y={open().y}
            move={(item, target) => dnd.drop(item, target)}
            onClose={() => setMenu(null)}
          />
        )}
      </Show>
    </aside>
  );
}
