import { describe, expect, it } from 'vitest';
import {
  MS_PER_DAY,
  SYSTEM_ALL,
  TRASHED_READ_ONLY_MESSAGE,
  deriveNoteState,
  isPurgeEligible,
  transitionNote,
  type EpochMs,
  type FolderId,
  type Note,
  type NoteAction,
  type NoteId,
  type NoteTransition,
} from '../src/index.js';

const ms = (n: number): EpochMs => n as EpochMs;
const NOTE_ID = '3f8b2a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b' as NoteId;
const FOLDER_ID = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d' as FolderId;
const T0 = ms(1_776_100_000_000);

const baseNote: Note = {
  id: NOTE_ID,
  folderId: null,
  categoryId: null,
  isEphemeral: true,
  isArchived: false,
  deletedAt: null,
  createdAt: T0,
  updatedAt: T0,
};

const ephemeral = baseNote;
const organized: Note = { ...baseNote, isEphemeral: false, folderId: FOLDER_ID, categoryId: SYSTEM_ALL };
const archived: Note = { ...organized, isArchived: true };
const trashed: Note = { ...organized, deletedAt: T0 };

function expectSaved(note: Note | null, action: NoteAction): Note {
  const result = transitionNote(note, action);
  if (!result.ok) throw new Error(`Expected success, got ${result.error.code}`);
  if (result.value.kind !== 'saved') throw new Error(`Expected saved, got ${result.value.kind}`);
  return result.value.note;
}

function expectTransition(note: Note | null, action: NoteAction): NoteTransition {
  const result = transitionNote(note, action);
  if (!result.ok) throw new Error(`Expected success, got ${result.error.code}`);
  return result.value;
}

function expectError(note: Note | null, action: NoteAction): string {
  const result = transitionNote(note, action);
  if (result.ok) throw new Error(`Expected error, got ${result.value.kind}`);
  return result.error.code;
}

describe('deriveNoteState', () => {
  it('derives every state from columns', () => {
    expect(deriveNoteState(null)).toBe('PURGED');
    expect(deriveNoteState(ephemeral)).toBe('EPHEMERAL');
    expect(deriveNoteState(organized)).toBe('ORGANIZED');
    expect(deriveNoteState(archived)).toBe('ARCHIVED');
    expect(deriveNoteState(trashed)).toBe('TRASHED');
    expect(deriveNoteState({ ...archived, deletedAt: T0 })).toBe('TRASHED');
  });
});

describe('transitionNote: allowed transitions', () => {
  it('CREATE_TAB spawns an ephemeral note', () => {
    const note = expectSaved(null, { type: 'CREATE_TAB', id: NOTE_ID, now: T0 });
    expect(deriveNoteState(note)).toBe('EPHEMERAL');
    expect(note).toMatchObject({ id: NOTE_ID, isEphemeral: true, createdAt: T0, updatedAt: T0 });
  });

  it('ASSIGN_HIERARCHY organizes an ephemeral note', () => {
    const now = ms(T0 + 1);
    const note = expectSaved(ephemeral, { type: 'ASSIGN_HIERARCHY', folderId: FOLDER_ID, categoryId: null, now });
    expect(deriveNoteState(note)).toBe('ORGANIZED');
    expect(note).toMatchObject({ folderId: FOLDER_ID, categoryId: null, updatedAt: now });
  });

  it('ASSIGN_HIERARCHY moves an archived note without unarchiving it', () => {
    const note = expectSaved(archived, { type: 'ASSIGN_HIERARCHY', folderId: null, categoryId: null, now: T0 });
    expect(deriveNoteState(note)).toBe('ARCHIVED');
    expect(note.folderId).toBeNull();
  });

  it('CLOSE_TAB purges an empty, unmodified ephemeral note without trashing', () => {
    expect(expectTransition(ephemeral, { type: 'CLOSE_TAB', isEmptyAndUnmodified: true })).toEqual({
      kind: 'purged',
      noteId: NOTE_ID,
    });
  });

  it('CLOSE_TAB keeps a modified ephemeral note', () => {
    expect(expectTransition(ephemeral, { type: 'CLOSE_TAB', isEmptyAndUnmodified: false })).toEqual({
      kind: 'unchanged',
    });
  });

  it('ARCHIVE and UNARCHIVE round-trip', () => {
    const a = expectSaved(organized, { type: 'ARCHIVE', now: T0 });
    expect(deriveNoteState(a)).toBe('ARCHIVED');
    expect(deriveNoteState(expectSaved(a, { type: 'UNARCHIVE', now: T0 }))).toBe('ORGANIZED');
  });

  it.each([
    ['EPHEMERAL', ephemeral],
    ['ORGANIZED', organized],
    ['ARCHIVED', archived],
  ])('DELETE trashes a %s note and preserves its pointers', (_, note) => {
    const now = ms(T0 + 5);
    const deleted = expectSaved(note, { type: 'DELETE', now });
    expect(deriveNoteState(deleted)).toBe('TRASHED');
    expect(deleted).toMatchObject({ deletedAt: now, folderId: note.folderId, categoryId: note.categoryId });
  });

  it('RESTORE returns a note to ORGANIZED with its pointers when parents exist', () => {
    const note = expectSaved(trashed, { type: 'RESTORE', now: T0, folderExists: true, categoryExists: true });
    expect(deriveNoteState(note)).toBe('ORGANIZED');
    expect(note).toMatchObject({ folderId: FOLDER_ID, categoryId: SYSTEM_ALL, deletedAt: null });
  });

  it('RESTORE of an archived note returns it to ARCHIVED', () => {
    const note = expectSaved(
      { ...archived, deletedAt: T0 },
      { type: 'RESTORE', now: T0, folderExists: true, categoryExists: true },
    );
    expect(deriveNoteState(note)).toBe('ARCHIVED');
  });

  it('RESTORE falls back to the All Notes root when parents were purged (BR-LIFE-05)', () => {
    const note = expectSaved(trashed, { type: 'RESTORE', now: T0, folderExists: false, categoryExists: false });
    expect(note).toMatchObject({ folderId: null, categoryId: null, deletedAt: null });
  });

  it('RESTORE of a trashed scratchpad organizes it', () => {
    const note = expectSaved(
      { ...ephemeral, deletedAt: T0 },
      { type: 'RESTORE', now: T0, folderExists: true, categoryExists: true },
    );
    expect(deriveNoteState(note)).toBe('ORGANIZED');
  });

  it('PURGE removes a trashed note', () => {
    expect(expectTransition(trashed, { type: 'PURGE' })).toEqual({ kind: 'purged', noteId: NOTE_ID });
  });
});

describe('transitionNote: forbidden transitions', () => {
  it('TRASHED -> EDIT_CONTENT throws ERR_READ_ONLY_TRASHED_ENTITY with the UI message', () => {
    const result = transitionNote(trashed, { type: 'EDIT_CONTENT', now: T0 });
    expect(result).toEqual({
      ok: false,
      error: { code: 'ERR_READ_ONLY_TRASHED_ENTITY', message: TRASHED_READ_ONLY_MESSAGE },
    });
  });

  it.each<NoteAction>([
    { type: 'ASSIGN_HIERARCHY', folderId: null, categoryId: null, now: T0 },
    { type: 'ARCHIVE', now: T0 },
    { type: 'UNARCHIVE', now: T0 },
    { type: 'DELETE', now: T0 },
    { type: 'CLOSE_TAB', isEmptyAndUnmodified: true },
  ])('trashed notes reject $type as read-only', (action) => {
    expect(expectError(trashed, action)).toBe('ERR_READ_ONLY_TRASHED_ENTITY');
  });

  it.each<NoteAction>([
    { type: 'EDIT_CONTENT', now: T0 },
    { type: 'RESTORE', now: T0, folderExists: true, categoryExists: true },
    { type: 'PURGE' },
    { type: 'DELETE', now: T0 },
  ])('PURGED rejects $type', (action) => {
    expect(expectError(null, action)).toBe('ERR_INVALID_TRANSITION');
  });

  it.each<[string, Note, NoteAction]>([
    ['CREATE_TAB on an existing note', organized, { type: 'CREATE_TAB', id: NOTE_ID, now: T0 }],
    ['ARCHIVE from EPHEMERAL', ephemeral, { type: 'ARCHIVE', now: T0 }],
    ['ARCHIVE from ARCHIVED', archived, { type: 'ARCHIVE', now: T0 }],
    ['UNARCHIVE from ORGANIZED', organized, { type: 'UNARCHIVE', now: T0 }],
    ['CLOSE_TAB from ORGANIZED', organized, { type: 'CLOSE_TAB', isEmptyAndUnmodified: true }],
    ['RESTORE from ORGANIZED', organized, { type: 'RESTORE', now: T0, folderExists: true, categoryExists: true }],
    ['PURGE from ORGANIZED', organized, { type: 'PURGE' }],
    ['EXPIRE from ORGANIZED', organized, { type: 'EXPIRE', now: T0, retentionDays: 28 }],
  ])('rejects %s', (_, note, action) => {
    expect(expectError(note, action)).toBe('ERR_INVALID_TRANSITION');
  });

  it('never moves an ARCHIVED note back to EPHEMERAL', () => {
    const actions: NoteAction[] = [
      { type: 'EDIT_CONTENT', now: T0 },
      { type: 'ASSIGN_HIERARCHY', folderId: null, categoryId: null, now: T0 },
      { type: 'UNARCHIVE', now: T0 },
    ];
    for (const action of actions) {
      const result = transitionNote(archived, action);
      if (result.ok && result.value.kind === 'saved') {
        expect(deriveNoteState(result.value.note)).not.toBe('EPHEMERAL');
      }
    }
  });
});

describe('retention expiry (BR-LIFE-04)', () => {
  const deletedAt = T0;
  const boundary = ms(T0 + 28 * MS_PER_DAY);

  it('is not eligible exactly at the retention boundary', () => {
    expect(isPurgeEligible(deletedAt, 28, boundary)).toBe(false);
  });

  it('is eligible one millisecond after the boundary', () => {
    expect(isPurgeEligible(deletedAt, 28, ms(boundary + 1))).toBe(true);
  });

  it('never auto-purges when retention is 0 (manual purge only)', () => {
    expect(isPurgeEligible(deletedAt, 0, ms(T0 + 10_000 * MS_PER_DAY))).toBe(false);
  });

  it('EXPIRE purges only eligible trashed notes', () => {
    expect(expectError(trashed, { type: 'EXPIRE', now: boundary, retentionDays: 28 })).toBe('ERR_INVALID_TRANSITION');
    expect(expectTransition(trashed, { type: 'EXPIRE', now: ms(boundary + 1), retentionDays: 28 })).toEqual({
      kind: 'purged',
      noteId: NOTE_ID,
    });
  });
});
