import { createSignal, For, Show, type JSX } from 'solid-js';
import { SYSTEM_ALL, SYSTEM_ARCHIVE, SYSTEM_TRASH, type SystemCategoryId } from '@ankylock/core';
import type { DragDropManager } from '../../dnd/dragDropManager.js';
import type { MenuTarget } from './ContextMenu.jsx';
import type { Selection, WorkspaceStore } from '../../stores/workspaceStore.js';
import { touchSized, useNarrowScreen } from '../../layout/screen.js';
import { longPress } from './rowMenu.jsx';
import { errorText, t } from '../../i18n/index.js';
import { createHover, fieldStyle, itemRowHeight, itemStyle, tokens, type ItemState } from './styles.js';

const SYSTEM_CATEGORY_KEYS = {
  [SYSTEM_ALL]: 'sidebar.allNotes',
  [SYSTEM_ARCHIVE]: 'sidebar.archive',
  [SYSTEM_TRASH]: 'sidebar.trash',
} as const;

/** Immutable system categories (BR-HIER-01): fixed labels, views rather than containers. */
export const systemCategoryLabel = (id: SystemCategoryId): string => t(SYSTEM_CATEGORY_KEYS[id]);

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
      setError(errorText(result.error));
    }
  };

  const narrow = useNarrowScreen();
  const style = (state: ItemState): JSX.CSSProperties => itemStyle(0, state, itemRowHeight(narrow()));

  return (
    <nav aria-label={t('sidebar.categories')} style={{ 'border-bottom': `1px solid ${tokens.border}`, 'padding': '4px 0' }}>
      <For each={SYSTEM_ORDER}>
        {(id) => {
          const [hovered, hover] = createHover();
          return (
            <div
              {...hover}
              role="button"
              aria-pressed={isSelected(props.store.state.selection, 'system', id)}
              style={style({ active: isSelected(props.store.state.selection, 'system', id), hovered: hovered() })}
              onClick={() => props.store.select({ kind: 'system', id })}
            >
              {systemCategoryLabel(id)}
            </div>
          );
        }}
      </For>
      <For each={props.store.state.categories}>
        {(category) => {
          const [hovered, hover] = createHover();
          return (
            <div
              {...props.dnd.dropTarget({ kind: 'category', id: category.id })}
              {...longPress((event) => props.onItemMenu?.(event, { kind: 'category', id: category.id }))}
              {...hover}
              role="button"
              aria-pressed={isSelected(props.store.state.selection, 'category', category.id)}
              style={style({ active: isSelected(props.store.state.selection, 'category', category.id), hovered: hovered() })}
              onClick={() => props.store.select({ kind: 'category', id: category.id })}
              onContextMenu={(event) => {
                event.preventDefault();
                props.onItemMenu?.(event, { kind: 'category', id: category.id });
              }}
            >
              {category.name}
            </div>
          );
        }}
      </For>
      <form onSubmit={(e) => void submit(e)} style={{ padding: '4px 8px' }}>
        <input
          aria-label={t('sidebar.newCategory')}
          placeholder={t('sidebar.newCategory')}
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          style={touchSized({ ...fieldStyle, width: '100%', padding: '3px 8px', font: tokens.font, 'box-sizing': 'border-box' }, narrow())}
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
