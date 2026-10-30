import { TextWriter, Uint8ArrayReader, ZipReader, type FileEntry } from '@zip.js/zip.js';
import { render } from 'solid-js/web';
import { afterEach, describe, expect, it } from 'vitest';
import type { CategoryId, FolderId, NoteId } from '@ankylock/core';
import { TEXT_FIELD } from '@ankylock/sync';
import { buildExport } from '../src/export/buildExport.js';
import type { ExportFile } from '../src/export/exportNotes.js';
import { noteFileName, safeName, uniqueName } from '../src/export/exportPlan.js';
import { AnkyLockApp, createRuntime, type Runtime } from '../src/index.js';
import { PASSPHRASE, TestVaults, localSealer, until } from './helpers.js';

describe('export file names', () => {
  it('makes names every OS accepts', () => {
    expect(safeName('a/b:c*d?"e<f>|g\\h')).toBe('a_b_c_d__e_f__g_h');
    expect(safeName('notes. . ')).toBe('notes');
    expect(safeName('CON')).toBe('_CON');
    expect(safeName('lpt1.txt')).toBe('_lpt1.txt');
    expect(safeName('   ')).toBe('Untitled');
    expect(safeName('..')).toBe('Untitled');
    // No path can leave its directory inside the zip (zip slip).
    expect(safeName('../../etc/passwd')).toBe('.._.._etc_passwd');
    expect(safeName('..\\..\\windows')).toBe('.._.._windows');
    expect(safeName('.')).toBe('Untitled');
    expect(Array.from(safeName('x'.repeat(300)))).toHaveLength(100);
    expect(safeName('Plans\u0000\u0007')).toBe('Plans__');
  });

  it('numbers duplicates before the extension, ignoring case', () => {
    const taken = new Set<string>();
    expect(['Todo.txt', 'todo.txt', 'TODO.txt', 'Notes'].map((n) => uniqueName(taken, n))).toEqual([
      'Todo.txt',
      'todo (2).txt',
      'TODO (3).txt',
      'Notes',
    ]);
  });

  it('names a note after its title, keeping an extension the title already has', () => {
    expect(noteFileName('Shopping list')).toBe('Shopping list.txt');
    expect(noteFileName('README.md')).toBe('README.md');
    expect(noteFileName('docker-compose.yaml')).toBe('docker-compose.yaml');
    expect(noteFileName(null)).toBe('Untitled.txt');
    expect(noteFileName('http://x.test/a?b')).toBe('http___x.test_a_b.txt');
  });
});

const entriesOf = async (file: ExportFile, password?: string): Promise<Record<string, string | null>> => {
  const reader = new ZipReader(new Uint8ArrayReader(file.bytes));
  const result: Record<string, string | null> = {};
  for (const entry of await reader.getEntries()) {
    result[entry.filename] = entry.directory ? null : await entry.getData(new TextWriter(), password ? { password } : {});
  }
  await reader.close();
  return result;
};

describe('exporting from a vault', () => {
  const runtimes: Runtime[] = [];
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((r) => r.lock()));
  });

  /** A vault with categories, nested folders, duplicates, an archived and a trashed note. */
  async function vault() {
    const runtime = createRuntime({ vaults: new TestVaults(), sealer: localSealer(), runExport: buildExport });
    runtimes.push(runtime);
    await runtime.init();
    expect(await runtime.createVault('Personal', PASSPHRASE)).toBeNull();
    const { store } = runtime;
    const note = async (text: string, folderId: FolderId | null, categoryId: CategoryId | null = null): Promise<NoteId> => {
      await store.createTab();
      const id = store.state.tabs.at(-1)?.noteId as NoteId;
      (await runtime.openDoc(id)).getText(TEXT_FIELD).insert(0, text);
      if (folderId !== null || categoryId !== null) expect((await store.moveNote(id, folderId, categoryId)).ok).toBe(true);
      return id;
    };
    const folder = async (name: string, parentId: FolderId | null, categoryId: CategoryId | null = null): Promise<FolderId> => {
      expect((await store.createFolder(name, parentId, categoryId)).ok).toBe(true);
      return store.state.folders.find((f) => f.name === name)?.id as FolderId;
    };
    expect((await store.createCategory('Work')).ok).toBe(true);
    const work = store.state.categories[0]?.id as CategoryId;
    const plans = await folder('Plans', null, work);
    const q4 = await folder('Q4: launch?', plans);
    await folder('Empty', null);
    await note('Roadmap\nship it', q4);
    await note('Standup\nnotes', null, work);
    await note('README.md\n# Hello', null);
    await note('Todo\nfirst', null);
    await note('Todo\nsecond', null);
    const archived = await note('Old idea\nmaybe', plans);
    expect((await store.setNoteArchived(archived, true)).ok).toBe(true);
    const trashed = await note('Secret draft\ngone', null);
    expect((await store.trashNote(trashed)).ok).toBe(true);
    return { runtime, plans, trashed };
  }

  it('exports the vault as a zip that keeps categories and folders, without Trash', async () => {
    const { runtime } = await vault();
    const file = await runtime.exportNotes({ kind: 'vault' }, null);
    expect(file.name).toMatch(/^AnkyLock Personal \d{4}-\d{2}-\d{2}\.zip$/);
    expect(file.type).toBe('application/zip');
    const entries = await entriesOf(file);
    expect(entries).toMatchObject({
      'Work/': null,
      'Work/Plans/': null,
      'Work/Plans/Q4_ launch_/': null,
      'Empty/': null,
      'Work/Plans/Q4_ launch_/Roadmap.txt': 'Roadmap\nship it',
      'Work/Standup.txt': 'Standup\nnotes',
      'README.md': 'README.md\n# Hello',
      'Work/Plans/Old idea.txt': 'Old idea\nmaybe',
    });
    expect([entries['Todo.txt'], entries['Todo (2).txt']].sort()).toEqual(['Todo\nfirst', 'Todo\nsecond']);
    expect(Object.keys(entries).some((name) => name.includes('Secret'))).toBe(false);
    expect(Object.values(entries).some((text) => text?.includes('gone'))).toBe(false);
  });

  it('exports a folder with its subfolders as a zip named after it', async () => {
    const { runtime, plans } = await vault();
    const file = await runtime.exportNotes({ kind: 'folder', id: plans }, null);
    expect(file.name).toBe('Plans.zip');
    expect(Object.keys(await entriesOf(file)).sort()).toEqual([
      'Plans/',
      'Plans/Old idea.txt',
      'Plans/Q4_ launch_/',
      'Plans/Q4_ launch_/Roadmap.txt',
    ]);
  });

  it('exports a single note as a plain file, or as a protected zip', async () => {
    const { runtime } = await vault();
    const readme = await noteWithText(runtime, 'README.md');
    const note = await runtime.exportNotes({ kind: 'note', id: readme }, null);
    expect(note.name).toBe('README.md');
    expect(new TextDecoder().decode(note.bytes)).toBe('README.md\n# Hello');

    const protectedNote = await runtime.exportNotes({ kind: 'note', id: readme }, 'zip password');
    expect(protectedNote.name).toBe('README.zip');
    expect(await entriesOf(protectedNote, 'zip password')).toEqual({ 'README.md': 'README.md\n# Hello' });
  });

  it('protects a zip with AES-256: it opens only with the password', async () => {
    const { runtime } = await vault();
    const file = await runtime.exportNotes({ kind: 'vault' }, 'correct horse');
    const reader = new ZipReader(new Uint8ArrayReader(file.bytes));
    const roadmap = (await reader.getEntries()).find((e) => e.filename.endsWith('Roadmap.txt')) as FileEntry;
    expect(roadmap.encrypted).toBe(true);
    expect(roadmap.zipCrypto).toBe(false);
    await expect(roadmap.getData(new TextWriter(), { password: 'wrong guess' })).rejects.toThrow();
    expect(await roadmap.getData(new TextWriter(), { password: 'correct horse' })).toBe('Roadmap\nship it');
    // The content never appears in the clear in the file.
    expect(new TextDecoder('latin1').decode(file.bytes)).not.toContain('ship it');
  });

  it('refuses to export what is in Trash', async () => {
    const { runtime, trashed } = await vault();
    await expect(runtime.exportNotes({ kind: 'note', id: trashed }, null)).rejects.toThrow(/Trash/);
  });
});

/** The id of the live note whose text starts with `title`. */
async function noteWithText(runtime: Runtime, title: string): Promise<NoteId> {
  for (const id of Object.keys(runtime.store.state.notes) as NoteId[]) {
    if (runtime.store.state.notes[id]?.deletedAt !== null) continue;
    if ((await runtime.openDoc(id)).getText(TEXT_FIELD).toString().startsWith(title)) return id;
  }
  throw new Error(`no note ${title}`);
}

describe('export dialog', () => {
  let dispose: (() => void) | undefined;
  afterEach(() => {
    dispose?.();
    document.body.replaceChildren();
  });

  it('exports only after confirming, and checks the zip password', async () => {
    const runtime = createRuntime({ vaults: new TestVaults(), sealer: localSealer(), runExport: buildExport });
    const saved: ExportFile[] = [];
    const root = document.createElement('div');
    document.body.append(root);
    dispose = render(() => <AnkyLockApp runtime={runtime} saveFile={async (file) => (saved.push(file), true)} />, root);
    await until(() => runtime.status() === 'uninitialized', 'vault list');
    expect(await runtime.createVault('Personal', PASSPHRASE)).toBeNull();
    await runtime.store.createTab();
    const noteId = runtime.store.state.tabs[0]?.noteId as NoteId;
    (await runtime.openDoc(noteId)).getText(TEXT_FIELD).insert(0, 'Plan\nsecret plan');
    await until(() => document.querySelector(`[data-note-id="${noteId}"]`) !== null, 'note row');

    document.querySelector(`[data-note-id="${noteId}"]`)?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    await until(() => document.querySelector('[role="menu"]') !== null, 'menu');
    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((b) => b.textContent === 'Export…') as HTMLButtonElement;
    item.click();
    await until(() => document.querySelector('[role="dialog"][aria-label="Export"]') !== null, 'dialog');
    const dialog = document.querySelector('[role="dialog"][aria-label="Export"]') as HTMLFormElement;
    expect(dialog.textContent).toContain('not protected by AnkyLock');
    expect(saved).toHaveLength(0);

    const button = (label: string) => Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement;
    const type = (label: string, value: string) => {
      const input = dialog.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    };
    const checkbox = dialog.querySelector('input[type="checkbox"]') as HTMLInputElement;
    checkbox.click();
    expect(dialog.textContent).toContain('7-Zip');
    type('Zip password', 'short');
    expect(button('Export').disabled).toBe(true);
    type('Zip password', 'long enough');
    type('Confirm zip password', 'long enougH');
    expect(button('Export').disabled).toBe(true);
    type('Confirm zip password', 'long enough');
    expect(button('Export').disabled).toBe(false);

    button('Export').click();
    await until(() => saved.length === 1, 'saved');
    expect(saved[0]?.name).toBe('Plan.zip');
    expect(await entriesOf(saved[0]!, 'long enough')).toEqual({ 'Plan.txt': 'Plan\nsecret plan' });
    await until(() => document.querySelector('[aria-label="Export"]') === null, 'dialog closed');

    // Cancelling exports nothing.
    document.querySelector(`[data-note-id="${noteId}"]`)?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    await until(() => document.querySelector('[role="menu"]') !== null, 'menu again');
    (Array.from(document.querySelectorAll('[role="menuitem"]')).find((b) => b.textContent === 'Export…') as HTMLButtonElement).click();
    await until(() => document.querySelector('[aria-label="Export"]') !== null, 'dialog again');
    (Array.from(document.querySelectorAll('[aria-label="Export"] button')).find((b) => b.textContent === 'Cancel') as HTMLButtonElement).click();
    expect(document.querySelector('[aria-label="Export"]')).toBeNull();
    expect(saved).toHaveLength(1);
    await runtime.lock();
  });
});
