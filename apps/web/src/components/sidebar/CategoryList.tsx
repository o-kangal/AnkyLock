import { createSignal, For, Show, type JSX } from 'solid-js';
import { SYSTEM_ALL, SYSTEM_ARCHIVE, SYSTEM_TRASH, type SystemCategoryId } from '@ankylock/core';
import type { DragDropManager } from '../../dnd/dragDropManager.js';
import type { MenuTarget } from './ContextMenu.jsx';
import type { Selection, WorkspaceStore } from '../../stores/workspaceStore.js';
import { TOUCH_TARGET_PX, touchSized, useNarrowScreen } from '../../layout/screen.js';
import { longPress } from './rowMenu.jsx';
import { rowStyle, tokens } from './styles.js';

/** Immutable system categories (BR-HIER-01): fixed labels, views rather than containers. */
export const SYSTEM_CATEGORY_LABELS: Record<SystemCategoryId, string> = {
  [SYSTEM_ALL]: 'All Notes',
  [SYSTEM_ARCHIVE]: 'Archive',
  [SYSTEM_TRASH]: 'Trash',
};

const SYSTEM_ORDER: SystemCategoryId[] = [SYSTEM_ALL, SYSTEM_ARCHIVE, SYSTEM_TRASH];

export interface CategoryListProps {
  readonly store: WorkspaceStore;
  readonly dnd: DragDropManager;
  readonly onItemMenu?: (event: MouseEvent, item: MenuTarget) => void;
}

const isSelected = (selection: Selection, kind: Selection['kind'], id: string): boolean =>
  selection.kind === kind && selection.id === id;

/** System categories, custom categories (drop targets for notes) and a form to add one. */
export function CategoryList(props: CategoryListProps): JSX.Element {
  const [draft, setDraft] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);

  const submit = async (event: SubmitEvent): Promise<void> => {
    event.preventDefault();
    const result = await props.store.createCategory(draft());
    if (result.ok) {
      setDraft('');
      setError(null);
    } else {
      setError(result.error.message);
    }
  };

  const narrow = useNarrowScreen();
  const rowHeight = (): number => (narrow() ? TOUCH_TARGET_PX : tokens.rowHeight);

  return (
    <nav aria-label="Categories" style={{ 'border-bottom': `1px solid ${tokens.border}`, 'padding-bottom': '4px' }}>
      <For each={SYSTEM_ORDER}>
        {(id) => (
          <div
            role="button"
            aria-pressed={isSelected(props.store.state.selection, 'system', id)}
            style={rowStyle(0, isSelected(props.store.state.selection, 'system', id), rowHeight())}
            onClick={() => props.store.select({ kind: 'system', id })}
          >
            {SYSTEM_CATEGORY_LABELS[id]}
          </div>
        )}
      </For>
      <For each={props.store.state.categories}>
        {(category) => (
          <div
            {...props.dnd.dropTarget({ kind: 'category', id: category.id })}
            {...longPress((event) => props.onItemMenu?.(event, { kind: 'category', id: category.id }))}
            role="button"
            aria-pressed={isSelected(props.store.state.selection, 'category', category.id)}
            style={rowStyle(0, isSelected(props.store.state.selection, 'category', category.id), rowHeight())}
            onClick={() => props.store.select({ kind: 'category', id: category.id })}
            onContextMenu={(event) => {
              event.preventDefault();
              props.onItemMenu?.(event, { kind: 'category', id: category.id });
            }}
          >
            {category.name}
          </div>
        )}
      </For>
      <form onSubmit={(e) => void submit(e)} style={{ padding: '4px 8px' }}>
        <input
          aria-label="New category"
          placeholder="New category"
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          style={touchSized({ width: '100%', font: tokens.font, 'box-sizing': 'border-box' }, narrow())}
        />
        <Show when={error()}>
          <div role="alert" style={{ color: tokens.danger, font: tokens.font, 'margin-top': '2px' }}>
            {error()}
          </div>
        </Show>
      </form>
    </nav>
  );
}
