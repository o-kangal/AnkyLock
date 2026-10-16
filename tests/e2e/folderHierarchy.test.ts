import { afterEach, describe, expect, it } from 'vitest';
import type { CategoryId, FolderId, NoteId } from '@ankylock/core';
import { twoDevices, until, type Device } from './harness.js';

const opened: Device[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((d) => d.runtime.lock()));
});

async function pair() {
  const devices = await twoDevices();
  opened.push(devices.a, devices.b);
  return devices;
}

const folderId = (d: Device, name: string): FolderId => {
  const folder = d.runtime.store.state.folders.find((f) => f.name === name);
  if (!folder) throw new Error(`no folder ${name}`);
  return folder.id;
};

/** Creates folders on A as a chain (each inside the previous one) and waits until B has them. */
async function chain(a: Device, b: Device, names: string[]): Promise<FolderId[]> {
  let parent: FolderId | null = null;
  for (const name of names) {
    expect((await a.runtime.store.createFolder(name, parent, null)).ok).toBe(true);
    parent = folderId(a, name);
  }
  const ids = names.map((name) => folderId(a, name));
  await until(() => ids.every((id) => b.runtime.store.state.folders.some((f) => f.id === id)), 'folders on B');
  return ids;
}

const parentOn = (d: Device, id: FolderId): FolderId | null | undefined =>
  d.runtime.store.state.folders.find((f) => f.id === id)?.parentId;

describe('folder hierarchy across devices', () => {
  it('rejects circular parenting and nesting deeper than three levels, changing nothing', async () => {
    const { a, b } = await pair();
    const [top, middle, bottom] = await chain(a, b, ['Top', 'Middle', 'Bottom']);

    // BR-HIER-05: a folder cannot move into its own subtree.
    const cycle = await a.runtime.store.moveFolder(top!, bottom!);
    expect(cycle).toMatchObject({ ok: false, error: { code: 'ERR_CIRCULAR_HIERARCHY' } });
    // BR-HIER-03: at most three levels.
    const tooDeep = await a.runtime.store.createFolder('Fourth', bottom!, null);
    expect(tooDeep).toMatchObject({ ok: false, error: { code: 'ERR_MAX_DEPTH_EXCEEDED' } });

    expect([parentOn(a, top!), parentOn(a, middle!), parentOn(a, bottom!)]).toEqual([null, top, middle]);
    expect([parentOn(b, top!), parentOn(b, middle!), parentOn(b, bottom!)]).toEqual([null, top, middle]);
    expect(b.runtime.store.state.folders.some((f) => f.name === 'Fourth')).toBe(false);
  });

  it('moves a loose note into a folder, back to the top level and into a category, on both devices', async () => {
    const { a, b } = await pair();
    const [inbox] = await chain(a, b, ['Inbox']);
    expect((await a.runtime.store.createCategory('Work')).ok).toBe(true);
    const work = a.runtime.store.state.categories[0]?.id as CategoryId;
    await a.runtime.store.createTab();
    const noteId = a.runtime.store.state.tabs[0]?.noteId as NoteId;
    const placement = (d: Device) => {
      const note = d.runtime.store.state.notes[noteId];
      return note && { folderId: note.folderId, categoryId: note.categoryId };
    };

    for (const [target, category] of [
      [inbox!, null],
      [null, null],
      [null, work],
    ] as const) {
      expect((await a.runtime.store.moveNote(noteId, target, category)).ok).toBe(true);
      await until(() => JSON.stringify(placement(b)) === JSON.stringify(placement(a)), `B follows to ${target ?? category ?? 'top level'}`);
    }
    expect(placement(b)).toEqual({ folderId: null, categoryId: work });
    // Filing a scratchpad organizes it (SPEC §3).
    expect(b.runtime.store.state.notes[noteId]?.isEphemeral).toBe(false);
  });

  it('cascades folder archival to the subtree, and unarchiving restores only what was archived with it', async () => {
    const { a, b } = await pair();
    const [projects, old] = await chain(a, b, ['Projects', 'Old']);
    const notes: NoteId[] = [];
    for (const target of [projects!, old!, old!]) {
      await a.runtime.store.createTab();
      const noteId = a.runtime.store.state.tabs.at(-1)?.noteId as NoteId;
      expect((await a.runtime.store.moveNote(noteId, target, null)).ok).toBe(true);
      notes.push(noteId);
    }
    const [inProjects, inOld, archivedAlone] = notes as [NoteId, NoteId, NoteId];
    await until(() => notes.every((id) => b.runtime.store.state.notes[id]?.folderId != null), 'notes filed on B');
    // Archived on its own first: it must stay archived after the folder is unarchived.
    expect((await a.runtime.store.setNoteArchived(archivedAlone, true)).ok).toBe(true);
    await until(() => b.runtime.store.state.notes[archivedAlone]?.isArchived === true, 'archived alone on B');

    expect((await a.runtime.store.archiveFolder(projects!)).ok).toBe(true);
    const archivedOn = (d: Device) => [
      d.runtime.store.state.folders.find((f) => f.id === projects)?.isArchived,
      d.runtime.store.state.folders.find((f) => f.id === old)?.isArchived,
      d.runtime.store.state.notes[inProjects]?.isArchived,
      d.runtime.store.state.notes[inOld]?.isArchived,
    ];
    expect(archivedOn(a)).toEqual([true, true, true, true]);
    await until(() => archivedOn(b).every(Boolean), 'subtree archived on B');

    expect((await a.runtime.store.unarchiveFolder(projects!)).ok).toBe(true);
    await until(() => archivedOn(b).every((archived) => archived === false), 'subtree unarchived on B');
    expect(b.runtime.store.state.notes[archivedAlone]?.isArchived).toBe(true);
    expect(a.runtime.store.state.notes[archivedAlone]?.isArchived).toBe(true);
  });

  it('repairs a circular move made on two offline devices the same way on both (SPEC §7)', async () => {
    const { a, b } = await pair();
    const [one, two] = await chain(a, b, ['One', 'Two']);
    // Two is inside One; make them siblings first, everywhere.
    expect((await a.runtime.store.moveFolder(two!, null)).ok).toBe(true);
    await until(() => parentOn(b, two!) === null, 'siblings on B');

    a.setOnline(false);
    b.setOnline(false);
    expect((await a.runtime.store.moveFolder(one!, two!)).ok).toBe(true);
    expect((await b.runtime.store.moveFolder(two!, one!)).ok).toBe(true);
    a.setOnline(true);
    b.setOnline(true);

    const shape = (d: Device) => [parentOn(d, one!), parentOn(d, two!)];
    await until(() => JSON.stringify(shape(a)) === JSON.stringify(shape(b)) && shape(a).includes(null), 'converged', 15_000);
    // One of the two is at the root and the other inside it: no cycle, nothing lost.
    expect(shape(a).filter((p) => p === null)).toHaveLength(1);
  });
});
