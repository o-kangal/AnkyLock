import { EditorView } from '@codemirror/view';
import { IDBFactory } from 'fake-indexeddb';
import { render } from 'solid-js/web';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EpochMs, FolderId, NoteId } from '@ankylock/core';
import { CryptoError, createKeySealer, type WorkerSealer } from '@ankylock/crypto';
import { WebIndexedDbAdapter, type IStorageEngine } from '@ankylock/storage';
import { AnkyLockApp, createRuntime, menuActions, type Runtime } from '../src/index.js';
import { setup } from './helpers.js';

beforeAll(() => {
  // jsdom has no layout; CodeMirror only needs these to exist.
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
  Range.prototype.getClientRects = () => Object.assign([] as DOMRect[], { item: () => null }) as unknown as DOMRectList;
});

/** Same-thread stand-in for the crypto worker. */
function localSealer(): WorkerSealer {
  let key: CryptoKey | null = null;
  const inner = createKeySealer(() => {
    if (key === null) throw new CryptoError('ERR_VAULT_LOCKED', 'The vault is locked.');
    return key;
  });
  return {
    ...inner,
    setKey: async (k) => {
      key = k;
    },
    dispose: () => undefined,
  };
}

let dispose: (() => void) | undefined;
let root: HTMLDivElement;

afterEach(() => {
  dispose?.();
  root?.remove();
});

function mount(storage: IStorageEngine): Runtime {
  const runtime = createRuntime({ storage, sealer: localSealer() });
  root = document.createElement('div');
  document.body.append(root);
  dispose = render(() => <AnkyLockApp runtime={runtime} />, root);
  return runtime;
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

/** Whole document: popovers render in a Portal on <body>, outside the mounted root. */
const text = (): string => document.body.textContent ?? '';

function type(selector: string, value: string): void {
  const input = document.querySelector(selector) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
}

function submit(): void {
  (document.querySelector('form') as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

function editor(): EditorView {
  const element = document.querySelector('.cm-editor');
  const view = element instanceof HTMLElement ? EditorView.findFromDOM(element) : null;
  if (!view) throw new Error('no editor');
  return view;
}

const pressCtrl = (key: string): void => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true }));
};

async function createVault(storage: IStorageEngine): Promise<Runtime> {
  const runtime = mount(storage);
  await waitFor(() => text().includes('Create your vault'), 'create screen');
  type('[aria-label="Passphrase"]', 'correct horse battery');
  type('[aria-label="Confirm passphrase"]', 'correct horse battery');
  submit();
  await waitFor(() => text().includes('Press Ctrl+N'), 'workspace');
  return runtime;
}

describe('vault screens', () => {
  it('validates the new passphrase before creating the vault', async () => {
    const storage = new WebIndexedDbAdapter(new IDBFactory());
    mount(storage);
    await waitFor(() => text().includes('Create your vault'), 'create screen');
    type('[aria-label="Passphrase"]', 'short');
    type('[aria-label="Confirm passphrase"]', 'short');
    submit();
    await waitFor(() => text().includes('at least 8 characters'), 'length error');
    type('[aria-label="Passphrase"]', 'long enough passphrase');
    type('[aria-label="Confirm passphrase"]', 'different passphrase');
    submit();
    await waitFor(() => text().includes('do not match'), 'mismatch error');
    expect(await storage.getVaultHeader()).toBeNull();
  });

  it('creates the vault, then asks for the passphrase on the next launch', async () => {
    const storage = new WebIndexedDbAdapter(new IDBFactory());
    await createVault(storage);
    expect(await storage.getVaultHeader()).not.toBeNull();
    dispose?.();
    root.remove();

    mount(storage);
    await waitFor(() => text().includes('Unlock AnkyLock'), 'unlock screen');
    type('[aria-label="Passphrase"]', 'wrong passphrase');
    submit();
    await waitFor(() => text().includes('does not unlock'), 'wrong passphrase error');
    type('[aria-label="Passphrase"]', 'correct horse battery');
    submit();
    await waitFor(() => text().includes('Press Ctrl+N'), 'workspace');
  });
});

describe('workspace', () => {
  it('saves typed text encrypted and restores it after relaunch', async () => {
    const storage = new WebIndexedDbAdapter(new IDBFactory());
    const runtime = await createVault(storage);
    pressCtrl('n');
    await waitFor(() => document.querySelector('.cm-editor') !== null, 'editor');
    editor().dispatch({ changes: { from: 0, insert: 'const secret = 42;' } });
    await waitFor(() => text().includes('const secret = 42;'), 'tab title');
    await runtime.lock();

    const noteId = (await storage.listNotes(null))[0]?.id as NoteId;
    const stored = await storage.getNoteContent(noteId);
    expect(new TextDecoder('latin1').decode(stored?.yjsUpdates)).not.toContain('secret');
    dispose?.();
    root.remove();

    const again = mount(storage);
    await waitFor(() => text().includes('Unlock AnkyLock'), 'unlock screen');
    type('[aria-label="Passphrase"]', 'correct horse battery');
    submit();
    await waitFor(() => text().includes('Press Ctrl+N'), 'workspace');
    again.store.openNote(noteId);
    await waitFor(() => document.querySelector('.cm-editor') !== null, 'editor');
    expect(editor().state.doc.toString()).toBe('const secret = 42;');
  });

  it('discards an untouched scratchpad on close but keeps an edited one', async () => {
    const storage = new WebIndexedDbAdapter(new IDBFactory());
    const runtime = await createVault(storage);
    pressCtrl('n');
    await waitFor(() => document.querySelector('.cm-editor') !== null, 'editor');
    pressCtrl('w');
    await waitFor(() => runtime.store.state.tabs.length === 0, 'tab closed');
    await waitFor(() => Object.keys(runtime.store.state.notes).length === 0, 'note discarded');

    pressCtrl('n');
    await waitFor(() => document.querySelector('.cm-editor') !== null, 'editor');
    editor().dispatch({ changes: { from: 0, insert: 'x' } });
    editor().dispatch({ changes: { from: 0, to: 1, insert: '' } });
    pressCtrl('w');
    await waitFor(() => runtime.store.state.tabs.length === 0, 'tab closed');
    expect(Object.keys(runtime.store.state.notes)).toHaveLength(1);
  });

  it('shows the trash notice for trashed notes and offers state-specific menu actions', async () => {
    const storage = new WebIndexedDbAdapter(new IDBFactory());
    const runtime = await createVault(storage);
    await runtime.store.createFolder('Projects', null, null);
    const folderRow = await (async () => {
      await waitFor(() => document.querySelector('[data-folder-id]') !== null, 'folder row');
      return document.querySelector('[data-folder-id]') as HTMLElement;
    })();
    folderRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    await waitFor(() => document.querySelector('[role="menu"]') !== null, 'menu');
    const labels = Array.from(document.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent);
    expect(labels).toEqual(['New subfolder', 'Rename', 'Archive', 'Move to Trash']);
    (Array.from(document.querySelectorAll('[role="menuitem"]')).find((b) => b.textContent === 'Archive') as HTMLElement).click();
    await waitFor(() => runtime.store.state.folders[0]?.isArchived === true, 'archived');
    expect(document.querySelector('[role="menu"]')).toBeNull();

    pressCtrl('n');
    await waitFor(() => document.querySelector('.cm-editor') !== null, 'editor');
    const noteId = runtime.store.state.tabs[0]?.noteId as NoteId;
    await runtime.store.trashNote(noteId);
    await waitFor(() => text().includes('Notes in Trash are read-only'), 'trash notice');
  });
});

describe('creating folders from the UI', () => {
  const menuItem = (label: string): HTMLElement =>
    Array.from(document.querySelectorAll('[role="menuitem"]')).find((b) => b.textContent === label) as HTMLElement;

  async function nameInMenu(label: string, name: string): Promise<void> {
    menuItem(label).click();
    await waitFor(() => document.querySelector(`[role="menu"] input[aria-label="${label}"]`) !== null, 'name field');
    const input = document.querySelector(`[role="menu"] input[aria-label="${label}"]`) as HTMLInputElement;
    input.value = name;
    input.dispatchEvent(new InputEvent('input', { bubbles: true }));
    (input.form as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }

  it('creates a category from the sidebar, then a folder inside it via right-click', async () => {
    const runtime = await createVault(new WebIndexedDbAdapter(new IDBFactory()));
    type('[aria-label="New category"]', 'Work');
    (document.querySelector('[aria-label="New category"]')?.closest('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await waitFor(() => runtime.store.state.categories.length === 1, 'category created');

    const categoryRow = Array.from(document.querySelectorAll('[role="button"]')).find((el) => el.textContent === 'Work') as HTMLElement;
    categoryRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
    await waitFor(() => document.querySelector('[role="menu"]') !== null, 'category menu');
    expect(Array.from(document.querySelectorAll('[role="menuitem"]')).map((b) => b.textContent)).toEqual([
      'New folder',
      'Rename',
      'Delete category',
    ]);
    await nameInMenu('New folder', 'Clients');
    await waitFor(() => runtime.store.state.folders.length === 1, 'folder created');
    expect(runtime.store.state.folders[0]).toMatchObject({
      name: 'Clients',
      parentId: null,
      categoryId: runtime.store.state.categories[0]?.id,
    });
  });

  it('creates a root folder with the + button in All Notes, and hides it in Trash', async () => {
    const runtime = await createVault(new WebIndexedDbAdapter(new IDBFactory()));
    (document.querySelector('[aria-label="New folder"]') as HTMLButtonElement).click();
    await waitFor(() => document.querySelector('[role="menu"]') !== null, 'root menu');
    await nameInMenu('New folder', 'Inbox');
    await waitFor(() => document.querySelector('[data-folder-id]')?.textContent?.includes('Inbox') === true, 'folder row');
    expect(runtime.store.state.folders[0]).toMatchObject({ parentId: null, categoryId: null });

    (Array.from(document.querySelectorAll('[role="button"]')).find((el) => el.textContent === 'Trash') as HTMLElement).click();
    await waitFor(() => document.querySelector('[aria-label="New folder"]') === null, '+ hidden in Trash');
  });

  it('creates a subfolder inside the selected folder', async () => {
    const runtime = await createVault(new WebIndexedDbAdapter(new IDBFactory()));
    await runtime.store.createFolder('Projects', null, null);
    runtime.store.select({ kind: 'folder', id: runtime.store.state.folders[0]?.id as FolderId });
    await waitFor(() => document.querySelector('[aria-label="New folder"]') !== null, '+ button');
    (document.querySelector('[aria-label="New folder"]') as HTMLButtonElement).click();
    await waitFor(() => document.querySelector('[role="menu"]') !== null, 'root menu');
    await nameInMenu('New folder', 'Alpha');
    await waitFor(() => runtime.store.state.folders.length === 2, 'subfolder created');
    expect(runtime.store.state.folders.find((f) => f.name === 'Alpha')?.parentId).toBe(runtime.store.state.folders[0]?.id);
  });

  it('renames and deletes a category, keeping its folders', async () => {
    const runtime = await createVault(new WebIndexedDbAdapter(new IDBFactory()));
    await runtime.store.createCategory('Work');
    const id = runtime.store.state.categories[0]?.id as NonNullable<(typeof runtime.store.state.categories)[0]>['id'];
    await runtime.store.createFolder('Clients', null, id);
    expect(await runtime.store.renameCategory(id, 'Job')).toEqual({ ok: true, value: undefined });
    expect(runtime.store.state.categories[0]?.name).toBe('Job');
    runtime.store.select({ kind: 'category', id });
    expect(await runtime.store.deleteCategory(id)).toEqual({ ok: true, value: undefined });
    expect(runtime.store.state.categories).toEqual([]);
    expect(runtime.store.state.folders[0]?.categoryId).toBeNull();
    expect(runtime.store.state.selection).toEqual({ kind: 'system', id: 'system_all' });
  });
});

describe('Trash toolbar', () => {
  const button = (label: string): HTMLButtonElement => document.querySelector(`[aria-label="${label}"]`) as HTMLButtonElement;

  async function trashView(runtime: Runtime): Promise<void> {
    (Array.from(document.querySelectorAll('[role="button"]')).find((el) => el.textContent === 'Trash') as HTMLElement).click();
    await waitFor(() => button('Trash settings') !== null, 'trash toolbar');
    expect(runtime.store.state.selection).toEqual({ kind: 'system', id: 'system_trash' });
  }

  it('only appears in the Trash view, with Empty Trash disabled while it is empty', async () => {
    const runtime = await createVault(new WebIndexedDbAdapter(new IDBFactory()));
    expect(button('Trash settings')).toBeNull();
    await trashView(runtime);
    expect(button('Empty Trash').disabled).toBe(true);
    expect(button('New folder')).toBeNull();
  });

  it('changes retention, asking first when items would be purged right away (SPEC §6)', async () => {
    // Storage clock that can run in the past, so a note can be trashed "10 days ago".
    let offset = 10 * 86_400_000;
    const storage = new WebIndexedDbAdapter(new IDBFactory(), () => (Date.now() - offset) as EpochMs);
    const runtime = await createVault(storage);
    await runtime.store.createTab();
    const noteId = runtime.store.state.tabs[0]?.noteId as NoteId;
    await runtime.store.trashNote(noteId);
    offset = 0;
    await trashView(runtime);

    const days = (): HTMLInputElement => document.querySelector('[aria-label="Retention days"]') as HTMLInputElement;
    button('Trash settings').click();
    await waitFor(() => days() !== null, 'settings popover');
    expect(days().value).toBe('28');
    type('[aria-label="Retention days"]', '7');
    (days().form as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => text().includes('1 item in Trash will be deleted permanently now'), 'confirmation');
    expect(await storage.getTrashRetentionDays()).toBe(28);

    (Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent === 'Cancel') as HTMLElement).click();
    await waitFor(() => days() !== null, 'back to the form');
    expect(await storage.getNote(noteId)).not.toBeNull();

    (days().form as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => text().includes('will be deleted permanently now'), 'confirmation again');
    (Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent === 'Delete and save') as HTMLElement).click();
    await waitFor(() => runtime.store.state.retentionDays === 7, 'retention saved');
    expect(await storage.getTrashRetentionDays()).toBe(7);
    expect(await storage.getNote(noteId)).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('can turn automatic deletion off', async () => {
    const storage = new WebIndexedDbAdapter(new IDBFactory());
    const runtime = await createVault(storage);
    await trashView(runtime);
    button('Trash settings').click();
    await waitFor(() => document.querySelector('[aria-label="Never delete automatically"]') !== null, 'settings popover');
    const checkbox = document.querySelector('[aria-label="Never delete automatically"]') as HTMLInputElement;
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    (checkbox.form as HTMLFormElement).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await waitFor(() => runtime.store.state.retentionDays === 0, 'manual mode saved');
    expect(await storage.getTrashRetentionDays()).toBe(0);
  });

  it('empties the Trash after confirmation, leaving live items alone', async () => {
    const storage = new WebIndexedDbAdapter(new IDBFactory());
    const runtime = await createVault(storage);
    await runtime.store.createFolder('Old', null, null);
    await runtime.store.createFolder('Old child', runtime.store.state.folders[0]?.id as FolderId, null);
    await runtime.store.createFolder('Keep', null, null);
    await runtime.store.trashFolder(runtime.store.state.folders.find((f) => f.name === 'Old')?.id as FolderId);
    await runtime.store.createTab();
    await runtime.store.createTab();
    const [trashedNote, liveNote] = runtime.store.state.tabs.map((t) => t.noteId) as [NoteId, NoteId];
    await runtime.store.trashNote(trashedNote);
    await trashView(runtime);

    button('Empty Trash').click();
    await waitFor(() => text().includes('Permanently delete all 3 items in Trash?'), 'confirmation');
    (Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent === 'Cancel') as HTMLElement).click();
    await waitFor(() => document.querySelector('[role="dialog"]') === null, 'cancelled');
    expect(await storage.listTrashedFolders()).toHaveLength(2);

    button('Empty Trash').click();
    await waitFor(() => document.querySelector('[role="dialog"]') !== null, 'confirmation again');
    (Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent === 'Delete permanently') as HTMLElement).click();
    await waitFor(() => document.querySelector('[role="dialog"]') === null, 'emptied');
    expect(await storage.listTrashedFolders()).toEqual([]);
    expect(await storage.listTrashedNotes()).toEqual([]);
    expect((await storage.listFolders()).map((f) => f.id)).toEqual([runtime.store.state.folders[0]?.id]);
    expect(await storage.getNote(liveNote)).not.toBeNull();
    expect(button('Empty Trash').disabled).toBe(true);
  });
});

describe('confirmation styling', () => {
  it('shows the purge confirmation in red', async () => {
    const runtime = await createVault(new WebIndexedDbAdapter(new IDBFactory()));
    await runtime.store.createFolder('Old', null, null);
    await runtime.store.trashFolder(runtime.store.state.folders[0]?.id as FolderId);
    runtime.store.select({ kind: 'system', id: 'system_trash' });
    await waitFor(() => document.querySelector('[data-folder-id]') !== null, 'trashed folder row');
    document.querySelector('[data-folder-id]')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    await waitFor(() => document.querySelector('[role="menu"]') !== null, 'menu');
    const purge = (): HTMLElement =>
      Array.from(document.querySelectorAll('[role="menuitem"]')).find((b) => b.textContent?.startsWith('Delete permanently')) as HTMLElement;
    expect(purge().style.color).toBe('inherit');
    purge().click();
    await waitFor(() => purge().textContent?.includes('Click again to confirm') === true, 'confirm prompt');
    expect(purge().style.color).toBe('rgb(179, 38, 30)');
  });
});

describe('menuActions', () => {
  it('offers restore and confirmed purge for trashed items', async () => {
    const { store } = setup();
    await store.createFolder('Old', null, null);
    await store.trashFolder('id-1' as FolderId);
    const actions = menuActions(store.state, store, { kind: 'folder', id: 'id-1' as FolderId });
    expect(actions.map((a) => [a.label, a.confirm ?? false])).toEqual([
      ['Restore', false],
      ['Delete permanently', true],
    ]);
  });

  it('does not offer Archive for unfiled scratchpads', async () => {
    const { store } = setup();
    await store.createTab();
    expect(menuActions(store.state, store, { kind: 'note', id: 'id-1' as NoteId }).map((a) => a.label)).toEqual([
      'Move to Trash',
    ]);
  });
});
