import { createSignal, Show, type JSX } from 'solid-js';
import { createDragDropManager } from '../../dnd/dragDropManager.js';
import type { WorkspaceStore } from '../../stores/workspaceStore.js';
import { CategoryList } from './CategoryList.jsx';
import { FolderTree } from './FolderTree.jsx';
import { tokens } from './styles.js';

export interface SidebarProps {
  readonly store: WorkspaceStore;
}

/** Left navigation: categories on top, the virtualized folder/note tree below. */
export function Sidebar(props: SidebarProps): JSX.Element {
  const [dropError, setDropError] = createSignal<string | null>(null);
  const dnd = createDragDropManager(props.store, setDropError);

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
      <CategoryList store={props.store} dnd={dnd} />
      <Show when={dropError()}>
        <div role="alert" style={{ color: tokens.danger, padding: '4px 8px' }} onClick={() => setDropError(null)}>
          {dropError()}
        </div>
      </Show>
      <FolderTree store={props.store} dnd={dnd} />
    </aside>
  );
}
