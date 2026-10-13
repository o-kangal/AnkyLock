import { MS_PER_DAY, isSystemCategoryId } from '../constants.js';
import { err, ok, type Result } from '../errors.js';
import type { CategoryId, EpochMs, FolderId, Note, NoteId } from '../types/entities.js';

export type NoteState = 'EPHEMERAL' | 'ORGANIZED' | 'ARCHIVED' | 'TRASHED' | 'PURGED';

export type NoteAction =
  | { readonly type: 'CREATE_TAB'; readonly id: NoteId; readonly now: EpochMs }
  | {
      readonly type: 'ASSIGN_HIERARCHY';
      readonly folderId: FolderId | null;
      readonly categoryId: CategoryId | null;
      readonly now: EpochMs;
    }
  | { readonly type: 'CLOSE_TAB'; readonly isEmptyAndUnmodified: boolean }
  | { readonly type: 'EDIT_CONTENT'; readonly now: EpochMs }
  | { readonly type: 'ARCHIVE'; readonly now: EpochMs }
  | { readonly type: 'UNARCHIVE'; readonly now: EpochMs }
  | { readonly type: 'DELETE'; readonly now: EpochMs }
  | {
      readonly type: 'RESTORE';
      readonly now: EpochMs;
      /**
       * Whether the note can go back into its folder (the folder exists and is not in Trash) and
       * whether its category still exists; otherwise that pointer is reset (BR-LIFE-05).
       */
      readonly folderExists: boolean;
      readonly categoryExists: boolean;
    }
  | { readonly type: 'PURGE' }
  | { readonly type: 'EXPIRE'; readonly now: EpochMs; readonly retentionDays: number };

export type NoteTransition =
  | { readonly kind: 'saved'; readonly note: Note }
  | { readonly kind: 'purged'; readonly noteId: NoteId }
  | { readonly kind: 'unchanged' };

export const TRASHED_READ_ONLY_MESSAGE = 'Notes in Trash are read-only. Restore the note to edit.';

/** A missing record means the note was purged. */
export function deriveNoteState(note: Note | null): NoteState {
  if (note === null) return 'PURGED';
  if (note.deletedAt !== null) return 'TRASHED';
  if (note.isArchived) return 'ARCHIVED';
  return note.isEphemeral ? 'EPHEMERAL' : 'ORGANIZED';
}

/** BR-LIFE-04: retention 0 means manual purge only. */
export function isPurgeEligible(deletedAt: EpochMs, retentionDays: number, now: EpochMs): boolean {
  return retentionDays > 0 && deletedAt + retentionDays * MS_PER_DAY < now;
}

const TRASH_ACTIONS: ReadonlySet<NoteAction['type']> = new Set(['RESTORE', 'PURGE', 'EXPIRE']);

/** Pure lifecycle reducer (SPEC §3). `note` is null when no record exists. */
export function transitionNote(note: Note | null, action: NoteAction): Result<NoteTransition> {
  const state = deriveNoteState(note);

  if (note === null) {
    if (action.type !== 'CREATE_TAB') {
      return err('ERR_INVALID_TRANSITION', `Cannot apply ${action.type} to a purged or missing note.`);
    }
    return ok({
      kind: 'saved',
      note: {
        id: action.id,
        folderId: null,
        categoryId: null,
        isEphemeral: true,
        isArchived: false,
        deletedAt: null,
        createdAt: action.now,
        updatedAt: action.now,
      },
    });
  }

  if (state === 'TRASHED' && !TRASH_ACTIONS.has(action.type)) {
    return err('ERR_READ_ONLY_TRASHED_ENTITY', TRASHED_READ_ONLY_MESSAGE);
  }

  const invalid = (): Result<never> =>
    err('ERR_INVALID_TRANSITION', `Cannot apply ${action.type} to a note in state ${state}.`);

  switch (action.type) {
    case 'CREATE_TAB':
      return invalid();

    case 'ASSIGN_HIERARCHY':
      if (action.categoryId !== null && isSystemCategoryId(action.categoryId)) {
        return err('ERR_SYSTEM_CATEGORY_IMMUTABLE', 'Notes cannot be assigned to a system category.');
      }
      return ok({
        kind: 'saved',
        note: {
          ...note,
          folderId: action.folderId,
          categoryId: action.categoryId,
          isEphemeral: false,
          updatedAt: action.now,
        },
      });

    case 'CLOSE_TAB':
      if (state !== 'EPHEMERAL') return invalid();
      return ok(action.isEmptyAndUnmodified ? { kind: 'purged', noteId: note.id } : { kind: 'unchanged' });

    case 'EDIT_CONTENT':
      return ok({ kind: 'saved', note: { ...note, updatedAt: action.now } });

    case 'ARCHIVE':
      if (state !== 'ORGANIZED') return invalid();
      return ok({ kind: 'saved', note: { ...note, isArchived: true, updatedAt: action.now } });

    case 'UNARCHIVE':
      if (state !== 'ARCHIVED') return invalid();
      return ok({ kind: 'saved', note: { ...note, isArchived: false, updatedAt: action.now } });

    case 'DELETE':
      return ok({ kind: 'saved', note: { ...note, deletedAt: action.now, updatedAt: action.now } });

    case 'RESTORE':
      if (state !== 'TRASHED') return invalid();
      return ok({
        kind: 'saved',
        note: {
          ...note,
          folderId: action.folderExists ? note.folderId : null,
          categoryId: action.categoryExists ? note.categoryId : null,
          isEphemeral: false,
          deletedAt: null,
          updatedAt: action.now,
        },
      });

    case 'PURGE':
      if (state !== 'TRASHED') return invalid();
      return ok({ kind: 'purged', noteId: note.id });

    case 'EXPIRE':
      if (note.deletedAt === null || !isPurgeEligible(note.deletedAt, action.retentionDays, action.now)) {
        return invalid();
      }
      return ok({ kind: 'purged', noteId: note.id });
  }
}
