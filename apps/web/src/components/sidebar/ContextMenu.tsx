import { createSignal, For, Show, type JSX } from 'solid-js';
import type { CategoryId, Result } from '@ankylock/core';
import type { DragItem } from '../../dnd/dragDropManager.js';
import type { WorkspaceState, WorkspaceStore } from '../../stores/workspaceStore.js';
import { Popover } from '../Popover.jsx';
import { tokens } from './styles.js';

export interface MenuAction {
  readonly label: string;
  /** Actions that take a name show an inline field first. */
  readonly input?: { readonly placeholder: string; readonly initial: string };
  /** Irreversible actions need a second click. */
  readonly confirm?: boolean;
  readonly run: (value: string) => Promise<Result<void>>;
}

/** What a menu was opened on: a tree row, a custom category, or the empty tree area / its "+" button. */
export type MenuTarget = DragItem | { readonly kind: 'category'; readonly id: CategoryId } | { readonly kind: 'root' };

const newFolder = (run: (name: string) => Promise<Result<void>>): MenuAction => ({
  label: 'New folder',
  input: { placeholder: 'Folder name', initial: '' },
  run,
});

/** The actions valid for a target in its current state (live, archived or trashed). */
export function menuActions(state: WorkspaceState, store: WorkspaceStore, item: MenuTarget): MenuAction[] {
  if (item.kind === 'root') {
    // New folders go where the user is looking: into the selected folder or category, else the root.
    const { selection } = state;
    if (selection.kind === 'folder') return [newFolder((name) => store.createFolder(name, selection.id, null))];
    if (selection.kind === 'category') return [newFolder((name) => store.createFolder(name, null, selection.id))];
    return selection.id === 'system_all' ? [newFolder((name) => store.createFolder(name, null, null))] : [];
  }
  if (item.kind === 'category') {
    const category = state.categories.find((c) => c.id === item.id);
    if (!category) return [];
    return [
      newFolder((name) => store.createFolder(name, null, category.id)),
      {
        label: 'Rename',
        input: { placeholder: 'Category name', initial: category.name },
        run: (name) => store.renameCategory(category.id, name),
      },
      { label: 'Delete category', confirm: true, run: () => store.deleteCategory(category.id) },
    ];
  }
  if (item.kind === 'folder') {
    const folder = state.folders.find((f) => f.id === item.id);
    if (!folder) return [];
    if (folder.deletedAt !== null) {
      return [
        { label: 'Restore', run: () => store.restoreFolder(folder.id) },
        { label: 'Delete permanently', confirm: true, run: () => store.purgeFolder(folder.id) },
      ];
    }
    const trash: MenuAction = { label: 'Move to Trash', run: () => store.trashFolder(folder.id) };
    if (folder.isArchived) return [{ label: 'Unarchive', run: () => store.unarchiveFolder(folder.id) }, trash];
    return [
      {
        label: 'New subfolder',
        input: { placeholder: 'Folder name', initial: '' },
        run: (name) => store.createFolder(name, folder.id, null),
      },
      { label: 'Rename', input: { placeholder: 'Folder name', initial: folder.name }, run: (name) => store.renameFolder(folder.id, name) },
      { label: 'Archive', run: () => store.archiveFolder(folder.id) },
      trash,
    ];
  }

  const note = state.notes[item.id];
  if (!note) return [];
  if (note.deletedAt !== null) {
    return [
      { label: 'Restore', run: () => store.restoreNote(note.id) },
      { label: 'Delete permanently', confirm: true, run: () => store.purgeNote(note.id) },
    ];
  }
  const trash: MenuAction = { label: 'Move to Trash', run: () => store.trashNote(note.id) };
  if (note.isArchived) return [{ label: 'Unarchive', run: () => store.setNoteArchived(note.id, false) }, trash];
  // Scratchpads must be filed into a folder or category before they can be archived (SPEC §3).
  return note.isEphemeral ? [trash] : [{ label: 'Archive', run: () => store.setNoteArchived(note.id, true) }, trash];
}

export interface ContextMenuProps {
  readonly store: WorkspaceStore;
  readonly item: MenuTarget;
  readonly x: number;
  readonly y: number;
  readonly onClose: () => void;
}

const itemStyle: JSX.CSSProperties = {
  display: 'block',
  width: '100%',
  'text-align': 'left',
  border: 'none',
  background: 'transparent',
  padding: '4px 12px',
  font: tokens.font,
  cursor: 'pointer',
};

/** Right-click menu for sidebar rows; closes on Escape, outside clicks or a successful action. */
export function ContextMenu(props: ContextMenuProps): JSX.Element {
  const [pending, setPending] = createSignal<MenuAction | null>(null);
  const [value, setValue] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);

  const execute = async (action: MenuAction, input: string): Promise<void> => {
    const result = await action.run(input);
    if (result.ok) props.onClose();
    else setError(result.error.message);
  };

  const choose = (action: MenuAction): void => {
    setError(null);
    if (action.input || (action.confirm && pending() !== action)) {
      setPending(action);
      setValue(action.input?.initial ?? '');
      return;
    }
    void execute(action, '');
  };

  return (
    <Popover
      role="menu"
      onClose={props.onClose}
      at={{ x: props.x, y: props.y }}
      width={200}
      style={{ padding: '4px 0' }}
    >
      <For each={menuActions(props.store.state, props.store, props.item)}>
        {(action) => (
          <>
            <button
              type="button"
              role="menuitem"
              style={{ ...itemStyle, color: action.confirm && pending() === action ? tokens.danger : 'inherit' }}
              onClick={() => choose(action)}
            >
              {action.confirm && pending() === action ? `${action.label}? Click again to confirm` : action.label}
            </button>
            <Show when={action.input && pending() === action}>
              <form
                style={{ padding: '2px 12px 6px' }}
                onSubmit={(event) => {
                  event.preventDefault();
                  void execute(action, value());
                }}
              >
                <input
                  aria-label={action.label}
                  placeholder={action.input?.placeholder}
                  value={value()}
                  onInput={(e) => setValue(e.currentTarget.value)}
                  ref={(el) => queueMicrotask(() => el.focus())}
                  style={{ width: '100%', font: tokens.font, 'box-sizing': 'border-box' }}
                />
              </form>
            </Show>
          </>
        )}
      </For>
      <Show when={error()}>
        <div role="alert" style={{ color: tokens.danger, padding: '4px 12px', font: tokens.font }}>
          {error()}
        </div>
      </Show>
    </Popover>
  );
}
