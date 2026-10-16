import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NoteId, VaultId } from '@ankylock/core';
import { WebVaultDirectory } from '@ankylock/storage';
import { TEXT_FIELD } from '@ankylock/sync';
import { PASSPHRASE, twoDevices, until, type Device } from './harness.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const opened: Device[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(opened.splice(0).map((d) => d.runtime.lock()));
});

/** The app opened again later: unlocking starts the retention worker, which purges right away. */
async function reopen(d: Device, vaultId: VaultId): Promise<void> {
  await d.runtime.lock();
  expect(await d.runtime.unlock(vaultId, PASSPHRASE)).toBeNull();
  await d.runtime.signIn();
}

describe('trash retention lifecycle', () => {
  it('keeps a trashed note read-only for 28 days, then purges it on every device', async () => {
    const { a, b, vaultId } = await twoDevices();
    opened.push(a, b);
    await a.runtime.store.createTab();
    const noteId = a.runtime.store.state.tabs[0]?.noteId as NoteId;
    (await a.runtime.openDoc(noteId)).getText(TEXT_FIELD).insert(0, 'old draft');
    await a.runtime.flush();
    await until(() => b.runtime.store.state.notes[noteId] !== undefined, 'note on B');

    // Only Date moves; timers stay real so storage and the network keep working.
    vi.useFakeTimers({ toFake: ['Date'] });
    const trashedAt = Date.now();
    expect((await a.runtime.store.trashNote(noteId)).ok).toBe(true);
    await until(() => b.runtime.store.state.notes[noteId]?.deletedAt != null, 'trashed on B');

    // BR-LIFE-02: Trash is read-only; storage refuses edits, whatever the UI does.
    const storage = await new WebVaultDirectory(a.factory).open(vaultId);
    const content = await storage.getNoteContent(noteId);
    await expect(storage.saveNoteContent({ ...content!, updatedAt: (Date.now() + 1) as never })).rejects.toMatchObject({
      code: 'ERR_READ_ONLY_TRASHED_ENTITY',
    });

    // 27 days later: still within the default 28-day retention.
    vi.setSystemTime(trashedAt + 27 * DAY_MS);
    await reopen(a, vaultId);
    expect(a.runtime.store.state.notes[noteId]?.deletedAt).not.toBeNull();

    // 29 days later: the worker purges it (BR-LIFE-04), and the purge reaches the other device.
    vi.setSystemTime(trashedAt + 29 * DAY_MS);
    await reopen(a, vaultId);
    await until(() => a.runtime.store.state.notes[noteId] === undefined, 'purged on A');
    expect(await storage.getNote(noteId)).toBeNull();
    expect((await storage.listTombstones()).map((t) => t.entityId)).toContain(noteId);
    await until(() => b.runtime.store.state.notes[noteId] === undefined, 'purged on B', 15_000);
  });

  it('never purges automatically when retention is set to 0 (manual purge only)', async () => {
    const { a, b, vaultId } = await twoDevices();
    opened.push(a, b);
    await a.runtime.store.createTab();
    const noteId = a.runtime.store.state.tabs[0]?.noteId as NoteId;
    expect((await a.runtime.store.changeRetention(0, true)).ok).toBe(true);
    vi.useFakeTimers({ toFake: ['Date'] });
    const trashedAt = Date.now();
    expect((await a.runtime.store.trashNote(noteId)).ok).toBe(true);

    vi.setSystemTime(trashedAt + 400 * DAY_MS);
    await reopen(a, vaultId);
    expect(a.runtime.store.state.notes[noteId]?.deletedAt).not.toBeNull();
  });
});
