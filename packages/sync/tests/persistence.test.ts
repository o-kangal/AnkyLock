import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { NoteId } from '@ankylock/core';
import { createKeySealer, createTextCodec } from '@ankylock/crypto';
import { WebIndexedDbAdapter } from '@ankylock/storage';
import { DocManager, TEXT_FIELD, loadNoteState, persistDoc, saveNoteState } from '../src/index.js';

const NOTE = 'n1' as NoteId;

async function deps() {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const storage = new WebIndexedDbAdapter(new IDBFactory());
  await storage.createNote(NOTE);
  return { storage, sealer: createKeySealer(() => key) };
}

describe('saveNoteState / loadNoteState', () => {
  it('round-trips a doc and stores nothing readable', async () => {
    const d = await deps();
    const doc = new Y.Doc();
    doc.getText(TEXT_FIELD).insert(0, 'const secret = 42;');
    await saveNoteState(d, NOTE, doc, 'const secret = 42;');

    const stored = await d.storage.getNoteContent(NOTE);
    for (const bytes of [stored?.contentCiphertext, stored?.yjsUpdates]) {
      expect(new TextDecoder('latin1').decode(bytes)).not.toContain('secret');
    }
    expect(await createTextCodec(d.sealer).decrypt(stored?.titleCiphertext ?? ('' as never))).toBe('const secret = 42;');

    const reopened = new DocManager().open(NOTE, await loadNoteState(d, NOTE));
    expect(reopened.getText(TEXT_FIELD).toString()).toBe('const secret = 42;');
  });

  it('returns undefined for notes never saved', async () => {
    expect(await loadNoteState(await deps(), NOTE)).toBeUndefined();
  });

  it('rejects notes over 10 MB', async () => {
    const d = await deps();
    const doc = new Y.Doc();
    doc.getText(TEXT_FIELD).insert(0, 'x'.repeat(10 * 1024 * 1024 + 1));
    await expect(saveNoteState(d, NOTE, doc, null)).rejects.toMatchObject({ code: 'ERR_NOTE_TOO_LARGE' });
  });
});

describe('persistDoc', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves batched changes after the delay and on dispose', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const d = await deps();
    const doc = new Y.Doc();
    const errors: unknown[] = [];
    const persister = persistDoc(NOTE, doc, { ...d, title: () => 'Title', onError: (e) => errors.push(e), delayMs: 100 });

    doc.getText(TEXT_FIELD).insert(0, 'a');
    doc.getText(TEXT_FIELD).insert(1, 'b');
    expect(await d.storage.getNoteContent(NOTE)).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    await persister.flush();
    const reopened = new DocManager().open(NOTE, await loadNoteState(d, NOTE));
    expect(reopened.getText(TEXT_FIELD).toString()).toBe('ab');

    doc.getText(TEXT_FIELD).insert(2, 'c');
    await persister.dispose();
    const final = new DocManager().open(NOTE, await loadNoteState(d, NOTE));
    expect(final.getText(TEXT_FIELD).toString()).toBe('abc');
    expect(errors).toEqual([]);
  });

  it('reports failures, e.g. a note moved to Trash', async () => {
    const d = await deps();
    await d.storage.trashNote(NOTE);
    const doc = new Y.Doc();
    const errors: unknown[] = [];
    const persister = persistDoc(NOTE, doc, { ...d, title: () => null, onError: (e) => errors.push(e) });
    doc.getText(TEXT_FIELD).insert(0, 'x');
    await persister.dispose();
    expect(errors).toMatchObject([{ code: 'ERR_READ_ONLY_TRASHED_ENTITY' }]);
  });
});
