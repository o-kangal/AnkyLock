import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { Bytes, Ciphertext, EpochMs, FolderId, NoteId, VaultId } from '@ankylock/core';
import { createKeySealer, type Sealer } from '@ankylock/crypto';
import { WebIndexedDbAdapter } from '@ankylock/storage';
import {
  DocManager,
  TEXT_FIELD,
  createCatchUp,
  exportSnapshot,
  loadNoteState,
  saveNoteState,
  vaultSnapshotFileName,
  type DriveFile,
} from '../src/index.js';

const VAULT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as VaultId;
const A = 'dddddddd-dddd-4ddd-8ddd-dddddddddd0a';
const B = 'dddddddd-dddd-4ddd-8ddd-dddddddddd0b';

/** appDataFolder in memory: one file per name, as the scheduler keeps it. */
class Drive {
  readonly files = new Map<string, { id: string; data: Bytes; modifiedTime: EpochMs }>();
  #clock = 1;
  put(name: string, data: Bytes): void {
    this.files.set(name, { id: name, data, modifiedTime: this.#clock++ as EpochMs });
  }
  async listFiles(prefix: string): Promise<DriveFile[]> {
    return [...this.files.entries()].filter(([n]) => n.startsWith(prefix)).map(([name, f]) => ({ id: f.id, name, modifiedTime: f.modifiedTime }));
  }
  async downloadFile(id: string): Promise<Bytes> {
    return this.files.get(id)!.data;
  }
}

async function sealer(): Promise<Sealer> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return createKeySealer(() => key);
}

async function write(s: Sealer, storage: WebIndexedDbAdapter, id: NoteId, text: string): Promise<void> {
  if ((await storage.getNote(id)) === null) await storage.createNote(id);
  const doc = new Y.Doc();
  const stored = await loadNoteState({ storage, sealer: s }, id);
  if (stored) Y.applyUpdate(doc, stored);
  doc.getText(TEXT_FIELD).insert(doc.getText(TEXT_FIELD).length, text);
  await saveNoteState({ storage, sealer: s }, id, doc, null);
}

async function text(s: Sealer, storage: WebIndexedDbAdapter, id: NoteId): Promise<string> {
  const doc = new Y.Doc();
  const state = await loadNoteState({ storage, sealer: s }, id);
  if (state) Y.applyUpdate(doc, state);
  return doc.getText(TEXT_FIELD).toString();
}

const backup = async (s: Sealer, drive: Drive, storage: WebIndexedDbAdapter, device: string): Promise<void> =>
  drive.put(vaultSnapshotFileName(VAULT, device), await exportSnapshot(storage, s, Date.now() as EpochMs));

const NOTE = 'shared' as NoteId;

describe('createCatchUp', () => {
  it('merges what another device did while this one was closed', async () => {
    const s = await sealer();
    const drive = new Drive();
    const a = new WebIndexedDbAdapter(new IDBFactory());
    const b = new WebIndexedDbAdapter(new IDBFactory());

    // Both start from the same note; each edits it while the other is closed.
    await write(s, a, NOTE, 'base');
    await backup(s, drive, a, A);
    const catchUpB = createCatchUp({ drive, storage: b, sealer: s, docs: new DocManager(), vaultId: VAULT, deviceId: B });
    await catchUpB.run();
    await write(s, b, NOTE, ' +B');

    await write(s, a, NOTE, ' +A');
    await a.createFolder({ id: 'work' as FolderId, parentId: null, categoryId: null, nameCiphertext: 'd29yaw==' as Ciphertext });
    await a.moveNote(NOTE, 'work' as FolderId, null);
    await a.createNote('doomed' as NoteId);
    await backup(s, drive, a, A);

    const first = await catchUpB.run();
    expect(first.changed).toBe(true);
    expect(first.changedNotes).toContain(NOTE);
    // Text merged through Yjs: both edits survive, in a stable order.
    expect(await text(s, b, NOTE)).toMatch(/^base( \+A \+B| \+B \+A)$/);
    expect((await b.getNote(NOTE))?.folderId).toBe('work');
    expect((await b.listFolders()).map((f) => f.id)).toEqual(['work']);

    // A purges a note; B purges it too even though it never saw the TOMBSTONE packet.
    await a.trashNote('doomed' as NoteId);
    await a.purgeNote('doomed' as NoteId);
    await backup(s, drive, a, A);
    await catchUpB.run();
    expect(await b.getNote('doomed' as NoteId)).toBeNull();

    // Nothing new: no work, no writes.
    const before = (await b.getNoteContent(NOTE))?.updatedAt;
    expect(await catchUpB.run()).toEqual({ changedNotes: [], changed: false, unreadable: 0 });
    expect((await b.getNoteContent(NOTE))?.updatedAt).toBe(before);
  });

  it("skips this device's own snapshot and unreadable ones", async () => {
    const s = await sealer();
    const drive = new Drive();
    const own = new WebIndexedDbAdapter(new IDBFactory());
    await write(s, own, NOTE, 'mine');
    await backup(s, drive, own, B);
    drive.put(vaultSnapshotFileName(VAULT, A), new Uint8Array(40));
    const result = await createCatchUp({ drive, storage: own, sealer: s, docs: new DocManager(), vaultId: VAULT, deviceId: B }).run();
    expect(result).toEqual({ changedNotes: [], changed: false, unreadable: 1 });
  });

  it('merges into a note that is open here, live', async () => {
    const s = await sealer();
    const drive = new Drive();
    const a = new WebIndexedDbAdapter(new IDBFactory());
    await write(s, a, NOTE, 'from A');
    await backup(s, drive, a, A);
    const b = new WebIndexedDbAdapter(new IDBFactory());
    const docs = new DocManager();
    const open = docs.open(NOTE);
    await createCatchUp({ drive, storage: b, sealer: s, docs, vaultId: VAULT, deviceId: B }).run();
    expect(open.getText(TEXT_FIELD).toString()).toBe('from A');
  });
});
