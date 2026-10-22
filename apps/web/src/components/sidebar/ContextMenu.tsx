import { createSignal, For, Show, type JSX } from 'solid-js';
import { ok, type CategoryId, type FolderId, type Result } from '@ankylock/core';
import { canDrop, type DragItem, type DropTarget } from '../../dnd/dragDropManager.js';
import type { ExportScope } from '../../export/exportPlan.js';
import { useExport } from '../../export/saveFile.js';
import type { WorkspaceState, WorkspaceStore } from '../../stores/workspaceStore.js';
import { TOUCH_TARGET_PX, touchSized, useNarrowScreen } from '../../layout/screen.js';
import { Popover } from '../Popover.jsx';
import { compareNames, errorText, t } from '../../i18n/index.js';
import { fieldStyle, tokens } from './styles.js';

export interface MenuAction {
  readonly label: string;
  /** Actions that take a name show an inline field first. */
  readonly input?: { readonly placeholder: string; readonly initial: string };
  /** Irreversible actions need a second click. */
  readonly confirm?: boolean;
  readonly run: (value: string) => Promise<Result<void>>;
  /** Actions that pick a destination ("Move to…") list their choices first. */
  readonly choices?: readonly MoveChoice[];
  /** "Export…" opens the export dialog for this scope instead of running. */
  readonly export?: { readonly scope: ExportScope; readonly label: string };
}

/** A destination in the "Move to…" list; `depth` indents folders under their parents. */
export interface MoveChoice {
  readonly label: string;
  readonly depth: number;
  readonly run: () => Promise<Result<void>>;
}

/** Moves an item the way dropping it there would (see `DragDropManager.drop`). */
export type MoveItem = (item: DragItem, target: DropTarget) => Promise<Result<void>>;

/**
 * Destinations for "Move to…", the touch and keyboard alternative to drag-and-drop: the top level,
 * every user category, and every live folder (tree order) that the drop rules allow.
 */
function moveChoices(state: WorkspaceState, store: WorkspaceStore, item: DragItem, move: MoveItem): MoveChoice[] {
  const links = new Map(state.folders.map((f) => [f.id, { id: f.id, parentId: f.parentId }]));
  const top: MoveChoice = {
    label: t('menu.topLevel'),
    depth: 0,
    run: () => {
      if (item.kind === 'folder') return store.moveFolder(item.id, null);
      const note = state.notes[item.id];
      return store.moveNote(item.id, null, note?.categoryId ?? null);
    },
  };
  const categories = state.categories.map((c) => ({
    label: t('menu.categoryChoice', { name: c.name }),
    depth: 0,
    target: { kind: 'category', id: c.id } as const,
  }));
  const live = state.folders.filter((f) => f.deletedAt === null && !f.isArchived);
  const folders: { label: string; depth: number; target: DropTarget }[] = [];
  const visit = (parentId: FolderId | null, depth: number): void => {
    for (const f of live.filter((x) => x.parentId === parentId).sort((a, b) => compareNames(a.name, b.name))) {
      folders.push({ label: f.name, depth, target: { kind: 'folder', id: f.id } });
      visit(f.id, depth + 1);
    }
  };
  visit(null, 0);
  const allowed = [...categories, ...folders].filter(
    (c) => canDrop(item, c.target, links).ok && !(item.kind === 'folder' && c.target.kind === 'folder' && c.target.id === item.id),
  );
  return [top, ...allowed.map((c) => ({ label: c.label, depth: c.depth, run: () => move(item, c.target) }))];
}

const moveTo = (choices: MoveChoice[]): MenuAction => ({
  label: t('menu.moveTo'),
  choices,
  run: () => Promise.resolve(ok(undefined)),
});

/** What a menu was opened on: a tree row, a custom category, or the empty tree area / its "+" button. */
export type MenuTarget = DragItem | { readonly kind: 'category'; readonly id: CategoryId } | { readonly kind: 'root' };

const exportAction = (scope: ExportScope, label: string): MenuAction => ({
  label: t('menu.export'),
  export: { scope, label },
  run: () => Promise.resolve(ok(undefined)),
});

const newFolder = (run: (name: string) => Promise<Result<void>>): MenuAction => ({
  label: t('menu.newFolder'),
  input: { placeholder: t('menu.folderName'), initial: '' },
  run,
});

/** The actions valid for a target in its current state (live, archived or trashed). */
export function menuActions(state: WorkspaceState, store: WorkspaceStore, item: MenuTarget, move?: MoveItem): MenuAction[] {
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
        label: t('menu.rename'),
        input: { placeholder: t('menu.categoryName'), initial: category.name },
        run: (name) => store.renameCategory(category.id, name),
      },
      { label: t('menu.deleteCategory'), confirm: true, run: () => store.deleteCategory(category.id) },
    ];
  }
  if (item.kind === 'folder') {
    const folder = state.folders.find((f) => f.id === item.id);
    if (!folder) return [];
    if (folder.deletedAt !== null) {
      return [
        { label: t('menu.restore'), run: () => store.restoreFolder(folder.id) },
        { label: t('menu.deletePermanently'), confirm: true, run: () => store.purgeFolder(folder.id) },
      ];
    }
    const trash: MenuAction = { label: t('menu.moveToTrash'), run: () => store.trashFolder(folder.id) };
    const exportFolder = exportAction({ kind: 'folder', id: folder.id }, `“${folder.name}”`);
    if (folder.isArchived) return [{ label: t('menu.unarchive'), run: () => store.unarchiveFolder(folder.id) }, exportFolder, trash];
    return [
      {
        label: t('menu.newSubfolder'),
        input: { placeholder: t('menu.folderName'), initial: '' },
        run: (name) => store.createFolder(name, folder.id, null),
      },
      { label: t('menu.rename'), input: { placeholder: t('menu.folderName'), initial: folder.name }, run: (name) => store.renameFolder(folder.id, name) },
      ...(move ? [moveTo(moveChoices(state, store, { kind: 'folder', id: folder.id }, move))] : []),
      { label: t('menu.archive'), run: () => store.archiveFolder(folder.id) },
      exportFolder,
      trash,
    ];
  }

  const note = state.notes[item.id];
  if (!note) return [];
  if (note.deletedAt !== null) {
    return [
      { label: t('menu.restore'), run: () => store.restoreNote(note.id) },
      { label: t('menu.deletePermanently'), confirm: true, run: () => store.purgeNote(note.id) },
    ];
  }
  const trash: MenuAction = { label: t('menu.moveToTrash'), run: () => store.trashNote(note.id) };
  const exportNote = exportAction({ kind: 'note', id: note.id }, `“${note.title ?? t('note.untitled')}”`);
  if (note.isArchived) return [{ label: t('menu.unarchive'), run: () => store.setNoteArchived(note.id, false) }, exportNote, trash];
  const moves = move ? [moveTo(moveChoices(state, store, { kind: 'note', id: note.id }, move))] : [];
  // Scratchpads must be filed into a folder or category before they can be archived (SPEC §3).
  return note.isEphemeral
    ? [...moves, exportNote, trash]
    : [...moves, { label: t('menu.archive'), run: () => store.setNoteArchived(note.id, true) }, exportNote, trash];
}

export interface ContextMenuProps {
  readonly store: WorkspaceStore;
  readonly item: MenuTarget;
  readonly x: number;
  readonly y: number;
  readonly onClose: () => void;
  /** Enables "Move to…" for notes and folders. */
  readonly move?: MoveItem;
}

const baseItemStyle: JSX.CSSProperties = {
  display: 'block',
  width: '100%',
  'text-align': 'left',
  border: 'none',
  background: 'transparent',
  padding: '4px 8px',
  'border-radius': tokens.radiusChip,
  font: tokens.font,
  cursor: 'pointer',
};

/** Right-click menu for sidebar rows; closes on Escape, outside clicks or a successful action. */
export function ContextMenu(props: ContextMenuProps): JSX.Element {
  const [pending, setPending] = createSignal<MenuAction | null>(null);
  const [value, setValue] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const narrow = useNarrowScreen();
  const openExport = useExport();
  const itemStyle = (): JSX.CSSProperties =>
    narrow() ? { ...baseItemStyle, 'min-height': `${TOUCH_TARGET_PX}px`, 'font-size': '16px' } : baseItemStyle;

  const execute = async (action: MenuAction, input: string): Promise<void> => {
    const result = await action.run(input);
    if (result.ok) props.onClose();
    else setError(errorText(result.error));
  };

  const choose = (action: MenuAction): void => {
    setError(null);
    if (action.export) {
      props.onClose();
      openExport?.(action.export.scope, action.export.label);
      return;
    }
    if (action.input || action.choices || (action.confirm && pending() !== action)) {
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
      style={{ padding: '6px' }}
    >
      <For each={menuActions(props.store.state, props.store, props.item, props.move).filter((a) => !a.export || openExport)}>
        {(action) => (
          <>
            <button
              type="button"
              role="menuitem"
              style={{ ...itemStyle(), color: action.confirm && pending() === action ? tokens.danger : 'inherit' }}
              onClick={() => choose(action)}
            >
              {action.confirm && pending() === action ? t('menu.confirmAgain', { action: action.label }) : action.label}
            </button>
            <Show when={action.choices && pending() === action}>
              <div role="group" aria-label={t('menu.destinations')} style={{ 'max-height': '240px', overflow: 'auto', padding: '0 0 4px' }}>
                <For each={action.choices}>
                  {(choice) => (
                    <button
                      type="button"
                      role="menuitem"
                      style={{ ...itemStyle(), 'padding-left': `${24 + choice.depth * tokens.indent}px` }}
                      onClick={() => void choice.run().then((r) => (r.ok ? props.onClose() : setError(errorText(r.error))))}
                    >
                      {choice.label}
                    </button>
                  )}
                </For>
              </div>
            </Show>
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
                  style={touchSized({ ...fieldStyle, width: '100%', padding: '3px 8px', font: tokens.font, 'box-sizing': 'border-box' }, narrow())}
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
