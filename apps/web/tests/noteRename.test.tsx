import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { NoteId } from '@ankylock/core';
import { REMOTE_ORIGIN, TEXT_FIELD, noteName, setNoteName } from '@ankylock/sync';
import { buildExport } from '../src/export/buildExport.js';
import { createRuntime, type Runtime } from '../src/index.js';
import { PASSPHRASE, TestVaults, localSealer } from './helpers.js';

describe('renaming a note', () => {
  const runtimes: Runtime[] = [];
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((r) => r.lock()));
  });

  async function vaultWithNote(text: string) {
    const runtime = createRuntime({ vaults: new TestVaults(), sealer: localSealer(), runExport: buildExport });
    runtimes.push(runtime);
    await runtime.init();
    expect(await runtime.createVault('Personal', PASSPHRASE)).toBeNull();
    await runtime.store.createTab();
    const id = runtime.store.state.tabs[0]?.noteId as NoteId;
    (await runtime.openDoc(id)).getText(TEXT_FIELD).insert(0, text);
    runtime.store.setTitle(id, text.split('\n', 1)[0] ?? null);
    return { runtime, id };
  }

  const title = (runtime: Runtime, id: NoteId): string | null | undefined => runtime.store.state.notes[id]?.title;

  it('shows the name instead of line 1 and exports under it', async () => {
    const { runtime, id } = await vaultWithNote('#!/bin/sh\necho hi');
    expect((await runtime.renameNote(id, '  deploy.sh ')).ok).toBe(true);
    expect(title(runtime, id)).toBe('deploy.sh');
    expect(noteName(await runtime.openDoc(id))).toBe('deploy.sh');

    const file = await runtime.exportNotes({ kind: 'note', id }, null);
    expect(file.name).toBe('deploy.sh');
    expect(new TextDecoder().decode(file.bytes)).toBe('#!/bin/sh\necho hi');
  });

  it('goes back to line 1 when the name is cleared', async () => {
    const { runtime, id } = await vaultWithNote('Shopping list\nmilk');
    await runtime.renameNote(id, 'Groceries');
    expect((await runtime.renameNote(id, '   ')).ok).toBe(true);
    expect(title(runtime, id)).toBe('Shopping list');
    expect((await runtime.exportNotes({ kind: 'note', id }, null)).name).toBe('Shopping list.txt');
  });

  it('does not pin line 1 as a name when the title is submitted unchanged', async () => {
    const { runtime, id } = await vaultWithNote('Shopping list\nmilk');
    expect((await runtime.renameNote(id, 'Shopping list')).ok).toBe(true);
    expect(noteName(await runtime.openDoc(id))).toBeNull();
  });

  it('renames a note without an open tab, and keeps the name after its doc is closed', async () => {
    const { runtime, id } = await vaultWithNote('draft\nbody');
    await runtime.store.closeTab(0, false);
    await runtime.retainDocs([]);
    expect((await runtime.renameNote(id, 'Final.md')).ok).toBe(true);
    expect(title(runtime, id)).toBe('Final.md');
    expect(noteName(await runtime.openDoc(id))).toBe('Final.md');
  });

  it('follows a rename made on another device', async () => {
    const { runtime, id } = await vaultWithNote('draft');
    const doc = await runtime.openDoc(id);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    setNoteName(peer, 'From laptop');
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer, Y.encodeStateVector(doc)), REMOTE_ORIGIN);
    expect(title(runtime, id)).toBe('From laptop');
  });

  it('refuses to rename a note in Trash', async () => {
    const { runtime, id } = await vaultWithNote('gone');
    expect((await runtime.store.trashNote(id)).ok).toBe(true);
    expect(await runtime.renameNote(id, 'new')).toMatchObject({ ok: false, error: { code: 'ERR_READ_ONLY_TRASHED_ENTITY' } });
  });
});
