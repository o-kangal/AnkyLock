import { createStore, produce } from 'solid-js/store';
import {
  DEFAULT_RETENTION_DAYS,
  err,
  ok,
  validateCategoryName,
  validateFolderMove,
  type CategoryId,
  type Ciphertext,
  type DomainError,
  type EpochMs,
  type Folder,
  type FolderId,
  type Note,
  type NoteId,
  type Result,
  type RetentionChangePlan,
  type SystemCategoryId,
} from '@ankylock/core';
import { StorageError, type IStorageEngine } from '@ankylock/storage';
import { changeTrashRetention } from '@ankylock/sync';
import { t } from '../i18n/index.js';

/** Encrypts and decrypts short names and titles; backed by the crypto worker in the app. */
export interface NameCodec {
  encrypt(plaintext: string): Promise<Ciphertext>;
  decrypt(ciphertext: Ciphertext): Promise<string>;
}

export interface CategoryView {
  id: CategoryId;
  name: string;
  sortOrder: number;
}

export interface FolderView {
  id: FolderId;
  parentId: FolderId | null;
  categoryId: CategoryId | null;
  name: string;
  isArchived: boolean;
  deletedAt: EpochMs | null;
  createdAt: EpochMs;
}

export interface NoteView {
  id: NoteId;
  folderId: FolderId | null;
  categoryId: CategoryId | null;
  isEphemeral: boolean;
  isArchived: boolean;
  deletedAt: EpochMs | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
  /** Decrypted BR-NOTE-03 title; null when line 1 is empty, undefined until loaded. */
  title: string | null | undefined;
}

export interface Tab {
  noteId: NoteId;
  /** `Untitled-N` number for scratchpads, assigned when the tab opens. */
  untitledNumber: number | null;
}

export type Selection =
  | { readonly kind: 'system'; readonly id: SystemCategoryId }
  | { readonly kind: 'category'; readonly id: CategoryId }
  | { readonly kind: 'folder'; readonly id: FolderId };

/**
 * Sidebar and tab state. Fields are mutable only so Solid's path setters type-check; consumers
 * get the store proxy, which can't be written outside the store's actions. Holds ids, flags, names and titles only: note bodies live in Y.Docs,
 * never in this reactive store.
 */
export interface WorkspaceState {
  categories: CategoryView[];
  folders: FolderView[];
  notes: Record<NoteId, NoteView>;
  tabs: Tab[];
  /** Index into `tabs`, or -1 when no tab is open. */
  activeTabIndex: number;
  selection: Selection;
  /** BR-LIFE-03: days before trashed items are purged; 0 means manual purge only. */
  retentionDays: number;
}

/** A hard-deleted entity, reported so other devices can purge it too (TOMBSTONE packets). */
export type PurgedItem = { readonly entityType: 'note'; readonly id: NoteId } | { readonly entityType: 'folder'; readonly id: FolderId };

export interface WorkspaceDeps {
  readonly storage: IStorageEngine;
  readonly names: NameCodec;
  readonly newId?: () => string;
  readonly onPurged?: (items: PurgedItem[]) => void;
}

const toDomainError = (error: unknown): DomainError =>
  error instanceof StorageError
    ? { code: error.code, message: error.message }
    : { code: 'ERR_STORAGE', message: error instanceof Error ? error.message : String(error) };

async function attempt(work: () => Promise<void>): Promise<Result<void>> {
  try {
    await work();
    return ok(undefined);
  } catch (error) {
    return { ok: false, error: toDomainError(error) };
  }
}

const noteView = (note: Note, title: string | null | undefined): NoteView => ({
  id: note.id,
  folderId: note.folderId,
  categoryId: note.categoryId,
  isEphemeral: note.isEphemeral,
  isArchived: note.isArchived,
  deletedAt: note.deletedAt,
  createdAt: note.createdAt,
  updatedAt: note.updatedAt,
  title,
});

/** Lowest positive N not used by an open `Untitled-N` tab. */
export function nextUntitledNumber(tabs: readonly Tab[]): number {
  const used = new Set(tabs.map((t) => t.untitledNumber));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

export function tabLabel(tab: Tab, note: NoteView | undefined): string {
  if (note?.title) return note.title;
  return tab.untitledNumber === null ? t('note.untitled') : t('note.untitledN', { n: tab.untitledNumber });
}

export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;

export function createWorkspaceStore(deps: WorkspaceDeps) {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const reportPurged = (folders: readonly FolderId[], notes: readonly NoteId[]): void => {
    const items: PurgedItem[] = [
      ...folders.map((id) => ({ entityType: 'folder' as const, id })),
      ...notes.map((id) => ({ entityType: 'note' as const, id })),
    ];
    if (items.length > 0) deps.onPurged?.(items);
  };
  const { storage, names } = deps;

  const [state, setState] = createStore<WorkspaceState>({
    categories: [],
    folders: [],
    notes: {},
    tabs: [],
    activeTabIndex: -1,
    selection: { kind: 'system', id: 'system_all' },
    retentionDays: DEFAULT_RETENTION_DAYS,
  });

  const folderView = async (folder: Folder): Promise<FolderView> => ({
    id: folder.id,
    parentId: folder.parentId,
    categoryId: folder.categoryId,
    name: await names.decrypt(folder.nameCiphertext),
    isArchived: folder.isArchived,
    deletedAt: folder.deletedAt,
    createdAt: folder.createdAt,
  });

  const putNote = (note: Note): void => {
    // A note new to the store has no view yet, whatever the record type says.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    setState('notes', note.id, (existing) => noteView(note, existing?.title));
  };

  function addTab(noteId: NoteId, untitled: boolean): void {
    setState(
      produce((s) => {
        s.tabs.push({ noteId, untitledNumber: untitled ? nextUntitledNumber(s.tabs) : null });
        s.activeTabIndex = s.tabs.length - 1;
      }),
    );
  }

  /** Loads categories, live and trashed folders and every note. Titles load lazily per row. */
  async function loadAll(): Promise<void> {
    const [categories, liveFolders, trashedFolders, trashed, retentionDays] = await Promise.all([
      storage.listCategories(),
      storage.listFolders(),
      storage.listTrashedFolders(),
      storage.listTrashedNotes(),
      storage.getTrashRetentionDays(),
    ]);
    const perFolder = await Promise.all([null, ...liveFolders.map((f) => f.id)].map((id) => storage.listNotes(id)));
    const categoryViews = await Promise.all(
      categories.map(async (c) => ({ id: c.id, name: await names.decrypt(c.nameCiphertext), sortOrder: c.sortOrder })),
    );
    const folderViews = await Promise.all([...liveFolders, ...trashedFolders].map(folderView));
    const notes: Record<NoteId, NoteView> = {};
    for (const note of [...perFolder.flat(), ...trashed]) notes[note.id] = noteView(note, state.notes[note.id]?.title);
    setState({ categories: categoryViews, folders: folderViews, notes, retentionDays });
    dropTabsOfMissingNotes();
  }

  /** Purges can remove notes that are open in tabs; close those tabs and keep a sensible active one. */
  function dropTabsOfMissingNotes(): void {
    const active = state.tabs[state.activeTabIndex]?.noteId;
    const tabs = state.tabs.filter((t) => state.notes[t.noteId] !== undefined);
    if (tabs.length === state.tabs.length) return;
    const kept = tabs.findIndex((t) => t.noteId === active);
    setState({ tabs, activeTabIndex: kept >= 0 ? kept : Math.min(state.activeTabIndex, tabs.length - 1) });
  }

  /** Folder archive and trash cascade through whole subtrees, so state is reloaded afterwards. */
  const cascade = (work: () => Promise<unknown>): Promise<Result<void>> =>
    attempt(async () => {
      await work();
      await loadAll();
    });

  return {
    state,

    load(): Promise<Result<void>> {
      return attempt(loadAll);
    },

    archiveFolder(id: FolderId): Promise<Result<void>> {
      return cascade(() => storage.archiveFolder(id));
    },

    unarchiveFolder(id: FolderId): Promise<Result<void>> {
      return cascade(() => storage.unarchiveFolder(id));
    },

    trashFolder(id: FolderId): Promise<Result<void>> {
      return cascade(() => storage.trashFolder(id));
    },

    restoreFolder(id: FolderId): Promise<Result<void>> {
      return cascade(() => storage.restoreFolder(id));
    },

    /**
     * Changes trash retention (SPEC §6). Shortening it so that items would be purged right away
     * returns `confirm_required` with the count and changes nothing until called with `confirmed`.
     */
    async changeRetention(days: number, confirmed: boolean): Promise<Result<RetentionChangePlan | { kind: 'applied' }>> {
      try {
        const result = await changeTrashRetention({ storage }, days, { confirmed });
        if (result.kind !== 'applied') return ok(result);
        await loadAll();
        return ok({ kind: 'applied' });
      } catch (error) {
        return { ok: false, error: toDomainError(error) };
      }
    },

    /** Permanently deletes everything in Trash: trashed folder trees first, then remaining notes. */
    emptyTrash(): Promise<Result<void>> {
      return cascade(async () => {
        const trashedIds = new Set(state.folders.filter((f) => f.deletedAt !== null).map((f) => f.id));
        const topLevel = state.folders.filter(
          (f) => f.deletedAt !== null && (f.parentId === null || !trashedIds.has(f.parentId)),
        );
        for (const folder of topLevel) {
          const purged = await storage.purgeFolder(folder.id);
          reportPurged(purged.folders, purged.notes);
        }
        for (const note of await storage.listTrashedNotes()) {
          await storage.purgeNote(note.id);
          reportPurged([], [note.id]);
        }
      });
    },

    purgeFolder(id: FolderId): Promise<Result<void>> {
      return cascade(async () => {
        const purged = await storage.purgeFolder(id);
        reportPurged(purged.folders, purged.notes);
      });
    },

    renameFolder(id: FolderId, name: string): Promise<Result<void>> {
      const trimmed = name.trim();
      if (trimmed === '') return Promise.resolve(err('ERR_INVALID_TRANSITION', 'Folder names cannot be empty.'));
      return attempt(async () => {
        await storage.renameFolder(id, await names.encrypt(trimmed));
        setState('folders', (f) => f.id === id, 'name', trimmed);
      });
    },

    setNoteArchived(noteId: NoteId, archived: boolean): Promise<Result<void>> {
      return attempt(async () => putNote(await storage.setNoteArchived(noteId, archived)));
    },

    purgeNote(noteId: NoteId): Promise<Result<void>> {
      return attempt(async () => {
        await storage.purgeNote(noteId);
        reportPurged([], [noteId]);
        setState(
          'notes',
          produce((notes) => {
            // Notes are a record keyed by id.
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
            delete notes[noteId];
          }),
        );
        dropTabsOfMissingNotes();
      });
    },

    /** Decrypts a note's title on demand (rows are virtualized, so only visible rows ask). */
    loadTitle(noteId: NoteId): Promise<Result<void>> {
      return attempt(async () => {
        if (state.notes[noteId]?.title !== undefined) return;
        const content = await storage.getNoteContent(noteId);
        const title = content ? await names.decrypt(content.titleCiphertext) : null;
        setState('notes', noteId, 'title', title === '' ? null : title);
      });
    },

    /**
     * Decrypts the titles of notes changed on another device again. A reload keeps titles it
     * already has, and a row only asks for its title when it first renders.
     */
    refreshTitles(noteIds: readonly NoteId[]): Promise<Result<void>> {
      return attempt(async () => {
        for (const noteId of noteIds) {
          if (!state.notes[noteId]) continue;
          const content = await storage.getNoteContent(noteId);
          const title = content ? await names.decrypt(content.titleCiphertext) : null;
          // The note may have been purged while its title was decrypting.
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          if (state.notes[noteId]) setState('notes', noteId, 'title', title === '' ? null : title);
        }
      });
    },

    /** Called by the editor when line 1 changes (BR-NOTE-03). Persisting it is the content pipeline's job. */
    setTitle(noteId: NoteId, title: string | null): void {
      if (state.notes[noteId]) setState('notes', noteId, 'title', title);
    },

    select(selection: Selection): void {
      setState('selection', selection);
    },

    /** BR-NOTE-01: a new tab is an ephemeral scratchpad, persisted immediately without a dialog. */
    createTab(): Promise<Result<void>> {
      return attempt(async () => {
        const note = await storage.createNote(newId() as NoteId);
        putNote(note);
        addTab(note.id, true);
      });
    },

    openNote(noteId: NoteId): void {
      const index = state.tabs.findIndex((t) => t.noteId === noteId);
      if (index >= 0) setState('activeTabIndex', index);
      else addTab(noteId, state.notes[noteId]?.isEphemeral ?? false);
    },

    activateTab(index: number): void {
      if (index >= 0 && index < state.tabs.length) setState('activeTabIndex', index);
    },

    /** Closing an empty, unmodified scratchpad deletes it without trashing (SPEC §3). */
    closeTab(index: number, isEmptyAndUnmodified = false): Promise<Result<void>> {
      return attempt(async () => {
        const tab = state.tabs[index];
        if (!tab) return;
        if (isEmptyAndUnmodified && state.notes[tab.noteId]?.isEphemeral && state.notes[tab.noteId]?.deletedAt === null) {
          await storage.discardEphemeralNote(tab.noteId);
          setState(
            'notes',
            produce((notes) => {
              // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
              delete notes[tab.noteId];
            }),
          );
        }
        setState(
          produce((s) => {
            s.tabs.splice(index, 1);
            if (s.tabs.length === 0) s.activeTabIndex = -1;
            else if (index < s.activeTabIndex || s.activeTabIndex >= s.tabs.length) s.activeTabIndex--;
          }),
        );
      });
    },

    /** Drag-reorders tabs, keeping the same tab active. */
    moveTab(from: number, to: number): void {
      if (from === to || !state.tabs[from] || to < 0 || to >= state.tabs.length) return;
      setState(
        produce((s) => {
          const active = s.tabs[s.activeTabIndex];
          const [moved] = s.tabs.splice(from, 1);
          if (moved) s.tabs.splice(to, 0, moved);
          s.activeTabIndex = active ? s.tabs.indexOf(active) : -1;
        }),
      );
    },

    createCategory(name: string): Promise<Result<void>> {
      const valid = validateCategoryName(
        name,
        state.categories.map((c) => c.name),
      );
      if (!valid.ok) return Promise.resolve(valid);
      return attempt(async () => {
        const category = await storage.createCategory(newId() as CategoryId, await names.encrypt(valid.value));
        setState('categories', (list) => [...list, { id: category.id, name: valid.value, sortOrder: category.sortOrder }]);
      });
    },

    renameCategory(id: CategoryId, name: string): Promise<Result<void>> {
      const valid = validateCategoryName(
        name,
        state.categories.filter((c) => c.id !== id).map((c) => c.name),
      );
      if (!valid.ok) return Promise.resolve(valid);
      return attempt(async () => {
        await storage.renameCategory(id, await names.encrypt(valid.value));
        setState('categories', (c) => c.id === id, 'name', valid.value);
      });
    },

    /** Its folders and notes stay, without a category; a selected deleted category falls back to All Notes. */
    deleteCategory(id: CategoryId): Promise<Result<void>> {
      return cascade(async () => {
        await storage.deleteCategory(id);
        if (state.selection.kind === 'category' && state.selection.id === id) {
          setState('selection', { kind: 'system', id: 'system_all' });
        }
      });
    },

    createFolder(name: string, parentId: FolderId | null, categoryId: CategoryId | null): Promise<Result<void>> {
      const trimmed = name.trim();
      if (trimmed === '') return Promise.resolve(err('ERR_INVALID_TRANSITION', 'Folder names cannot be empty.'));
      return attempt(async () => {
        const folder = await storage.createFolder({
          id: newId() as FolderId,
          parentId,
          categoryId,
          nameCiphertext: await names.encrypt(trimmed),
        });
        const view = await folderView(folder);
        setState('folders', (list) => [...list, view]);
      });
    },

    /**
     * Validates locally first for instant feedback, then lets storage re-check atomically.
     * State only changes after storage succeeds, so a rejected drop leaves the folder in place.
     */
    /** Moves a folder to the root of a category; its subfolders and notes come along. */
    moveFolderToCategory(id: FolderId, categoryId: CategoryId): Promise<Result<void>> {
      return cascade(() => storage.moveFolderToCategory(id, categoryId));
    },

    moveFolder(id: FolderId, newParentId: FolderId | null): Promise<Result<void>> {
      const links = new Map(state.folders.map((f) => [f.id, { id: f.id, parentId: f.parentId }]));
      const valid = validateFolderMove(links, id, newParentId);
      if (!valid.ok) return Promise.resolve(valid);
      return attempt(async () => {
        const moved = await storage.moveFolder(id, newParentId);
        setState('folders', (f) => f.id === id, 'parentId', moved.parentId);
      });
    },

    moveNote(noteId: NoteId, folderId: FolderId | null, categoryId: CategoryId | null): Promise<Result<void>> {
      return attempt(async () => putNote(await storage.moveNote(noteId, folderId, categoryId)));
    },

    trashNote(noteId: NoteId): Promise<Result<void>> {
      return attempt(async () => putNote(await storage.trashNote(noteId)));
    },

    restoreNote(noteId: NoteId): Promise<Result<void>> {
      return attempt(async () => putNote(await storage.restoreNote(noteId)));
    },
  };
}
